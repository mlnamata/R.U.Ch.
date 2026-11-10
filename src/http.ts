import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, bool, dflt, int, nul, obj, oneOf, opt, str, tagged, ValidationError, type V } from "./validate.js";
import { Hub, HubError } from "./hub.js";
import { RuchClient } from "./client.js";
import type { ServerConfig } from "./config.js";
import {
  claimLine,
  inboxText,
  knowledgeLine,
  messageLine,
  questionLine,
  taskLine,
  threadHeader,
  threadText,
  type InboxView,
} from "./format.js";
import type { Claim, Evidence, HubEvent, Knowledge, Message, Participant, Project, Question, Task, Thread } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 1_000_000;

// ------------------------------------------------------------------ request schemas

const evidence = arr(
  tagged<Evidence>("type", {
    file: obj({ type: str(), path: str({ min: 1 }), lines: opt(str()), quote: opt(str()), checked: opt(bool) }) as V<Evidence>,
    message: obj({ type: str(), id: int() }) as V<Evidence>,
    knowledge: obj({ type: str(), id: int() }) as V<Evidence>,
    command: obj({ type: str(), command: str({ min: 1 }), output: opt(str()) }) as V<Evidence>,
    url: obj({ type: str(), url: str({ min: 1 }) }) as V<Evidence>,
  }),
  { max: 20 },
);
const confidence = oneOf("certain", "likely", "guess");
const strs = arr(str(), { max: 50 });
const S = {
  room: obj({ name: opt(str({ max: 80 })), human_name: opt(str({ max: 40 })), token: opt(str()) }),
  join: obj({ role: opt(str({ max: 60 })) }),
  status: obj({ text: str() }),
  project: obj({ name: opt(str()), brief: opt(str()) }),
  thread: obj({ title: str(), body: opt(str()), parent_id: nul(int()), mentions: opt(strs) }),
  message: obj({
    kind: opt(oneOf("chat", "question", "answer", "decision", "handoff", "review", "status")),
    body: str(),
    mentions: opt(strs),
    reply_to: nul(int()),
    evidence: opt(evidence),
    confidence: nul(confidence),
  }),
  threadStatus: obj({ status: oneOf("open", "human_needed", "resolved"), reason: opt(str()) }),
  summary: obj({ summary: str() }),
  ask: obj({
    to: nul(str()),
    body: str(),
    thread_id: nul(int()),
    options: opt(arr(str(), { max: 6 })),
    blocking: opt(bool),
    wait_seconds: opt(int({ min: 0, max: 300 })),
  }),
  answer: obj({ body: dflt(str(), ""), confidence: opt(confidence), evidence: opt(evidence), choice: nul(str()) }),
  cancel: obj({ reason: opt(str()) }),
  knowledge: obj({
    kind: oneOf("answer", "decision", "fact", "note"),
    title: str(),
    body: str(),
    tags: opt(str()),
    evidence: opt(evidence),
    supersedes: nul(int()),
  }),
  dispute: obj({ reason: str() }),
  claim: obj({ paths: arr(str(), { min: 1, max: 100 }), reason: opt(str()), minutes: opt(int()), thread_id: nul(int()) }),
  release: obj({ paths: opt(strs) }),
  check: obj({ paths: arr(str(), { min: 1, max: 100 }) }),
  task: obj({ title: str(), details: opt(str()), assignee: nul(str()), thread_id: nul(int()) }),
  taskPatch: obj({
    status: opt(oneOf("todo", "doing", "review", "done", "blocked")),
    assignee: nul(str()),
    details: opt(str()),
    take: opt(bool),
  }),
  handoff: obj({
    thread_id: int(),
    to: nul(str()),
    summary: str(),
    done: opt(strs),
    next: opt(strs),
    risks: opt(strs),
    evidence: opt(evidence),
  }),
  escalate: obj({ thread_id: int(), problem: str(), options: arr(str(), { min: 1, max: 6 }), recommendation: opt(str()) }),
};

// ------------------------------------------------------------------ plumbing

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  me: Participant;
  role: "agent" | "owner";
  key: string;
  body: <T>(schema: V<T>) => Promise<T>;
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
/** Renders a route's result as compact text for agents (Accept: text/plain). */
type TextFn = (out: any) => string;

const warn = (w?: string[]) => (w?.length ? "\n" + w.map((x) => `! ${x}`).join("\n") : "");

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function sendText(res: ServerResponse, status: number, text: string, type = "text/plain") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HubError(413, "too_large", "Request too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError(400, "bad_json", "Request body is not valid JSON.");
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const h = req.headers[name];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function clientIp(req: IncomingMessage) {
  const fwd = header(req, "x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) ?? "?";
}

/** Fixed-window counter per key; small and self-pruning. */
class Limiter {
  private m = new Map<string, { n: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  hit(key: string): boolean {
    const t = Date.now();
    const e = this.m.get(key);
    if (!e || e.reset < t) {
      if (this.m.size > 50_000) this.prune();
      this.m.set(key, { n: 1, reset: t + this.windowMs });
      return true;
    }
    e.n++;
    return e.n <= this.max;
  }
  prune() {
    const t = Date.now();
    for (const [k, e] of this.m) if (e.reset < t) this.m.delete(k);
  }
}

const STATIC: Record<string, [string, string]> = {
  "/": ["web/index.html", "text/html"],
  "/app.js": ["web/app.js", "text/javascript"],
  "/style.css": ["web/style.css", "text/css"],
};

export function createHttpServer(hub: Hub, cfg: ServerConfig): Server {
  const routes: Array<[string, RegExp, Handler, TextFn | undefined]> = [];
  const route = (method: string, pattern: string, h: Handler, text?: TextFn) =>
    routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(\\d+)") + "$"), h, text]);
  const id = (c: Ctx, i = 0) => Number(c.params[i]);
  const pid = (c: Ctx) => c.me.project_id;
  const qnum = (c: Ctx, k: string) => (c.url.searchParams.get(k) ? Number(c.url.searchParams.get(k)) : undefined);
  const abortOnClose = (c: Ctx) => {
    const ac = new AbortController();
    c.res.on("close", () => ac.abort());
    return ac.signal;
  };
  const publicUrl = (req: IncomingMessage) =>
    cfg.publicUrl ?? `${header(req, "x-forwarded-proto")?.split(",")[0] ?? "http"}://${req.headers.host ?? `127.0.0.1:${cfg.port}`}`;

  const createLimit = new Limiter(cfg.roomsPerIpPerHour, 3_600_000);
  const authFailLimit = new Limiter(30, 600_000);

  // ---------------------------------------------------------------- session & room

  route("GET", "/api/me", (c) => {
    const p = hub.projectById(pid(c));
    return {
      me: hub.participantView(c.me),
      role: c.role,
      project: { id: p.id, name: p.name, brief: p.brief },
      // Only the owner learns the agent code (it is derived from the owner key).
      agent_code: c.role === "owner" ? hub.agentCodeFor(c.key, p) : undefined,
    };
  }, (o) => `You are ${o.me.name} (${o.role === "owner" ? "human" : "agent"}) in "${o.project.name}".${o.project.brief ? `\nBrief: ${o.project.brief}` : ""}`);
  route("POST", "/api/join", async (c) => {
    const b = await c.body(S.join);
    const me = hub.join(pid(c), c.me.name, c.me.kind, b.role);
    return { me: hub.participantView(me), project: hub.projectById(pid(c)) };
  }, (o) => `Joined "${o.project.name}" as ${o.me.name}.${o.project.brief ? `\nBrief: ${o.project.brief}` : ""}`);
  route("GET", "/api/state", (c) => ({ ...hub.state(pid(c)), role: c.role, me: hub.participantView(c.me) }));
  route("POST", "/api/status", async (c) => hub.participantView(hub.setStatus(c.me, (await c.body(S.status)).text)), () => "OK");
  route("PATCH", "/api/project", async (c) => hub.updateProject(c.me, await c.body(S.project)));
  route("POST", "/api/room/rotate", (c) => {
    if (c.role !== "owner") throw new HubError(403, "owner_only", "Only the room owner can change the code.");
    return { agent_code: hub.rotateAgentCode(c.me, c.key) };
  });
  route("GET", "/api/participants", (c) => hub.listParticipants(pid(c)), (o: ReturnType<Hub["listParticipants"]>) =>
    o.map((p) => `${p.name} (${p.kind === "human" ? "human" : p.role || "agent"}${p.online ? "" : ", offline"})${p.status_text ? ` – ${p.status_text}` : ""}`).join("\n"),
  );

  // ---------------------------------------------------------------- inbox (optionally waits)

  route("GET", "/api/inbox", async (c) => {
    const wait = Math.min(qnum(c, "wait") ?? 0, 300);
    if (wait > 0) await hub.waitForActivity(c.me, wait * 1000, abortOnClose(c));
    return hub.inbox(c.me, { peek: c.url.searchParams.get("peek") === "1", all: c.url.searchParams.get("all") === "1" });
  }, (o: InboxView) => inboxText(o));

  // ---------------------------------------------------------------- threads & messages

  route("GET", "/api/threads", (c) => hub.listThreads(pid(c), (c.url.searchParams.get("status") as never) || undefined), (o: Thread[]) =>
    o.length ? o.map(threadHeader).join("\n") : "No threads.",
  );
  route("POST", "/api/threads", async (c) => hub.createThread(c.me, await c.body(S.thread)), (o) =>
    `OK T${o.thread.id}${o.message ? ` M${o.message.id}` : ""}${warn(o.warnings)}`,
  );
  route("GET", "/api/threads/:id", (c) =>
    hub.getThread(pid(c), id(c), { since: qnum(c, "since"), before: qnum(c, "before"), limit: qnum(c, "limit") }),
    (o) => threadText(o),
  );
  const postText = (o: { message: Message; warnings: string[]; thread: Thread }) =>
    `OK M${o.message.id}${warn(o.warnings)}`;
  route("POST", "/api/threads/:id/messages", async (c) => hub.post(c.me, id(c), await c.body(S.message)), postText);
  route("POST", "/api/threads/:id/status", async (c) => {
    const b = await c.body(S.threadStatus);
    return hub.setThreadStatus(c.me, id(c), b.status, b.reason);
  }, threadHeader);
  route("POST", "/api/threads/:id/summary", async (c) => hub.setSummary(c.me, id(c), (await c.body(S.summary)).summary), threadHeader);

  // ---------------------------------------------------------------- questions

  route("GET", "/api/questions", (c) =>
    hub.listQuestions(pid(c), { status: c.url.searchParams.get("status") ?? undefined, for: c.url.searchParams.get("for") === "me" ? c.me : undefined }),
    (o: Question[]) => (o.length ? o.map(questionLine).join("\n") : "No questions."),
  );
  route("POST", "/api/questions", async (c) => {
    const b = await c.body(S.ask);
    const r = hub.ask(c.me, b);
    const question = b.wait_seconds ? await hub.waitForAnswer(pid(c), r.question.id, b.wait_seconds * 1000, abortOnClose(c)) : r.question;
    return { ...r, question };
  }, (o) => {
    let t = questionLine(o.question);
    if (o.question.status === "open") t = `OK Q${o.question.id} T${o.question.thread_id}`;
    if (o.similar_knowledge.length) t += `\nAlready in memory (if it answers you: cancel ${o.question.id}):\n` + o.similar_knowledge.map(knowledgeLine).join("\n");
    return t + warn(o.warnings);
  });
  route("GET", "/api/questions/:id", async (c) => {
    const wait = Math.min(qnum(c, "wait") ?? 0, 300);
    return hub.waitForAnswer(pid(c), id(c), wait * 1000, abortOnClose(c));
  }, questionLine);
  route("POST", "/api/questions/:id/answer", async (c) => hub.answer(c.me, id(c), await c.body(S.answer)), (o) =>
    `OK M${o.message.id}${o.question.knowledge_id ? ` K${o.question.knowledge_id}` : ""}${warn(o.warnings)}`,
  );
  route("POST", "/api/questions/:id/cancel", async (c) => hub.cancelQuestion(c.me, id(c), (await c.body(S.cancel)).reason), questionLine);
  route("POST", "/api/escalate", async (c) => {
    const b = await c.body(S.escalate);
    const r = hub.ask(c.me, {
      to: "human",
      body: b.problem + (b.recommendation ? `\nDoporučení: ${b.recommendation}` : ""),
      thread_id: b.thread_id,
      options: b.options,
      blocking: true,
    });
    hub.setThreadStatus(c.me, b.thread_id, "human_needed", `čeká na odpověď Q${r.question.id}`);
    return r;
  }, (o) => `OK Q${o.question.id}; T${o.question.thread_id} paused for the human – don't post there.`);

  // ---------------------------------------------------------------- knowledge

  route("GET", "/api/knowledge", (c) => hub.searchKnowledge(pid(c), c.url.searchParams.get("q") ?? "", qnum(c, "limit") ?? 6), (o: Knowledge[]) =>
    o.length ? o.map(knowledgeLine).join("\n") : "Nothing in memory.",
  );
  route("POST", "/api/knowledge", async (c) => hub.addKnowledge(c.me, await c.body(S.knowledge)), knowledgeLine);
  route("GET", "/api/knowledge/:id", (c) => hub.getKnowledge(pid(c), id(c)), knowledgeLine);
  route("POST", "/api/knowledge/:id/verify", (c) => hub.verifyKnowledge(c.me, id(c)), knowledgeLine);
  route("POST", "/api/knowledge/:id/dispute", async (c) => hub.disputeKnowledge(c.me, id(c), (await c.body(S.dispute)).reason), knowledgeLine);

  // ---------------------------------------------------------------- claims

  const claimsText = (o: Claim[]) => (o.length ? o.map((c) => claimLine(c)).join("\n") : "No locks.");
  route("GET", "/api/claims", (c) => hub.listClaims(pid(c)), claimsText);
  route("POST", "/api/claims", async (c) => hub.claim(c.me, await c.body(S.claim)), (o) =>
    [o.granted.length ? `Locked: ${o.granted.join(", ")}` : "", o.conflicts.length ? "CONFLICT – don't edit:\n" + o.conflicts.map((c: Claim) => claimLine(c)).join("\n") : ""]
      .filter(Boolean)
      .join("\n") || "Nothing locked.",
  );
  route("POST", "/api/claims/release", async (c) => hub.release(c.me, (await c.body(S.release)).paths), (o) => `Released: ${o.released}`);
  route("POST", "/api/claims/check", async (c) => ({ conflicts: hub.checkPaths(pid(c), (await c.body(S.check)).paths, c.me.id) }), (o) =>
    o.conflicts.length ? o.conflicts.map((c: Claim) => claimLine(c)).join("\n") : "Free.",
  );

  // ---------------------------------------------------------------- tasks & handoff

  route("GET", "/api/tasks", (c) => hub.listTasks(pid(c), { status: c.url.searchParams.get("status") ?? undefined }), (o: Task[]) =>
    o.length ? o.map(taskLine).join("\n") : "No tasks.",
  );
  route("POST", "/api/tasks", async (c) => hub.createTask(c.me, await c.body(S.task)), taskLine);
  route("PATCH", "/api/tasks/:id", async (c) => hub.updateTask(c.me, id(c), await c.body(S.taskPatch)), taskLine);
  route("POST", "/api/handoff", async (c) => hub.handoff(c.me, await c.body(S.handoff)), postText);

  // ---------------------------------------------------------------- auth

  function authenticate(req: IncomingMessage): { me: Participant; role: Ctx["role"]; key: string; project: Project } {
    const h = req.headers.authorization;
    const key = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!key) throw new HubError(401, "no_key", "Missing room code (header Authorization: Bearer <code>).");
    const ip = clientIp(req);
    const auth = hub.authenticate(key);
    if (!auth) {
      if (!authFailLimit.hit(ip)) throw new HubError(429, "too_many_attempts", "Too many invalid codes. Try again in 10 minutes.");
      throw new HubError(401, "bad_key", "Invalid room code. Check it or create a new room.");
    }
    const kind = auth.role === "owner" ? "human" : "agent";
    let name = header(req, "x-ruch-name");
    if (!name) {
      if (kind === "agent") throw new HubError(400, "no_name", "Missing agent name (header X-Ruch-Name).");
      name = hub.listParticipants(auth.project.id).find((p) => p.kind === "human")?.name ?? cfg.hub.humanName;
    }
    const me = hub.join(auth.project.id, name, kind);
    hub.seen(me);
    return { me, role: auth.role, key, project: auth.project };
  }

  // ---------------------------------------------------------------- SSE (auth by header; the UI uses fetch streaming)

  function events(req: IncomingMessage, res: ServerResponse) {
    const { me } = authenticate(req);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`event: hello\ndata: {}\n\n`);
    const off = hub.subscribe(me.project_id, (e: HubEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      off();
    });
  }

  // ---------------------------------------------------------------- public files (cached in memory once, tiny)

  const fileCache = new Map<string, string>();
  const readCached = (rel: string) => {
    let s = fileCache.get(rel);
    if (s === undefined) {
      s = readFileSync(join(ROOT, rel), "utf8");
      fileCache.set(rel, s);
    }
    return s;
  };
  const RAW_CLI = "https://raw.githubusercontent.com/mlnamata/R.U.Ch./HEAD/ruch.mjs";
  const withHub = (text: string, req: IncomingMessage) => text.replaceAll(RAW_CLI, `${publicUrl(req)}/ruch.mjs`);

  function agentInstructions(req: IncomingMessage, code?: string) {
    const hubUrl = publicUrl(req);
    return `# R.U.Ch. – agent setup${code ? ` for room ${code}` : ""}

You are an AI agent. R.U.Ch. is a chat hub where AI agents and their human coordinate on one project.

With a shell (Claude Code, Cursor, Codex, Antigravity, VS Code agent):
  node -e "fetch('${hubUrl}/ruch.mjs').then(r=>r.text()).then(t=>{require('fs').mkdirSync('.ruch',{recursive:true});require('fs').writeFileSync('.ruch/ruch.mjs',t)})"
  node .ruch/ruch.mjs ${code ? `join ${code}` : "new"} --name <YourName>
Then follow \`node .ruch/ruch.mjs help\` (rules: ${hubUrl}/skill.md). Optional: \`node .ruch/ruch.mjs skill\` installs the skill.

Without a shell (ChatGPT, Claude.ai connectors…): add a remote MCP server
  URL: ${hubUrl}/mcp?code=${code ?? "<CODE>"}&name=<YourName>

Ask the human (in their language) before joining if you were not given a code: "Do you already have an R.U.Ch. room code? If not, I will create one."
`;
  }

  async function servePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const p = url.pathname;
    const st = STATIC[p];
    if (st) {
      sendText(res, 200, readCached(st[0]), st[1]);
      return true;
    }
    if (p === "/ruch.mjs") {
      sendText(res, 200, readCached("ruch.mjs").replace('"http://127.0.0.1:4317"', JSON.stringify(publicUrl(req))), "text/javascript");
      return true;
    }
    if (p === "/skill.md") {
      sendText(res, 200, withHub(readCached("skills/ruch/SKILL.md"), req), "text/markdown");
      return true;
    }
    if (p === "/llms.txt" || p === "/agents.txt") {
      sendText(res, 200, agentInstructions(req));
      return true;
    }
    const j = /^\/j\/([0-9A-Za-z-]{4,40})$/.exec(p);
    if (j) {
      sendText(res, 200, agentInstructions(req, j[1].toUpperCase()));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- remote MCP (stateless)

  async function mcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const code = url.searchParams.get("code") ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
    const name = url.searchParams.get("name") ?? header(req, "x-ruch-name") ?? "Agent";
    if (!code) throw new HubError(401, "no_key", "Add ?code=<room code>&name=<name> to the MCP server URL.");
    if (!hub.authenticate(code)) {
      if (!authFailLimit.hit(clientIp(req))) throw new HubError(429, "too_many_attempts", "Too many invalid codes.");
      throw new HubError(401, "bad_key", "Invalid room code.");
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = await readJson(req);
    // The MCP SDK costs ~12 MB, so it is loaded only when a client actually uses /mcp.
    const [{ StreamableHTTPServerTransport }, { buildMcpServer }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("./tools.js"),
    ]);
    // Tools talk to this same server over loopback, so they reuse every rule and text renderer.
    const port = (server.address() as AddressInfo).port;
    const client = new RuchClient({ url: `http://127.0.0.1:${port}`, key: code, name });
    const mcpServer = buildMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // ---------------------------------------------------------------- server

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (await servePublic(req, res, url)) return;
      if (url.pathname === "/mcp") return await mcp(req, res, url);
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not_found" });
      if (url.pathname === "/api/health") return send(res, 200, { ok: true });
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        const b = S.room(await readJson(req), "");
        if (cfg.createToken && b.token !== cfg.createToken) throw new HubError(403, "create_token", "This hub requires a token to create a room.");
        if (!createLimit.hit(clientIp(req))) throw new HubError(429, "too_many_rooms", "Too many new rooms from this address. Try later.");
        const r = hub.createRoom({ name: b.name, humanName: b.human_name });
        const base = publicUrl(req);
        return send(res, 200, {
          room: r.project.name,
          agent_code: r.agentCode,
          owner_key: r.ownerKey,
          owner_url: `${base}/#o=${r.ownerKey}`,
          invite_url: `${base}/j/${r.agentCode}`,
          human: r.human.name,
        });
      }
      if (url.pathname === "/api/events" && req.method === "GET") return events(req, res);

      for (const [method, re, handler, toText] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const a = authenticate(req);
        const ctx: Ctx = {
          req,
          res,
          url,
          params: m.slice(1),
          me: a.me,
          role: a.role,
          key: a.key,
          body: async (schema) => schema(await readJson(req), ""),
        };
        const out = await handler(ctx);
        if (res.headersSent || res.destroyed) return;
        if (toText && (req.headers.accept ?? "").startsWith("text/plain")) {
          // Tell agents about waiting news on every reply, so they never call the inbox just to check.
          const n = a.role === "agent" && url.pathname !== "/api/inbox" ? hub.pending(a.me) : 0;
          return sendText(res, 200, toText(out) + (n ? `\n+${n} new → inbox` : ""));
        }
        return send(res, 200, out);
      }
      send(res, 404, { error: "not_found", message: `Unknown endpoint ${req.method} ${url.pathname}` });
    } catch (e) {
      if (res.headersSent) return void res.end();
      const err = e instanceof ValidationError ? new HubError(400, "bad_request", `Bad request: ${e.message}`) : e;
      if (err instanceof HubError) {
        if ((req.headers.accept ?? "").startsWith("text/plain")) return sendText(res, err.status, `ERROR: ${err.message}`);
        return send(res, err.status, { error: err.code, message: err.message, details: err.details });
      }
      console.error(e);
      send(res, 500, { error: "internal", message: "Internal server error." });
    }
  });

  const timer = setInterval(() => {
    try {
      const r = hub.cleanup();
      createLimit.prune();
      authFailLimit.prune();
      if (r.roomsDeleted) console.log(`Úklid: smazáno ${r.roomsDeleted} neaktivních místností.`);
    } catch (e) {
      console.error("Úklid selhal:", e);
    }
  }, 10 * 60_000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  // Agents long-poll up to 5 minutes.
  server.requestTimeout = 330_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  return server;
}
