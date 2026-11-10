import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { DEFAULT_CONFIG, Hub, HubError, type HubConfig } from "../hub.js";

function setup(overrides: Partial<HubConfig> = {}) {
  const hub = new Hub(openDatabase(":memory:"), { ...DEFAULT_CONFIG, ...overrides });
  const room = hub.createRoom({ name: "Test" });
  const pid = room.project.id;
  const human = room.human;
  const a = hub.join(pid, "Alfa", "agent", { role: "coder" }).participant;
  const b = hub.join(pid, "Beta", "agent", { role: "reviewer" }).participant;
  return { hub, human, a, b, pid, room };
}

function rejects(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof HubError && e.code === code, `expected HubError ${code}`);
}

test("rooms start with the coordination thread as T1 and use room-local numbers", () => {
  const { hub, a } = setup();
  const t = hub.createThread(a, { title: "Work", body: "hi" });
  assert.equal(t.thread.id, 2);
  assert.equal(t.message?.id, 2); // M1 is the coordination welcome
  const other = hub.createRoom();
  const x = hub.join(other.project.id, "Xena", "agent").participant;
  const t2 = hub.createThread(x, { title: "Elsewhere", body: "hello" });
  assert.equal(t2.thread.id, 2, "numbers restart in every room");
  assert.equal(t2.message?.id, 2);
  rejects(() => hub.getThread(other.project.id, 99), "thread_not_found");
});

test("mentions resolve names and aliases, unknown names produce a warning", () => {
  const { hub, a, human } = setup();
  const { thread } = hub.createThread(a, { title: "Auth" });
  const r = hub.post(a, thread.id, { body: "@Beta check this, @human too, @Gama does not exist" });
  assert.deepEqual(r.message.mentions.sort(), ["Beta", human.name].sort());
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Gama/);
});

test("loop guard pauses the thread after N agent messages and the human resumes it", () => {
  const { hub, human, a, b } = setup({ maxAgentStreak: 4 });
  const { thread } = hub.createThread(human, { title: "Debate", body: "Pick a database" });
  hub.post(a, thread.id, { body: "I suggest PostgreSQL for relations" });
  hub.post(b, thread.id, { body: "I'd take Redis for cache speed" });
  hub.post(a, thread.id, { body: "Redis has no relations, we need joins" });
  const r = hub.post(b, thread.id, { body: "We can do joins in the application, fine" });
  assert.equal(r.thread.status, "human_needed");
  rejects(() => hub.post(a, thread.id, { body: "One more argument for Postgres" }), "waiting_for_human");
  rejects(() => hub.setThreadStatus(a, thread.id, "open"), "waiting_for_human");
  const h = hub.post(human, thread.id, { body: "PostgreSQL it is." });
  assert.equal(h.thread.status, "open");
  assert.equal(h.thread.agent_streak, 0);
  hub.post(a, thread.id, { body: "Understood, writing migrations" });
});

test("repetition guard refuses near-identical messages from the same agent", () => {
  const { hub, a } = setup();
  const { thread } = hub.createThread(a, { title: "Bug" });
  hub.post(a, thread.id, { body: "The bug is in auth.ts line 40, the token check is missing" });
  rejects(() => hub.post(a, thread.id, { body: "The bug is in auth.ts line 40 – the token check is missing!" }), "repetition");
  hub.post(a, thread.id, { body: "Tried another approach: check in middleware" });
});

test("evidence is verified against real files, hallucinated evidence is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "ruch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "auth.ts"), "export function login() {\n  const token = sign(user);\n  return token;\n}\n");
  const { hub, a } = setup({ projectRoot: root });
  const { thread } = hub.createThread(a, { title: "Review" });
  const ok = hub.post(a, thread.id, { kind: "review", body: "Token signed without expiry", evidence: [{ type: "file", path: "src/auth.ts", lines: "2", quote: "const token = sign(user);" }] });
  assert.equal(ok.message.evidence_status, "verified");
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/auth.ts", quote: "jwt.verify(token)" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/auth.ts", lines: "40-50" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/nope.ts" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "../../etc/passwd" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "answer", body: "x", evidence: [{ type: "message", id: 9999 }] }), "evidence_invalid");
  const msgRef = hub.post(a, thread.id, { kind: "answer", body: "see earlier", evidence: [{ type: "message", id: ok.message.id }] });
  assert.equal(msgRef.message.evidence_status, "verified");
  const missing = hub.post(a, thread.id, { kind: "decision", body: "We use JWT" });
  assert.equal(missing.message.evidence_status, "missing");
});

test("questions: answers go to shared memory, guesses do not, similar questions are surfaced", () => {
  const { hub, human, a, b } = setup();
  const q = hub.ask(a, { to: "human", body: "Which database do we use in production?", options: ["PostgreSQL", "MySQL"] });
  assert.equal(q.question.target, human.name);
  const ans = hub.answer(human, q.question.id, { body: "", choice: "A) PostgreSQL" });
  assert.equal(ans.question.status, "answered");
  const k = hub.getKnowledge(human.project_id, ans.question.knowledge_id!);
  assert.equal(k.trust, "human");
  assert.equal(hub.searchKnowledge(a.project_id, "databases production")[0]?.id, k.id);
  const again = hub.ask(b, { body: "What database runs in production?" });
  assert.equal(again.similar_knowledge[0]?.id, k.id);
  const g = hub.ask(b, { to: "Alfa", body: "How many users do we have?" });
  assert.equal(hub.answer(a, g.question.id, { body: "About a thousand", confidence: "guess" }).question.knowledge_id, null);
  rejects(() => hub.answer(b, again.question.id, { body: "self" }), "own_question");
  rejects(() => hub.ask(a, { to: "Nobody", body: "?" }), "unknown_participant");
});

test("waitForAnswer resolves when the question is answered", async () => {
  const { hub, a, b } = setup();
  const q = hub.ask(a, { to: "Beta", body: "Where is the config?" });
  const waiting = hub.waitForAnswer(a.project_id, q.question.id, 2000);
  setTimeout(() => hub.answer(b, q.question.id, { body: "In config.ts", confidence: "certain" }), 20);
  const res = await waiting;
  assert.equal(res.status, "answered");
  assert.equal(res.answered_by, "Beta");
});

test("file claims: overlapping paths conflict, own claims refresh, release frees them", () => {
  const { hub, a, b } = setup();
  assert.deepEqual(hub.claim(a, { paths: ["src/db/", "README.md"] }).granted, ["src/db", "README.md"]);
  const r2 = hub.claim(b, { paths: ["src/db/schema.ts", "src/api.ts"] });
  assert.deepEqual(r2.granted, ["src/api.ts"]);
  assert.equal(r2.conflicts[0].holder, "Alfa");
  assert.equal(hub.claim(a, { paths: ["./src/db"] }).granted.length, 1);
  hub.release(a);
  assert.equal(hub.claim(b, { paths: ["src/db/schema.ts"] }).granted.length, 1);
});

test("areas: no overlapping ownership, others can't claim inside unless forced in the open", () => {
  const { hub, a, b } = setup();
  hub.setArea(a, { paths: ["src/api/"], rules: "keep the JSON shape" });
  rejects(() => hub.setArea(b, { paths: ["src/api/cart.ts"] }), "area_taken");
  hub.setArea(b, { paths: ["web/"] });
  const blocked = hub.claim(b, { paths: ["src/api/cart.ts"] });
  assert.equal(blocked.granted.length, 0);
  assert.equal(blocked.area_conflicts[0].owner, "Alfa");
  assert.equal(blocked.area_conflicts[0].rules, "keep the JSON shape");
  assert.equal(hub.claim(a, { paths: ["src/api/cart.ts"] }).granted.length, 1, "owner can claim");
  hub.release(a);
  const forced = hub.claim(b, { paths: ["src/api/cart.ts"], force: true, reason: "Alfa offline, hotfix" });
  assert.equal(forced.granted.length, 1);
  const coord = hub.getThread(b.project_id, 1);
  assert.match(coord.messages.at(-1)!.body, /editing inside other areas/);
});

test("requests: owner does it, requester reviews, feedback sends it back, approval closes it", () => {
  const { hub, a, b } = setup();
  hub.setArea(b, { paths: ["web/"] });
  const task = hub.request(a, { to: "Beta", what: "Add a cart badge", details: "show item count" });
  assert.equal(task.assignee, "Beta");
  assert.equal(task.created_by, "Alfa");
  assert.match(hub.inbox(b).messages.map((m) => m.body).join("\n"), /request #1: Add a cart badge/);
  hub.updateTask(b, task.id, { status: "review" });
  assert.match(hub.inbox(a).messages.map((m) => m.body).join("\n"), /#1 is ready for your review/);
  assert.equal(hub.briefing(a).to_review.length, 1);
  rejects(() => hub.feedback(b, task.id, "looks fine"), "own_task");
  assert.equal(hub.feedback(a, task.id, "count is off by one").status, "doing");
  assert.match(hub.inbox(b).messages.map((m) => m.body).join("\n"), /feedback on #1.*off by one/);
  hub.updateTask(b, task.id, { status: "review" });
  rejects(() => hub.updateTask(b, task.id, { status: "done" }), "self_review");
  assert.equal(hub.updateTask(a, task.id, { status: "done" }).status, "done");
  assert.match(hub.inbox(b).messages.map((m) => m.body).join("\n"), /#1 approved/);
});

test("start/end: check-in announces plan and area and asks for constraints; check-out releases everything", () => {
  const { hub, a, b } = setup({ maxAgentStreak: 3 });
  hub.checkIn(b, { plan: "build the UI", paths: ["web/"], rules: "no inline styles" });
  const r = hub.checkIn(a, { plan: "build the API", paths: ["src/api/"] });
  assert.match(r.message.body, /Starting: build the API\nMy area: src\/api\n@Beta any constraints/);
  assert.equal(r.briefing.areas.find((x) => x.owner === "Beta")?.rules, "no inline styles");
  // Coordination notices don't trip the loop guard.
  for (let i = 0; i < 5; i++) hub.request(a, { to: "Beta", what: `thing ${i}` });
  assert.equal(hub.getThread(a.project_id, 1).thread.status, "open");
  hub.claim(a, { paths: ["src/api/x.ts"] });
  const end = hub.checkOut(a, { summary: "API done", left: ["pagination"] });
  assert.match(end.message.body, /Done, signing off: API done\nLeft for anyone:\n- pagination/);
  assert.equal(hub.listClaims(a.project_id).length, 0);
  assert.equal(hub.listAreas(a.project_id).some((x) => x.owner === "Alfa"), false);
  assert.match(hub.participantView(hub.identify(a.project_id, "Alfa", "agent", null)).status_text, /^finished/);
});

test("agent secrets: a fresh join claims the name; others cannot use or re-join it", () => {
  const { hub, pid } = setup();
  const first = hub.join(pid, "Gamma", "agent", { fresh: true });
  assert.ok(first.secret);
  rejects(() => hub.identify(pid, "Gamma", "agent", null), "name_owned");
  rejects(() => hub.identify(pid, "Gamma", "agent", "WRONG"), "name_owned");
  assert.equal(hub.identify(pid, "Gamma", "agent", first.secret!).name, "Gamma");
  rejects(() => hub.join(pid, "Gamma", "agent", { fresh: true }), "name_in_use");
  rejects(() => hub.join(pid, "Alfa", "agent", { fresh: true }), "name_in_use"); // active recently, even without a secret
});

test("tasks: no taking active work of others, no self-approval", () => {
  const { hub, human, a, b } = setup();
  const t = hub.createTask(human, { title: "Login" });
  hub.updateTask(a, t.id, { take: true });
  rejects(() => hub.updateTask(b, t.id, { take: true }), "task_taken");
  rejects(() => hub.updateTask(a, t.id, { status: "done" }), "review_required");
  hub.updateTask(a, t.id, { status: "review" });
  rejects(() => hub.updateTask(a, t.id, { status: "done" }), "self_review");
  assert.equal(hub.updateTask(b, t.id, { status: "done" }).status, "done");
});

test("knowledge: agent decisions need evidence, human knowledge cannot be overwritten by agents", () => {
  const { hub, human, a } = setup();
  rejects(() => hub.addKnowledge(a, { kind: "decision", title: "We use Redis", body: "..." }), "evidence_required");
  const hk = hub.addKnowledge(human, { kind: "decision", title: "Stack", body: "Next.js + Postgres" });
  rejects(() => hub.addKnowledge(a, { kind: "fact", title: "Stack", body: "Remix", supersedes: hk.id }), "human_knowledge");
  assert.equal(hub.getKnowledge(a.project_id, hk.id).status, "active");
  hub.disputeKnowledge(a, hk.id, "package.json says Remix");
  assert.equal(hub.getKnowledge(a.project_id, hk.id).status, "disputed");
  assert.equal(hub.verifyKnowledge(human, hk.id).status, "active");
});

test("inbox returns only relevant news once and advances the cursor", () => {
  const { hub, human, a, b } = setup();
  const t1 = hub.createThread(a, { title: "Mine", body: "Starting" }).thread;
  const t2 = hub.createThread(b, { title: "Other", body: "Just for me" }).thread;
  hub.inbox(a);
  hub.post(b, t1.id, { body: "Added tests" });
  hub.post(b, t2.id, { body: "Another note for myself" });
  hub.post(b, t2.id, { body: "@Alfa I need you here" });
  hub.post(human, t2.id, { body: "Mind the deadline" });
  assert.deepEqual(hub.inbox(a).messages.map((m) => m.body), ["Added tests", "@Alfa I need you here", "Mind the deadline"]);
  assert.equal(hub.inbox(a).messages.length, 0);
  hub.post(b, t2.id, { body: "One more thing about it" });
  assert.equal(hub.inbox(a).messages.length, 1);
});

test("rate limit and room limits stop flooding", () => {
  const { hub, a, pid } = setup({ maxMessagesPerMinute: 3, maxAgentStreak: 100, limits: { ...DEFAULT_CONFIG.limits, threads: 3, agents: 3 } });
  const { thread } = hub.createThread(a, { title: "Spam" });
  hub.post(a, thread.id, { body: "one" });
  hub.post(a, thread.id, { body: "two" });
  hub.post(a, thread.id, { body: "three" });
  rejects(() => hub.post(a, thread.id, { body: "four" }), "rate_limited");
  hub.createThread(a, { title: "third" });
  rejects(() => hub.createThread(a, { title: "fourth" }), "room_full");
  hub.join(pid, "Third", "agent");
  rejects(() => hub.join(pid, "Fourth", "agent"), "room_full");
});

test("participant names are validated and kinds cannot be hijacked", () => {
  const { hub, pid } = setup();
  rejects(() => hub.join(pid, "human", "agent"), "reserved_name");
  rejects(() => hub.join(pid, "two words", "agent"), "bad_name");
  hub.join(pid, "Jarda", "human");
  rejects(() => hub.join(pid, "Jarda", "agent"), "name_taken");
});

test("room keys: tolerant input, owner vs agent role, rotation revokes, rooms are isolated", () => {
  const { hub, room, human } = setup();
  assert.match(room.agentCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(hub.authenticate(room.agentCode.toLowerCase().replace(/-/g, " "))?.role, "agent");
  assert.equal(hub.authenticate(room.ownerKey)?.role, "owner");
  assert.equal(hub.authenticate("AAAA-BBBB-CCCC"), null);
  assert.equal(hub.agentCodeFor(room.ownerKey, room.project), room.agentCode);
  const fresh = hub.rotateAgentCode(human, room.ownerKey);
  assert.equal(hub.authenticate(room.agentCode), null);
  assert.equal(hub.authenticate(fresh)?.project.id, room.project.id);
  const other = hub.createRoom();
  const x = hub.join(other.project.id, "Alfa", "agent").participant;
  assert.equal(hub.inbox(x).messages.length, 0);
  hub.checkIn(hub.join(other.project.id, "Yuri", "agent").participant, { plan: "docs" });
  assert.match(hub.inbox(x).messages[0].body, /Starting: docs/, "agents follow the coordination thread");
});

test("export, delete, cleanup and backup", () => {
  const { hub, a, human, pid } = setup({ roomTtlDays: 1 });
  hub.createThread(a, { title: "x", body: "message" });
  const ex = hub.exportRoom(pid);
  assert.equal(ex.format, "ruch-export-1");
  assert.equal(ex.threads.length, 2);
  rejects(() => hub.deleteRoom(a), "human_only");
  const dir = mkdtempSync(join(tmpdir(), "ruch-bak-"));
  const file = hub.backup(dir, 2);
  assert.equal(new DatabaseSync(file).prepare("SELECT COUNT(*) AS c FROM projects").get()!.c, 1);
  hub.backup(dir, 2);
  hub.backup(dir, 2);
  assert.ok(readdirSync(dir).length <= 2);
  hub.deleteRoom(human);
  assert.equal(hub.stats().rooms, 0);
  const again = setup({ roomTtlDays: 1 });
  (again.hub as any).db.prepare("UPDATE projects SET last_active_at = '2000-01-01T00:00:00Z'").run();
  assert.equal(again.hub.cleanup().roomsDeleted, 1);
});

test("a v2 database is migrated to room-local numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruch-mig-"));
  const path = join(dir, "v2.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', agent_key_hash TEXT NOT NULL UNIQUE, owner_key_hash TEXT NOT NULL UNIQUE, code_rotation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '2026-01-01', last_active_at TEXT NOT NULL DEFAULT '2099-01-01');
    CREATE TABLE participants (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', status_text TEXT NOT NULL DEFAULT '', inbox_cursor INTEGER NOT NULL DEFAULT 0, thread_cursor INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT '', UNIQUE (project_id, name));
    CREATE TABLE threads (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, parent_id INTEGER, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', status_reason TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', agent_streak INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE messages (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, author_id INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', reply_to INTEGER, evidence TEXT NOT NULL DEFAULT '[]', evidence_status TEXT NOT NULL DEFAULT 'none', confidence TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE questions (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, message_id INTEGER NOT NULL, asked_by INTEGER, target_id INTEGER, body TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', blocking INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', answer_message_id INTEGER, answered_by INTEGER, knowledge_id INTEGER, created_at TEXT NOT NULL DEFAULT '', answered_at TEXT);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]', trust TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', status_note TEXT NOT NULL DEFAULT '', superseded_by INTEGER, author_id INTEGER, source_message_id INTEGER, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, thread_id INTEGER, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', assignee_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO projects (id, name, agent_key_hash, owner_key_hash) VALUES (1, 'A', 'a1', 'o1'), (2, 'B', 'a2', 'o2');
    INSERT INTO participants (id, project_id, name, kind) VALUES (1, 1, 'Alfa', 'agent'), (2, 2, 'Beta', 'agent');
    INSERT INTO threads (id, project_id, title) VALUES (1, 1, 'a-1'), (2, 2, 'b-1'), (3, 1, 'a-2');
    INSERT INTO messages (id, project_id, thread_id, author_id, kind, body) VALUES (1, 1, 1, 1, 'chat', 'x'), (2, 2, 2, 2, 'chat', 'y'), (3, 1, 3, 1, 'chat', 'z');
    UPDATE messages SET reply_to = 1 WHERE id = 3;
    PRAGMA user_version = 2;
  `);
  db.close();
  const hub = new Hub(openDatabase(path), DEFAULT_CONFIG);
  const alfa = hub.identify(1, "Alfa", "agent", null);
  const t = hub.getThread(1, 2);
  assert.equal(t.thread.title, "a-2");
  assert.equal(t.messages[0].id, 2);
  assert.equal(t.messages[0].reply_to, 1);
  const next = hub.createThread(alfa, { title: "new" });
  assert.ok(next.thread.id >= 3);
  assert.equal(hub.getThread(2, 1).thread.title, "b-1");
});
