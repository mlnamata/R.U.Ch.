import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
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
  /** Rooms without any activity for this many days are deleted (0 = never). */
  roomTtlDays: number;
  /** Self-hosted only: local checkout the hub can read to verify file evidence. */
  projectRoot: string | null;
}

export const DEFAULT_CONFIG: HubConfig = {
  maxAgentStreak: 12,
  maxMessagesPerMinute: 20,
  repeatWindow: 6,
  defaultClaimMinutes: 30,
  onlineSeconds: 120,
  humanName: "Supervizor",
  inboxLimit: 40,
  roomTtlDays: 30,
  projectRoot: null,
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
  if (typeof s !== "string" || s === "" || s === "[]" || s === "{}") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const num = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));

const HUMAN_ALIASES = new Set(["human", "clovek", "člověk", "supervizor", "user"]);
const ALL_ALIASES = new Set(["all", "vsichni", "všichni", "everyone"]);

// ------------------------------------------------------------------ room keys

/** Crockford base32: no I, L, O, U – easy to read aloud and type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encode32 = (bytes: Uint8Array, len: number) => Array.from(bytes.subarray(0, len), (b) => ALPHABET[b & 31]).join("");

/** Normalise a typed key: case-insensitive, separators ignored, O→0, I/L→1. */
export function normalizeKey(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
const hashKey = (key: string) => createHash("sha256").update(normalizeKey(key)).digest("hex");

/** The agent code is derived from the owner key, so the server never stores it in plain text. */
export function deriveAgentCode(ownerKey: string, rotation: number): string {
  const raw = encode32(createHash("sha256").update(`${normalizeKey(ownerKey)}:agent:${rotation}`).digest(), 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// ------------------------------------------------------------------ text helpers

/** Normalise text for repetition detection. */
function fingerprint(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
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

export interface Auth {
  project: Project;
  role: "agent" | "owner";
}

const MSG_SELECT =
  "SELECT m.*, p.name AS author_name, p.kind AS author_kind FROM messages m LEFT JOIN participants p ON p.id = m.author_id";
const Q_SELECT = "SELECT q.*, am.body AS answer_body FROM questions q LEFT JOIN messages am ON am.id = q.answer_message_id";

export class Hub {
  private readonly events = new EventEmitter();
  private readonly stmts = new Map<string, StatementSync>();
  /** id -> name/kind. Participants are never renamed, so the cache never goes stale. */
  private readonly names = new Map<number, { name: string; kind: ParticipantKind }>();
  private readonly recentPosts = new Map<number, number[]>();
  private readonly touched = new Map<number, number>();

  constructor(
    private db: DatabaseSync,
    readonly config: HubConfig = DEFAULT_CONFIG,
  ) {
    this.events.setMaxListeners(0);
  }

  // ---------------------------------------------------------------- db helpers

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.st(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.st(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.st(sql).run(...params);
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

  // ---------------------------------------------------------------- events (one channel per room)

  private emit(projectId: number, type: HubEvent["type"], data: unknown) {
    this.events.emit(`p${projectId}`, { projectId, type, data } satisfies HubEvent);
  }
  subscribe(projectId: number, fn: (e: HubEvent) => void): () => void {
    this.events.on(`p${projectId}`, fn);
    return () => this.events.off(`p${projectId}`, fn);
  }
  listenerCount(projectId: number) {
    return this.events.listenerCount(`p${projectId}`);
  }

  // ---------------------------------------------------------------- rooms

  /** Create a room. Returns the two secrets; only their hashes are stored. */
  createRoom(opts: { name?: string; humanName?: string; brief?: string } = {}) {
    const ownerKey = encode32(randomBytes(24), 24);
    const agentCode = deriveAgentCode(ownerKey, 0);
    const name = (opts.name ?? "").trim().slice(0, 80) || "Nový projekt";
    const r = this.run(
      "INSERT INTO projects (name, brief, agent_key_hash, owner_key_hash) VALUES (?, ?, ?, ?)",
      name,
      (opts.brief ?? "").slice(0, 20_000),
      hashKey(agentCode),
      hashKey(ownerKey),
    );
    const project = this.projectById(Number(r.lastInsertRowid));
    const human = this.join(project.id, opts.humanName?.trim() || this.config.humanName, "human", "supervizor");
    return { project, agentCode, ownerKey, human };
  }

  projectById(id: number): Project {
    const p = this.one<Project>("SELECT id, name, brief, code_rotation, created_at, last_active_at FROM projects WHERE id = ?", id);
    if (!p) throw new HubError(404, "room_not_found", "Místnost neexistuje.");
    return p;
  }

  /** Resolve a key (agent code or owner key) to its room. */
  authenticate(key: string): Auth | null {
    const h = hashKey(key);
    let row = this.one<{ id: number }>("SELECT id FROM projects WHERE agent_key_hash = ?", h);
    let role: Auth["role"] = "agent";
    if (!row) {
      row = this.one<{ id: number }>("SELECT id FROM projects WHERE owner_key_hash = ?", h);
      role = "owner";
    }
    if (!row) return null;
    this.touch(row.id);
    return { project: this.projectById(row.id), role };
  }

  /** Record activity (at most once a minute per room) so active rooms are never cleaned up. */
  private touch(projectId: number) {
    const t = Date.now();
    if ((this.touched.get(projectId) ?? 0) > t - 60_000) return;
    this.touched.set(projectId, t);
    this.run("UPDATE projects SET last_active_at = ? WHERE id = ?", now(), projectId);
  }

  agentCodeFor(ownerKey: string, project: Project) {
    return deriveAgentCode(ownerKey, project.code_rotation);
  }

  /** New agent code; the old one stops working immediately. */
  rotateAgentCode(by: Participant, ownerKey: string): string {
    this.requireHuman(by, "měnit kód místnosti");
    const p = this.projectById(by.project_id);
    const code = deriveAgentCode(ownerKey, p.code_rotation + 1);
    this.run("UPDATE projects SET code_rotation = code_rotation + 1, agent_key_hash = ? WHERE id = ?", hashKey(code), p.id);
    return code;
  }

  updateProject(by: Participant, patch: { name?: string; brief?: string }): Project {
    this.requireHuman(by, "měnit zadání projektu");
    const p = this.projectById(by.project_id);
    this.run(
      "UPDATE projects SET name = ?, brief = ? WHERE id = ?",
      (patch.name ?? p.name).slice(0, 80),
      (patch.brief ?? p.brief).slice(0, 20_000),
      p.id,
    );
    return this.projectById(p.id);
  }

  /** Housekeeping: drop expired claims, old rate-limit entries and inactive rooms. */
  cleanup(): { roomsDeleted: number } {
    this.run("DELETE FROM claims WHERE expires_at <= ?", now());
    const minuteAgo = Date.now() - 60_000;
    for (const [id, list] of this.recentPosts) if (!list.some((t) => t > minuteAgo)) this.recentPosts.delete(id);
    const hourAgo = Date.now() - 3_600_000;
    for (const [id, t] of this.touched) if (t < hourAgo) this.touched.delete(id);
    let roomsDeleted = 0;
    if (this.config.roomTtlDays > 0) {
      const cutoff = new Date(Date.now() - this.config.roomTtlDays * 86_400_000).toISOString();
      roomsDeleted = Number(this.run("DELETE FROM projects WHERE last_active_at < ?", cutoff).changes);
      if (roomsDeleted) this.names.clear();
    }
    return { roomsDeleted };
  }

  // ---------------------------------------------------------------- participants

  join(projectId: number, name: string, kind: ParticipantKind, role?: string): Participant {
    const clean = name.trim();
    if (!/^[\p{L}\p{N}_.-]{1,40}$/u.test(clean)) {
      throw new HubError(400, "bad_name", "Jméno smí obsahovat jen písmena, čísla, _ . - (max 40 znaků, bez mezer).");
    }
    const lower = clean.toLowerCase();
    if (ALL_ALIASES.has(lower) || (kind === "agent" && HUMAN_ALIASES.has(lower))) {
      throw new HubError(400, "reserved_name", `Jméno "${clean}" je rezervované.`);
    }
    let p = this.one<Participant>("SELECT * FROM participants WHERE project_id = ? AND name = ?", projectId, clean);
    if (p && p.kind !== kind) {
      throw new HubError(409, "name_taken", `Jméno "${clean}" už používá ${p.kind === "human" ? "člověk" : "agent"}.`);
    }
    if (!p) {
      const r = this.run(
        "INSERT INTO participants (project_id, name, kind, role, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        projectId,
        clean,
        kind,
        (role ?? "").slice(0, 60),
        now(),
      );
      p = this.one<Participant>("SELECT * FROM participants WHERE id = ?", Number(r.lastInsertRowid))!;
      this.emit(projectId, "participant", this.participantView(p));
    } else if (role && role !== p.role) {
      this.run("UPDATE participants SET role = ? WHERE id = ?", role.slice(0, 60), p.id);
      p.role = role;
    }
    this.names.set(p.id, { name: p.name, kind: p.kind });
    return p;
  }

  /** Mark as seen (cheap: skipped if seen within the last 30 s). */
  seen(p: Participant) {
    if (p.last_seen_at && Date.parse(p.last_seen_at) > Date.now() - 30_000) return;
    p.last_seen_at = now();
    this.run("UPDATE participants SET last_seen_at = ? WHERE id = ?", p.last_seen_at, p.id);
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
    return { id: p.id, name: p.name, kind: p.kind, role: p.role, status_text: p.status_text, last_seen_at: p.last_seen_at, online };
  }

  listParticipants(projectId: number) {
    return this.all<Participant>("SELECT * FROM participants WHERE project_id = ? ORDER BY kind DESC, name", projectId).map((p) =>
      this.participantView(p),
    );
  }

  private who(id: SQLInputValue | undefined): { name: string; kind: ParticipantKind } | null {
    if (id === null || id === undefined) return null;
    const n = Number(id);
    let v = this.names.get(n);
    if (!v) {
      v = this.one<{ name: string; kind: ParticipantKind }>("SELECT name, kind FROM participants WHERE id = ?", n);
      if (!v) return null;
      if (this.names.size > 20_000) this.names.clear();
      this.names.set(n, { name: v.name, kind: v.kind });
    }
    return v;
  }
  private nameOf(id: SQLInputValue | undefined): string | null {
    return this.who(id)?.name ?? null;
  }

  private requireHuman(by: Participant, what: string) {
    if (by.kind !== "human") throw new HubError(403, "human_only", `Jen člověk může ${what}.`);
  }

  private resolveName(projectId: number, name: string): Participant[] {
    const n = name.replace(/^@/, "").trim();
    const lower = n.toLowerCase();
    if (HUMAN_ALIASES.has(lower)) return this.all<Participant>("SELECT * FROM participants WHERE project_id = ? AND kind = 'human'", projectId);
    if (ALL_ALIASES.has(lower)) return this.all<Participant>("SELECT * FROM participants WHERE project_id = ?", projectId);
    const p = this.one<Participant>("SELECT * FROM participants WHERE project_id = ? AND name = ?", projectId, n);
    return p ? [p] : [];
  }

  private addMember(threadId: number, participantId: number, sinceId: number) {
    this.run("INSERT OR IGNORE INTO thread_members (thread_id, participant_id, since_id) VALUES (?, ?, ?)", threadId, participantId, sinceId);
  }

  // ---------------------------------------------------------------- threads

  private threadIn(id: number, projectId: number): Thread {
    const t = this.one<Thread>("SELECT * FROM threads WHERE id = ? AND project_id = ?", id, projectId);
    if (!t) throw new HubError(404, "thread_not_found", `Vlákno T${id} neexistuje.`);
    return t;
  }

  createThread(by: Participant, input: { title: string; body?: string; parent_id?: number | null; mentions?: string[] }) {
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new HubError(400, "bad_title", "Vlákno musí mít název.");
    if (input.parent_id) this.threadIn(input.parent_id, by.project_id);
    const r = this.run(
      "INSERT INTO threads (project_id, parent_id, title, created_by) VALUES (?, ?, ?, ?)",
      by.project_id,
      input.parent_id ?? null,
      title,
      by.id,
    );
    const id = Number(r.lastInsertRowid);
    this.addMember(id, by.id, 0);
    const thread = this.threadIn(id, by.project_id);
    this.emit(by.project_id, "thread", thread);
    let first: PostResult | null = null;
    if (input.body?.trim()) first = this.post(by, id, { body: input.body, mentions: input.mentions });
    return { thread: first?.thread ?? thread, message: first?.message ?? null, warnings: first?.warnings ?? [] };
  }

  listThreads(projectId: number, status?: ThreadStatus) {
    const sql = `SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.thread_id = t.id AND q.status = 'open') AS open_questions
        FROM threads t WHERE t.project_id = ? ${status ? "AND t.status = ?" : ""}
        ORDER BY CASE t.status WHEN 'human_needed' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 200`;
    return this.all<Thread & { open_questions: number }>(sql, ...(status ? [projectId, status] : [projectId]));
  }

  getThread(projectId: number, id: number, opts: { since?: number; before?: number; limit?: number } = {}) {
    const thread = this.threadIn(id, projectId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let rows: Row[];
    if (opts.since !== undefined) {
      rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`, id, opts.since, limit);
    } else if (opts.before) {
      rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, id, opts.before, limit).reverse();
    } else {
      rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT ?`, id, limit).reverse();
    }
    const questions = this.all<Row>(`${Q_SELECT} WHERE q.thread_id = ? AND q.status = 'open'`, id).map((q) => this.questionView(q));
    const subthreads = this.all<{ id: number; title: string; status: string }>("SELECT id, title, status FROM threads WHERE parent_id = ?", id);
    return { thread, messages: rows.map((r) => this.messageView(r)), total: thread.message_count, open_questions: questions, subthreads };
  }

  setThreadStatus(by: Participant, id: number, status: ThreadStatus, reason = ""): Thread {
    const t = this.threadIn(id, by.project_id);
    if (by.kind === "agent" && t.status === "human_needed" && status !== "human_needed") {
      throw new HubError(423, "waiting_for_human", "Vlákno čeká na člověka – agent ho nemůže znovu otevřít.");
    }
    if (by.kind === "agent" && status === "resolved" && !reason.trim()) {
      throw new HubError(400, "summary_required", "Při uzavření vlákna napiš shrnutí výsledku.");
    }
    this.tx(() => {
      this.run(
        "UPDATE threads SET status = ?, status_reason = ?, updated_at = ?, agent_streak = CASE WHEN ? = 'open' THEN 0 ELSE agent_streak END WHERE id = ?",
        status,
        reason.slice(0, 500),
        now(),
        status,
        id,
      );
      if (status === "resolved" && reason.trim()) this.run("UPDATE threads SET summary = ? WHERE id = ?", reason.trim().slice(0, 4000), id);
      const label = { open: "otevřel(a) vlákno znovu", human_needed: "pozastavil(a) vlákno – čeká se na člověka", resolved: "uzavřel(a) vlákno" }[status];
      this.insertSystem(by.project_id, id, `${by.name} ${label}${reason ? `: ${reason}` : ""}`);
    });
    const updated = this.threadIn(id, by.project_id);
    this.emit(by.project_id, "thread", updated);
    return updated;
  }

  setSummary(by: Participant, id: number, summary: string): Thread {
    this.threadIn(id, by.project_id);
    this.run("UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?", summary.slice(0, 4000), now(), id);
    const t = this.threadIn(id, by.project_id);
    this.emit(by.project_id, "thread", t);
    return t;
  }

  private insertSystem(projectId: number, threadId: number, body: string): Message {
    const r = this.run(
      "INSERT INTO messages (project_id, thread_id, author_id, kind, body) VALUES (?, ?, NULL, 'system', ?)",
      projectId,
      threadId,
      body,
    );
    this.run("UPDATE threads SET message_count = message_count + 1 WHERE id = ?", threadId);
    const msg = this.messageView(this.one<Row>(`${MSG_SELECT} WHERE m.id = ?`, Number(r.lastInsertRowid))!);
    queueMicrotask(() => this.emit(projectId, "message", msg));
    return msg;
  }

  // ---------------------------------------------------------------- messages

  messageView(r: Row): Message {
    const mentionIds = parse<number[]>(r.mentions, []);
    return {
      id: Number(r.id),
      thread_id: Number(r.thread_id),
      author_id: num(r.author_id),
      author: (r.author_name as string | null) ?? "system",
      author_kind: (r.author_kind as ParticipantKind | null) ?? "system",
      kind: r.kind as MessageKind,
      body: String(r.body),
      mentions: mentionIds.map((id) => this.nameOf(id)).filter((n): n is string => n !== null),
      reply_to: num(r.reply_to),
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
      throw new HubError(429, "rate_limited", `Posíláš příliš mnoho zpráv (${this.config.maxMessagesPerMinute}/min). Zpomal a shrň myšlenky do jedné zprávy.`);
    }
    list.push(t);
    this.recentPosts.set(by.id, list);
  }

  /** Validate evidence; throws 422 when something cited does not exist (= likely hallucination). */
  private validateEvidence(projectId: number, kind: string, evidence: Evidence[]) {
    const checks = checkEvidence(evidence, {
      projectRoot: this.config.projectRoot,
      messageExists: (id) => !!this.one("SELECT 1 FROM messages WHERE id = ? AND project_id = ?", id, projectId),
      knowledgeStatus: (id) =>
        this.one<{ status: Knowledge["status"] }>("SELECT status FROM knowledge WHERE id = ? AND project_id = ?", id, projectId)?.status ?? null,
    });
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
    if (body.length > 20_000) throw new HubError(413, "too_long", "Zpráva je moc dlouhá (max 20 000 znaků). Pošli odkaz na soubor místo obsahu.");
    const thread = this.threadIn(threadId, by.project_id);

    if (by.kind === "agent") {
      if (thread.status === "human_needed") {
        throw new HubError(
          423,
          "waiting_for_human",
          `Vlákno T${threadId} čeká na člověka (${thread.status_reason || "bez důvodu"}). Nepiš sem, dokud neodpoví – dělej jinou práci nebo počkej.`,
        );
      }
      const recent = this.all<{ body: string; id: number }>(
        "SELECT id, body FROM messages WHERE thread_id = ? AND author_id = ? ORDER BY id DESC LIMIT ?",
        threadId,
        by.id,
        this.config.repeatWindow,
      );
      const fp = fingerprint(body);
      if (fp.size >= 4) {
        const dup = recent.find((m) => similarity(fp, fingerprint(m.body)) >= 0.85);
        if (dup) throw new HubError(409, "repetition", `Tohle jsi už poslal(a) (M${dup.id}). Neopakuj se – změň přístup, zeptej se nebo eskaluj.`);
      }
      this.checkRate(by);
    }

    const warnings: string[] = [];
    const names = new Set<string>(input.mentions ?? []);
    for (const m of body.matchAll(/(?:^|[\s(,])@([\p{L}\p{N}_.-]+)/gu)) names.add(m[1].replace(/[.]+$/, ""));
    const mentionIds = new Set<number>();
    for (const n of names) {
      const found = this.resolveName(by.project_id, n);
      if (found.length === 0) warnings.push(`@${n} není účastník – nikdo takový zprávu nedostane.`);
      for (const p of found) if (p.id !== by.id) mentionIds.add(p.id);
    }

    if (input.reply_to && !this.one("SELECT 1 FROM messages WHERE id = ? AND thread_id = ?", input.reply_to, threadId)) {
      throw new HubError(400, "bad_reply", `Zpráva M${input.reply_to} v tomto vlákně neexistuje.`);
    }

    const evidence = input.evidence ?? [];
    const validated = this.validateEvidence(by.project_id, kind, evidence);
    // The human is the source of truth – their answers and decisions need no evidence.
    const status = by.kind === "human" && validated.status === "missing" ? "none" : validated.status;
    if (status === "missing") warnings.push(`Zpráva typu "${kind}" nemá důkaz – v UI je označena jako neověřená.`);

    let systemNote: string | null = null;
    const message = this.tx(() => {
      const r = this.run(
        `INSERT INTO messages (project_id, thread_id, author_id, kind, body, mentions, reply_to, evidence, evidence_status, confidence, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        by.project_id,
        threadId,
        by.id,
        kind,
        body,
        mentionIds.size ? json([...mentionIds]) : "[]",
        input.reply_to ?? null,
        evidence.length ? json(evidence) : "[]",
        status,
        input.confidence ?? null,
        input.meta ? json(input.meta) : "{}",
      );
      const id = Number(r.lastInsertRowid);
      this.addMember(threadId, by.id, id);
      for (const pid of mentionIds) this.addMember(threadId, pid, id);

      let newStatus: ThreadStatus = thread.status;
      let streak = thread.agent_streak;
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
          systemNote = `Pojistka proti zacyklení: agenti si vyměnili ${streak} zpráv bez člověka. Vlákno čeká na člověka.`;
        }
      }
      this.run(
        `UPDATE threads SET agent_streak = ?, status = ?, message_count = message_count + 1, updated_at = ?,
           status_reason = CASE WHEN ? != status THEN ? ELSE status_reason END WHERE id = ?`,
        streak,
        newStatus,
        now(),
        newStatus,
        newStatus === "human_needed" ? "limit zpráv bez člověka" : "",
        threadId,
      );
      this.seen(by);
      const msg = this.messageView(this.one<Row>(`${MSG_SELECT} WHERE m.id = ?`, id)!);
      if (systemNote) this.insertSystem(by.project_id, threadId, systemNote);
      return msg;
    });

    const updated = this.threadIn(threadId, by.project_id);
    this.emit(by.project_id, "message", message);
    if (updated.status !== thread.status || updated.agent_streak !== thread.agent_streak) this.emit(by.project_id, "thread", updated);
    if (updated.status === "human_needed" && thread.status !== "human_needed") warnings.push("Vlákno bylo pozastaveno pojistkou proti zacyklení – čeká se na člověka.");
    return { message, warnings, evidence_checks: validated.checks, thread: updated };
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
      superseded_by: num(r.superseded_by),
      author: this.nameOf(r.author_id),
      source_message_id: num(r.source_message_id),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  /** Full-text search. Superseded entries are hidden; human-confirmed ones rank first. */
  searchKnowledge(projectId: number, query: string, limit = 8): Knowledge[] {
    limit = Math.min(Math.max(limit, 1), 50);
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
    return this.all<Row>(
      `SELECT k.* FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ? AND k.project_id = ? AND k.status != 'superseded'
        ORDER BY bm25(knowledge_fts) + CASE k.trust WHEN 'human' THEN -2 WHEN 'evidence' THEN -1 ELSE 0 END
        LIMIT ?`,
      match,
      projectId,
      limit,
    ).map((r) => this.knowledgeView(r));
  }

  getKnowledge(projectId: number, id: number): Knowledge {
    const r = this.one<Row>("SELECT * FROM knowledge WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new HubError(404, "knowledge_not_found", `Znalost K${id} neexistuje.`);
    return this.knowledgeView(r);
  }

  addKnowledge(
    by: Participant,
    input: { kind: KnowledgeKind; title: string; body: string; tags?: string; evidence?: Evidence[]; source_message_id?: number | null; supersedes?: number | null },
  ): Knowledge {
    if (!input.title.trim() || !input.body.trim()) throw new HubError(400, "empty", "Znalost musí mít název i obsah.");
    const evidence = input.evidence ?? [];
    const { status } = this.validateEvidence(by.project_id, "note", evidence);
    if (by.kind === "agent" && input.kind === "decision" && evidence.length === 0) {
      throw new HubError(422, "evidence_required", "Rozhodnutí od agenta musí odkazovat na zdroj (např. zprávu, kde se na tom tým shodl, nebo odpověď člověka).");
    }
    const trust: Trust = by.kind === "human" ? "human" : status === "verified" ? "evidence" : "agent";
    const k = this.tx(() => {
      const r = this.run(
        `INSERT INTO knowledge (project_id, kind, title, body, tags, evidence, trust, author_id, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        by.project_id,
        input.kind,
        input.title.trim().slice(0, 300),
        input.body.trim().slice(0, 10_000),
        (input.tags ?? "").slice(0, 200),
        evidence.length ? json(evidence) : "[]",
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
        this.run("UPDATE knowledge SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", id, now(), old.id);
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
    this.run("UPDATE knowledge SET status = 'disputed', status_note = ?, updated_at = ? WHERE id = ?", `${by.name}: ${reason.trim()}`.slice(0, 1000), now(), id);
    const k = this.getKnowledge(by.project_id, id);
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  // ---------------------------------------------------------------- questions

  questionView(r: Row): Question {
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      thread_id: Number(r.thread_id),
      message_id: Number(r.message_id),
      asked_by: this.nameOf(r.asked_by) ?? "?",
      target: this.nameOf(r.target_id),
      body: String(r.body),
      options: parse<string[]>(r.options, []),
      blocking: Number(r.blocking) === 1,
      status: r.status as Question["status"],
      answer: (r.answer_body as string | null) ?? null,
      answered_by: this.nameOf(r.answered_by),
      answer_message_id: num(r.answer_message_id),
      knowledge_id: num(r.knowledge_id),
      created_at: String(r.created_at),
      answered_at: (r.answered_at as string | null) ?? null,
    };
  }

  getQuestion(projectId: number, id: number): Question {
    const r = this.one<Row>(`${Q_SELECT} WHERE q.id = ? AND q.project_id = ?`, id, projectId);
    if (!r) throw new HubError(404, "question_not_found", `Otázka Q${id} neexistuje.`);
    return this.questionView(r);
  }

  listQuestions(projectId: number, opts: { status?: string; for?: Participant } = {}): Question[] {
    const where = ["q.project_id = ?"];
    const params: SQLInputValue[] = [projectId];
    if (opts.status) {
      where.push("q.status = ?");
      params.push(opts.status);
    }
    if (opts.for) {
      where.push("(q.target_id = ? OR (q.target_id IS NULL AND (q.asked_by IS NULL OR q.asked_by != ?)))");
      params.push(opts.for.id, opts.for.id);
    }
    return this.all<Row>(`${Q_SELECT} WHERE ${where.join(" AND ")} ORDER BY q.blocking DESC, q.id LIMIT 100`, ...params).map((r) => this.questionView(r));
  }

  ask(by: Participant, input: { to?: string | null; body: string; thread_id?: number | null; options?: string[]; blocking?: boolean }) {
    const body = input.body.trim();
    if (!body) throw new HubError(400, "empty", "Prázdná otázka.");
    let target: Participant | null = null;
    const to = input.to?.trim();
    if (to && !ALL_ALIASES.has(to.toLowerCase()) && !["anyone", "any", "kdokoli"].includes(to.toLowerCase())) {
      const found = this.resolveName(by.project_id, to);
      if (found.length === 0) {
        throw new HubError(
          404,
          "unknown_participant",
          `"${to}" není účastník. Dostupní: ${this.listParticipants(by.project_id).map((p) => p.name).join(", ")}`,
        );
      }
      target = found[0];
      if (target.id === by.id) throw new HubError(400, "self_question", "Nemůžeš se ptát sám sebe.");
    }
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
    const similar = this.searchKnowledge(by.project_id, body, 3);
    const threadId = input.thread_id ?? this.createThread(by, { title: `Otázka: ${body.slice(0, 80)}` }).thread.id;
    const text =
      (target ? `@${target.name} ` : "") + body + (options.length ? "\n" + options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("\n") : "");
    const posted = this.post(by, threadId, { kind: "question", body: text });
    const r = this.run(
      "INSERT INTO questions (project_id, thread_id, message_id, asked_by, target_id, body, options, blocking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      by.project_id,
      threadId,
      posted.message.id,
      by.id,
      target?.id ?? null,
      body,
      options.length ? json(options) : "[]",
      input.blocking ? 1 : 0,
    );
    const qid = Number(r.lastInsertRowid);
    this.run("UPDATE messages SET meta = ? WHERE id = ?", json({ question_id: qid }), posted.message.id);
    const question = this.getQuestion(by.project_id, qid);
    this.emit(by.project_id, "question", question);
    return { question, similar_knowledge: similar, warnings: posted.warnings };
  }

  /** Answer a question. Stored as shared knowledge – except guesses, so they cannot spread. */
  answer(by: Participant, questionId: number, input: { body: string; confidence?: Confidence; evidence?: Evidence[]; choice?: string | null }) {
    const q = this.getQuestion(by.project_id, questionId);
    if (q.status !== "open") {
      throw new HubError(409, "not_open", `Otázka Q${q.id} už je ${q.status === "answered" ? `zodpovězená (${q.answered_by})` : "zrušená"}.`);
    }
    if (q.asked_by === by.name) throw new HubError(400, "own_question", "Na vlastní otázku neodpovídej – zruš ji.");
    const confidence: Confidence = by.kind === "human" ? "certain" : (input.confidence ?? "likely");
    let body = input.body.trim();
    if (input.choice) body = `Volba: ${input.choice}${body ? `\n${body}` : ""}`;
    if (!body) throw new HubError(400, "empty", "Prázdná odpověď.");
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
      knowledgeId = this.addKnowledge(by, {
        kind: "answer",
        title: q.body,
        body,
        evidence: input.evidence ?? [],
        source_message_id: posted.message.id,
      }).id;
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
    if (confidence === "guess") warnings.push("Odhad se neukládá do sdílené paměti.");
    return { question, message: posted.message, warnings };
  }

  cancelQuestion(by: Participant, questionId: number, reason = "") {
    const q = this.getQuestion(by.project_id, questionId);
    if (q.asked_by !== by.name && by.kind !== "human") throw new HubError(403, "not_owner", "Otázku může zrušit jen ten, kdo ji položil, nebo člověk.");
    if (q.status !== "open") throw new HubError(409, "not_open", `Otázka Q${q.id} už není otevřená.`);
    this.run("UPDATE questions SET status = 'cancelled', answered_at = ? WHERE id = ?", now(), q.id);
    this.insertSystem(by.project_id, q.thread_id, `${by.name} zrušil(a) otázku Q${q.id}${reason ? `: ${reason}` : ""}`);
    const question = this.getQuestion(by.project_id, q.id);
    this.emit(by.project_id, "question", question);
    return question;
  }

  waitForAnswer(projectId: number, questionId: number, timeoutMs: number, signal?: AbortSignal): Promise<Question> {
    const q = this.getQuestion(projectId, questionId);
    if (q.status !== "open" || timeoutMs <= 0) return Promise.resolve(q);
    return new Promise((resolveP) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", done);
        resolveP(this.getQuestion(projectId, questionId));
      };
      const off = this.subscribe(projectId, (e) => {
        if (e.type === "question" && (e.data as Question).id === questionId && (e.data as Question).status !== "open") done();
      });
      const timer = setTimeout(done, timeoutMs);
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
      holder: this.nameOf(r.holder_id) ?? "?",
      reason: String(r.reason),
      thread_id: num(r.thread_id),
      expires_at: String(r.expires_at),
      created_at: String(r.created_at),
    };
  }

  listClaims(projectId: number): Claim[] {
    return this.all<Row>("SELECT * FROM claims WHERE project_id = ? AND expires_at > ? ORDER BY path", projectId, now()).map((r) => this.claimView(r));
  }

  checkPaths(projectId: number, paths: string[], exceptHolder?: number) {
    const active = this.listClaims(projectId);
    const out = new Map<number, Claim>();
    for (const raw of paths) {
      const p = normalizePath(raw);
      for (const c of active) if (c.holder_id !== exceptHolder && pathsOverlap(p, c.path)) out.set(c.id, c);
    }
    return [...out.values()];
  }

  claim(by: Participant, input: { paths: string[]; reason?: string; minutes?: number; thread_id?: number | null }) {
    const minutes = Math.min(Math.max(input.minutes ?? this.config.defaultClaimMinutes, 1), 240);
    const expires = new Date(Date.now() + minutes * 60_000).toISOString();
    const granted: string[] = [];
    const conflicts: Claim[] = [];
    this.tx(() => {
      this.run("DELETE FROM claims WHERE project_id = ? AND expires_at <= ?", by.project_id, now());
      for (const raw of input.paths.slice(0, 100)) {
        const p = normalizePath(raw);
        if (!p) continue;
        const c = this.checkPaths(by.project_id, [p], by.id);
        if (c.length) {
          conflicts.push(...c);
          continue;
        }
        const mine = this.one<{ id: number }>("SELECT id FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?", by.project_id, by.id, p);
        if (mine) this.run("UPDATE claims SET expires_at = ?, reason = ? WHERE id = ?", expires, input.reason ?? "", mine.id);
        else {
          this.run(
            "INSERT INTO claims (project_id, path, holder_id, reason, thread_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            by.project_id,
            p,
            by.id,
            (input.reason ?? "").slice(0, 200),
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
    if (!paths || paths.length === 0) n = Number(this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ?", by.project_id, by.id).changes);
    else {
      for (const raw of paths) {
        n += Number(this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?", by.project_id, by.id, normalizePath(raw)).changes);
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
      thread_id: num(r.thread_id),
      title: String(r.title),
      details: String(r.details),
      status: r.status as TaskStatus,
      assignee: this.nameOf(r.assignee_id),
      created_by: this.nameOf(r.created_by),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  getTask(projectId: number, id: number): Task {
    const r = this.one<Row>("SELECT * FROM tasks WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new HubError(404, "task_not_found", `Úkol #${id} neexistuje.`);
    return this.taskView(r);
  }

  listTasks(projectId: number, opts: { status?: string; assignee?: Participant; openOnly?: boolean } = {}): Task[] {
    const where = ["project_id = ?"];
    const params: SQLInputValue[] = [projectId];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.openOnly) where.push("status != 'done'");
    if (opts.assignee) {
      where.push("assignee_id = ?");
      params.push(opts.assignee.id);
    }
    return this.all<Row>(
      `SELECT * FROM tasks WHERE ${where.join(" AND ")}
       ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END, id LIMIT 200`,
      ...params,
    ).map((r) => this.taskView(r));
  }

  createTask(by: Participant, input: { title: string; details?: string; assignee?: string | null; thread_id?: number | null }) {
    if (!input.title.trim()) throw new HubError(400, "empty", "Úkol musí mít název.");
    let assigneeId: number | null = null;
    if (input.assignee) {
      const found = this.resolveName(by.project_id, input.assignee);
      if (!found.length) throw new HubError(404, "unknown_participant", `"${input.assignee}" není účastník.`);
      assigneeId = found[0].id;
    }
    if (input.thread_id) this.threadIn(input.thread_id, by.project_id);
    const r = this.run(
      "INSERT INTO tasks (project_id, thread_id, title, details, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      by.project_id,
      input.thread_id ?? null,
      input.title.trim().slice(0, 200),
      (input.details ?? "").slice(0, 4000),
      assigneeId,
      by.id,
    );
    const t = this.getTask(by.project_id, Number(r.lastInsertRowid));
    this.emit(by.project_id, "task", t);
    return t;
  }

  updateTask(by: Participant, id: number, patch: { status?: TaskStatus; assignee?: string | null; details?: string; take?: boolean }) {
    const r = this.one<Row>("SELECT * FROM tasks WHERE id = ? AND project_id = ?", id, by.project_id);
    if (!r) throw new HubError(404, "task_not_found", `Úkol #${id} neexistuje.`);
    let assigneeId = num(r.assignee_id);
    if (patch.take) {
      if (assigneeId !== null && assigneeId !== by.id && (r.status === "doing" || r.status === "review")) {
        throw new HubError(409, "task_taken", `Úkol #${id} právě dělá ${this.nameOf(assigneeId)}. Domluv se, než ho převezmeš.`);
      }
      assigneeId = by.id;
    } else if (patch.assignee !== undefined) {
      if (patch.assignee === null) assigneeId = null;
      else {
        const found = this.resolveName(by.project_id, patch.assignee);
        if (!found.length) throw new HubError(404, "unknown_participant", `"${patch.assignee}" není účastník.`);
        assigneeId = found[0].id;
      }
    }
    const status = (patch.status ?? (patch.take && r.status === "todo" ? "doing" : r.status)) as TaskStatus;
    if (status === "done" && by.kind === "agent" && assigneeId === by.id) {
      // Self-approval is the most common source of unnoticed mistakes.
      throw new HubError(
        409,
        r.status === "review" ? "self_review" : "review_required",
        r.status === "review"
          ? "Vlastní práci nemůžeš schválit. Schválit musí jiný agent nebo člověk."
          : `Úkol #${id} nejdřív přepni do "review" a nech ho zkontrolovat jiným agentem nebo člověkem.`,
      );
    }
    this.run(
      "UPDATE tasks SET status = ?, assignee_id = ?, details = ?, updated_at = ? WHERE id = ?",
      status,
      assigneeId,
      (patch.details ?? String(r.details)).slice(0, 4000),
      now(),
      id,
    );
    const t = this.getTask(by.project_id, id);
    this.emit(by.project_id, "task", t);
    return t;
  }

  // ---------------------------------------------------------------- handoff

  handoff(by: Participant, input: { thread_id: number; to?: string | null; summary: string; done?: string[]; next?: string[]; risks?: string[]; evidence?: Evidence[] }) {
    const lines = [input.to ? `@${input.to} předávám:` : "Předávka:", input.summary.trim()];
    if (input.done?.length) lines.push("", "Hotovo:", ...input.done.map((d) => `- ${d}`));
    if (input.next?.length) lines.push("", "Další kroky:", ...input.next.map((d) => `- ${d}`));
    if (input.risks?.length) lines.push("", "Rizika / nejistoty:", ...input.risks.map((d) => `- ${d}`));
    return this.post(by, input.thread_id, { kind: "handoff", body: lines.join("\n"), evidence: input.evidence });
  }

  // ---------------------------------------------------------------- inbox

  private isMember(threadId: number, participantId: number, messageId: number): boolean {
    const r = this.one<{ since_id: number }>("SELECT since_id FROM thread_members WHERE thread_id = ? AND participant_id = ?", threadId, participantId);
    return !!r && r.since_id <= messageId;
  }

  private isRelevant(p: Participant, m: Message): boolean {
    if (m.author_id === p.id) return false;
    if (p.kind === "human" || m.author_kind === "human" || m.kind === "decision" || m.mentions.includes(p.name)) return true;
    return this.isMember(m.thread_id, p.id, m.id);
  }

  /**
   * Everything new and relevant since the participant's cursor, in one indexed query.
   * Relevance: human messages, decisions, and threads the agent takes part in (from the moment it joined them).
   */
  inbox(p: Participant, opts: { peek?: boolean } = {}) {
    const me = this.one<Participant>("SELECT * FROM participants WHERE id = ?", p.id)!;
    const cursor = me.inbox_cursor;
    const limit = this.config.inboxLimit;
    const rows =
      me.kind === "human"
        ? this.all<Row>(
            `${MSG_SELECT} WHERE m.project_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id != ?) ORDER BY m.id LIMIT ?`,
            me.project_id,
            cursor,
            me.id,
            limit + 1,
          )
        : this.all<Row>(
            `${MSG_SELECT}
              WHERE m.project_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id != ?)
                AND (p.kind = 'human' OR m.kind = 'decision'
                     OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.participant_id = ? AND tm.since_id <= m.id))
              ORDER BY m.id LIMIT ?`,
            me.project_id,
            cursor,
            me.id,
            me.id,
            limit + 1,
          );
    const more = rows.length > limit;
    const messages = rows.slice(0, limit).map((r) => this.messageView(r));
    const maxId = this.one<{ m: number | null }>("SELECT MAX(id) AS m FROM messages WHERE project_id = ?", me.project_id)?.m ?? cursor;
    const newCursor = more ? messages[messages.length - 1].id : Math.max(cursor, maxId);

    const newThreads = this.all<{ id: number; title: string; created_by: number | null }>(
      "SELECT id, title, created_by FROM threads WHERE project_id = ? AND id > ? AND (created_by IS NULL OR created_by != ?) ORDER BY id LIMIT 20",
      me.project_id,
      me.thread_cursor,
      me.id,
    ).map((t) => ({ id: t.id, title: t.title, by: this.nameOf(t.created_by) }));
    const maxThread = this.one<{ m: number | null }>("SELECT MAX(id) AS m FROM threads WHERE project_id = ?", me.project_id)?.m ?? 0;

    const myQuestions = this.all<Row>(
      `${Q_SELECT} WHERE q.asked_by = ? AND (q.status = 'open' OR q.answer_message_id > ?) ORDER BY q.id DESC LIMIT 20`,
      me.id,
      cursor,
    ).map((r) => this.questionView(r));

    if (!opts.peek) {
      this.run("UPDATE participants SET inbox_cursor = ?, thread_cursor = ?, last_seen_at = ? WHERE id = ?", newCursor, Math.max(me.thread_cursor, maxThread), now(), me.id);
    }
    const claims = this.listClaims(me.project_id);
    return {
      me: this.participantView(me),
      cursor: { from: cursor, to: opts.peek ? cursor : newCursor },
      messages,
      more,
      new_threads: newThreads,
      questions_for_me: this.listQuestions(me.project_id, { status: "open", for: me }),
      my_questions: myQuestions,
      paused_threads: this.all<{ id: number; title: string; status_reason: string }>(
        `SELECT t.id, t.title, t.status_reason FROM threads t WHERE t.project_id = ? AND t.status = 'human_needed'
           AND (? = 'human' OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.participant_id = ?))`,
        me.project_id,
        me.kind,
        me.id,
      ).map((t) => ({ id: t.id, title: t.title, reason: t.status_reason })),
      my_tasks: this.listTasks(me.project_id, { assignee: me, openOnly: true }),
      my_claims: claims.filter((c) => c.holder_id === me.id),
      others_claims: claims.filter((c) => c.holder_id !== me.id),
    };
  }

  /** Resolve when something relevant for the participant happens, or after the timeout. */
  waitForActivity(p: Participant, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const pending = this.one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages m LEFT JOIN participants a ON a.id = m.author_id
        WHERE m.project_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id != ?)
          AND (? = 'human' OR a.kind = 'human' OR m.kind = 'decision'
               OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.participant_id = ? AND tm.since_id <= m.id))`,
      p.project_id,
      this.one<{ c: number }>("SELECT inbox_cursor AS c FROM participants WHERE id = ?", p.id)!.c,
      p.id,
      p.kind,
      p.id,
    )!.c;
    if (pending > 0 || this.listQuestions(p.project_id, { status: "open", for: p }).length > 0) return Promise.resolve(true);
    return new Promise((resolveP) => {
      const finish = (v: boolean) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", onAbort);
        resolveP(v);
      };
      const onAbort = () => finish(false);
      const off = this.subscribe(p.project_id, (e) => {
        if (e.type === "message" && this.isRelevant(p, e.data as Message)) finish(true);
        else if (e.type === "question") {
          const q = e.data as Question;
          if (q.status === "open" && q.asked_by !== p.name && (q.target === null || q.target === p.name)) finish(true);
        }
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort);
    });
  }

  /** Snapshot for the web UI. */
  state(projectId: number) {
    return {
      project: this.projectById(projectId),
      config: { maxAgentStreak: this.config.maxAgentStreak },
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
