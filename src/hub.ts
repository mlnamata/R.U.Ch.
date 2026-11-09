import { EventEmitter } from "node:events";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { checkEvidence, overallStatus, type EvidenceCheck } from "./evidence.js";
import type {
  Claim,
  Confidence,
  Evidence,
  HubEvent,
  Knowledge,
  KnowledgeKind,
  Message,
  MessageKind,
  Participant,
  ParticipantKind,
  Project,
  Question,
  Task,
  TaskStatus,
  Thread,
  ThreadStatus,
  Trust,
} from "./types.js";

export interface HubConfig {
  /** Agent messages in one thread without a human message before the thread pauses. */
  maxAgentStreak: number;
  /** Max messages one agent may post per minute (all threads). */
  maxMessagesPerMinute: number;
  /** How many of the agent's own recent messages are checked for repetition. */
  repeatWindow: number;
  defaultClaimMinutes: number;
  onlineSeconds: number;
  humanName: string;
  /** Max messages returned by one inbox call. */
  inboxLimit: number;
}

export const DEFAULT_CONFIG: HubConfig = {
  maxAgentStreak: 12,
  maxMessagesPerMinute: 20,
  repeatWindow: 6,
  defaultClaimMinutes: 30,
  onlineSeconds: 120,
  humanName: "Supervizor",
  inboxLimit: 40,
};

export class HubError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Row = Record<string, SQLInputValue>;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const HUMAN_ALIASES = new Set(["human", "clovek", "člověk", "supervizor", "user"]);
const ALL_ALIASES = new Set(["all", "vsichni", "všichni", "everyone"]);

/** Normalise text for repetition detection. */
function fingerprint(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words);
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s;
}

/** Two claims conflict when they are the same path or one is a directory containing the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b || a === "." || b === ".") return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

export interface PostInput {
  kind?: MessageKind;
  body: string;
  mentions?: string[];
  reply_to?: number | null;
  evidence?: Evidence[];
  confidence?: Confidence | null;
  meta?: Record<string, unknown>;
}

export interface PostResult {
  message: Message;
  warnings: string[];
  evidence_checks: EvidenceCheck[];
  thread: Thread;
}

export class Hub {
  readonly events = new EventEmitter();
  private recentPosts = new Map<number, number[]>();

  constructor(
    private db: DatabaseSync,
    readonly config: HubConfig = DEFAULT_CONFIG,
  ) {
    this.events.setMaxListeners(1000);
  }

  // ---------------------------------------------------------------- helpers

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private emit(projectId: number, type: HubEvent["type"], data: unknown) {
    this.events.emit("event", { projectId, type, data } satisfies HubEvent);
  }

  // ---------------------------------------------------------------- projects & participants

  ensureProject(slug: string, opts: { name?: string; brief?: string; root_path?: string | null } = {}): Project {
    const existing = this.one<Project>("SELECT * FROM projects WHERE slug = ?", slug);
    if (existing) {
      if (opts.root_path !== undefined && existing.root_path !== opts.root_path) {
        this.run("UPDATE projects SET root_path = ? WHERE id = ?", opts.root_path, existing.id);
        existing.root_path = opts.root_path;
      }
      return existing;
    }
    const r = this.run(
      "INSERT INTO projects (slug, name, brief, root_path) VALUES (?, ?, ?, ?)",
      slug,
      opts.name ?? slug,
      opts.brief ?? "",
      opts.root_path ?? null,
    );
    const id = Number(r.lastInsertRowid);
    this.run(
      "INSERT INTO participants (project_id, name, kind, role) VALUES (?, ?, 'human', 'supervizor')",
      id,
      this.config.humanName,
    );
    return this.one<Project>("SELECT * FROM projects WHERE id = ?", id)!;
  }

  getProject(slug: string): Project {
    const p = this.one<Project>("SELECT * FROM projects WHERE slug = ?", slug);
    if (!p) throw new HubError(404, "project_not_found", `Projekt "${slug}" neexistuje.`);
    return p;
  }

  updateProject(by: Participant, patch: { name?: string; brief?: string; root_path?: string | null }): Project {
    this.requireHuman(by, "měnit zadání projektu");
    const p = this.one<Project>("SELECT * FROM projects WHERE id = ?", by.project_id)!;
    this.run(
      "UPDATE projects SET name = ?, brief = ?, root_path = ? WHERE id = ?",
      patch.name ?? p.name,
      patch.brief ?? p.brief,
      patch.root_path === undefined ? p.root_path : patch.root_path,
      p.id,
    );
    return this.one<Project>("SELECT * FROM projects WHERE id = ?", p.id)!;
  }

  /** Find or create a participant and mark them as seen. */
  join(projectSlug: string, name: string, kind: ParticipantKind, role?: string): Participant {
    const clean = name.trim();
    if (!/^[\p{L}\p{N}_.-]{1,40}$/u.test(clean)) {
      throw new HubError(400, "bad_name", "Jméno smí obsahovat jen písmena, čísla, _ . - (max 40 znaků, bez mezer).");
    }
    const lower = clean.toLowerCase();
    if (ALL_ALIASES.has(lower) || (kind === "agent" && HUMAN_ALIASES.has(lower))) {
      throw new HubError(400, "reserved_name", `Jméno "${clean}" je rezervované.`);
    }
    const project = this.getProject(projectSlug);
    let p = this.one<Participant>(
      "SELECT * FROM participants WHERE project_id = ? AND name = ?",
      project.id,
      clean,
    );
    if (p && p.kind !== kind) {
      throw new HubError(409, "name_taken", `Jméno "${clean}" už používá ${p.kind === "human" ? "člověk" : "agent"}.`);
    }
    if (!p) {
      const r = this.run(
        "INSERT INTO participants (project_id, name, kind, role, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        project.id,
        clean,
        kind,
        role ?? "",
        now(),
      );
      p = this.one<Participant>("SELECT * FROM participants WHERE id = ?", Number(r.lastInsertRowid))!;
      this.emit(project.id, "participant", this.participantView(p));
    } else {
      this.run(
        "UPDATE participants SET last_seen_at = ?, role = CASE WHEN ? = '' THEN role ELSE ? END WHERE id = ?",
        now(),
        role ?? "",
        role ?? "",
        p.id,
      );
      p = this.one<Participant>("SELECT * FROM participants WHERE id = ?", p.id)!;
    }
    return p;
  }

  setStatus(by: Participant, text: string): Participant {
    this.run("UPDATE participants SET status_text = ?, last_seen_at = ? WHERE id = ?", text.slice(0, 200), now(), by.id);
    const p = this.one<Participant>("SELECT * FROM participants WHERE id = ?", by.id)!;
    this.emit(by.project_id, "participant", this.participantView(p));
    return p;
  }

  participantView(p: Participant) {
    const online =
      p.kind === "human" ||
      (p.last_seen_at !== null && Date.now() - Date.parse(p.last_seen_at) < this.config.onlineSeconds * 1000);
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      role: p.role,
      status_text: p.status_text,
      last_seen_at: p.last_seen_at,
      online,
    };
  }

  listParticipants(projectId: number) {
    return this.all<Participant>("SELECT * FROM participants WHERE project_id = ? ORDER BY kind DESC, name", projectId).map(
      (p) => this.participantView(p),
    );
  }

  private nameOf(id: number | null): string | null {
    if (id === null) return null;
    return this.one<{ name: string }>("SELECT name FROM participants WHERE id = ?", id)?.name ?? null;
  }

  private requireHuman(by: Participant, what: string) {
    if (by.kind !== "human") throw new HubError(403, "human_only", `Jen člověk může ${what}.`);
  }

  private humans(projectId: number): Participant[] {
    return this.all<Participant>("SELECT * FROM participants WHERE project_id = ? AND kind = 'human'", projectId);
  }

  /** Resolve a name or alias to participants. Returns [] for unknown names. */
  private resolveName(projectId: number, name: string): Participant[] {
    const n = name.replace(/^@/, "").trim();
    const lower = n.toLowerCase();
    if (HUMAN_ALIASES.has(lower)) return this.humans(projectId);
    if (ALL_ALIASES.has(lower)) return this.all<Participant>("SELECT * FROM participants WHERE project_id = ?", projectId);
    const p = this.one<Participant>("SELECT * FROM participants WHERE project_id = ? AND name = ?", projectId, n);
    return p ? [p] : [];
  }

  // ---------------------------------------------------------------- threads

  private threadRow(id: number): Thread {
    const t = this.one<Thread>("SELECT * FROM threads WHERE id = ?", id);
    if (!t) throw new HubError(404, "thread_not_found", `Vlákno T${id} neexistuje.`);
    return t;
  }

  private threadInProject(id: number, projectId: number): Thread {
    const t = this.threadRow(id);
    if (t.project_id !== projectId) throw new HubError(404, "thread_not_found", `Vlákno T${id} neexistuje.`);
    return t;
  }

  createThread(by: Participant, input: { title: string; body?: string; parent_id?: number | null; mentions?: string[] }) {
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new HubError(400, "bad_title", "Vlákno musí mít název.");
    if (input.parent_id) this.threadInProject(input.parent_id, by.project_id);
    const r = this.run(
      "INSERT INTO threads (project_id, parent_id, title, created_by) VALUES (?, ?, ?, ?)",
      by.project_id,
      input.parent_id ?? null,
      title,
      by.id,
    );
    const id = Number(r.lastInsertRowid);
    const thread = this.threadRow(id);
    this.emit(by.project_id, "thread", thread);
    let first: PostResult | null = null;
    if (input.body?.trim()) {
      first = this.post(by, id, { body: input.body, mentions: input.mentions });
    }
    return { thread: first?.thread ?? thread, message: first?.message ?? null, warnings: first?.warnings ?? [] };
  }

  listThreads(projectId: number, status?: ThreadStatus) {
    const rows = this.all<Thread & { message_count: number; last_message_at: string | null; open_questions: number }>(
      `SELECT t.*,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT MAX(created_at) FROM messages m WHERE m.thread_id = t.id) AS last_message_at,
              (SELECT COUNT(*) FROM questions q WHERE q.thread_id = t.id AND q.status = 'open') AS open_questions
         FROM threads t
        WHERE t.project_id = ? ${status ? "AND t.status = ?" : ""}
        ORDER BY CASE t.status WHEN 'human_needed' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, t.updated_at DESC`,
      ...(status ? [projectId, status] : [projectId]),
    );
    return rows;
  }

  getThread(projectId: number, id: number, opts: { since?: number; before?: number; limit?: number } = {}) {
    const thread = this.threadInProject(id, projectId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let rows: Row[];
    if (opts.since !== undefined) {
      rows = this.all<Row>("SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?", id, opts.since, limit);
    } else {
      rows = this.all<Row>(
        `SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ${opts.before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?) ORDER BY id`,
        ...(opts.before ? [id, opts.before, limit] : [id, limit]),
      );
    }
    const total = this.one<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?", id)!.c;
    const questions = this.all<Row>("SELECT * FROM questions WHERE thread_id = ? AND status = 'open'", id).map((q) =>
      this.questionView(q),
    );
    const subthreads = this.all<{ id: number; title: string; status: string }>(
      "SELECT id, title, status FROM threads WHERE parent_id = ?",
      id,
    );
    return { thread, messages: rows.map((r) => this.messageView(r)), total, open_questions: questions, subthreads };
  }

  setThreadStatus(by: Participant, id: number, status: ThreadStatus, reason = ""): Thread {
    const t = this.threadInProject(id, by.project_id);
    if (by.kind === "agent" && t.status === "human_needed" && status !== "human_needed") {
      throw new HubError(423, "waiting_for_human", "Vlákno čeká na člověka – agent ho nemůže znovu otevřít.");
    }
    if (by.kind === "agent" && status === "resolved" && !reason.trim()) {
      throw new HubError(400, "summary_required", "Při uzavření vlákna napiš shrnutí výsledku (reason).");
    }
    this.tx(() => {
      this.run(
        "UPDATE threads SET status = ?, status_reason = ?, updated_at = ?, agent_streak = CASE WHEN ? = 'open' THEN 0 ELSE agent_streak END WHERE id = ?",
        status,
        reason,
        now(),
        status,
        id,
      );
      if (status === "resolved" && reason.trim()) {
        this.run("UPDATE threads SET summary = ? WHERE id = ?", reason.trim(), id);
      }
      const label = { open: "otevřel(a) vlákno znovu", human_needed: "pozastavil(a) vlákno – čeká se na člověka", resolved: "uzavřel(a) vlákno" }[status];
      this.insertSystem(id, `${by.name} ${label}${reason ? `: ${reason}` : ""}`);
    });
    const updated = this.threadRow(id);
    this.emit(by.project_id, "thread", updated);
    return updated;
  }

  setSummary(by: Participant, id: number, summary: string): Thread {
    this.threadInProject(id, by.project_id);
    this.run("UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?", summary.slice(0, 4000), now(), id);
    const t = this.threadRow(id);
    this.emit(by.project_id, "thread", t);
    return t;
  }

  private insertSystem(threadId: number, body: string): Message {
    const r = this.run("INSERT INTO messages (thread_id, author_id, kind, body) VALUES (?, NULL, 'system', ?)", threadId, body);
    const msg = this.messageView(this.one<Row>("SELECT * FROM messages WHERE id = ?", Number(r.lastInsertRowid))!);
    const t = this.threadRow(threadId);
    // emit after commit is fine: listeners only read
    queueMicrotask(() => this.emit(t.project_id, "message", msg));
    return msg;
  }

  // ---------------------------------------------------------------- messages

  messageView(r: Row): Message {
    const authorId = r.author_id === null ? null : Number(r.author_id);
    const author = authorId === null ? null : this.one<Participant>("SELECT * FROM participants WHERE id = ?", authorId);
    const mentionIds = parse<number[]>(r.mentions, []);
    return {
      id: Number(r.id),
      thread_id: Number(r.thread_id),
      author_id: authorId,
      author: author?.name ?? "system",
      author_kind: author?.kind ?? "system",
      kind: r.kind as MessageKind,
      body: String(r.body),
      mentions: mentionIds.map((id) => this.nameOf(id)).filter((n): n is string => n !== null),
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
      evidence: parse<Evidence[]>(r.evidence, []),
      evidence_status: r.evidence_status as Message["evidence_status"],
      confidence: (r.confidence as Confidence | null) ?? null,
      meta: parse<Record<string, unknown>>(r.meta, {}),
      created_at: String(r.created_at),
    };
  }

  private checkRate(by: Participant) {
    if (by.kind !== "agent") return;
    const t = Date.now();
    const list = (this.recentPosts.get(by.id) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= this.config.maxMessagesPerMinute) {
      throw new HubError(
        429,
        "rate_limited",
        `Posíláš příliš mnoho zpráv (${this.config.maxMessagesPerMinute}/min). Zpomal a shrň myšlenky do jedné zprávy.`,
      );
    }
    list.push(t);
    this.recentPosts.set(by.id, list);
  }

  private evidenceLookup(projectId: number) {
    const project = this.one<Project>("SELECT * FROM projects WHERE id = ?", projectId)!;
    return {
      projectRoot: project.root_path,
      messageExists: (id: number) =>
        !!this.one(
          "SELECT 1 FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ? AND t.project_id = ?",
          id,
          projectId,
        ),
      knowledgeStatus: (id: number) =>
        this.one<{ status: Knowledge["status"] }>("SELECT status FROM knowledge WHERE id = ? AND project_id = ?", id, projectId)
          ?.status ?? null,
    };
  }

  /** Validate evidence; throws 422 when something cited does not exist (= likely hallucination). */
  private validateEvidence(projectId: number, kind: string, evidence: Evidence[]) {
    const checks = checkEvidence(evidence, this.evidenceLookup(projectId));
    const bad = checks.filter((c) => c.result === "invalid");
    if (bad.length) {
      throw new HubError(
        422,
        "evidence_invalid",
        "Zpráva odmítnuta: citované důkazy neodpovídají realitě. Ověř fakta (načti soubor / dohledej ID) a pošli znovu.\n" +
          bad.map((b) => `- ${b.note}`).join("\n"),
        bad,
      );
    }
    return { checks, status: overallStatus(kind, checks) };
  }

  /** Post a message. All anti-loop and anti-hallucination guards live here. */
  post(by: Participant, threadId: number, input: PostInput): PostResult {
    const kind: MessageKind = input.kind ?? "chat";
    if (kind === "system") throw new HubError(400, "bad_kind", "Systémové zprávy posílá jen hub.");
    const body = input.body.trim();
    if (!body) throw new HubError(400, "empty", "Prázdná zpráva.");
    if (body.length > 20_000) {
      throw new HubError(413, "too_long", "Zpráva je moc dlouhá (max 20 000 znaků). Pošli odkaz na soubor místo obsahu.");
    }
    const thread = this.threadInProject(threadId, by.project_id);

    if (by.kind === "agent") {
      if (thread.status === "human_needed") {
        throw new HubError(
          423,
          "waiting_for_human",
          `Vlákno T${threadId} je pozastavené a čeká na člověka (${thread.status_reason || "bez důvodu"}). Nepiš sem, dokud neodpoví – mezitím dělej něco jiného nebo použij wait_for_activity.`,
        );
      }
      // Repetition guard: refuse near-duplicates of the agent's own recent messages.
      const recent = this.all<{ body: string; id: number }>(
        "SELECT id, body FROM messages WHERE thread_id = ? AND author_id = ? ORDER BY id DESC LIMIT ?",
        threadId,
        by.id,
        this.config.repeatWindow,
      );
      const fp = fingerprint(body);
      if (fp.size >= 4) {
        const dup = recent.find((m) => similarity(fp, fingerprint(m.body)) >= 0.85);
        if (dup) {
          throw new HubError(
            409,
            "repetition",
            `Tuhle zprávu jsi už poslal(a) (M${dup.id}). Neopakuj se – změň přístup, polož otázku nebo eskaluj na člověka.`,
          );
        }
      }
      this.checkRate(by);
    }

    // Mentions: explicit list + @names in the body.
    const warnings: string[] = [];
    const names = new Set<string>(input.mentions ?? []);
    for (const m of body.matchAll(/(?:^|[\s(,])@([\p{L}\p{N}_.-]+)/gu)) names.add(m[1].replace(/[.]+$/, ""));
    const mentionIds = new Set<number>();
    for (const n of names) {
      const found = this.resolveName(by.project_id, n);
      if (found.length === 0) warnings.push(`@${n} není účastník projektu – nikdo takový zprávu nedostane.`);
      for (const p of found) if (p.id !== by.id) mentionIds.add(p.id);
    }

    if (input.reply_to) {
      const ok = this.one("SELECT 1 FROM messages WHERE id = ? AND thread_id = ?", input.reply_to, threadId);
      if (!ok) throw new HubError(400, "bad_reply", `Zpráva M${input.reply_to} v tomto vlákně neexistuje.`);
    }

    const evidence = input.evidence ?? [];
    const validated = this.validateEvidence(by.project_id, kind, evidence);
    const checks = validated.checks;
    // The human is the source of truth – their answers and decisions need no evidence.
    const status = by.kind === "human" && validated.status === "missing" ? "none" : validated.status;
    if (status === "missing") {
      warnings.push(
        `Zpráva typu "${kind}" nemá žádný důkaz – v UI je označena jako neověřená. Příště přilož evidence (soubor+citace, ID zprávy, výstup příkazu).`,
      );
    }

    const result = this.tx(() => {
      const r = this.run(
        `INSERT INTO messages (thread_id, author_id, kind, body, mentions, reply_to, evidence, evidence_status, confidence, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        threadId,
        by.id,
        kind,
        body,
        json([...mentionIds]),
        input.reply_to ?? null,
        json(evidence),
        status,
        input.confidence ?? null,
        json(input.meta ?? {}),
      );
      const id = Number(r.lastInsertRowid);
      let newStatus: ThreadStatus = thread.status;
      let streak = thread.agent_streak;
      let systemNote: string | null = null;

      if (by.kind === "human") {
        streak = 0;
        if (thread.status !== "open") {
          newStatus = "open";
          systemNote = `${by.name} se zapojil(a) – vlákno pokračuje.`;
        }
      } else {
        streak += 1;
        if (thread.status === "resolved") {
          newStatus = "open";
          systemNote = `${by.name} znovu otevřel(a) uzavřené vlákno.`;
        }
        if (streak >= this.config.maxAgentStreak) {
          newStatus = "human_needed";
          systemNote = `Pojistka proti zacyklení: agenti si vyměnili ${streak} zpráv bez člověka. Vlákno je pozastaveno, dokud ${this.config.humanName} neodpoví.`;
        }
      }
      this.run(
        "UPDATE threads SET agent_streak = ?, status = ?, status_reason = CASE WHEN ? != status THEN ? ELSE status_reason END, updated_at = ? WHERE id = ?",
        streak,
        newStatus,
        newStatus,
        newStatus === "human_needed" ? "limit zpráv bez člověka" : "",
        now(),
        threadId,
      );
      this.run("UPDATE participants SET last_seen_at = ? WHERE id = ?", now(), by.id);
      const message = this.messageView(this.one<Row>("SELECT * FROM messages WHERE id = ?", id)!);
      const sys = systemNote ? this.insertSystem(threadId, systemNote) : null;
      return { message, sys };
    });

    const updated = this.threadRow(threadId);
    this.emit(by.project_id, "message", result.message);
    if (updated.status !== thread.status || updated.agent_streak !== thread.agent_streak) {
      this.emit(by.project_id, "thread", updated);
    }
    if (updated.status === "human_needed" && thread.status !== "human_needed") {
      warnings.push("Vlákno bylo pozastaveno pojistkou proti zacyklení – čeká se na člověka.");
    }
    return { message: result.message, warnings, evidence_checks: checks, thread: updated };
  }

  // ---------------------------------------------------------------- knowledge

  knowledgeView(r: Row): Knowledge {
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      kind: r.kind as KnowledgeKind,
      title: String(r.title),
      body: String(r.body),
      tags: String(r.tags),
      evidence: parse<Evidence[]>(r.evidence, []),
      trust: r.trust as Trust,
      status: r.status as Knowledge["status"],
      status_note: String(r.status_note),
      superseded_by: r.superseded_by === null ? null : Number(r.superseded_by),
      author: this.nameOf(r.author_id === null ? null : Number(r.author_id)),
      source_message_id: r.source_message_id === null ? null : Number(r.source_message_id),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  /** Full-text search. Superseded entries are hidden; human-confirmed ones rank first. */
  searchKnowledge(projectId: number, query: string, limit = 8): Knowledge[] {
    const tokens = query
      .normalize("NFC")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 2)
      .slice(0, 12);
    if (tokens.length === 0) {
      return this.all<Row>(
        "SELECT * FROM knowledge WHERE project_id = ? AND status != 'superseded' ORDER BY updated_at DESC LIMIT ?",
        projectId,
        limit,
      ).map((r) => this.knowledgeView(r));
    }
    // Crude stemming for inflected languages like Czech: "databáze" should match "databázi".
    const stem = (t: string) => (t.length >= 6 ? t.slice(0, Math.max(4, t.length - 2)) : t);
    const match = tokens.map((t) => `"${stem(t).replace(/"/g, "")}"*`).join(" OR ");
    const rows = this.all<Row>(
      `SELECT k.* FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ? AND k.project_id = ? AND k.status != 'superseded'
        ORDER BY bm25(knowledge_fts) + CASE k.trust WHEN 'human' THEN -2 WHEN 'evidence' THEN -1 ELSE 0 END
        LIMIT ?`,
      match,
      projectId,
      limit,
    );
    return rows.map((r) => this.knowledgeView(r));
  }

  getKnowledge(projectId: number, id: number): Knowledge {
    const r = this.one<Row>("SELECT * FROM knowledge WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new HubError(404, "knowledge_not_found", `Znalost K${id} neexistuje.`);
    return this.knowledgeView(r);
  }

  addKnowledge(
    by: Participant,
    input: {
      kind: KnowledgeKind;
      title: string;
      body: string;
      tags?: string;
      evidence?: Evidence[];
      source_message_id?: number | null;
      supersedes?: number | null;
    },
  ): Knowledge {
    if (!input.title.trim() || !input.body.trim()) throw new HubError(400, "empty", "Znalost musí mít název i obsah.");
    const evidence = input.evidence ?? [];
    const { status } = this.validateEvidence(by.project_id, "note", evidence);
    if (by.kind === "agent" && input.kind === "decision" && evidence.length === 0) {
      throw new HubError(
        422,
        "evidence_required",
        "Rozhodnutí od agenta musí odkazovat na zdroj (např. zprávu, kde se na tom tým shodl, nebo odpověď člověka).",
      );
    }
    const trust: Trust = by.kind === "human" ? "human" : status === "verified" ? "evidence" : "agent";
    const k = this.tx(() => {
      const r = this.run(
        `INSERT INTO knowledge (project_id, kind, title, body, tags, evidence, trust, author_id, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        by.project_id,
        input.kind,
        input.title.trim().slice(0, 300),
        input.body.trim(),
        (input.tags ?? "").slice(0, 200),
        json(evidence),
        trust,
        by.id,
        input.source_message_id ?? null,
      );
      const id = Number(r.lastInsertRowid);
      if (input.supersedes) {
        const old = this.getKnowledge(by.project_id, input.supersedes);
        if (old.trust === "human" && by.kind === "agent") {
          throw new HubError(403, "human_knowledge", `K${old.id} potvrdil člověk – agent ji nemůže nahradit. Zeptej se člověka.`);
        }
        this.run(
          "UPDATE knowledge SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
          id,
          now(),
          old.id,
        );
      }
      return this.getKnowledge(by.project_id, id);
    });
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  verifyKnowledge(by: Participant, id: number): Knowledge {
    this.requireHuman(by, "potvrdit znalost");
    this.getKnowledge(by.project_id, id);
    this.run("UPDATE knowledge SET trust = 'human', status = 'active', status_note = '', updated_at = ? WHERE id = ?", now(), id);
    const k = this.getKnowledge(by.project_id, id);
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  disputeKnowledge(by: Participant, id: number, reason: string): Knowledge {
    if (!reason.trim()) throw new HubError(400, "reason_required", "Uveď, proč je znalost špatně.");
    const k0 = this.getKnowledge(by.project_id, id);
    if (k0.status === "superseded") throw new HubError(409, "superseded", `K${id} už je nahrazená K${k0.superseded_by}.`);
    this.run(
      "UPDATE knowledge SET status = 'disputed', status_note = ?, updated_at = ? WHERE id = ?",
      `${by.name}: ${reason.trim()}`.slice(0, 1000),
      now(),
      id,
    );
    const k = this.getKnowledge(by.project_id, id);
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  // ---------------------------------------------------------------- questions

  questionView(r: Row): Question {
    const answerBody =
      r.answer_message_id === null || r.answer_message_id === undefined
        ? null
        : (this.one<{ body: string }>("SELECT body FROM messages WHERE id = ?", Number(r.answer_message_id))?.body ?? null);
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      thread_id: Number(r.thread_id),
      message_id: Number(r.message_id),
      asked_by: this.nameOf(Number(r.asked_by)) ?? "?",
      target: this.nameOf(r.target_id === null ? null : Number(r.target_id)),
      body: String(r.body),
      options: parse<string[]>(r.options, []),
      blocking: Number(r.blocking) === 1,
      status: r.status as Question["status"],
      answer: answerBody,
      answered_by: this.nameOf(r.answered_by === null ? null : Number(r.answered_by)),
      answer_message_id: r.answer_message_id === null ? null : Number(r.answer_message_id),
      knowledge_id: r.knowledge_id === null ? null : Number(r.knowledge_id),
      created_at: String(r.created_at),
      answered_at: r.answered_at === null ? null : String(r.answered_at),
    };
  }

  getQuestion(projectId: number, id: number): Question {
    const r = this.one<Row>("SELECT * FROM questions WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new HubError(404, "question_not_found", `Otázka Q${id} neexistuje.`);
    return this.questionView(r);
  }

  listQuestions(projectId: number, opts: { status?: string; for?: Participant } = {}): Question[] {
    const where = ["project_id = ?"];
    const params: SQLInputValue[] = [projectId];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.for) {
      where.push("(target_id = ? OR (target_id IS NULL AND asked_by != ?))");
      params.push(opts.for.id, opts.for.id);
    }
    return this.all<Row>(`SELECT * FROM questions WHERE ${where.join(" AND ")} ORDER BY blocking DESC, id`, ...params).map((r) =>
      this.questionView(r),
    );
  }

  /**
   * Ask a question to a participant, the human, or anyone.
   * Returns similar knowledge so the asker can skip the question if it is already answered.
   */
  ask(
    by: Participant,
    input: { to?: string | null; body: string; thread_id?: number | null; options?: string[]; blocking?: boolean },
  ) {
    const body = input.body.trim();
    if (!body) throw new HubError(400, "empty", "Prázdná otázka.");
    let target: Participant | null = null;
    if (input.to && !ALL_ALIASES.has(input.to.toLowerCase()) && input.to.toLowerCase() !== "anyone") {
      const found = this.resolveName(by.project_id, input.to);
      if (found.length === 0) {
        throw new HubError(
          404,
          "unknown_participant",
          `"${input.to}" není účastník projektu. Dostupní: ${this.listParticipants(by.project_id)
            .map((p) => p.name)
            .join(", ")}`,
        );
      }
      target = found[0];
      if (target.id === by.id) throw new HubError(400, "self_question", "Nemůžeš se ptát sám sebe.");
    }
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
    const similar = this.searchKnowledge(by.project_id, body, 3);

    let threadId = input.thread_id ?? null;
    if (!threadId) {
      threadId = this.createThread(by, { title: `Otázka: ${body.slice(0, 80)}` }).thread.id;
    }
    const text =
      (target ? `@${target.name} ` : "") +
      body +
      (options.length ? "\n" + options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("\n") : "");
    const posted = this.post(by, threadId, { kind: "question", body: text });
    const r = this.run(
      `INSERT INTO questions (project_id, thread_id, message_id, asked_by, target_id, body, options, blocking)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      by.project_id,
      threadId,
      posted.message.id,
      by.id,
      target?.id ?? null,
      body,
      json(options),
      input.blocking ? 1 : 0,
    );
    const qid = Number(r.lastInsertRowid);
    this.run("UPDATE messages SET meta = ? WHERE id = ?", json({ question_id: qid }), posted.message.id);
    const question = this.getQuestion(by.project_id, qid);
    this.emit(by.project_id, "question", question);
    return { question, similar_knowledge: similar, warnings: posted.warnings };
  }

  /**
   * Answer a question. The answer is posted to the thread (mentioning the asker) and stored
   * as shared knowledge – except guesses, which are never stored so they cannot spread.
   */
  answer(
    by: Participant,
    questionId: number,
    input: { body: string; confidence?: Confidence; evidence?: Evidence[]; choice?: string | null },
  ) {
    const q = this.getQuestion(by.project_id, questionId);
    if (q.status !== "open") {
      throw new HubError(409, "not_open", `Otázka Q${q.id} už je ${q.status === "answered" ? `zodpovězená (${q.answered_by})` : "zrušená"}.`);
    }
    if (q.asked_by === by.name) throw new HubError(400, "own_question", "Na vlastní otázku neodpovídej – zruš ji (cancel_question).");
    const confidence: Confidence = by.kind === "human" ? "certain" : (input.confidence ?? "likely");
    let body = input.body.trim();
    if (input.choice) body = `Volba: ${input.choice}${body ? `\n${body}` : ""}`;
    if (!body) throw new HubError(400, "empty", "Prázdná odpověď.");

    // The asker may be paused in a human_needed thread; human answers unpause it via post().
    const posted = this.post(by, q.thread_id, {
      kind: "answer",
      body: `@${q.asked_by} ${body}`,
      reply_to: q.message_id,
      evidence: input.evidence,
      confidence,
      meta: { question_id: q.id },
    });

    let knowledgeId: number | null = null;
    if (confidence !== "guess") {
      const k = this.addKnowledge(by, {
        kind: "answer",
        title: q.body,
        body,
        // Only the answerer's own evidence counts for trust; the source message is linked separately.
        evidence: input.evidence ?? [],
        source_message_id: posted.message.id,
      });
      knowledgeId = k.id;
    }
    this.run(
      "UPDATE questions SET status = 'answered', answer_message_id = ?, answered_by = ?, knowledge_id = ?, answered_at = ? WHERE id = ?",
      posted.message.id,
      by.id,
      knowledgeId,
      now(),
      q.id,
    );
    const question = this.getQuestion(by.project_id, q.id);
    this.emit(by.project_id, "question", question);
    const warnings = [...posted.warnings];
    if (confidence === "guess") warnings.push("Odpověď označená jako odhad se neukládá do sdílené paměti.");
    return { question, message: posted.message, warnings };
  }

  cancelQuestion(by: Participant, questionId: number, reason = "") {
    const q = this.getQuestion(by.project_id, questionId);
    if (q.asked_by !== by.name && by.kind !== "human") {
      throw new HubError(403, "not_owner", "Otázku může zrušit jen ten, kdo ji položil, nebo člověk.");
    }
    if (q.status !== "open") throw new HubError(409, "not_open", `Otázka Q${q.id} už není otevřená.`);
    this.run("UPDATE questions SET status = 'cancelled', answered_at = ? WHERE id = ?", now(), q.id);
    this.insertSystem(q.thread_id, `${by.name} zrušil(a) otázku Q${q.id}${reason ? `: ${reason}` : ""}`);
    const question = this.getQuestion(by.project_id, q.id);
    this.emit(by.project_id, "question", question);
    return question;
  }

  /** Resolve once the question is answered or cancelled, or after the timeout. */
  waitForAnswer(projectId: number, questionId: number, timeoutMs: number, signal?: AbortSignal): Promise<Question> {
    const q = this.getQuestion(projectId, questionId);
    if (q.status !== "open" || timeoutMs <= 0) return Promise.resolve(q);
    return new Promise((resolveP) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off("event", onEvent);
        signal?.removeEventListener("abort", done);
        resolveP(this.getQuestion(projectId, questionId));
      };
      const onEvent = (e: HubEvent) => {
        if (e.type === "question" && (e.data as Question).id === questionId && (e.data as Question).status !== "open") done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.events.on("event", onEvent);
      signal?.addEventListener("abort", done);
    });
  }

  // ---------------------------------------------------------------- claims (file locks)

  private claimView(r: Row): Claim {
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      path: String(r.path),
      holder_id: Number(r.holder_id),
      holder: this.nameOf(Number(r.holder_id)) ?? "?",
      reason: String(r.reason),
      thread_id: r.thread_id === null ? null : Number(r.thread_id),
      expires_at: String(r.expires_at),
      created_at: String(r.created_at),
    };
  }

  listClaims(projectId: number): Claim[] {
    this.run("DELETE FROM claims WHERE expires_at <= ?", now());
    return this.all<Row>("SELECT * FROM claims WHERE project_id = ? ORDER BY path", projectId).map((r) => this.claimView(r));
  }

  checkPaths(projectId: number, paths: string[], exceptHolder?: number) {
    const active = this.listClaims(projectId);
    const conflicts: Claim[] = [];
    for (const raw of paths) {
      const p = normalizePath(raw);
      for (const c of active) if (c.holder_id !== exceptHolder && pathsOverlap(p, c.path)) conflicts.push(c);
    }
    return conflicts.filter((c, i) => conflicts.findIndex((x) => x.id === c.id) === i);
  }

  /**
   * Claim paths for editing. Non-conflicting paths are granted, conflicting ones are reported
   * with the holder and reason so the agent can ask them instead of overwriting their work.
   */
  claim(by: Participant, input: { paths: string[]; reason?: string; minutes?: number; thread_id?: number | null }) {
    const minutes = Math.min(Math.max(input.minutes ?? this.config.defaultClaimMinutes, 1), 240);
    const expires = new Date(Date.now() + minutes * 60_000).toISOString();
    const granted: string[] = [];
    const conflicts: Claim[] = [];
    this.tx(() => {
      for (const raw of input.paths) {
        const p = normalizePath(raw);
        if (!p) continue;
        const c = this.checkPaths(by.project_id, [p], by.id);
        if (c.length) {
          conflicts.push(...c);
          continue;
        }
        const mine = this.one<{ id: number }>(
          "SELECT id FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?",
          by.project_id,
          by.id,
          p,
        );
        if (mine) {
          this.run("UPDATE claims SET expires_at = ?, reason = ? WHERE id = ?", expires, input.reason ?? "", mine.id);
        } else {
          this.run(
            "INSERT INTO claims (project_id, path, holder_id, reason, thread_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            by.project_id,
            p,
            by.id,
            input.reason ?? "",
            input.thread_id ?? null,
            expires,
          );
        }
        granted.push(p);
      }
    });
    if (granted.length) this.emit(by.project_id, "claim", { holder: by.name, granted });
    return { granted, conflicts, expires_at: expires };
  }

  release(by: Participant, paths?: string[]) {
    let n = 0;
    if (!paths || paths.length === 0) {
      n = Number(this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ?", by.project_id, by.id).changes);
    } else {
      for (const raw of paths) {
        n += Number(
          this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?", by.project_id, by.id, normalizePath(raw))
            .changes,
        );
      }
    }
    this.emit(by.project_id, "claim", { holder: by.name, released: n });
    return { released: n };
  }

  // ---------------------------------------------------------------- tasks

  private taskView(r: Row): Task {
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      thread_id: r.thread_id === null ? null : Number(r.thread_id),
      title: String(r.title),
      details: String(r.details),
      status: r.status as TaskStatus,
      assignee: this.nameOf(r.assignee_id === null ? null : Number(r.assignee_id)),
      created_by: this.nameOf(r.created_by === null ? null : Number(r.created_by)),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  getTask(projectId: number, id: number): Task {
    const r = this.one<Row>("SELECT * FROM tasks WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new HubError(404, "task_not_found", `Úkol #${id} neexistuje.`);
    return this.taskView(r);
  }

  listTasks(projectId: number, opts: { status?: string; assignee?: Participant } = {}): Task[] {
    const where = ["project_id = ?"];
    const params: SQLInputValue[] = [projectId];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.assignee) {
      where.push("assignee_id = ?");
      params.push(opts.assignee.id);
    }
    return this.all<Row>(
      `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END, id`,
      ...params,
    ).map((r) => this.taskView(r));
  }

  createTask(by: Participant, input: { title: string; details?: string; assignee?: string | null; thread_id?: number | null }) {
    if (!input.title.trim()) throw new HubError(400, "empty", "Úkol musí mít název.");
    let assigneeId: number | null = null;
    if (input.assignee) {
      const found = this.resolveName(by.project_id, input.assignee);
      if (!found.length) throw new HubError(404, "unknown_participant", `"${input.assignee}" není účastník projektu.`);
      assigneeId = found[0].id;
    }
    if (input.thread_id) this.threadInProject(input.thread_id, by.project_id);
    const r = this.run(
      "INSERT INTO tasks (project_id, thread_id, title, details, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      by.project_id,
      input.thread_id ?? null,
      input.title.trim().slice(0, 200),
      input.details ?? "",
      assigneeId,
      by.id,
    );
    const t = this.getTask(by.project_id, Number(r.lastInsertRowid));
    this.emit(by.project_id, "task", t);
    return t;
  }

  /** Update a task. Taking a task someone else is actively working on is refused. */
  updateTask(by: Participant, id: number, patch: { status?: TaskStatus; assignee?: string | null; details?: string; take?: boolean }) {
    const r = this.one<Row>("SELECT * FROM tasks WHERE id = ? AND project_id = ?", id, by.project_id);
    if (!r) throw new HubError(404, "task_not_found", `Úkol #${id} neexistuje.`);
    let assigneeId = r.assignee_id === null ? null : Number(r.assignee_id);
    if (patch.take) {
      if (assigneeId !== null && assigneeId !== by.id && (r.status === "doing" || r.status === "review")) {
        throw new HubError(
          409,
          "task_taken",
          `Úkol #${id} právě dělá ${this.nameOf(assigneeId)}. Domluv se s ním/ní, než ho převezmeš.`,
        );
      }
      assigneeId = by.id;
    } else if (patch.assignee !== undefined) {
      if (patch.assignee === null) assigneeId = null;
      else {
        const found = this.resolveName(by.project_id, patch.assignee);
        if (!found.length) throw new HubError(404, "unknown_participant", `"${patch.assignee}" není účastník projektu.`);
        assigneeId = found[0].id;
      }
    }
    let status = (patch.status ?? (patch.take && r.status === "todo" ? "doing" : r.status)) as TaskStatus;
    if (status === "done" && by.kind === "agent" && r.status !== "review" && assigneeId === by.id) {
      // Self-approval is the most common source of unnoticed mistakes.
      throw new HubError(
        409,
        "review_required",
        `Úkol #${id} nejdřív přepni do stavu "review" a nech ho zkontrolovat jiným agentem nebo člověkem.`,
      );
    }
    if (status === "done" && by.kind === "agent" && r.status === "review" && assigneeId === by.id) {
      throw new HubError(409, "self_review", "Vlastní práci nemůžeš schválit. Schválit musí jiný agent nebo člověk.");
    }
    this.run(
      "UPDATE tasks SET status = ?, assignee_id = ?, details = ?, updated_at = ? WHERE id = ?",
      status,
      assigneeId,
      patch.details ?? String(r.details),
      now(),
      id,
    );
    const t = this.getTask(by.project_id, id);
    this.emit(by.project_id, "task", t);
    return t;
  }

  // ---------------------------------------------------------------- handoff

  handoff(
    by: Participant,
    input: {
      thread_id: number;
      to?: string | null;
      summary: string;
      done?: string[];
      next?: string[];
      risks?: string[];
      evidence?: Evidence[];
    },
  ) {
    const lines = [input.to ? `@${input.to} předávám:` : "Předávka:", input.summary.trim()];
    if (input.done?.length) lines.push("", "Hotovo:", ...input.done.map((d) => `- ${d}`));
    if (input.next?.length) lines.push("", "Další kroky:", ...input.next.map((d) => `- ${d}`));
    if (input.risks?.length) lines.push("", "Rizika / nejistoty:", ...input.risks.map((d) => `- ${d}`));
    return this.post(by, input.thread_id, {
      kind: "handoff",
      body: lines.join("\n"),
      evidence: input.evidence,
      meta: { done: input.done ?? [], next: input.next ?? [], risks: input.risks ?? [] },
    });
  }

  // ---------------------------------------------------------------- inbox

  /** Threads this participant takes part in (created, posted, or was mentioned in). */
  private myThreadIds(p: Participant, upToMessageId = Number.MAX_SAFE_INTEGER): Set<number> {
    const rows = this.all<{ id: number }>(
      `SELECT id FROM threads WHERE created_by = ? AND project_id = ?
       UNION SELECT DISTINCT thread_id FROM messages WHERE author_id = ? AND id <= ?
       UNION SELECT DISTINCT m.thread_id FROM messages m, json_each(m.mentions) j WHERE j.value = ? AND m.id <= ?`,
      p.id,
      p.project_id,
      p.id,
      upToMessageId,
      p.id,
      upToMessageId,
    );
    return new Set(rows.map((r) => Number(r.id)));
  }

  private isRelevant(p: Participant, m: Message, mine: Set<number>): boolean {
    if (m.author_id === p.id) return false;
    if (p.kind === "human") return true;
    if (m.mentions.includes(p.name)) return true;
    if (m.author_kind === "human") return true;
    if (m.kind === "decision") return true;
    return mine.has(m.thread_id);
  }

  /**
   * Everything new and relevant since the participant's cursor, in one call.
   * This is how agents stay in sync cheaply: they never need to re-read whole threads.
   */
  inbox(p: Participant, opts: { peek?: boolean } = {}) {
    const fresh = this.one<Participant>("SELECT * FROM participants WHERE id = ?", p.id)!;
    const cursor = fresh.inbox_cursor;
    // Thread membership is evaluated chronologically: being mentioned later in a thread
    // does not make its earlier messages "new for you".
    const mine = this.myThreadIds(fresh, cursor);
    const rows = this.all<Row>(
      `SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.project_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`,
      fresh.project_id,
      cursor,
    );
    const relevant: Message[] = [];
    let lastScanned = cursor;
    let truncated = false;
    for (const r of rows) {
      const m = this.messageView(r);
      if (m.author_id === fresh.id || m.mentions.includes(fresh.name)) mine.add(m.thread_id);
      if (this.isRelevant(fresh, m, mine)) {
        if (relevant.length >= this.config.inboxLimit) {
          truncated = true;
          break;
        }
        relevant.push(m);
      }
      lastScanned = m.id;
    }
    if (!truncated && rows.length === 500) truncated = true;
    const newThreads = this.all<{ id: number; title: string; created_by: number | null }>(
      `SELECT t.id, t.title, t.created_by FROM threads t
        WHERE t.project_id = ? AND t.created_by != ?
          AND (SELECT MIN(id) FROM messages WHERE thread_id = t.id) > ?`,
      fresh.project_id,
      fresh.id,
      cursor,
    ).map((t) => ({ id: t.id, title: t.title, by: this.nameOf(t.created_by) }));

    if (!opts.peek) {
      this.run("UPDATE participants SET inbox_cursor = ?, last_seen_at = ? WHERE id = ?", lastScanned, now(), fresh.id);
    }
    const questionsForMe = this.listQuestions(fresh.project_id, { status: "open", for: fresh });
    const myQuestions = this.all<Row>(
      "SELECT * FROM questions WHERE asked_by = ? AND (status = 'open' OR answered_at > (SELECT COALESCE(MAX(created_at), '') FROM messages WHERE id = ?)) ORDER BY id DESC LIMIT 20",
      fresh.id,
      cursor,
    ).map((r) => this.questionView(r));
    const pausedThreads = this.all<Thread>(
      "SELECT * FROM threads WHERE project_id = ? AND status = 'human_needed'",
      fresh.project_id,
    ).filter((t) => fresh.kind === "human" || mine.has(t.id));
    const claims = this.listClaims(fresh.project_id);

    return {
      me: this.participantView(fresh),
      cursor: { from: cursor, to: opts.peek ? cursor : lastScanned },
      messages: relevant,
      more: truncated,
      new_threads: newThreads,
      questions_for_me: questionsForMe,
      my_questions: myQuestions,
      paused_threads: pausedThreads.map((t) => ({ id: t.id, title: t.title, reason: t.status_reason })),
      my_tasks: this.listTasks(fresh.project_id, { assignee: fresh }).filter((t) => t.status !== "done"),
      my_claims: claims.filter((c) => c.holder_id === fresh.id),
      others_claims: claims.filter((c) => c.holder_id !== fresh.id),
    };
  }

  /** Resolve when something relevant for the participant happens, or after the timeout. */
  waitForActivity(p: Participant, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const peek = this.inbox(p, { peek: true });
    if (peek.messages.length || peek.questions_for_me.length) return Promise.resolve(true);
    return new Promise((resolveP) => {
      let mine = this.myThreadIds(p);
      const finish = (v: boolean) => {
        clearTimeout(timer);
        this.events.off("event", onEvent);
        signal?.removeEventListener("abort", onAbort);
        resolveP(v);
      };
      const onAbort = () => finish(false);
      const onEvent = (e: HubEvent) => {
        if (e.projectId !== p.project_id) return;
        if (e.type === "message") {
          mine = this.myThreadIds(p);
          if (this.isRelevant(p, e.data as Message, mine)) finish(true);
        } else if (e.type === "question") {
          const q = e.data as Question;
          if (q.status === "open" && q.asked_by !== p.name && (q.target === null || q.target === p.name)) finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.events.on("event", onEvent);
      signal?.addEventListener("abort", onAbort);
    });
  }

  /** Snapshot for the web UI. */
  state(projectId: number) {
    const project = this.one<Project>("SELECT * FROM projects WHERE id = ?", projectId)!;
    return {
      project,
      config: { maxAgentStreak: this.config.maxAgentStreak, humanName: this.config.humanName },
      participants: this.listParticipants(projectId),
      threads: this.listThreads(projectId),
      questions: this.listQuestions(projectId, { status: "open" }),
      claims: this.listClaims(projectId),
      tasks: this.listTasks(projectId),
      knowledge: this.all<Row>(
        "SELECT * FROM knowledge WHERE project_id = ? AND status != 'superseded' ORDER BY updated_at DESC LIMIT 50",
        projectId,
      ).map((r) => this.knowledgeView(r)),
    };
  }
}
