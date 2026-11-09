import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RuchClient } from "../client.js";
import { loadServerConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { Hub } from "../hub.js";
import { createHttpServer } from "../http.js";
import { runTool } from "../tools.js";

let server: Server;
let url: string;
const cfg = loadServerConfig({ RUCH_HUMAN_NAME: "Jarda", RUCH_MAX_AGENT_STREAK: "6" } as NodeJS.ProcessEnv);

before(async () => {
  const hub = new Hub(openDatabase(":memory:"), cfg.hub);
  hub.ensureProject("default");
  server = createHttpServer(hub, { ...cfg, port: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const agent = (name: string) => new RuchClient({ url, project: "default", name });
const tool = async (c: RuchClient, name: string, args: unknown) => {
  const r = await runTool(c, name, args);
  assert.equal(r.isError, false, `${name} selhal: ${r.text}`);
  return r.text;
};

test("two agents and a human collaborate through the HTTP API and tools", async () => {
  const alfa = agent("Alfa");
  const beta = agent("Beta");
  const human = new RuchClient({ url, project: "default", name: "Jarda", kind: "human" });

  // MCP servers join on startup; an agent that has not joined yet cannot be @mentioned.
  await beta.post("/api/join", { role: "reviewer" });
  const created = await tool(alfa, "create_thread", { title: "Přihlašování", body: "Začínám na auth, @Beta budeš dělat review." });
  const threadId = Number(/T(\d+)/.exec(created)![1]);

  // Beta sees the mention in the inbox, exactly once.
  assert.match(await tool(beta, "inbox", {}), /Beta budeš dělat review/);
  assert.match(await tool(beta, "inbox", {}), /Nic nového/);

  // File claims prevent parallel edits.
  assert.match(await tool(alfa, "claim_files", { paths: ["src/auth/"], reason: "login" }), /Zamčeno/);
  assert.match(await tool(beta, "claim_files", { paths: ["src/auth/login.ts"], reason: "fix" }), /KONFLIKT.*\n.*Alfa/);

  // ask + wait: Beta answers while Alfa waits.
  const asking = tool(alfa, "ask", { to: "Beta", question: "Používáme cookies nebo localStorage pro token?", thread_id: threadId, wait_seconds: 5 });
  await new Promise((r) => setTimeout(r, 100));
  const pending = await human.get<{ id: number }[]>("/api/questions?status=open");
  await tool(beta, "answer", { question_id: pending[0].id, answer: "HttpOnly cookies", confidence: "certain" });
  assert.match(await asking, /odpověděl\(a\) Beta: @Alfa HttpOnly cookies/);
  assert.match(await tool(alfa, "search_knowledge", { query: "token cookies" }), /HttpOnly cookies/);

  // Unknown participants are reported, not silently accepted.
  const bad = await runTool(alfa, "ask", { to: "Gama", question: "?" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /není účastník/);

  // Escalation pauses the thread; agents are blocked until the human answers.
  assert.match(
    await tool(beta, "escalate_to_human", { thread_id: threadId, problem: "Session vs JWT?", options: ["Session", "JWT"] }),
    /pozastaveno/,
  );
  const blocked = await runTool(alfa, "post_message", { thread_id: threadId, body: "Já bych přesto bral JWT" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /čeká na člověka/);

  const open = await human.get<{ id: number; target: string }[]>("/api/questions?status=open");
  const q = open.find((x) => x.target === "Jarda")!;
  await human.post(`/api/questions/${q.id}/answer`, { choice: "A) Session", body: "" });
  assert.match(await tool(alfa, "post_message", { thread_id: threadId, body: "OK, jdu na session" }), /Odesláno/);
  assert.match(await tool(beta, "inbox", {}), /Volba: A\) Session/);
});

test("agents cannot act as the human when a human token is configured", async () => {
  const hub = new Hub(openDatabase(":memory:"), cfg.hub);
  hub.ensureProject("default");
  const s = createHttpServer(hub, { ...cfg, humanToken: "tajne" });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const fake = new RuchClient({ url: u, project: "default", name: "Jarda", kind: "human" });
    await assert.rejects(fake.get("/api/state"), /Neplatný token/);
    const real = new RuchClient({ url: u, project: "default", name: "Jarda", kind: "human", humanToken: "tajne" });
    assert.equal((await real.get<{ project: { slug: string } }>("/api/state")).project.slug, "default");
  } finally {
    s.close();
  }
});

test("MCP server exposes the tools and instructions over stdio", async () => {
  const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", mcpPath],
    env: { ...process.env, RUCH_URL: url, RUCH_AGENT: "Claude1", RUCH_ROLE: "coder" } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? "", /Protokol R\.U\.Ch\./);
    assert.match(client.getInstructions() ?? "", /Role: Kóder/);
    const { tools } = await client.listTools();
    for (const name of ["inbox", "post_message", "ask", "answer", "claim_files", "escalate_to_human", "search_knowledge"]) {
      assert.ok(tools.some((t) => t.name === name), `chybí nástroj ${name}`);
    }
    const res = await client.callTool({ name: "list_threads", arguments: {} });
    assert.match((res.content as { text: string }[])[0].text, /Přihlašování/);
    const err = await client.callTool({ name: "post_message", arguments: { thread_id: 9999, body: "x" } });
    assert.equal(err.isError, true);
  } finally {
    await client.close();
  }
});
