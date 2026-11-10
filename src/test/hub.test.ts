import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.js";
import { inboxText } from "../format.js";
import { DEFAULT_CONFIG, Hub, HubError } from "../hub.js";
import { parseEvidence } from "../tools.js";
import { DatabaseSync } from "node:sqlite";

function setup(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const hub = new Hub(openDatabase(":memory:"), { ...DEFAULT_CONFIG, ...overrides });
  const room = hub.createRoom({ name: "Test" });
  const pid = room.project.id;
  const human = room.human;
  const a = hub.join(pid, "Alfa", "agent", "coder");
  const b = hub.join(pid, "Beta", "agent", "reviewer");
  return { hub, human, a, b, pid, room };
}

function rejects(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof HubError && e.code === code, `expected HubError ${code}`);
}

test("mentions resolve names and aliases, unknown names produce a warning", () => {
  const { hub, a } = setup();
  const { thread } = hub.createThread(a, { title: "Auth" });
  const r = hub.post(a, thread.id, { body: "@Beta mrkni na to, @human taky, @Gama neexistuje" });
  assert.deepEqual(r.message.mentions.sort(), ["Beta", DEFAULT_CONFIG.humanName].sort());
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Gama/);
});

test("loop breaker pauses the thread after N agent messages and a human resumes it", () => {
  const { hub, human, a, b } = setup({ maxAgentStreak: 4 });
  const { thread } = hub.createThread(human, { title: "Debata", body: "Vyberte databázi" });
  hub.post(a, thread.id, { body: "Navrhuju PostgreSQL kvůli relacím" });
  hub.post(b, thread.id, { body: "Já bych bral Redis kvůli rychlosti cache" });
  hub.post(a, thread.id, { body: "Redis nemá relace, potřebujeme joiny" });
  const r = hub.post(b, thread.id, { body: "Joiny můžeme řešit v aplikaci, je to OK" });
  assert.equal(r.thread.status, "human_needed");
  rejects(() => hub.post(a, thread.id, { body: "Ještě jeden argument pro Postgres" }), "waiting_for_human");
  rejects(() => hub.setThreadStatus(a, thread.id, "open"), "waiting_for_human");
  const h = hub.post(human, thread.id, { body: "Bereme PostgreSQL." });
  assert.equal(h.thread.status, "open");
  assert.equal(h.thread.agent_streak, 0);
  hub.post(a, thread.id, { body: "Rozumím, jdu na migrace" });
});

test("repetition guard refuses near-identical messages from the same agent", () => {
  const { hub, a } = setup();
  const { thread } = hub.createThread(a, { title: "Bug" });
  hub.post(a, thread.id, { body: "Chyba je v souboru auth.ts na řádku 40, chybí kontrola tokenu" });
  rejects(() => hub.post(a, thread.id, { body: "Chyba je v souboru auth.ts na řádku 40 – chybí kontrola tokenu!" }), "repetition");
  hub.post(a, thread.id, { body: "Zkusil jsem jiný přístup: kontrola v middleware" });
});

test("evidence is verified against real files, hallucinated evidence is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "ruch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "auth.ts"), "export function login() {\n  const token = sign(user);\n  return token;\n}\n");
  const { hub, a } = setup({ projectRoot: root });
  const { thread } = hub.createThread(a, { title: "Review" });

  const ok = hub.post(a, thread.id, {
    kind: "review",
    body: "Token se podepisuje bez expirace",
    evidence: [{ type: "file", path: "src/auth.ts", lines: "2", quote: "const token = sign(user);" }],
  });
  assert.equal(ok.message.evidence_status, "verified");

  rejects(
    () => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/auth.ts", quote: "jwt.verify(token)" }] }),
    "evidence_invalid",
  );
  rejects(
    () => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/auth.ts", lines: "40-50" }] }),
    "evidence_invalid",
  );
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "src/nope.ts" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "review", body: "x", evidence: [{ type: "file", path: "../../etc/passwd" }] }), "evidence_invalid");
  rejects(() => hub.post(a, thread.id, { kind: "answer", body: "x", evidence: [{ type: "message", id: 9999 }] }), "evidence_invalid");

  const missing = hub.post(a, thread.id, { kind: "decision", body: "Bereme JWT" });
  assert.equal(missing.message.evidence_status, "missing");
  assert.ok(missing.warnings.some((w) => /without evidence/.test(w)));
});

test("questions: answers go to shared memory, guesses do not, similar questions are surfaced", () => {
  const { hub, human, a, b } = setup();
  const q = hub.ask(a, { to: "human", body: "Jakou databázi používáme v produkci?", options: ["PostgreSQL", "MySQL"] });
  assert.equal(q.question.target, DEFAULT_CONFIG.humanName);
  assert.equal(q.similar_knowledge.length, 0);

  const ans = hub.answer(human, q.question.id, { body: "", choice: "A) PostgreSQL" });
  assert.equal(ans.question.status, "answered");
  assert.ok(ans.question.knowledge_id);
  const k = hub.getKnowledge(human.project_id, ans.question.knowledge_id!);
  assert.equal(k.trust, "human");

  // diacritics-insensitive search finds the stored answer
  const found = hub.searchKnowledge(a.project_id, "databaze produkce");
  assert.equal(found[0]?.id, k.id);
  const again = hub.ask(b, { body: "Jaká databáze je v produkci?" });
  assert.equal(again.similar_knowledge[0]?.id, k.id);

  const g = hub.ask(b, { to: "Alfa", body: "Kolik máme uživatelů?" });
  const ga = hub.answer(a, g.question.id, { body: "Asi kolem tisíce", confidence: "guess" });
  assert.equal(ga.question.knowledge_id, null);
  rejects(() => hub.answer(b, again.question.id, { body: "sám sobě" }), "own_question");
  rejects(() => hub.ask(a, { to: "Nikdo", body: "?" }), "unknown_participant");
});

test("waitForAnswer resolves when the question is answered", async () => {
  const { hub, a, b } = setup();
  const q = hub.ask(a, { to: "Beta", body: "Kde je konfigurace?" });
  const waiting = hub.waitForAnswer(a.project_id, q.question.id, 2000);
  setTimeout(() => hub.answer(b, q.question.id, { body: "V config.ts", confidence: "certain" }), 20);
  const res = await waiting;
  assert.equal(res.status, "answered");
  assert.equal(res.answered_by, "Beta");
});

test("file claims: overlapping paths conflict, own claims refresh, release frees them", () => {
  const { hub, a, b } = setup();
  const r1 = hub.claim(a, { paths: ["src/db/", "README.md"], reason: "migrace" });
  assert.deepEqual(r1.granted, ["src/db", "README.md"]);
  const r2 = hub.claim(b, { paths: ["src/db/schema.ts", "src/api.ts"] });
  assert.deepEqual(r2.granted, ["src/api.ts"]);
  assert.equal(r2.conflicts[0].holder, "Alfa");
  assert.equal(hub.claim(a, { paths: ["./src/db"] }).granted.length, 1); // refresh, not conflict
  assert.equal(hub.listClaims(a.project_id).length, 3);
  hub.release(a);
  assert.equal(hub.claim(b, { paths: ["src/db/schema.ts"] }).granted.length, 1);
});

test("tasks: no taking active work of others, no self-approval", () => {
  const { hub, human, a, b } = setup();
  const t = hub.createTask(human, { title: "Přihlášení" });
  hub.updateTask(a, t.id, { take: true });
  rejects(() => hub.updateTask(b, t.id, { take: true }), "task_taken");
  rejects(() => hub.updateTask(a, t.id, { status: "done" }), "review_required");
  hub.updateTask(a, t.id, { status: "review" });
  rejects(() => hub.updateTask(a, t.id, { status: "done" }), "self_review");
  assert.equal(hub.updateTask(b, t.id, { status: "done" }).status, "done");
});

test("knowledge: agent decisions need evidence, human knowledge cannot be overwritten by agents", () => {
  const { hub, human, a } = setup();
  rejects(() => hub.addKnowledge(a, { kind: "decision", title: "Používáme Redis", body: "..." }), "evidence_required");
  const hk = hub.addKnowledge(human, { kind: "decision", title: "Stack", body: "Next.js + Postgres" });
  rejects(() => hub.addKnowledge(a, { kind: "fact", title: "Stack", body: "Remix", supersedes: hk.id }), "human_knowledge");
  assert.equal(hub.getKnowledge(a.project_id, hk.id).status, "active"); // rolled back
  hub.disputeKnowledge(a, hk.id, "v package.json je Remix");
  assert.equal(hub.getKnowledge(a.project_id, hk.id).status, "disputed");
  assert.equal(hub.verifyKnowledge(human, hk.id).status, "active");
});

test("inbox returns only relevant news once and advances the cursor", () => {
  const { hub, human, a, b } = setup();
  const t1 = hub.createThread(a, { title: "Moje", body: "Začínám" }).thread;
  const t2 = hub.createThread(b, { title: "Cizí", body: "Něco jen pro mě" }).thread;
  hub.inbox(a); // drain
  hub.post(b, t1.id, { body: "Přidal jsem testy" }); // in Alfa's thread -> relevant
  hub.post(b, t2.id, { body: "Další poznámka pro sebe" }); // not relevant to Alfa
  hub.post(b, t2.id, { body: "@Alfa tady tě potřebuju" }); // mention -> relevant
  hub.post(human, t2.id, { body: "Pozor na termín" }); // human -> relevant
  const ib = hub.inbox(a);
  assert.deepEqual(
    ib.messages.map((m) => m.body),
    ["Přidal jsem testy", "@Alfa tady tě potřebuju", "Pozor na termín"],
  );
  assert.equal(hub.inbox(a).messages.length, 0);
  // Alfa was mentioned in T2, so further T2 messages are now relevant to Alfa
  hub.post(b, t2.id, { body: "Ještě jedna věc k tomu" });
  assert.equal(hub.inbox(a).messages.length, 1);
});

test("rate limit stops an agent from flooding", () => {
  const { hub, a } = setup({ maxMessagesPerMinute: 3, maxAgentStreak: 100 });
  const { thread } = hub.createThread(a, { title: "Spam" });
  hub.post(a, thread.id, { body: "jedna" });
  hub.post(a, thread.id, { body: "dvě" });
  hub.post(a, thread.id, { body: "tři" });
  rejects(() => hub.post(a, thread.id, { body: "čtyři" }), "rate_limited");
});

test("participant names are validated and kinds cannot be hijacked", () => {
  const { hub, pid } = setup();
  rejects(() => hub.join(pid, "human", "agent"), "reserved_name");
  rejects(() => hub.join(pid, "dva slova", "agent"), "bad_name");
  hub.join(pid, "Jarda", "human");
  rejects(() => hub.join(pid, "Jarda", "agent"), "name_taken");
});

test("rooms: codes are case/format tolerant, owner and agent roles differ, rotation revokes", () => {
  const { hub, room, human } = setup();
  assert.match(room.agentCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(hub.authenticate(room.agentCode.toLowerCase().replace(/-/g, " "))?.role, "agent");
  assert.equal(hub.authenticate(room.ownerKey)?.role, "owner");
  assert.equal(hub.authenticate("AAAA-BBBB-CCCC"), null);
  assert.equal(hub.agentCodeFor(room.ownerKey, room.project), room.agentCode);
  const fresh = hub.rotateAgentCode(human, room.ownerKey);
  assert.notEqual(fresh, room.agentCode);
  assert.equal(hub.authenticate(room.agentCode), null);
  assert.equal(hub.authenticate(fresh)?.project.id, room.project.id);
  // rooms are isolated
  const other = hub.createRoom();
  const x = hub.join(other.project.id, "Alfa", "agent");
  rejects(() => hub.getThread(other.project.id, hub.createThread(human, { title: "tajné" }).thread.id), "thread_not_found");
  assert.equal(hub.inbox(x).messages.length, 0);
});

test("cleanup deletes inactive rooms with all their data", () => {
  const { hub, a, pid } = setup({ roomTtlDays: 1 });
  hub.createThread(a, { title: "x", body: "zpráva" });
  (hub as any).db.prepare("UPDATE projects SET last_active_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(pid);
  assert.equal(hub.cleanup().roomsDeleted, 1);
  assert.equal((hub as any).db.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 0);
});

test("inbox shows standing state once and again only when it changes", () => {
  const { hub, a, b } = setup();
  const { thread } = hub.createThread(a, { title: "API", body: "@Beta mrkni" });
  hub.claim(a, { paths: ["src/api"], reason: "refactor" });
  hub.createTask(a, { title: "Review", assignee: "Beta" });
  hub.ask(a, { body: "Jaký port má staging?", thread_id: thread.id });

  const first = inboxText(hub.inbox(b));
  assert.match(first, /Questions for you[\s\S]*Q1 /);
  assert.match(first, /Your tasks:\n #1 todo Review/);
  assert.match(first, /Locked by others[^\n]*\n src\/api Alfa \(refactor\)/);
  // The question is listed as a question, not a second time as a message.
  assert.equal(first.match(/Jaký port/g)?.length, 1);

  assert.equal(inboxText(hub.inbox(b)), "Nothing new.");
  hub.post(a, thread.id, { body: "Hotovo, testy prošly" });
  assert.equal(inboxText(hub.inbox(b)), `T${thread.id}:\n M3 Alfa: Hotovo, testy prošly`);

  hub.release(a);
  assert.equal(inboxText(hub.inbox(b)), "Locked by others (don't edit): none");
  assert.match(inboxText(hub.inbox(b, { all: true })), /Still open for you: Q1\nYour tasks:/);
});

test("answers reach the asker once, merged with the answer message", () => {
  const { hub, human, a } = setup();
  const { question } = hub.ask(a, { to: "human", body: "Nasadit?", options: ["Ano", "Ne"] });
  hub.inbox(a);
  hub.answer(human, question.id, { body: "", choice: "A) Ano" });
  assert.equal(inboxText(hub.inbox(a)), 'Answers to your questions:\nQ1 "Nasadit?" ✓ Supervizor [certain]: Volba: A) Ano (K1)');
  assert.equal(inboxText(hub.inbox(a)), "Nothing new.");
});

test("waiting is not woken by a question the agent has already seen", async () => {
  const { hub, a, b } = setup();
  hub.ask(a, { body: "Ví někdo, kde je konfigurace?" });
  assert.equal(hub.pending(b), 1);
  assert.equal(await hub.waitForActivity(b, 1000), true);
  hub.inbox(b);
  assert.equal(hub.pending(b), 0);
  // Before: an open question to anyone made every wait return at once, so an idle agent spun in a loop.
  assert.equal(await hub.waitForActivity(b, 30), false);
  const waiting = hub.waitForActivity(b, 2000);
  hub.ask(a, { to: "Beta", body: "A kde jsou testy?" });
  assert.equal(await waiting, true);
});

test("MCP evidence strings parse into the same evidence as the CLI flags", () => {
  assert.deepEqual(parseEvidence(["src/a.ts:10-20 | const x = 1 | 2", "M12", "k3", "$ npm test | 12 passed", "https://x.dev/a", "README.md"]), [
    { type: "file", path: "src/a.ts", lines: "10-20", quote: "const x = 1 | 2" },
    { type: "message", id: 12 },
    { type: "knowledge", id: 3 },
    { type: "command", command: "npm test", output: "12 passed" },
    { type: "url", url: "https://x.dev/a" },
    { type: "file", path: "README.md", lines: undefined, quote: undefined },
  ]);
  assert.equal(parseEvidence([]), undefined);
});

test("a version 2 database is upgraded in place", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ruch-db-")), "hub.db");
  const hub = new Hub(openDatabase(file));
  const room = hub.createRoom({ name: "Staré" });
  hub.join(room.project.id, "Alfa", "agent");
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE participants DROP COLUMN q_cursor; ALTER TABLE participants DROP COLUMN digest; PRAGMA user_version = 2");
  raw.close();
  const again = new Hub(openDatabase(file));
  const alfa = again.join(room.project.id, "Alfa", "agent");
  assert.equal(inboxText(again.inbox(alfa)), "Nothing new.");
});
