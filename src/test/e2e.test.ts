import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  const cfg = loadServerConfig({ RUCH_MAX_AGENT_STREAK: "8" } as NodeJS.ProcessEnv);
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
  assert.equal(r.code, 0, `ruch ${args.join(" ")} selhal: ${r.err}${r.out}`);
  return r.out;
};

async function createRoom() {
  const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await res.json()) as { agent_code: string; owner_key: string; owner_url: string; invite_url: string };
}

test("CLI: first agent creates a room, second joins by invite link, they talk, the human answers", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "ruch-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "ruch-b-"));
  writeFileSync(join(dirA, ".gitignore"), "node_modules\n");
  writeFileSync(join(dirA, "api.ts"), "export const port = 8080;\nexport function start() {}\n");

  const created = await ok(dirA, ["new", "--name", "Alfa", "--room", "Shop", "--role", "coder"]);
  const invite = /Připoj se do R\.U\.Ch\.: (\S+)"/.exec(created)![1];
  const ownerUrl = /stránka.*?: (\S+)/.exec(created)![1];
  assert.match(invite, /\/j\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.match(readFileSync(join(dirA, ".gitignore"), "utf8"), /^\.ruch\/$/m, "secrets must be git-ignored");
  assert.ok(existsSync(join(dirA, ".ruch", "owner-link.txt")));

  assert.match(await ok(dirB, ["join", invite, "--name", "Beta", "--role", "reviewer"]), /Připojen\(a\) jako Beta/);

  const topic = await ok(dirA, ["topic", "API", "@Beta mrkni na port"]);
  const t = /T(\d+)/.exec(topic)![1];
  assert.match(await ok(dirB, ["in"]), /Alfa: @Beta mrkni na port/);
  assert.match(await ok(dirB, ["in"]), /Nic nového/);

  // Evidence is verified locally before anything is sent.
  const bad = await cli(dirA, ["say", t, "Port je 3000", "--kind", "review", "--ev", "api.ts:1", "--quote", "port = 3000"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /citace/);
  assert.match(await ok(dirA, ["say", t, "Port je 8080", "--kind", "review", "--ev", "api.ts:1", "--quote", "port = 8080"]), /^OK M\d+/);
  assert.match(await ok(dirB, ["read", t]), /důkazy: api\.ts:1 ✓ ověřeno/);

  // Multi-line text from stdin.
  assert.match(await ok(dirB, ["say", t, "-"], "řádek 1\nřádek 2"), /^OK/);

  // File locks across agents.
  assert.match(await ok(dirA, ["claim", "src/", "--why", "refactor"]), /Zamčeno: src/);
  assert.match(await ok(dirB, ["claim", "src/db.ts"]), /KONFLIKT[\s\S]*Alfa/);

  // Agent asks the human and waits; the human answers from the web (owner key).
  const asking = ok(dirB, ["ask", "human", "Mám to nasadit?", "--t", t, "--opt", "Ano", "--opt", "Ne", "--wait", "5"]);
  await new Promise((r) => setTimeout(r, 200));
  const ownerKey = ownerUrl.split("#o=")[1];
  const human = new RuchClient({ url, key: ownerKey, name: "Supervizor" });
  const qs = await human.get<{ id: number }[]>("/api/questions?status=open");
  await human.post(`/api/questions/${qs[0].id}/answer`, { choice: "B) Ne", body: "" });
  assert.match(await asking, /odpověděl\(a\) Supervizor: @Beta Volba: B\) Ne/);
  assert.match(await ok(dirA, ["mem", "nasadit"]), /potvrdil člověk/);

  // Unknown participants are reported, not silently accepted.
  const unknown = await cli(dirA, ["ask", "Gama", "Kde je config?"]);
  assert.match(unknown.err, /není účastník/);
});

test("roles: agents cannot act as the owner, bad codes are refused", async () => {
  const room = await createRoom();
  const agent = new RuchClient({ url, key: room.agent_code, name: "Alfa" });
  await assert.rejects(agent.post("/api/room/rotate"), /vlastník/);
  assert.equal((await agent.get<{ role: string; agent_code?: string }>("/api/me")).agent_code, undefined);
  const owner = new RuchClient({ url, key: room.owner_key, name: "Jarda" });
  const me = await owner.get<{ role: string; agent_code: string }>("/api/me");
  assert.equal(me.role, "owner");
  assert.equal(me.agent_code, room.agent_code);
  await assert.rejects(new RuchClient({ url, key: "ZZZZ-ZZZZ-ZZZZ", name: "X" }).get("/api/inbox"), /Neplatný kód/);
});

test("public files: CLI and skill are served with this hub's address, invite page has instructions", async () => {
  const js = await (await fetch(`${url}/ruch.mjs`)).text();
  assert.ok(js.includes(JSON.stringify(url)), "hub URL baked into the CLI");
  const skill = await (await fetch(`${url}/skill.md`)).text();
  assert.ok(skill.includes(`${url}/ruch.mjs`) && skill.startsWith("---\nname: ruch"));
  const inv = await (await fetch(`${url}/j/ABCD-EFGH-JKMN`)).text();
  assert.match(inv, /join ABCD-EFGH-JKMN/);
  assert.match(inv, /\/mcp\?code=ABCD-EFGH-JKMN/);
});

test("remote MCP endpoint works for clients without a shell", async () => {
  const room = await createRoom();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?code=${room.agent_code}&name=GPT`)));
  try {
    assert.match(client.getInstructions() ?? "", /R\.U\.Ch\. protocol/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["answer", "ask", "escalate", "files", "handoff", "inbox", "memory", "send", "status", "task", "thread"]);
    const made = await client.callTool({ name: "thread", arguments: { action: "new", title: "Z ChatGPT", text: "ahoj" } });
    assert.match((made.content as { text: string }[])[0].text, /Vytvořeno T\d+/);
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
    assert.match((res.content as { text: string }[])[0].text, /Nic nového pro Claude1/);
  } finally {
    await client.close();
  }
});
