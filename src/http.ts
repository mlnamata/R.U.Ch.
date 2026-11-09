import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Hub, HubError } from "./hub.js";
import type { ServerConfig } from "./config.js";
import type { HubEvent, Participant } from "./types.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MAX_BODY = 1_000_000;

// ------------------------------------------------------------------ request schemas

const evidence = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("file"), path: z.string().min(1), lines: z.string().optional(), quote: z.string().optional() }),
    z.object({ type: z.literal("message"), id: z.number().int() }),
    z.object({ type: z.literal("knowledge"), id: z.number().int() }),
    z.object({ type: z.literal("command"), command: z.string().min(1), output: z.string().optional() }),
    z.object({ type: z.literal("url"), url: z.string().min(1) }),
  ]),
);
const confidence = z.enum(["certain", "likely", "guess"]);

const S = {
  join: z.object({ role: z.string().max(200).optional() }),
  status: z.object({ text: z.string() }),
  project: z.object({ name: z.string().optional(), brief: z.string().optional(), root_path: z.string().nullable().optional() }),
  thread: z.object({
    title: z.string(),
    body: z.string().optional(),
    parent_id: z.number().int().nullable().optional(),
    mentions: z.array(z.string()).optional(),
  }),
  message: z.object({
    kind: z.enum(["chat", "question", "answer", "decision", "handoff", "review", "status"]).optional(),
    body: z.string(),
    mentions: z.array(z.string()).optional(),
    reply_to: z.number().int().nullable().optional(),
    evidence: evidence.optional(),
    confidence: confidence.nullable().optional(),
  }),
  threadStatus: z.object({ status: z.enum(["open", "human_needed", "resolved"]), reason: z.string().optional() }),
  summary: z.object({ summary: z.string() }),
  ask: z.object({
    to: z.string().nullable().optional(),
    body: z.string(),
    thread_id: z.number().int().nullable().optional(),
    options: z.array(z.string()).optional(),
    blocking: z.boolean().optional(),
  }),
  answer: z.object({
    body: z.string().default(""),
    confidence: confidence.optional(),
    evidence: evidence.optional(),
    choice: z.string().nullable().optional(),
  }),
  cancel: z.object({ reason: z.string().optional() }),
  knowledge: z.object({
    kind: z.enum(["answer", "decision", "fact", "note"]),
    title: z.string(),
    body: z.string(),
    tags: z.string().optional(),
    evidence: evidence.optional(),
    supersedes: z.number().int().nullable().optional(),
  }),
  dispute: z.object({ reason: z.string() }),
  claim: z.object({
    paths: z.array(z.string()).min(1),
    reason: z.string().optional(),
    minutes: z.number().int().optional(),
    thread_id: z.number().int().nullable().optional(),
  }),
  release: z.object({ paths: z.array(z.string()).optional() }),
  check: z.object({ paths: z.array(z.string()).min(1) }),
  task: z.object({
    title: z.string(),
    details: z.string().optional(),
    assignee: z.string().nullable().optional(),
    thread_id: z.number().int().nullable().optional(),
  }),
  taskPatch: z.object({
    status: z.enum(["todo", "doing", "review", "done", "blocked"]).optional(),
    assignee: z.string().nullable().optional(),
    details: z.string().optional(),
    take: z.boolean().optional(),
  }),
  handoff: z.object({
    thread_id: z.number().int(),
    to: z.string().nullable().optional(),
    summary: z.string(),
    done: z.array(z.string()).optional(),
    next: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    evidence: evidence.optional(),
  }),
};

// ------------------------------------------------------------------ plumbing

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  me: () => Participant;
  body: <T extends z.ZodType>(schema: T) => Promise<z.infer<T>>;
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HubError(413, "too_large", "Požadavek je příliš velký.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError(400, "bad_json", "Tělo požadavku není platný JSON.");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createHttpServer(hub: Hub, cfg: ServerConfig) {
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: string, h: Handler) =>
    routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(\\d+)") + "$"), h]);
  const id = (ctx: Ctx, i = 0) => Number(ctx.params[i]);

  route("GET", "/api/health", () => ({ ok: true }));
  // Needed by the web UI before it knows who it is.
  route("GET", "/api/config", () => ({
    humanName: cfg.hub.humanName,
    defaultProject: cfg.defaultProject,
    humanTokenRequired: !!cfg.humanToken,
  }));
  route("GET", "/api/state", (c) => hub.state(c.me().project_id));
  route("GET", "/api/me", (c) => ({ me: hub.participantView(c.me()), project: hub.state(c.me().project_id).project }));
  route("POST", "/api/join", async (c) => {
    const b = await c.body(S.join);
    const p = c.me();
    if (b.role) hub.join(projectOf(c), p.name, p.kind, b.role);
    const project = hub.getProject(projectOf(c));
    return { me: hub.participantView(hub.join(projectOf(c), p.name, p.kind)), project };
  });
  route("POST", "/api/status", async (c) => hub.participantView(hub.setStatus(c.me(), (await c.body(S.status)).text)));
  route("PATCH", "/api/project", async (c) => hub.updateProject(c.me(), await c.body(S.project)));
  route("GET", "/api/participants", (c) => hub.listParticipants(c.me().project_id));
  route("GET", "/api/inbox", (c) => hub.inbox(c.me(), { peek: c.url.searchParams.get("peek") === "1" }));
  route("GET", "/api/wait", async (c) => {
    const timeout = Math.min(Number(c.url.searchParams.get("timeout") ?? 60), 300) * 1000;
    const ac = new AbortController();
    c.req.on("close", () => ac.abort());
    return { activity: await hub.waitForActivity(c.me(), timeout, ac.signal) };
  });

  route("GET", "/api/threads", (c) => hub.listThreads(c.me().project_id, (c.url.searchParams.get("status") as never) || undefined));
  route("POST", "/api/threads", async (c) => hub.createThread(c.me(), await c.body(S.thread)));
  route("GET", "/api/threads/:id", (c) => {
    const q = c.url.searchParams;
    const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
    return hub.getThread(c.me().project_id, id(c), { since: num("since"), before: num("before"), limit: num("limit") });
  });
  route("POST", "/api/threads/:id/messages", async (c) => hub.post(c.me(), id(c), await c.body(S.message)));
  route("POST", "/api/threads/:id/status", async (c) => {
    const b = await c.body(S.threadStatus);
    return hub.setThreadStatus(c.me(), id(c), b.status, b.reason);
  });
  route("POST", "/api/threads/:id/summary", async (c) => hub.setSummary(c.me(), id(c), (await c.body(S.summary)).summary));

  route("GET", "/api/questions", (c) => {
    const me = c.me();
    return hub.listQuestions(me.project_id, {
      status: c.url.searchParams.get("status") ?? undefined,
      for: c.url.searchParams.get("for") === "me" ? me : undefined,
    });
  });
  route("POST", "/api/questions", async (c) => hub.ask(c.me(), await c.body(S.ask)));
  route("GET", "/api/questions/:id", (c) => hub.getQuestion(c.me().project_id, id(c)));
  route("GET", "/api/questions/:id/wait", async (c) => {
    const timeout = Math.min(Number(c.url.searchParams.get("timeout") ?? 60), 300) * 1000;
    const ac = new AbortController();
    c.req.on("close", () => ac.abort());
    return hub.waitForAnswer(c.me().project_id, id(c), timeout, ac.signal);
  });
  route("POST", "/api/questions/:id/answer", async (c) => hub.answer(c.me(), id(c), await c.body(S.answer)));
  route("POST", "/api/questions/:id/cancel", async (c) => hub.cancelQuestion(c.me(), id(c), (await c.body(S.cancel)).reason));

  route("GET", "/api/knowledge", (c) =>
    hub.searchKnowledge(c.me().project_id, c.url.searchParams.get("q") ?? "", Number(c.url.searchParams.get("limit") ?? 8)),
  );
  route("POST", "/api/knowledge", async (c) => hub.addKnowledge(c.me(), await c.body(S.knowledge)));
  route("GET", "/api/knowledge/:id", (c) => hub.getKnowledge(c.me().project_id, id(c)));
  route("POST", "/api/knowledge/:id/verify", (c) => hub.verifyKnowledge(c.me(), id(c)));
  route("POST", "/api/knowledge/:id/dispute", async (c) => hub.disputeKnowledge(c.me(), id(c), (await c.body(S.dispute)).reason));

  route("GET", "/api/claims", (c) => hub.listClaims(c.me().project_id));
  route("POST", "/api/claims", async (c) => hub.claim(c.me(), await c.body(S.claim)));
  route("POST", "/api/claims/release", async (c) => hub.release(c.me(), (await c.body(S.release)).paths));
  route("POST", "/api/claims/check", async (c) => {
    const me = c.me();
    return { conflicts: hub.checkPaths(me.project_id, (await c.body(S.check)).paths, me.id) };
  });

  route("GET", "/api/tasks", (c) => hub.listTasks(c.me().project_id, { status: c.url.searchParams.get("status") ?? undefined }));
  route("POST", "/api/tasks", async (c) => hub.createTask(c.me(), await c.body(S.task)));
  route("PATCH", "/api/tasks/:id", async (c) => hub.updateTask(c.me(), id(c), await c.body(S.taskPatch)));

  route("POST", "/api/handoff", async (c) => hub.handoff(c.me(), await c.body(S.handoff)));

  // ------------------------------------------------------------------ identity

  function param(req: IncomingMessage, url: URL, header: string, query: string): string | null {
    const h = req.headers[header];
    const v = (Array.isArray(h) ? h[0] : h) ?? url.searchParams.get(query);
    if (!v) return null;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  function projectOf(c: { req: IncomingMessage; url: URL }) {
    return param(c.req, c.url, "x-ruch-project", "project") ?? cfg.defaultProject;
  }
  function identify(req: IncomingMessage, url: URL): Participant {
    const name = param(req, url, "x-ruch-name", "name");
    if (!name) throw new HubError(401, "no_identity", "Chybí jméno účastníka (hlavička X-Ruch-Name).");
    const kind = param(req, url, "x-ruch-kind", "kind") === "human" ? "human" : "agent";
    if (kind === "human" && cfg.humanToken) {
      const t = param(req, url, "x-ruch-human-token", "human_token");
      if (!t || !safeEqual(t, cfg.humanToken)) throw new HubError(403, "not_human", "Neplatný token člověka.");
    }
    const project = projectOf({ req, url });
    // The default project is created on demand; other projects too (local tool, cheap).
    hub.ensureProject(project);
    return hub.join(project, name, kind);
  }
  function authorized(req: IncomingMessage, url: URL) {
    if (!cfg.token) return true;
    const h = req.headers.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
    return !!t && safeEqual(t, cfg.token);
  }

  // ------------------------------------------------------------------ SSE

  function events(req: IncomingMessage, res: ServerResponse, url: URL) {
    const me = identify(req, url);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ me: hub.participantView(me) })}\n\n`);
    const onEvent = (e: HubEvent) => {
      if (e.projectId !== me.project_id) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    hub.events.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      hub.events.off("event", onEvent);
    });
  }

  // ------------------------------------------------------------------ static files

  async function serveStatic(res: ServerResponse, pathname: string) {
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return send(res, 404, { error: "not_found" });
    try {
      const data = await readFile(join(WEB_DIR, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      send(res, 404, { error: "not_found" });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        return await serveStatic(res, url.pathname);
      }
      const open = url.pathname === "/api/config" || url.pathname === "/api/health";
      if (!open && !authorized(req, url)) throw new HubError(401, "unauthorized", "Chybí nebo nesedí RUCH_TOKEN.");
      if (url.pathname === "/api/events" && req.method === "GET") return events(req, res, url);
      for (const [method, re, handler] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        let cached: Participant | null = null;
        const ctx: Ctx = {
          req,
          res,
          url,
          params: m.slice(1),
          me: () => (cached ??= identify(req, url)),
          body: async (schema) => {
            const parsed = schema.safeParse(await readJson(req));
            if (!parsed.success) {
              throw new HubError(
                400,
                "bad_request",
                "Neplatný požadavek: " + parsed.error.issues.map((i) => `${i.path.join(".") || "(tělo)"}: ${i.message}`).join("; "),
              );
            }
            return parsed.data;
          },
        };
        const out = await handler(ctx);
        if (!res.headersSent) send(res, 200, out);
        return;
      }
      send(res, 404, { error: "not_found", message: `Neznámý endpoint ${req.method} ${url.pathname}` });
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HubError) return send(res, e.status, { error: e.code, message: e.message, details: e.details });
      console.error(e);
      send(res, 500, { error: "internal", message: String((e as Error)?.message ?? e) });
    }
  });
}
