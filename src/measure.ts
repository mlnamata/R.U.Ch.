/**
 * Measures what agents actually read (npm run measure): static texts and a scripted session.
 * Bytes are reported next to characters because non-ASCII text costs more tokens per character.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RuchClient } from "./client.js";
import { loadServerConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { Hub } from "./hub.js";
import { createHttpServer } from "./http.js";
import { loadProtocol } from "./prompts.js";
import { TOOLS } from "./tools.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const size = (s: string) => `${s.length} chars / ${Buffer.byteLength(s)} bytes`;

const cfg = loadServerConfig({} as NodeJS.ProcessEnv);
const server = createHttpServer(new Hub(openDatabase(":memory:"), cfg.hub), { ...cfg, port: 0 });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const room = (await (await fetch(`${url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as {
  agent_code: string;
  owner_key: string;
};
const a = new RuchClient({ url, key: room.agent_code, name: "Alfa" });
const b = new RuchClient({ url, key: room.agent_code, name: "Beta" });
const h = new RuchClient({ url, key: room.owner_key, name: "Supervizor" });
await a.post("/api/join");
await b.post("/api/join");

let session = "";
const read = async (c: RuchClient, method: string, path: string, body?: unknown) => {
  const t = await c.text(method, path, body);
  session += t + "\n";
  return t;
};

// A typical working session seen from Beta: locks and a task exist, a question to anyone stays open,
// and Alfa posts ten updates that Beta picks up one by one.
await a.post("/api/threads", { title: "API design", body: "@Beta please review the routing plan" });
await a.post("/api/claims", { paths: ["src/api/", "src/db.ts"], reason: "refactor" });
await read(b, "POST", "/api/claims", { paths: ["web/"], reason: "ui" });
await a.post("/api/tasks", { title: "Review routing", assignee: "Beta", thread_id: 1 });
await a.post("/api/questions", { body: "Which port does staging use?", thread_id: 1 });
await read(b, "POST", "/api/questions", { to: "human", body: "Deploy on Friday?", options: ["Yes", "No"], thread_id: 1 });
const updates = [
  "Moved the auth routes into src/api/auth.ts, all 14 tests pass.",
  "Cart endpoints now validate quantity, negative values return 400.",
  "Replaced the hand-written router with a table of method + regex.",
  "Order history query got an index, the page loads in 20 ms.",
  "Stripe webhook verifies the signature before parsing the body.",
  "Removed the legacy /v1/products alias, nothing in web/ used it.",
  "Rate limiter is per IP now and prunes itself every ten minutes.",
  "Session cookie is HttpOnly and SameSite=Lax on every response.",
  "Search falls back to prefix matching when full text finds nothing.",
  "Health check reports database latency next to the build hash.",
];
const replies = ["Auth split looks right, names match the handlers.", "Router table reads well; one regex lacked an anchor, see M9.", "Rate limiter: fine, pruning interval is sensible.", "Health check output is clear, nothing to add."];
for (let i = 0; i < 10; i++) {
  await a.post("/api/threads/1/messages", { body: updates[i] });
  await read(b, "GET", "/api/inbox");
  if (i === 4) await h.post("/api/questions/2/answer", { choice: "B) No" });
  if (i % 3 === 0) await read(b, "POST", "/api/threads/1/messages", { body: replies[i / 3] });
}
await read(b, "GET", "/api/inbox");
await read(b, "GET", "/api/threads/1");

const tools = JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) })));
const help = execFileSync(process.execPath, [join(ROOT, "ruch.mjs"), "help"], { encoding: "utf8" });

console.log(`Session (Beta: 11x inbox, 4x say, claim, ask, read): ${size(session)}`);
console.log(`CLI help:        ${size(help)}`);
console.log(`Skill:           ${size(readFileSync(join(ROOT, "skills/ruch/SKILL.md"), "utf8"))}`);
console.log(`MCP protocol:    ${size(loadProtocol())}`);
console.log(`MCP tools (${TOOLS.length}):  ${size(tools)}`);
if (process.argv.includes("--show")) console.log("\n" + session);
server.close();
