#!/usr/bin/env node
/**
 * Local MCP server (stdio) for MCP clients that prefer it over the hub's remote /mcp endpoint.
 * Env: RUCH_CODE (room code or invite link), RUCH_AGENT (name), RUCH_ROLE (optional), RUCH_HUB.
 */
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuchClient } from "./client.js";
import { buildMcpServer } from "./tools.js";

// Two sessions sharing one config would otherwise get the same name and look like one agent.
const name = process.env.RUCH_AGENT?.trim() || `Agent-${randomBytes(2).toString("hex")}`;
const client = RuchClient.fromEnv(process.env, { name });
const role = process.env.RUCH_ROLE ?? "";

client.post("/api/join", { role }).catch((e) => console.error(`[ruch-mcp] ${(e as Error).message}`));
await buildMcpServer(client, role).connect(new StdioServerTransport());
