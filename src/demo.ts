#!/usr/bin/env node
/** Creates a sample room on a running hub: two agents split the work, request, review and sign off. */
import { RuchClient } from "./client.js";
import { runTool } from "./tools.js";

const url = (process.env.RUCH_HUB ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const res = await fetch(`${url}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Demo: web shop" }),
});
const room = (await res.json()) as { agent_code: string; owner_url: string; invite_url: string; human: string; message?: string };
if (!res.ok) throw new Error(room.message);

async function agent(name: string) {
  const c = new RuchClient({ url, key: room.agent_code, name });
  const r = await c.post<{ secret?: string }>("/api/join", { fresh: true });
  c.opts.secret = r.secret;
  return c;
}
async function t(c: RuchClient, name: string, args: unknown) {
  const r = await runTool(c, name, args);
  if (r.isError) throw new Error(`${c.opts.name}.${name}: ${r.text}`);
  return r.text;
}

const api = await agent("Claude-API");
const web = await agent("Cursor-Web");

await t(web, "coordinate", { action: "start", text: "Build the cart page", paths: ["web/"], rules: "Use the design tokens in web/tokens.css, no inline styles" });
await t(api, "coordinate", { action: "start", text: "Build the cart API", paths: ["api/", "db/"], rules: "Amounts are integers in cents" });
await t(web, "send", { thread: 1, text: "@Claude-API one constraint from me: please return the cart as {items, total_cents}." });
await t(api, "memory", { action: "save", kind: "decision", title: "Cart API shape", text: "GET /api/cart returns {items, total_cents}", evidence: [{ type: "message", id: 4 }] });
await t(api, "files", { action: "claim", paths: ["api/cart.ts"], reason: "cart endpoint" });
await t(api, "coordinate", { action: "request", to: "Cursor-Web", text: "Show the cart total in the header", details: "Use GET /api/cart → total_cents" });
await t(web, "task", { action: "update", id: 1, status: "review" });
await t(api, "coordinate", { action: "feedback", id: 1, text: "Format the total as currency, not raw cents" });
await t(web, "ask", {
  to: "human",
  thread: 1,
  question: "Should the cart total include VAT?",
  options: ["Yes, show prices with VAT", "No, add VAT at checkout"],
  blocking: true,
});
await t(api, "files", { action: "release" });

console.log(`Demo room is ready.
  Your page:      ${room.owner_url}
  Agent invite:   ${room.invite_url}`);
