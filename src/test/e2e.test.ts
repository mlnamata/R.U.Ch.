import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RuchClient } from "../client.js";
import { loadServerConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { Hub } from "../hub.js";
import { createHttpServer } from "../http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "ruch.mjs");
let server: Server;
let url: string;

before(async () => {
  const cfg = loadServerConfig({ RUCH_MAX_AGENT_STREAK: "8", RUCH_ADMIN_TOKEN: "admintoken", RUCH_OPERATOR_NAME: "ACME s.r.o.", RUCH_DB: ":memory:" } as NodeJS.ProcessEnv);
  server = createHttpServer(new Hub(openDatabase(":memory:"), cfg.hub), { ...cfg, port: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function cli(cwd: string, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP) => {
    const p = execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, RUCH_HUB: url, RUCH_AGENT: "" } }, (e, out, err) =>
      resolveP({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
    );
    if (stdin !== undefined) p.stdin!.end(stdin);
  });
}
const ok = async (cwd: string, args: string[], stdin?: string) => {
  const r = await cli(cwd, args, stdin);
  assert.equal(r.code, 0, `ruch ${args.join(" ")} failed: ${r.err}${r.out}`);
  return r.out;
};
const fail = async (cwd: string, args: string[]) => {
  const r = await cli(cwd, args);
  assert.notEqual(r.code, 0, `ruch ${args.join(" ")} should fail`);
  return r.err;
};

async function createRoom() {
  const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await res.json()) as { agent_code: string; owner_key: string; owner_url: string; invite_url: string };
}

test("CLI: two agents split the work, request each other's changes, review, and sign off", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "ruch-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "ruch-b-"));
  writeFileSync(join(dirA, ".gitignore"), "node_modules\n");
  mkdirSync(join(dirA, "api"));
  writeFileSync(join(dirA, "api", "cart.ts"), "export const port = 8080;\nexport function total() {}\n");

  const created = await ok(dirA, ["new", "--name", "Alfa", "--room", "Shop"]);
  const invite = /Join R\.U\.Ch\.: (\S+)"/.exec(created)![1];
  const ownerUrl = /Your page.*?: (\S+)/.exec(created)![1];
  assert.match(invite, /\/j\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.match(readFileSync(join(dirA, ".gitignore"), "utf8"), /^\.ruch\/$/m, "secrets must be git-ignored");
  assert.ok(JSON.parse(readFileSync(join(dirA, ".ruch", "session.json"), "utf8")).secret, "agent secret stored");

  assert.match(await ok(dirB, ["join", invite, "--name", "Beta"]), /Joined "Shop" as Beta\. Coordination thread: T1/);
  // Nobody else can take Beta's name, and re-running join in the same folder is harmless.
  const dirC = mkdtempSync(join(tmpdir(), "ruch-c-"));
  assert.match(await fail(dirC, ["join", invite, "--name", "Beta"]), /already uses the name "Beta"/);
  assert.match(await ok(dirB, ["join", invite, "--name", "Beta"]), /Joined/);

  // Session start: plan + area; the other agent is asked for constraints.
  const startB = await ok(dirB, ["start", "build the web UI", "--area", "web/", "--rules", "no inline styles"]);
  assert.match(startB, /Checked in/);
  const startA = await ok(dirA, ["start", "build the cart API", "--area", "api/"]);
  assert.match(startA, /Areas of others[\s\S]*Beta: web[\s\S]*rules: no inline styles/);
  assert.match(await ok(dirB, ["in"]), /Starting: build the cart API[\s\S]*@Beta any constraints/);
  await ok(dirB, ["say", "1", "@Alfa keep amounts in cents please"]);
  assert.match(await ok(dirA, ["in"]), /keep amounts in cents/);

  // Alfa cannot edit Beta's area – it sends a request instead.
  assert.match(await ok(dirA, ["claim", "web/cart.html"]), /OTHER AGENT'S AREA[\s\S]*Beta \(rules: no inline styles\)/);
  assert.match(await ok(dirA, ["request", "Beta", "Show cart total in the header", "use GET /cart"]), /Requested #1/);
  assert.match(await ok(dirB, ["in"]), /request #1: Show cart total/);
  assert.match(await ok(dirB, ["task", "1", "review"]), /\[review\]/);
  assert.match(await ok(dirA, ["in"]), /#1 is ready for your review/);
  assert.match(await ok(dirA, ["feedback", "1", "total must include VAT"]), /Sent back/);
  assert.match(await ok(dirB, ["in"]), /feedback on #1.*include VAT/);
  await ok(dirB, ["task", "1", "review"]);
  assert.match(await fail(dirB, ["approve", "1"]), /can't approve your own work/);
  assert.match(await ok(dirA, ["approve", "1"]), /\[done\]/);
  assert.match(await ok(dirB, ["in"]), /#1 approved/);

  // Evidence is verified locally before anything is sent.
  assert.match(await fail(dirA, ["say", "1", "Port is 3000", "--kind", "review", "--ev", "api/cart.ts:1", "--quote", "port = 3000"]), /quote is not in/);
  assert.match(await ok(dirA, ["say", "1", "Port is 8080", "--kind", "review", "--ev", "api/cart.ts:1", "--quote", "port = 8080"]), /^OK M\d+/);
  assert.match(await ok(dirB, ["read", "1"]), /api\/cart\.ts:1 ✓verified/);
  assert.match(await ok(dirB, ["say", "1", "-"], "line 1\nline 2"), /^OK/);

  // Agent asks the human and waits; the human answers from the web page (owner key).
  const asking = ok(dirB, ["ask", "human", "Deploy now?", "--opt", "Yes", "--opt", "No", "--wait", "5"]);
  await new Promise((r) => setTimeout(r, 300));
  const human = new RuchClient({ url, key: ownerUrl.split("#o=")[1], name: "Owner" });
  const qs = await human.get<{ id: number }[]>("/api/questions?status=open");
  await human.post(`/api/questions/${qs[0].id}/answer`, { choice: "B) No", body: "" });
  assert.match(await asking, /Owner answered: @Beta Choice: B\) No/);
  assert.match(await ok(dirA, ["mem", "deploy"]), /human-confirmed/);

  // Session end: locks and area released, the others are told what's left.
  await ok(dirA, ["claim", "api/cart.ts"]);
  assert.match(await ok(dirA, ["end", "cart API done", "--left", "pagination"]), /Checked out/);
  assert.match(await ok(dirB, ["in"]), /Done, signing off: cart API done[\s\S]*- pagination[\s\S]*area is free now: api/);
  assert.match(await ok(dirB, ["areas"]), /^Beta: web/);
  assert.match(await ok(dirB, ["claim", "api/cart.ts"]), /Locked: api\/cart\.ts/);
});

test("roles, limits and safety: owner-only actions, bad codes, outdated CLI", async () => {
  const room = await createRoom();
  const agent = new RuchClient({ url, key: room.agent_code, name: "Alfa" });
  await assert.rejects(agent.post("/api/room/rotate"), /room owner/);
  await assert.rejects(agent.request("DELETE", "/api/room"), /room owner/);
  await assert.rejects(agent.get("/api/export"), /room owner/);
  assert.equal((await agent.get<{ agent_code?: string }>("/api/me")).agent_code, undefined);
  const owner = new RuchClient({ url, key: room.owner_key, name: "Jarda" });
  assert.equal((await owner.get<{ agent_code: string }>("/api/me")).agent_code, room.agent_code);
  const ex = await owner.get<{ format: string }>("/api/export");
  assert.equal(ex.format, "ruch-export-1");
  await assert.rejects(new RuchClient({ url, key: "ZZZZ-ZZZZ-ZZZZ", name: "X" }).get("/api/inbox"), /Invalid room code/);
  const old = await fetch(`${url}/api/inbox`, { headers: { authorization: `Bearer ${room.agent_code}`, "x-ruch-name": "Old", "x-ruch-client": "1" } });
  assert.equal(old.status, 426);
  assert.equal((await owner.request<{ deleted: boolean }>("DELETE", "/api/room")).deleted, true);
  await assert.rejects(owner.get("/api/me"), /Invalid room code/);
});

test("public pages and files: landing, legal, CLI and skill with this hub's address, invite text, admin stats", async () => {
  const home = await fetch(url);
  assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await home.text(), /R\.U\.Ch\./);
  const terms = await (await fetch(`${url}/terms`)).text();
  assert.match(terms, /ACME s\.r\.o\./);
  assert.doesNotMatch(terms, /\{\{/);
  assert.match(await (await fetch(`${url}/privacy`)).text(), /ACME s\.r\.o\./);
  const js = await (await fetch(`${url}/ruch.mjs`)).text();
  assert.ok(js.includes(`const DEFAULT_HUB = process.env.RUCH_HUB || ${JSON.stringify(url)};`), "hub URL baked into the CLI");
  const skill = await (await fetch(`${url}/skill.md`)).text();
  assert.ok(skill.includes(`${url}/ruch.mjs`) && skill.startsWith("---\nname: ruch"));
  const inv = await (await fetch(`${url}/j/ABCD-EFGH-JKMN`)).text();
  assert.match(inv, /join ABCD-EFGH-JKMN/);
  assert.match(inv, /\/mcp\?code=ABCD-EFGH-JKMN/);
  assert.equal((await fetch(`${url}/api/admin/stats`)).status, 401);
  const stats = await (await fetch(`${url}/api/admin/stats`, { headers: { authorization: "Bearer admintoken" } })).json();
  assert.ok(stats.rooms >= 1 && typeof stats.rss_mb === "number");
});

test("remote MCP endpoint works for clients without a shell", async () => {
  const room = await createRoom();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?code=${room.agent_code}&name=GPT`)));
  try {
    assert.match(client.getInstructions() ?? "", /R\.U\.Ch\. protocol/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["answer", "ask", "coordinate", "escalate", "files", "handoff", "inbox", "memory", "send", "status", "task", "thread"]);
    const started = await client.callTool({ name: "coordinate", arguments: { action: "start", text: "write docs", paths: ["docs/"] } });
    assert.match((started.content as { text: string }[])[0].text, /Checked in/);
    const made = await client.callTool({ name: "thread", arguments: { action: "new", title: "From ChatGPT", text: "hi" } });
    assert.match((made.content as { text: string }[])[0].text, /Created T2/);
    const err = await client.callTool({ name: "send", arguments: { thread: 9999, text: "x" } });
    assert.equal(err.isError, true);
  } finally {
    await client.close();
  }
});

test("local stdio MCP server connects with a room code", async () => {
  const room = await createRoom();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", join(ROOT, "dist", "mcp.js")],
      env: { ...process.env, RUCH_HUB: url, RUCH_CODE: room.agent_code, RUCH_AGENT: "Claude1", RUCH_ROLE: "coder" } as Record<string, string>,
    }),
  );
  try {
    assert.match(client.getInstructions() ?? "", /Role: coder/);
    const res = await client.callTool({ name: "inbox", arguments: {} });
    assert.match((res.content as { text: string }[])[0].text, /Nothing new for Claude1/);
  } finally {
    await client.close();
  }
  assert.ok(existsSync(CLI));
});
