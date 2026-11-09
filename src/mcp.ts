#!/usr/bin/env node
/**
 * MCP server (stdio) that connects one agent – e.g. a Claude Code session – to the hub.
 * Run one per agent with a different RUCH_AGENT name; they all talk to the same hub over HTTP.
 */
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuchClient } from "./client.js";
import { loadProtocol, loadRole } from "./prompts.js";
import { TOOLS, runTool } from "./tools.js";

// Two sessions sharing one .mcp.json would otherwise get the same name and look like one agent.
const name = process.env.RUCH_AGENT?.trim() || `Agent-${randomBytes(2).toString("hex")}`;
const client = RuchClient.fromEnv(process.env, { name });
const role = process.env.RUCH_ROLE ?? "";
const roleText = role ? loadRole(role) : null;

const instructions = [
  `Jsi agent "${client.opts.name}" v projektu "${client.opts.project}".`,
  loadProtocol(),
  roleText ?? (role ? `Tvoje role: ${role}` : ""),
]
  .filter(Boolean)
  .join("\n\n");

const server = new McpServer({ name: "ruch", version: "0.1.0" }, { instructions });

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    {
      description: t.description,
      inputSchema: t.schema.shape,
      annotations: { readOnlyHint: t.readOnly ?? false, openWorldHint: false },
    },
    async (args: unknown) => {
      const r = await runTool(client, t.name, args);
      return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
    },
  );
}

server.registerPrompt(
  "ruch-protocol",
  { description: "Pravidla spolupráce v R.U.Ch. (vlož do kontextu agenta, pokud klient nečte instrukce serveru)" },
  () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: instructions } }] }),
);

// Register on the hub right away so the agent shows up as online in the UI.
client
  .post("/api/join", { role })
  .catch((e) => console.error(`[ruch-mcp] Nepodařilo se připojit k hubu: ${(e as Error).message}`));

await server.connect(new StdioServerTransport());
