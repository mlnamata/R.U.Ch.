/**
 * MCP tool set (used by the local stdio server and the hub's remote /mcp endpoint).
 * Tool schemas are sent to the model on every turn, so they are few, merged by action,
 * and described tersely. The hub renders all results as compact text.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuchClient } from "./client.js";
import { loadProtocol } from "./prompts.js";

const ev = z
  .array(
    z.object({
      type: z.enum(["file", "message", "knowledge", "command", "url"]),
      path: z.string().optional(),
      lines: z.string().optional().describe('e.g. "10-25"'),
      quote: z.string().optional().describe("verbatim text from the file"),
      id: z.number().optional().describe("message/knowledge id"),
      command: z.string().optional(),
      output: z.string().optional(),
      url: z.string().optional(),
    }),
  )
  .optional()
  .describe("Proof for claims. Fake file/lines/quote/id => rejected.");
const conf = z.enum(["certain", "likely", "guess"]).optional().describe("guess = not stored in memory");

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly?: boolean;
  run: (c: RuchClient, a: any) => Promise<string>;
}

const q = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const TOOLS: ToolDef[] = [
  {
    name: "inbox",
    description: "New items for you: messages, questions to you, answers, tasks, locks. Call first each step. wait>0 blocks until activity.",
    readOnly: true,
    schema: z.object({ wait: z.number().min(0).max(300).optional().describe("seconds") }),
    run: (c, a) => c.text("GET", `/api/inbox${q({ wait: a.wait })}`),
  },
  {
    name: "send",
    description: "Post to thread. @Name mentions (@human = the human). kind: chat|decision|review|status.",
    schema: z.object({
      thread: z.number(),
      text: z.string(),
      kind: z.enum(["chat", "decision", "review", "status"]).optional(),
      reply_to: z.number().optional(),
      evidence: ev,
      confidence: conf,
    }),
    run: (c, a) =>
      c.text("POST", `/api/threads/${a.thread}/messages`, { body: a.text, kind: a.kind, reply_to: a.reply_to, evidence: a.evidence, confidence: a.confidence }),
  },
  {
    name: "thread",
    description: "list | read (id, since, before) | new (title, text, parent) | summary (id, text) | resolve (id, text).",
    schema: z.object({
      action: z.enum(["list", "read", "new", "summary", "resolve"]),
      id: z.number().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      parent: z.number().optional(),
      since: z.number().optional(),
      before: z.number().optional(),
    }),
    run: (c, a) => {
      switch (a.action) {
        case "list":
          return c.text("GET", "/api/threads");
        case "read":
          return c.text("GET", `/api/threads/${a.id}${q({ since: a.since, before: a.before, limit: 30 })}`);
        case "new":
          return c.text("POST", "/api/threads", { title: a.title ?? "", body: a.text, parent_id: a.parent });
        case "summary":
          return c.text("POST", `/api/threads/${a.id}/summary`, { summary: a.text ?? "" });
        default:
          return c.text("POST", `/api/threads/${a.id}/status`, { status: "resolved", reason: a.text ?? "" });
      }
    },
  },
  {
    name: "ask",
    description: 'Ask an agent (to=name), the human (to="human") or anyone. Shows similar known answers. wait>0 waits for the answer.',
    schema: z.object({
      question: z.string(),
      to: z.string().optional(),
      thread: z.number().optional(),
      options: z.array(z.string()).max(6).optional(),
      blocking: z.boolean().optional(),
      wait: z.number().min(0).max(300).optional(),
    }),
    run: (c, a) =>
      c.text("POST", "/api/questions", { body: a.question, to: a.to, thread_id: a.thread, options: a.options, blocking: a.blocking, wait_seconds: a.wait }),
  },
  {
    name: "answer",
    description: "Answer question Q. Stored in shared memory unless confidence=guess. Unsure? Say so, never invent.",
    schema: z.object({ question: z.number(), text: z.string(), confidence: conf, choice: z.string().optional(), evidence: ev }),
    run: (c, a) => c.text("POST", `/api/questions/${a.question}/answer`, { body: a.text, confidence: a.confidence, choice: a.choice, evidence: a.evidence }),
  },
  {
    name: "memory",
    description: "Shared project memory. search (query) before asking/deciding | save (kind fact|decision|note, title, text, evidence) | dispute (id, text).",
    schema: z.object({
      action: z.enum(["search", "save", "dispute"]),
      query: z.string().optional(),
      kind: z.enum(["fact", "decision", "note"]).optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      id: z.number().optional(),
      evidence: ev,
    }),
    readOnly: false,
    run: (c, a) => {
      if (a.action === "search") return c.text("GET", `/api/knowledge${q({ q: a.query ?? "", limit: 6 })}`);
      if (a.action === "save") return c.text("POST", "/api/knowledge", { kind: a.kind ?? "fact", title: a.title ?? "", body: a.text ?? "", evidence: a.evidence });
      return c.text("POST", `/api/knowledge/${a.id}/dispute`, { reason: a.text ?? "" });
    },
  },
  {
    name: "files",
    description: "File locks. claim before editing (conflict = someone else edits it, don't) | release when done | check.",
    schema: z.object({ action: z.enum(["claim", "release", "check"]), paths: z.array(z.string()).optional(), reason: z.string().optional() }),
    run: (c, a) => {
      if (a.action === "claim") return c.text("POST", "/api/claims", { paths: a.paths ?? [], reason: a.reason });
      if (a.action === "release") return c.text("POST", "/api/claims/release", { paths: a.paths });
      return c.text("POST", "/api/claims/check", { paths: a.paths ?? [] });
    },
  },
  {
    name: "task",
    description: "list | new (title, to, thread) | update (id, status todo|doing|review|done|blocked, take). Done work goes to review; you can't approve your own.",
    schema: z.object({
      action: z.enum(["list", "new", "update"]),
      id: z.number().optional(),
      title: z.string().optional(),
      to: z.string().optional(),
      thread: z.number().optional(),
      status: z.enum(["todo", "doing", "review", "done", "blocked"]).optional(),
      take: z.boolean().optional(),
    }),
    run: (c, a) => {
      if (a.action === "list") return c.text("GET", "/api/tasks");
      if (a.action === "new") return c.text("POST", "/api/tasks", { title: a.title ?? "", assignee: a.to, thread_id: a.thread });
      return c.text("PATCH", `/api/tasks/${a.id}`, { status: a.status, take: a.take });
    },
  },
  {
    name: "handoff",
    description: "Structured handover: summary, done[], next[], risks[].",
    schema: z.object({
      thread: z.number(),
      to: z.string().optional(),
      summary: z.string(),
      done: z.array(z.string()).optional(),
      next: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      evidence: ev,
    }),
    run: (c, a) => c.text("POST", "/api/handoff", { thread_id: a.thread, to: a.to, summary: a.summary, done: a.done, next: a.next, risks: a.risks, evidence: a.evidence }),
  },
  {
    name: "escalate",
    description: "Ask the human to decide (disagreement after 2 rounds, unclear spec, irreversible step). Pauses the thread.",
    schema: z.object({ thread: z.number(), problem: z.string(), options: z.array(z.string()).min(1).max(6), recommendation: z.string().optional() }),
    run: (c, a) => c.text("POST", "/api/escalate", { thread_id: a.thread, problem: a.problem, options: a.options, recommendation: a.recommendation }),
  },
  {
    name: "status",
    description: "Set your short visible status.",
    schema: z.object({ text: z.string().max(200) }),
    run: (c, a) => c.text("POST", "/api/status", { text: a.text }),
  },
];

export async function runTool(client: RuchClient, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { text: `Unknown tool ${name}.`, isError: true };
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { text: "Bad arguments: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), isError: true };
  }
  try {
    return { text: await def.run(client, parsed.data), isError: false };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

export function buildMcpServer(client: RuchClient, role = ""): McpServer {
  const server = new McpServer(
    { name: "ruch", version: "0.2.0" },
    { instructions: `You are "${client.opts.name}" in an R.U.Ch. room.\n\n${loadProtocol(role)}` },
  );
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.schema.shape, annotations: { readOnlyHint: t.readOnly ?? false, openWorldHint: false } },
      async (args: unknown) => {
        const r = await runTool(client, t.name, args);
        return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
      },
    );
  }
  return server;
}
