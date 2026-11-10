import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
  /** Per-room caps that keep one room from eating the server. */
  limits: { agents: number; threads: number; messages: number; questions: number; knowledge: number; tasks: number };
}

export const DEFAULT_CONFIG: HubConfig = {
  maxAgentStreak: 12,
  maxMessagesPerMinute: 20,
  repeatWindow: 6,
  defaultClaimMinutes: 30,
  onlineSeconds: 120,
  humanName: "Owner",
  inboxLimit: 40,
  roomTtlDays: 30,
  projectRoot: null,
  limits: { agents: 30, threads: 5_000, messages: 100_000, questions: 10_000, knowledge: 10_000, tasks: 5_000 },
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
type Seq = "seq_thread" | "seq_message" | "seq_question" | "seq_knowledge" | "seq_task";

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
const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v));

const HUMAN_ALIASES = new Set(["human", "owner", "user", "clovek", "člověk", "supervizor"]);
const ALL_ALIASES = new Set(["all", "everyone", "vsichni", "všichni"]);
const ANYONE = new Set(["any", "anyone", "kdokoli"]);

// ------------------------------------------------------------------ keys

/** Crockford base32: no I, L, O, U – easy to read aloud and type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encode32 = (bytes: Uint8Array, len: number) => Array.from(bytes.subarray(0, len), (b) => ALPHABET[b & 31]).join("");

/** Normalise a typed key: case-insensitive, separators ignored, O→0, I/L→1. */
export function normalizeKey(key: string): string {
  return key.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hashKey = (key: string) => sha(normalizeKey(key));

/** The agent code is derived from the owner key, so the server never stores it in plain text. */
export function deriveAgentCode(ownerKey: string, rotation: number): string {
  const raw = encode32(createHash("sha256").update(`${normalizeKey(ownerKey)}:agent:${rotation}`).digest(), 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// ------------------------------------------------------------------ text helpers

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
  /** Room-local number of the message this replies to. */
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

// Public views expose room-local numbers (n) as "id"; internal row ids never leave the hub.
const T_SELECT = "SELECT t.*, pt.n AS parent_n, cp.name AS creator FROM threads t LEFT JOIN threads pt ON pt.id = t.parent_id LEFT JOIN participants cp ON cp.id = t.created_by";
const MSG_SELECT =
  "SELECT m.*, t.n AS thread_n, p.name AS author_name, p.kind AS author_kind FROM messages m JOIN threads t ON t.id = m.thread_id LEFT JOIN participants p ON p.id = m.author_id";
const Q_SELECT =
  "SELECT q.*, t.n AS thread_n, qm.n AS message_n, am.n AS answer_n, am.body AS answer_body FROM questions q JOIN threads t ON t.id = q.thread_id LEFT JOIN messages qm ON qm.id = q.message_id LEFT JOIN messages am ON am.id = q.answer_message_id";
const TASK_SELECT = "SELECT k.*, t.n AS thread_n FROM tasks k LEFT JOIN threads t ON t.id = k.thread_id";
const CLAIM_SELECT = "SELECT c.*, t.n AS thread_n FROM claims c LEFT JOIN threads t ON t.id = c.thread_id";

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
    if (this.db.isTransaction) return fn();
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

  /** Next room-local number; refuses when the room hit its cap. */
  private next(projectId: number, seq: Seq, limit: number, what: string): number {
    const r = this.one<{ v: number }>(`UPDATE projects SET ${seq} = ${seq} + 1 WHERE id = ? AND ${seq} < ? RETURNING ${seq} AS v`, projectId, limit);
    if (!r) throw new HubError(507, "room_full", `This room reached its limit of ${limit} ${what}. Start a new room or ask the owner to clean up.`);
    return r.v;
  }

  // ---------------------------------------------------------------- events (one channel per room)

  private emit(projectId: number, type: HubEvent["type"], data: unknown) {
    this.events.emit(`p${projectId}`, { projectId, type, data } satisfies HubEvent);
  }
  subscribe(projectId: number, fn: (e: HubEvent) => void): () => void {
    this.events.on(`p${projectId}`, fn);
    return () => this.events.off(`p${projectId}`, fn);
  }

  // ---------------------------------------------------------------- rooms

  /** Create a room. Returns the two secrets; only their hashes are stored. */
  createRoom(opts: { name?: string; humanName?: string; brief?: string } = {}) {
    const ownerKey = encode32(randomBytes(24), 24);
    const agentCode = deriveAgentCode(ownerKey, 0);
    const name = (opts.name ?? "").trim().slice(0, 80) || "New project";
    const r = this.run(
      "INSERT INTO projects (name, brief, agent_key_hash, owner_key_hash) VALUES (?, ?, ?, ?)",
      name,
      (opts.brief ?? "").slice(0, 20_000),
      hashKey(agentCode),
      hashKey(ownerKey),
    );
    const project = this.projectById(Number(r.lastInsertRowid));
    const human = this.join(project.id, opts.humanName?.trim() || this.config.humanName, "human", { role: "owner" }).participant;
    this.coordThread(project.id);
    return { project, agentCode, ownerKey, human };
  }

  projectById(id: number): Project {
    const p = this.one<Project>("SELECT id, name, brief, code_rotation, created_at, last_active_at FROM projects WHERE id = ?", id);
    if (!p) throw new HubError(404, "room_not_found", "Room not found.");
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
    this.requireHuman(by, "change the room code");
    const p = this.projectById(by.project_id);
    const code = deriveAgentCode(ownerKey, p.code_rotation + 1);
    this.run("UPDATE projects SET code_rotation = code_rotation + 1, agent_key_hash = ? WHERE id = ?", hashKey(code), p.id);
    return code;
  }

  updateProject(by: Participant, patch: { name?: string; brief?: string }): Project {
    this.requireHuman(by, "edit the project brief");
    const p = this.projectById(by.project_id);
    this.run("UPDATE projects SET name = ?, brief = ? WHERE id = ?", (patch.name ?? p.name).trim().slice(0, 80) || p.name, (patch.brief ?? p.brief).slice(0, 20_000), p.id);
    return this.projectById(p.id);
  }

  /** Permanently delete a room and everything in it (owner only). */
  deleteRoom(by: Participant) {
    this.requireHuman(by, "delete the room");
    this.emit(by.project_id, "thread", { deleted: true });
    this.run("DELETE FROM projects WHERE id = ?", by.project_id);
    this.names.clear();
    return { deleted: true };
  }

  /** Everything in a room as one JSON document (data portability). */
  exportRoom(projectId: number) {
    const p = this.projectById(projectId);
    const threads = this.all<Row>(`${T_SELECT} WHERE t.project_id = ? ORDER BY t.n`, projectId).map((r) => ({
      ...this.threadView(r),
      messages: this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? ORDER BY m.id`, Number(r.id)).map((m) => this.messageView(m)),
    }));
    return {
      format: "ruch-export-1",
      exported_at: now(),
      room: { name: p.name, brief: p.brief, created_at: p.created_at },
      participants: this.listParticipants(projectId),
      threads,
      questions: this.all<Row>(`${Q_SELECT} WHERE q.project_id = ? ORDER BY q.n`, projectId).map((r) => this.questionView(r)),
      knowledge: this.all<Row>("SELECT * FROM knowledge WHERE project_id = ? ORDER BY n", projectId).map((r) => this.knowledgeView(r)),
      tasks: this.all<Row>(`${TASK_SELECT} WHERE k.project_id = ? ORDER BY k.n`, projectId).map((r) => this.taskView(r)),
    };
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

  /** Consistent copy of the whole database; keeps the newest `keep` files. */
  backup(dir: string, keep = 7): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `ruch-${now().replace(/[:T.]/g, "-").replace("Z", "")}.db`);
    this.db.prepare("VACUUM INTO ?").run(file);
    const old = readdirSync(dir)
      .filter((f) => /^ruch-.*\.db$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) unlinkSync(join(dir, f));
    return file;
  }

  /** Operator metrics (no room contents). */
  stats() {
    const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const c = (sql: string, ...p: SQLInputValue[]) => this.one<{ c: number }>(sql, ...p)!.c;
    return {
      rooms: c("SELECT COUNT(*) AS c FROM projects"),
      rooms_active_24h: c("SELECT COUNT(*) AS c FROM projects WHERE last_active_at >= ?", since(1)),
      rooms_active_7d: c("SELECT COUNT(*) AS c FROM projects WHERE last_active_at >= ?", since(7)),
      rooms_created_7d: c("SELECT COUNT(*) AS c FROM projects WHERE created_at >= ?", since(7)),
      agents: c("SELECT COUNT(*) AS c FROM participants WHERE kind = 'agent'"),
      agents_seen_24h: c("SELECT COUNT(*) AS c FROM participants WHERE kind = 'agent' AND last_seen_at >= ?", since(1)),
      messages: c("SELECT COUNT(*) AS c FROM messages"),
      messages_24h: c("SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?", since(1)),
      questions_open: c("SELECT COUNT(*) AS c FROM questions WHERE status = 'open'"),
      knowledge: c("SELECT COUNT(*) AS c FROM knowledge"),
    };
  }

  // ---------------------------------------------------------------- participants

  /**
   * Find or create a participant. Agents that join explicitly (`fresh`) get a secret;
   * once a name has a secret, nobody else can use that name.
   */
  join(projectId: number, name: string, kind: ParticipantKind, opts: { role?: string; fresh?: boolean } = {}): { participant: Participant; secret?: string } {
    const clean = name.trim();
    if (!/^[\p{L}\p{N}_.-]{1,40}$/u.test(clean)) {
      throw new HubError(400, "bad_name", "Name may contain only letters, digits, _ . - (max 40 chars, no spaces).");
    }
    const lower = clean.toLowerCase();
    if (ALL_ALIASES.has(lower) || ANYONE.has(lower) || (kind === "agent" && HUMAN_ALIASES.has(lower))) {
      throw new HubError(400, "reserved_name", `"${clean}" is a reserved name.`);
    }
    let p = this.one<Participant>("SELECT * FROM participants WHERE project_id = ? AND name = ?", projectId, clean);
    if (p && p.kind !== kind) throw new HubError(409, "name_taken", `"${clean}" is already used by ${p.kind === "human" ? "a human" : "an agent"}. Pick another name.`);
    let secret: string | undefined;
    if (!p) {
      if (kind === "agent") {
        const count = this.one<{ c: number }>("SELECT COUNT(*) AS c FROM participants WHERE project_id = ? AND kind = 'agent'", projectId)!.c;
        if (count >= this.config.limits.agents) throw new HubError(507, "room_full", `This room already has ${count} agents (limit).`);
      }
      if (kind === "agent" && opts.fresh) secret = encode32(randomBytes(20), 20);
      const r = this.run(
        "INSERT INTO participants (project_id, name, kind, role, secret_hash, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        projectId,
        clean,
        kind,
        (opts.role ?? "").slice(0, 60),
        secret ? sha(secret) : null,
        now(),
      );
      p = this.one<Participant>("SELECT * FROM participants WHERE id = ?", Number(r.lastInsertRowid))!;
      // Everyone follows the coordination thread from the moment they join.
      const coord = this.one<{ coord_thread_id: number | null }>("SELECT coord_thread_id FROM projects WHERE id = ?", projectId)?.coord_thread_id;
      if (coord) {
        const last = this.one<{ m: number | null }>("SELECT MAX(id) AS m FROM messages WHERE project_id = ?", projectId)?.m ?? 0;
        this.addMember(coord, p.id, last + 1);
      }
      // Threads that existed before joining are not "new" for this participant.
      this.run("UPDATE participants SET thread_cursor = (SELECT COALESCE(MAX(id), 0) FROM threads WHERE project_id = ?) WHERE id = ?", projectId, p.id);
      p.thread_cursor = this.one<{ c: number }>("SELECT thread_cursor AS c FROM participants WHERE id = ?", p.id)!.c;
      this.emit(projectId, "participant", this.participantView(p));
    } else if (kind === "agent" && opts.fresh) {
      const active = p.last_seen_at !== null && Date.parse(p.last_seen_at) > Date.now() - 10 * 60_000;
      if (p.secret_hash || active) throw new HubError(409, "name_in_use", `Another agent already uses the name "${clean}" in this room. Pick a different name.`);
      secret = encode32(randomBytes(20), 20);
      this.run("UPDATE participants SET secret_hash = ? WHERE id = ?", sha(secret), p.id);
      p.secret_hash = sha(secret);
    }
    if (opts.role && opts.role !== p.role) {
      this.run("UPDATE participants SET role = ? WHERE id = ?", opts.role.slice(0, 60), p.id);
      p.role = opts.role;
    }
    this.names.set(p.id, { name: p.name, kind: p.kind });
    return { participant: p, secret };
  }

  /** Identify the caller of a request. A name protected by a secret needs that secret. */
  identify(projectId: number, name: string, kind: ParticipantKind, secret: string | null): Participant {
    const existing = this.one<Participant>("SELECT * FROM participants WHERE project_id = ? AND name = ?", projectId, name.trim());
    if (existing?.secret_hash && (!secret || sha(secret) !== existing.secret_hash)) {
      throw new HubError(401, "name_owned", `The name "${existing.name}" belongs to another agent in this room. Join with your own name.`);
    }
    const p = existing && existing.kind === kind ? existing : this.join(projectId, name, kind).participant;
    this.seen(p);
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
    const online = p.kind === "human" || (p.last_seen_at !== null && Date.now() - Date.parse(p.last_seen_at) < this.config.onlineSeconds * 1000);
    return { name: p.name, kind: p.kind, role: p.role, status_text: p.status_text, last_seen_at: p.last_seen_at, online };
  }

  listParticipants(projectId: number) {
    return this.all<Participant>("SELECT * FROM participants WHERE project_id = ? ORDER BY kind DESC, name", projectId).map((p) => this.participantView(p));
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
    if (by.kind !== "human") throw new HubError(403, "human_only", `Only the human can ${what}.`);
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

  threadView(r: Row): Thread {
    return {
      id: Number(r.n),
      parent_id: num(r.parent_n),
      title: String(r.title),
      status: r.status as ThreadStatus,
      status_reason: String(r.status_reason),
      summary: String(r.summary),
      agent_streak: Number(r.agent_streak),
      message_count: Number(r.message_count),
      created_by: str(r.creator),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  /** Internal thread row by its room number. */
  private threadRow(projectId: number, n: number): Row {
    const t = this.one<Row>(`${T_SELECT} WHERE t.project_id = ? AND t.n = ?`, projectId, n);
    if (!t) throw new HubError(404, "thread_not_found", `Thread T${n} does not exist.`);
    return t;
  }
  private threadRowById(id: number): Row {
    return this.one<Row>(`${T_SELECT} WHERE t.id = ?`, id)!;
  }

  createThread(by: Participant, input: { title: string; body?: string; parent_id?: number | null; mentions?: string[] }) {
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new HubError(400, "bad_title", "A thread needs a title.");
    const parent = input.parent_id ? this.threadRow(by.project_id, input.parent_id) : null;
    const id = this.tx(() => {
      const n = this.next(by.project_id, "seq_thread", this.config.limits.threads, "threads");
      const r = this.run("INSERT INTO threads (project_id, n, parent_id, title, created_by) VALUES (?, ?, ?, ?, ?)", by.project_id, n, parent ? Number(parent.id) : null, title, by.id);
      const tid = Number(r.lastInsertRowid);
      this.addMember(tid, by.id, 0);
      return tid;
    });
    const thread = this.threadView(this.threadRowById(id));
    this.emit(by.project_id, "thread", thread);
    let first: PostResult | null = null;
    if (input.body?.trim()) first = this.post(by, thread.id, { body: input.body, mentions: input.mentions });
    return { thread: first?.thread ?? thread, message: first?.message ?? null, warnings: first?.warnings ?? [] };
  }

  listThreads(projectId: number, status?: ThreadStatus) {
    const sql = `${T_SELECT.replace("SELECT t.*", "SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.thread_id = t.id AND q.status = 'open') AS open_questions")}
        WHERE t.project_id = ? ${status ? "AND t.status = ?" : ""}
        ORDER BY CASE t.status WHEN 'human_needed' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 200`;
    return this.all<Row>(sql, ...(status ? [projectId, status] : [projectId])).map((r) => ({ ...this.threadView(r), open_questions: Number(r.open_questions) }));
  }

  /** since/before are room message numbers. */
  getThread(projectId: number, n: number, opts: { since?: number; before?: number; limit?: number } = {}) {
    const row = this.threadRow(projectId, n);
    const tid = Number(row.id);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let rows: Row[];
    if (opts.since !== undefined) rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? AND m.n > ? ORDER BY m.n LIMIT ?`, tid, opts.since, limit);
    else if (opts.before) rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? AND m.n < ? ORDER BY m.n DESC LIMIT ?`, tid, opts.before, limit).reverse();
    else rows = this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? ORDER BY m.n DESC LIMIT ?`, tid, limit).reverse();
    const thread = this.threadView(row);
    return {
      thread,
      messages: rows.map((r) => this.messageView(r)),
      total: thread.message_count,
      open_questions: this.all<Row>(`${Q_SELECT} WHERE q.thread_id = ? AND q.status = 'open'`, tid).map((q) => this.questionView(q)),
      subthreads: this.all<{ n: number; title: string; status: string }>("SELECT n, title, status FROM threads WHERE parent_id = ?", tid).map((s) => ({ id: s.n, title: s.title, status: s.status })),
    };
  }

  setThreadStatus(by: Participant, n: number, status: ThreadStatus, reason = ""): Thread {
    const t = this.threadRow(by.project_id, n);
    if (by.kind === "agent" && t.status === "human_needed" && status !== "human_needed") {
      throw new HubError(423, "waiting_for_human", "This thread waits for the human; an agent cannot reopen it.");
    }
    if (by.kind === "agent" && status === "resolved" && !reason.trim()) throw new HubError(400, "summary_required", "Give a short summary of the result when resolving.");
    this.tx(() => {
      this.run(
        "UPDATE threads SET status = ?, status_reason = ?, updated_at = ?, agent_streak = CASE WHEN ? = 'open' THEN 0 ELSE agent_streak END WHERE id = ?",
        status,
        reason.slice(0, 500),
        now(),
        status,
        Number(t.id),
      );
      if (status === "resolved" && reason.trim()) this.run("UPDATE threads SET summary = ? WHERE id = ?", reason.trim().slice(0, 4000), Number(t.id));
      const label = { open: "reopened the thread", human_needed: "paused the thread for the human", resolved: "resolved the thread" }[status];
      this.insertSystem(by.project_id, Number(t.id), `${by.name} ${label}${reason ? `: ${reason}` : ""}`);
    });
    const updated = this.threadView(this.threadRowById(Number(t.id)));
    this.emit(by.project_id, "thread", updated);
    return updated;
  }

  setSummary(by: Participant, n: number, summary: string): Thread {
    const t = this.threadRow(by.project_id, n);
    this.run("UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?", summary.slice(0, 4000), now(), Number(t.id));
    const updated = this.threadView(this.threadRowById(Number(t.id)));
    this.emit(by.project_id, "thread", updated);
    return updated;
  }

  /** System messages are not counted against the room's message cap. */
  private insertSystem(projectId: number, threadId: number, body: string): Message {
    const n = this.next(projectId, "seq_message", Number.MAX_SAFE_INTEGER, "messages");
    const r = this.run("INSERT INTO messages (project_id, n, thread_id, author_id, kind, body) VALUES (?, ?, ?, NULL, 'system', ?)", projectId, n, threadId, body);
    this.run("UPDATE threads SET message_count = message_count + 1 WHERE id = ?", threadId);
    const msg = this.messageView(this.one<Row>(`${MSG_SELECT} WHERE m.id = ?`, Number(r.lastInsertRowid))!);
    queueMicrotask(() => this.emit(projectId, "message", msg));
    return msg;
  }

  // ---------------------------------------------------------------- messages

  messageView(r: Row): Message {
    const mentionIds = parse<number[]>(r.mentions, []);
    return {
      id: Number(r.n),
      thread_id: Number(r.thread_n),
      author_id: null,
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
      throw new HubError(429, "rate_limited", `Too many messages (${this.config.maxMessagesPerMinute}/min). Slow down and combine your points into one message.`);
    }
    list.push(t);
    this.recentPosts.set(by.id, list);
  }

  /** Validate evidence; throws 422 when something cited does not exist (= likely hallucination). */
  private validateEvidence(projectId: number, kind: string, evidence: Evidence[]) {
    const checks = checkEvidence(evidence, {
      projectRoot: this.config.projectRoot,
      messageExists: (n) => !!this.one("SELECT 1 FROM messages WHERE project_id = ? AND n = ?", projectId, n),
      knowledgeStatus: (n) => this.one<{ status: Knowledge["status"] }>("SELECT status FROM knowledge WHERE project_id = ? AND n = ?", projectId, n)?.status ?? null,
    });
    const bad = checks.filter((c) => c.result === "invalid");
    if (bad.length) {
      throw new HubError(
        422,
        "evidence_invalid",
        "Rejected: the cited evidence does not match reality. Re-check the facts (read the file, look up the id) and send again.\n" + bad.map((b) => `- ${b.note}`).join("\n"),
        bad,
      );
    }
    return { checks, status: overallStatus(kind, checks) };
  }

  /** Post a message. All anti-loop and anti-hallucination guards live here. */
  post(by: Participant, threadN: number, input: PostInput, internal = false): PostResult {
    const kind: MessageKind = input.kind ?? "chat";
    if (kind === "system") throw new HubError(400, "bad_kind", "Only the hub posts system messages.");
    const body = input.body.trim();
    if (!body) throw new HubError(400, "empty", "Empty message.");
    if (body.length > 20_000) throw new HubError(413, "too_long", "Message too long (max 20,000 chars). Reference a file instead of pasting it.");
    const row = this.threadRow(by.project_id, threadN);
    const tid = Number(row.id);
    const thread = this.threadView(row);

    if (by.kind === "agent" && !internal) {
      if (thread.status === "human_needed") {
        throw new HubError(423, "waiting_for_human", `Thread T${threadN} waits for the human (${thread.status_reason || "no reason given"}). Don't post here until they answer; do other work or wait.`);
      }
      const recent = this.all<{ body: string; n: number }>("SELECT n, body FROM messages WHERE thread_id = ? AND author_id = ? ORDER BY id DESC LIMIT ?", tid, by.id, this.config.repeatWindow);
      const fp = fingerprint(body);
      if (fp.size >= 4) {
        const dup = recent.find((m) => similarity(fp, fingerprint(m.body)) >= 0.85);
        if (dup) throw new HubError(409, "repetition", `You already sent this (M${dup.n}). Don't repeat yourself – change approach, ask, or escalate.`);
      }
      this.checkRate(by);
    }

    const warnings: string[] = [];
    const names = new Set<string>(input.mentions ?? []);
    for (const m of body.matchAll(/(?:^|[\s(,])@([\p{L}\p{N}_.-]+)/gu)) names.add(m[1].replace(/[.]+$/, ""));
    const mentionIds = new Set<number>();
    for (const n of names) {
      const found = this.resolveName(by.project_id, n);
      if (found.length === 0) warnings.push(`@${n} is not in this room – nobody will get it.`);
      for (const p of found) if (p.id !== by.id) mentionIds.add(p.id);
    }

    if (input.reply_to && !this.one("SELECT 1 FROM messages WHERE thread_id = ? AND n = ?", tid, input.reply_to)) {
      throw new HubError(400, "bad_reply", `Message M${input.reply_to} is not in this thread.`);
    }

    const evidence = input.evidence ?? [];
    const validated = this.validateEvidence(by.project_id, kind, evidence);
    // The human is the source of truth – their answers and decisions need no evidence.
    const status = by.kind === "human" && validated.status === "missing" ? "none" : validated.status;
    if (status === "missing") warnings.push(`A "${kind}" without evidence is shown as unverified.`);

    let systemNote: string | null = null;
    const message = this.tx(() => {
      const n = this.next(by.project_id, "seq_message", this.config.limits.messages, "messages");
      const r = this.run(
        `INSERT INTO messages (project_id, n, thread_id, author_id, kind, body, mentions, reply_to, evidence, evidence_status, confidence, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        by.project_id,
        n,
        tid,
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
      this.addMember(tid, by.id, id);
      for (const pid of mentionIds) this.addMember(tid, pid, id);

      let newStatus: ThreadStatus = thread.status;
      let streak = thread.agent_streak;
      if (internal || kind === "status") {
        // Structured notices (check-ins, requests, reviews) are not a debate: no loop-guard counting.
      } else if (by.kind === "human") {
        streak = 0;
        if (thread.status !== "open") {
          newStatus = "open";
          systemNote = `${by.name} joined in – the thread continues.`;
        }
      } else {
        streak += 1;
        if (thread.status === "resolved") {
          newStatus = "open";
          systemNote = `${by.name} reopened the resolved thread.`;
        }
        if (streak >= this.config.maxAgentStreak) {
          newStatus = "human_needed";
          systemNote = `Loop guard: agents exchanged ${streak} messages without the human. The thread waits for the human.`;
        }
      }
      this.run(
        `UPDATE threads SET agent_streak = ?, status = ?, message_count = message_count + 1, updated_at = ?,
           status_reason = CASE WHEN ? != status THEN ? ELSE status_reason END WHERE id = ?`,
        streak,
        newStatus,
        now(),
        newStatus,
        newStatus === "human_needed" ? "agent message limit without the human" : "",
        tid,
      );
      this.seen(by);
      const msg = this.messageView(this.one<Row>(`${MSG_SELECT} WHERE m.id = ?`, id)!);
      if (systemNote) this.insertSystem(by.project_id, tid, systemNote);
      return msg;
    });

    const updated = this.threadView(this.threadRowById(tid));
    this.emit(by.project_id, "message", message);
    if (updated.status !== thread.status || updated.agent_streak !== thread.agent_streak) this.emit(by.project_id, "thread", updated);
    if (updated.status === "human_needed" && thread.status !== "human_needed") warnings.push("The loop guard paused this thread – it now waits for the human.");
    return { message, warnings, evidence_checks: validated.checks, thread: updated };
  }

  // ---------------------------------------------------------------- knowledge

  knowledgeView(r: Row): Knowledge {
    return {
      id: Number(r.n),
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
      return this.all<Row>("SELECT * FROM knowledge WHERE project_id = ? AND status != 'superseded' ORDER BY updated_at DESC LIMIT ?", projectId, limit).map((r) => this.knowledgeView(r));
    }
    // Crude stemming for inflected languages: "databáze" should match "databázi".
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

  private knowledgeRow(projectId: number, n: number): Row {
    const r = this.one<Row>("SELECT * FROM knowledge WHERE project_id = ? AND n = ?", projectId, n);
    if (!r) throw new HubError(404, "knowledge_not_found", `Memory entry K${n} does not exist.`);
    return r;
  }

  getKnowledge(projectId: number, n: number): Knowledge {
    return this.knowledgeView(this.knowledgeRow(projectId, n));
  }

  addKnowledge(
    by: Participant,
    input: { kind: KnowledgeKind; title: string; body: string; tags?: string; evidence?: Evidence[]; source_message_id?: number | null; supersedes?: number | null },
  ): Knowledge {
    if (!input.title.trim() || !input.body.trim()) throw new HubError(400, "empty", "A memory entry needs a title and a body.");
    const evidence = input.evidence ?? [];
    const { status } = this.validateEvidence(by.project_id, "note", evidence);
    if (by.kind === "agent" && input.kind === "decision" && evidence.length === 0) {
      throw new HubError(422, "evidence_required", "An agent's decision must cite its source (e.g. the message where the team or the human agreed).");
    }
    const trust: Trust = by.kind === "human" ? "human" : status === "verified" ? "evidence" : "agent";
    const k = this.tx(() => {
      const old = input.supersedes ? this.knowledgeRow(by.project_id, input.supersedes) : null;
      if (old && old.trust === "human" && by.kind === "agent") {
        throw new HubError(403, "human_knowledge", `K${old.n} was confirmed by the human – an agent cannot replace it. Ask the human.`);
      }
      const n = this.next(by.project_id, "seq_knowledge", this.config.limits.knowledge, "memory entries");
      this.run(
        `INSERT INTO knowledge (project_id, n, kind, title, body, tags, evidence, trust, author_id, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        by.project_id,
        n,
        input.kind,
        input.title.trim().slice(0, 300),
        input.body.trim().slice(0, 10_000),
        (input.tags ?? "").slice(0, 200),
        evidence.length ? json(evidence) : "[]",
        trust,
        by.id,
        input.source_message_id ?? null,
      );
      if (old) this.run("UPDATE knowledge SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", n, now(), Number(old.id));
      return this.getKnowledge(by.project_id, n);
    });
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  verifyKnowledge(by: Participant, n: number): Knowledge {
    this.requireHuman(by, "confirm memory entries");
    const r = this.knowledgeRow(by.project_id, n);
    this.run("UPDATE knowledge SET trust = 'human', status = 'active', status_note = '', updated_at = ? WHERE id = ?", now(), Number(r.id));
    const k = this.getKnowledge(by.project_id, n);
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  disputeKnowledge(by: Participant, n: number, reason: string): Knowledge {
    if (!reason.trim()) throw new HubError(400, "reason_required", "Say why the entry is wrong.");
    const r = this.knowledgeRow(by.project_id, n);
    if (r.status === "superseded") throw new HubError(409, "superseded", `K${n} was already replaced by K${r.superseded_by}.`);
    this.run("UPDATE knowledge SET status = 'disputed', status_note = ?, updated_at = ? WHERE id = ?", `${by.name}: ${reason.trim()}`.slice(0, 1000), now(), Number(r.id));
    const k = this.getKnowledge(by.project_id, n);
    this.emit(by.project_id, "knowledge", k);
    return k;
  }

  // ---------------------------------------------------------------- questions

  questionView(r: Row): Question {
    return {
      id: Number(r.n),
      thread_id: Number(r.thread_n),
      message_id: Number(r.message_n),
      asked_by: this.nameOf(r.asked_by) ?? "?",
      target: this.nameOf(r.target_id),
      body: String(r.body),
      options: parse<string[]>(r.options, []),
      blocking: Number(r.blocking) === 1,
      status: r.status as Question["status"],
      answer: str(r.answer_body),
      answered_by: this.nameOf(r.answered_by),
      answer_message_id: num(r.answer_n),
      knowledge_id: num(r.knowledge_id),
      created_at: String(r.created_at),
      answered_at: str(r.answered_at),
    };
  }

  private questionRow(projectId: number, n: number): Row {
    const r = this.one<Row>(`${Q_SELECT} WHERE q.project_id = ? AND q.n = ?`, projectId, n);
    if (!r) throw new HubError(404, "question_not_found", `Question Q${n} does not exist.`);
    return r;
  }

  getQuestion(projectId: number, n: number): Question {
    return this.questionView(this.questionRow(projectId, n));
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
    return this.all<Row>(`${Q_SELECT} WHERE ${where.join(" AND ")} ORDER BY q.blocking DESC, q.n LIMIT 100`, ...params).map((r) => this.questionView(r));
  }

  ask(by: Participant, input: { to?: string | null; body: string; thread_id?: number | null; options?: string[]; blocking?: boolean }) {
    const body = input.body.trim();
    if (!body) throw new HubError(400, "empty", "Empty question.");
    let target: Participant | null = null;
    const to = input.to?.trim();
    if (to && !ALL_ALIASES.has(to.toLowerCase()) && !ANYONE.has(to.toLowerCase())) {
      const found = this.resolveName(by.project_id, to);
      if (found.length === 0) {
        throw new HubError(404, "unknown_participant", `"${to}" is not in this room. Present: ${this.listParticipants(by.project_id).map((p) => p.name).join(", ")}`);
      }
      target = found[0];
      if (target.id === by.id) throw new HubError(400, "self_question", "You can't ask yourself.");
    }
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
    const similar = this.searchKnowledge(by.project_id, body, 3);
    const threadN = input.thread_id ?? this.createThread(by, { title: `Q: ${body.slice(0, 80)}` }).thread.id;
    const text = (target ? `@${target.name} ` : "") + body + (options.length ? "\n" + options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("\n") : "");
    const qn = this.tx(() => {
      const posted = this.post(by, threadN, { kind: "question", body: text });
      const n = this.next(by.project_id, "seq_question", this.config.limits.questions, "questions");
      const msgId = this.one<{ id: number }>("SELECT id FROM messages WHERE project_id = ? AND n = ?", by.project_id, posted.message.id)!.id;
      this.run(
        "INSERT INTO questions (project_id, n, thread_id, message_id, asked_by, target_id, body, options, blocking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        by.project_id,
        n,
        Number(this.threadRow(by.project_id, threadN).id),
        msgId,
        by.id,
        target?.id ?? null,
        body,
        options.length ? json(options) : "[]",
        input.blocking ? 1 : 0,
      );
      this.run("UPDATE messages SET meta = ? WHERE id = ?", json({ question_id: n }), msgId);
      return { n, warnings: posted.warnings };
    });
    const question = this.getQuestion(by.project_id, qn.n);
    this.emit(by.project_id, "question", question);
    return { question, similar_knowledge: similar, warnings: qn.warnings };
  }

  /** Answer a question. Stored as shared memory – except guesses, so they cannot spread. */
  answer(by: Participant, n: number, input: { body: string; confidence?: Confidence; evidence?: Evidence[]; choice?: string | null }) {
    const q = this.getQuestion(by.project_id, n);
    if (q.status !== "open") throw new HubError(409, "not_open", `Question Q${q.id} is already ${q.status === "answered" ? `answered (by ${q.answered_by})` : "cancelled"}.`);
    if (q.asked_by === by.name) throw new HubError(400, "own_question", "Don't answer your own question – cancel it instead.");
    const confidence: Confidence = by.kind === "human" ? "certain" : (input.confidence ?? "likely");
    let body = input.body.trim();
    if (input.choice) body = `Choice: ${input.choice}${body ? `\n${body}` : ""}`;
    if (!body) throw new HubError(400, "empty", "Empty answer.");
    const posted = this.post(by, q.thread_id, {
      kind: "answer",
      body: `@${q.asked_by} ${body}`,
      reply_to: q.message_id,
      evidence: input.evidence,
      confidence,
      meta: { question_id: q.id },
    });
    let knowledgeN: number | null = null;
    if (confidence !== "guess") {
      knowledgeN = this.addKnowledge(by, { kind: "answer", title: q.body, body, evidence: input.evidence ?? [], source_message_id: posted.message.id }).id;
    }
    this.run(
      "UPDATE questions SET status = 'answered', answer_message_id = (SELECT id FROM messages WHERE project_id = ? AND n = ?), answered_by = ?, knowledge_id = ?, answered_at = ? WHERE project_id = ? AND n = ?",
      by.project_id,
      posted.message.id,
      by.id,
      knowledgeN,
      now(),
      by.project_id,
      n,
    );
    const question = this.getQuestion(by.project_id, n);
    this.emit(by.project_id, "question", question);
    const warnings = [...posted.warnings];
    if (confidence === "guess") warnings.push("Guesses are not stored in shared memory.");
    return { question, message: posted.message, warnings };
  }

  cancelQuestion(by: Participant, n: number, reason = "") {
    const row = this.questionRow(by.project_id, n);
    const q = this.questionView(row);
    if (q.asked_by !== by.name && by.kind !== "human") throw new HubError(403, "not_owner", "Only the asker or the human can cancel a question.");
    if (q.status !== "open") throw new HubError(409, "not_open", `Question Q${n} is not open.`);
    this.run("UPDATE questions SET status = 'cancelled', answered_at = ? WHERE id = ?", now(), Number(row.id));
    this.insertSystem(by.project_id, Number(row.thread_id), `${by.name} cancelled question Q${n}${reason ? `: ${reason}` : ""}`);
    const question = this.getQuestion(by.project_id, n);
    this.emit(by.project_id, "question", question);
    return question;
  }

  waitForAnswer(projectId: number, n: number, timeoutMs: number, signal?: AbortSignal): Promise<Question> {
    const q = this.getQuestion(projectId, n);
    if (q.status !== "open" || timeoutMs <= 0) return Promise.resolve(q);
    return new Promise((resolveP) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", done);
        try {
          resolveP(this.getQuestion(projectId, n));
        } catch {
          resolveP(q); // room deleted meanwhile
        }
      };
      const off = this.subscribe(projectId, (e) => {
        if (e.type === "question" && (e.data as Question).id === n && (e.data as Question).status !== "open") done();
      });
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done);
    });
  }

  // ---------------------------------------------------------------- claims (file locks)

  private claimView(r: Row): Claim {
    return {
      id: Number(r.id),
      path: String(r.path),
      holder: this.nameOf(r.holder_id) ?? "?",
      reason: String(r.reason),
      thread_id: num(r.thread_n),
      expires_at: String(r.expires_at),
      created_at: String(r.created_at),
    };
  }

  listClaims(projectId: number): Claim[] {
    return this.all<Row>(`${CLAIM_SELECT} WHERE c.project_id = ? AND c.expires_at > ? ORDER BY c.path`, projectId, now()).map((r) => this.claimView(r));
  }

  checkPaths(projectId: number, paths: string[], except?: Participant) {
    const active = this.listClaims(projectId);
    const out = new Map<number, Claim>();
    for (const raw of paths) {
      const p = normalizePath(raw);
      for (const c of active) if (c.holder !== except?.name && pathsOverlap(p, c.path)) out.set(c.id, c);
    }
    return [...out.values()];
  }

  claim(by: Participant, input: { paths: string[]; reason?: string; minutes?: number; thread_id?: number | null; force?: boolean }) {
    const minutes = Math.min(Math.max(input.minutes ?? this.config.defaultClaimMinutes, 1), 240);
    const expires = new Date(Date.now() + minutes * 60_000).toISOString();
    const threadId = input.thread_id ? Number(this.threadRow(by.project_id, input.thread_id).id) : null;
    const granted: string[] = [];
    const conflicts: Claim[] = [];
    const areaConflicts: { path: string; owner: string; rules: string }[] = [];
    const forced: string[] = [];
    this.tx(() => {
      this.run("DELETE FROM claims WHERE project_id = ? AND expires_at <= ?", by.project_id, now());
      for (const raw of input.paths.slice(0, 100)) {
        const p = normalizePath(raw);
        if (!p) continue;
        const c = this.checkPaths(by.project_id, [p], by);
        if (c.length) {
          conflicts.push(...c);
          continue;
        }
        const owners = this.areaOwners(by.project_id, p, by);
        if (owners.length && !input.force) {
          for (const a of owners) areaConflicts.push({ path: p, owner: a.owner, rules: a.rules });
          continue;
        }
        if (owners.length) forced.push(`${p} (${owners.map((a) => a.owner).join(", ")})`);
        const mine = this.one<{ id: number }>("SELECT id FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?", by.project_id, by.id, p);
        if (mine) this.run("UPDATE claims SET expires_at = ?, reason = ? WHERE id = ?", expires, (input.reason ?? "").slice(0, 200), mine.id);
        else {
          this.run(
            "INSERT INTO claims (project_id, path, holder_id, reason, thread_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            by.project_id,
            p.slice(0, 500),
            by.id,
            (input.reason ?? "").slice(0, 200),
            threadId,
            expires,
          );
        }
        granted.push(p);
      }
    });
    if (granted.length) this.emit(by.project_id, "claim", { holder: by.name, granted });
    if (forced.length) {
      // Overriding someone's area is allowed only in the open.
      this.notice(by, Number(this.coordThread(by.project_id).id), `Heads-up: I'm editing inside other areas: ${forced.join("; ")}. Reason: ${input.reason || "none given"}`, { type: "override" });
    }
    return { granted, conflicts, area_conflicts: areaConflicts, expires_at: expires };
  }

  release(by: Participant, paths?: string[]) {
    let n = 0;
    if (!paths || paths.length === 0) n = Number(this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ?", by.project_id, by.id).changes);
    else for (const raw of paths) n += Number(this.run("DELETE FROM claims WHERE project_id = ? AND holder_id = ? AND path = ?", by.project_id, by.id, normalizePath(raw)).changes);
    this.emit(by.project_id, "claim", { holder: by.name, released: n });
    return { released: n };
  }

  // ---------------------------------------------------------------- tasks

  private taskView(r: Row): Task {
    return {
      id: Number(r.n),
      thread_id: num(r.thread_n),
      title: String(r.title),
      details: String(r.details),
      status: r.status as TaskStatus,
      assignee: this.nameOf(r.assignee_id),
      created_by: this.nameOf(r.created_by),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  private taskRow(projectId: number, n: number): Row {
    const r = this.one<Row>(`${TASK_SELECT} WHERE k.project_id = ? AND k.n = ?`, projectId, n);
    if (!r) throw new HubError(404, "task_not_found", `Task #${n} does not exist.`);
    return r;
  }

  getTask(projectId: number, n: number): Task {
    return this.taskView(this.taskRow(projectId, n));
  }

  listTasks(projectId: number, opts: { status?: string; assignee?: Participant; openOnly?: boolean } = {}): Task[] {
    const where = ["k.project_id = ?"];
    const params: SQLInputValue[] = [projectId];
    if (opts.status) {
      where.push("k.status = ?");
      params.push(opts.status);
    }
    if (opts.openOnly) where.push("k.status != 'done'");
    if (opts.assignee) {
      where.push("k.assignee_id = ?");
      params.push(opts.assignee.id);
    }
    return this.all<Row>(
      `${TASK_SELECT} WHERE ${where.join(" AND ")}
       ORDER BY CASE k.status WHEN 'doing' THEN 0 WHEN 'review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END, k.n LIMIT 200`,
      ...params,
    ).map((r) => this.taskView(r));
  }

  createTask(by: Participant, input: { title: string; details?: string; assignee?: string | null; thread_id?: number | null }) {
    if (!input.title.trim()) throw new HubError(400, "empty", "A task needs a title.");
    let assigneeId: number | null = null;
    if (input.assignee) {
      const found = this.resolveName(by.project_id, input.assignee);
      if (!found.length) throw new HubError(404, "unknown_participant", `"${input.assignee}" is not in this room.`);
      assigneeId = found[0].id;
    }
    const threadId = input.thread_id ? Number(this.threadRow(by.project_id, input.thread_id).id) : null;
    const n = this.tx(() => {
      const n = this.next(by.project_id, "seq_task", this.config.limits.tasks, "tasks");
      this.run(
        "INSERT INTO tasks (project_id, n, thread_id, title, details, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        by.project_id,
        n,
        threadId,
        input.title.trim().slice(0, 200),
        (input.details ?? "").slice(0, 4000),
        assigneeId,
        by.id,
      );
      return n;
    });
    const t = this.getTask(by.project_id, n);
    this.emit(by.project_id, "task", t);
    return t;
  }

  updateTask(by: Participant, n: number, patch: { status?: TaskStatus; assignee?: string | null; details?: string; take?: boolean }, quiet = false) {
    const r = this.taskRow(by.project_id, n);
    let assigneeId = num(r.assignee_id);
    if (patch.take) {
      if (assigneeId !== null && assigneeId !== by.id && (r.status === "doing" || r.status === "review")) {
        throw new HubError(409, "task_taken", `${this.nameOf(assigneeId)} is working on task #${n}. Agree with them before taking it over.`);
      }
      assigneeId = by.id;
    } else if (patch.assignee !== undefined) {
      if (patch.assignee === null) assigneeId = null;
      else {
        const found = this.resolveName(by.project_id, patch.assignee);
        if (!found.length) throw new HubError(404, "unknown_participant", `"${patch.assignee}" is not in this room.`);
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
          ? "You can't approve your own work. Another agent or the human must approve it."
          : `Move task #${n} to "review" first and have another agent or the human check it.`,
      );
    }
    this.run("UPDATE tasks SET status = ?, assignee_id = ?, details = ?, updated_at = ? WHERE id = ?", status, assigneeId, (patch.details ?? String(r.details)).slice(0, 4000), now(), Number(r.id));
    const t = this.getTask(by.project_id, n);
    this.emit(by.project_id, "task", t);
    // Close the request loop: tell the requester when it's ready, and the assignee when it's approved.
    if (!quiet && status !== r.status) {
      const creator = this.nameOf(r.created_by);
      const tid = r.thread_id !== null ? Number(r.thread_id) : null;
      const where = () => tid ?? Number(this.coordThread(by.project_id).id);
      if (status === "review" && creator && creator !== by.name) {
        this.notice(by, where(), `@${creator} #${n} is ready for your review: ${t.title}. Approve: task ${n} done · or send feedback.`, { task: n, type: "review" });
      } else if (status === "done" && t.assignee && t.assignee !== by.name) {
        this.notice(by, where(), `@${t.assignee} #${n} approved: ${t.title}`, { task: n, type: "approved" });
      }
    }
    return t;
  }

  // ---------------------------------------------------------------- handoff

  handoff(by: Participant, input: { thread_id: number; to?: string | null; summary: string; done?: string[]; next?: string[]; risks?: string[]; evidence?: Evidence[] }) {
    const lines = [input.to ? `@${input.to} handing over:` : "Handover:", input.summary.trim()];
    if (input.done?.length) lines.push("", "Done:", ...input.done.map((d) => `- ${d}`));
    if (input.next?.length) lines.push("", "Next:", ...input.next.map((d) => `- ${d}`));
    if (input.risks?.length) lines.push("", "Risks / open questions:", ...input.risks.map((d) => `- ${d}`));
    return this.post(by, input.thread_id, { kind: "handoff", body: lines.join("\n"), evidence: input.evidence });
  }

  // ---------------------------------------------------------------- coordination: areas, requests, start/end

  /** The room's coordination thread (T1 in new rooms): check-ins, check-outs, requests, reviews. */
  coordThread(projectId: number): Row {
    const p = this.one<{ coord_thread_id: number | null }>("SELECT coord_thread_id FROM projects WHERE id = ?", projectId)!;
    if (p.coord_thread_id) {
      const t = this.one<Row>(`${T_SELECT} WHERE t.id = ?`, p.coord_thread_id);
      if (t) return t;
    }
    return this.tx(() => {
      const n = this.next(projectId, "seq_thread", Number.MAX_SAFE_INTEGER, "threads");
      const r = this.run("INSERT INTO threads (project_id, n, title, summary) VALUES (?, ?, 'Coordination', ?)", projectId, n, "Who works where. Agents check in (start), check out (end) and send requests here.");
      const tid = Number(r.lastInsertRowid);
      this.run("UPDATE projects SET coord_thread_id = ? WHERE id = ?", tid, projectId);
      this.insertSystem(projectId, tid, "Coordination thread: agents announce their plan and area when they start, ask each other for constraints, send requests for each other's areas, and say what's left when they finish.");
      return this.threadRowById(tid);
    });
  }

  private areaView(r: Row) {
    return {
      owner: this.nameOf(r.participant_id) ?? "?",
      paths: parse<string[]>(r.paths, []),
      description: String(r.description),
      rules: String(r.rules),
      updated_at: String(r.updated_at),
    };
  }

  listAreas(projectId: number) {
    return this.all<Row>("SELECT * FROM areas WHERE project_id = ? ORDER BY updated_at", projectId).map((r) => this.areaView(r));
  }

  /** Areas of other participants that overlap the given path. */
  private areaOwners(projectId: number, path: string, except: Participant) {
    const p = normalizePath(path);
    return this.listAreas(projectId).filter((a) => a.owner !== except.name && a.paths.some((x) => pathsOverlap(p, x)));
  }

  /** Take ownership of paths. Overlap with someone else's area is refused: agree first, then they release it. */
  setArea(by: Participant, input: { paths: string[]; description?: string; rules?: string }) {
    const paths = [...new Set(input.paths.map(normalizePath).filter(Boolean))].slice(0, 50);
    if (!paths.length) throw new HubError(400, "no_paths", "Give at least one path (file or folder) for your area.");
    const clashes = paths.flatMap((p) => this.areaOwners(by.project_id, p, by).map((a) => `${p} overlaps ${a.owner}'s area (${a.paths.join(", ")})`));
    if (clashes.length) {
      throw new HubError(409, "area_taken", `${clashes.join("; ")}. Agree on a split with them first (or ask them to end/release).`);
    }
    const old = this.one<Row>("SELECT * FROM areas WHERE participant_id = ?", by.id);
    this.run(
      `INSERT INTO areas (participant_id, project_id, paths, description, rules, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET paths = excluded.paths, description = excluded.description, rules = excluded.rules, updated_at = excluded.updated_at`,
      by.id,
      by.project_id,
      json(paths),
      (input.description ?? (old ? String(old.description) : "")).slice(0, 300),
      (input.rules ?? (old ? String(old.rules) : "")).slice(0, 1000),
      now(),
    );
    const area = this.areaView(this.one<Row>("SELECT * FROM areas WHERE participant_id = ?", by.id)!);
    this.emit(by.project_id, "area", area);
    return area;
  }

  releaseArea(by: Participant) {
    const n = Number(this.run("DELETE FROM areas WHERE participant_id = ?", by.id).changes);
    if (n) this.emit(by.project_id, "area", { owner: by.name, released: true });
    return { released: n > 0 };
  }

  /** Post a structured notice to a thread (internal id), bypassing the debate guards. */
  private notice(by: Participant, threadId: number, body: string, meta?: Record<string, unknown>) {
    const n = Number(this.threadRowById(threadId).n);
    return this.post(by, n, { kind: "status", body, meta }, true).message;
  }

  /** Ask the owner of another area to do something. Creates a task for them; you review the result. */
  request(by: Participant, input: { to: string; what: string; details?: string; thread_id?: number | null }) {
    const owner = this.resolveName(by.project_id, input.to);
    if (!owner.length) throw new HubError(404, "unknown_participant", `"${input.to}" is not in this room.`);
    if (owner[0].id === by.id) throw new HubError(400, "self_request", "That's your own area – just do it.");
    const task = this.createTask(by, { title: input.what, details: input.details, assignee: owner[0].name, thread_id: input.thread_id });
    const tid = input.thread_id ? Number(this.threadRow(by.project_id, input.thread_id).id) : Number(this.coordThread(by.project_id).id);
    this.notice(by, tid, `@${owner[0].name} request #${task.id}: ${input.what}${input.details ? `\n${input.details}` : ""}\nWhen done: task ${task.id} review – I'll check it.`, { task: task.id, type: "request" });
    return task;
  }

  /** Requester rejects the result: task goes back to the assignee with the feedback. */
  feedback(by: Participant, n: number, text: string) {
    if (!text.trim()) throw new HubError(400, "empty", "Say what needs to change.");
    const t = this.getTask(by.project_id, n);
    if (t.assignee === by.name) throw new HubError(400, "own_task", "This is your task – fix it yourself.");
    const updated = this.updateTask(by, n, { status: "doing" }, true);
    const tid = this.taskThreadId(by.project_id, n);
    if (t.assignee) this.notice(by, tid, `@${t.assignee} feedback on #${n} (${t.title}): ${text.trim()}`, { task: n, type: "feedback" });
    return updated;
  }

  private taskThreadId(projectId: number, n: number): number {
    const r = this.taskRow(projectId, n);
    return r.thread_id !== null ? Number(r.thread_id) : Number(this.coordThread(projectId).id);
  }

  /** Session start: announce the plan, take an area, ask the others for constraints, get a briefing. */
  checkIn(by: Participant, input: { plan: string; paths?: string[]; description?: string; rules?: string }) {
    if (!input.plan.trim()) throw new HubError(400, "empty", "Say what you plan to do.");
    const area = input.paths?.length ? this.setArea(by, { paths: input.paths, description: input.description, rules: input.rules }) : null;
    this.setStatus(by, `working: ${input.plan.trim()}`.slice(0, 200));
    const others = this.all<Participant>("SELECT * FROM participants WHERE project_id = ? AND kind = 'agent' AND id != ?", by.project_id, by.id).filter(
      (p) => this.participantView(p).online && !p.status_text.startsWith("finished"),
    );
    const mine = area ?? this.listAreas(by.project_id).find((a) => a.owner === by.name) ?? null;
    const body = [
      `Starting: ${input.plan.trim()}`,
      mine ? `My area: ${mine.paths.join(", ")}${mine.rules ? ` – rules: ${mine.rules}` : ""}` : "No fixed area.",
      others.length ? `${others.map((o) => `@${o.name}`).join(" ")} any constraints or requests for me?` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const coord = this.coordThread(by.project_id);
    const message = this.notice(by, Number(coord.id), body, { type: "start" });
    return { message, briefing: this.briefing(by) };
  }

  /** Session end: say what's done and what's left, release locks (and the area unless kept). */
  checkOut(by: Participant, input: { summary: string; left?: string[]; keepArea?: boolean }) {
    if (!input.summary.trim()) throw new HubError(400, "empty", "Summarise what you did.");
    const open = this.listTasks(by.project_id, { assignee: by, openOnly: true });
    this.release(by);
    const area = this.listAreas(by.project_id).find((a) => a.owner === by.name);
    if (area && !input.keepArea) this.releaseArea(by);
    const lines = [`Done, signing off: ${input.summary.trim()}`];
    if (input.left?.length) lines.push("Left for anyone:", ...input.left.map((l) => `- ${l}`));
    if (open.length) lines.push(`Still open on me: ${open.map((t) => `#${t.id} ${t.title} [${t.status}]`).join("; ")}`);
    if (area) lines.push(input.keepArea ? `Keeping my area ${area.paths.join(", ")}.` : `My area is free now: ${area.paths.join(", ")}.`);
    const message = this.notice(by, Number(this.coordThread(by.project_id).id), lines.join("\n"), { type: "end" });
    this.setStatus(by, `finished: ${input.summary.trim()}`.slice(0, 200));
    return { message, open_tasks: open };
  }

  /** What an agent needs to know when it starts: who owns what, their rules, requests waiting for it. */
  briefing(by: Participant) {
    const coord = this.coordThread(by.project_id);
    return {
      areas: this.listAreas(by.project_id),
      agents: this.listParticipants(by.project_id).filter((p) => p.name !== by.name),
      requests_for_me: this.listTasks(by.project_id, { assignee: by, openOnly: true }),
      to_review: this.all<Row>(`${TASK_SELECT} WHERE k.project_id = ? AND k.created_by = ? AND k.status = 'review' AND (k.assignee_id IS NULL OR k.assignee_id != ?)`, by.project_id, by.id, by.id).map((r) =>
        this.taskView(r),
      ),
      recent: this.all<Row>(`${MSG_SELECT} WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT 8`, Number(coord.id)).reverse().map((r) => this.messageView(r)),
      coordination_thread: Number(coord.n),
    };
  }

  // ---------------------------------------------------------------- inbox

  private isRelevant(p: Participant, m: Message): boolean {
    if (m.author === p.name) return false;
    if (p.kind === "human" || m.author_kind === "human" || m.kind === "decision" || m.mentions.includes(p.name)) return true;
    return !!this.one(
      `SELECT 1 FROM thread_members tm JOIN threads t ON t.id = tm.thread_id JOIN messages mm ON mm.project_id = t.project_id AND mm.n = ?
        WHERE t.project_id = ? AND t.n = ? AND tm.participant_id = ? AND tm.since_id <= mm.id`,
      m.id,
      p.project_id,
      m.thread_id,
      p.id,
    );
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
        ? this.all<Row>(`${MSG_SELECT} WHERE m.project_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id != ?) ORDER BY m.id LIMIT ?`, me.project_id, cursor, me.id, limit + 1)
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
    const kept = rows.slice(0, limit);
    const messages = kept.map((r) => this.messageView(r));
    const maxId = this.one<{ m: number | null }>("SELECT MAX(id) AS m FROM messages WHERE project_id = ?", me.project_id)?.m ?? cursor;
    const newCursor = more ? Number(kept[kept.length - 1].id) : Math.max(cursor, maxId);

    const newThreads = this.all<Row>(`${T_SELECT} WHERE t.project_id = ? AND t.id > ? AND (t.created_by IS NULL OR t.created_by != ?) ORDER BY t.id LIMIT 20`, me.project_id, me.thread_cursor, me.id).map(
      (t) => ({ id: Number(t.n), title: String(t.title), by: str(t.creator) }),
    );
    const maxThread = this.one<{ m: number | null }>("SELECT MAX(id) AS m FROM threads WHERE project_id = ?", me.project_id)?.m ?? 0;
    const myQuestions = this.all<Row>(`${Q_SELECT} WHERE q.asked_by = ? AND (q.status = 'open' OR q.answer_message_id > ?) ORDER BY q.id DESC LIMIT 20`, me.id, cursor).map((r) =>
      this.questionView(r),
    );
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
      paused_threads: this.all<Row>(
        `${T_SELECT} WHERE t.project_id = ? AND t.status = 'human_needed'
           AND (? = 'human' OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.participant_id = ?))`,
        me.project_id,
        me.kind,
        me.id,
      ).map((t) => ({ id: Number(t.n), title: String(t.title), reason: String(t.status_reason) })),
      my_tasks: this.listTasks(me.project_id, { assignee: me, openOnly: true }),
      my_claims: claims.filter((c) => c.holder === me.name),
      others_claims: claims.filter((c) => c.holder !== me.name),
    };
  }

  /** Resolve when something relevant for the participant happens, or after the timeout. */
  waitForActivity(p: Participant, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const cursor = this.one<{ c: number }>("SELECT inbox_cursor AS c FROM participants WHERE id = ?", p.id)!.c;
    const pending = this.one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages m LEFT JOIN participants a ON a.id = m.author_id
        WHERE m.project_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id != ?)
          AND (? = 'human' OR a.kind = 'human' OR m.kind = 'decision'
               OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.participant_id = ? AND tm.since_id <= m.id))`,
      p.project_id,
      cursor,
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
      knowledge: this.all<Row>("SELECT * FROM knowledge WHERE project_id = ? AND status != 'superseded' ORDER BY updated_at DESC LIMIT 50", projectId).map((r) => this.knowledgeView(r)),
    };
  }
}
