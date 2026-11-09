#!/usr/bin/env node
/**
 * Built-in agent: a Claude model that lives in the hub under one role.
 * It wakes up when something relevant arrives, works through its inbox using the
 * hub tools (plus read-only access to the project files), then goes back to waiting.
 *
 * Usage:  RUCH_AGENT=Kritik node dist/agent-runner.js --role reviewer --root ../my-project
 * Needs Anthropic credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { RuchClient } from "./client.js";
import { resolveInRoot } from "./evidence.js";
import { inboxText, type InboxView } from "./format.js";
import { normalizePath } from "./hub.js";
import { loadProtocol, loadRole, ROLES } from "./prompts.js";
import { TOOLS, runTool } from "./tools.js";
import type { Claim, Project } from "./types.js";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    role: { type: "string", default: "reviewer" },
    model: { type: "string", default: process.env.RUCH_MODEL ?? "claude-opus-5-5" },
    effort: { type: "string", default: process.env.RUCH_EFFORT ?? "medium" },
    root: { type: "string", default: process.env.RUCH_PROJECT_ROOT },
    "allow-write": { type: "boolean", default: false },
    "max-steps": { type: "string", default: "20" },
    "max-turns-per-hour": { type: "string", default: "20" },
    once: { type: "boolean", default: false },
  },
});

const ruch = RuchClient.fromEnv(process.env, args.name ? { name: args.name } : {});
const role = args.role!;
const roleText = loadRole(role);
if (!roleText) {
  console.error(`Neznámá role "${role}". Dostupné: ${ROLES.join(", ")} (nebo přidej prompts/roles/${role}.md).`);
  process.exit(1);
}
const root = args.root ?? null;
const maxSteps = Number(args["max-steps"]);
const maxTurnsPerHour = Number(args["max-turns-per-hour"]);
const effort = args.effort as "low" | "medium" | "high" | "xhigh" | "max";

const anthropic = new Anthropic();
const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}] [${ruch.opts.name}]`, ...a);

// ------------------------------------------------------------------ local file tools

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv"]);

function inRoot(p: string): string {
  if (!root) throw new Error("Agent nemá přístup k souborům (spusť s --root).");
  const full = resolveInRoot(root, p || ".");
  if (!full) throw new Error(`Cesta ${p} je mimo projekt.`);
  return full;
}

function walk(dir: string, out: string[], limit: number) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out, limit);
    } else out.push(join(dir, entry.name));
  }
}

interface LocalTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  run: (a: any) => Promise<string> | string;
}

const fileTools: LocalTool[] = [
  {
    name: "read_file",
    description: "Přečte soubor z projektu s čísly řádků (max 400 řádků najednou). Používej před každým tvrzením o kódu.",
    schema: z.object({ path: z.string(), from_line: z.number().int().min(1).optional(), to_line: z.number().int().optional() }),
    run: (a: { path: string; from_line?: number; to_line?: number }) => {
      const lines = readFileSync(inRoot(a.path), "utf8").split(/\r?\n/);
      const from = a.from_line ?? 1;
      const to = Math.min(a.to_line ?? from + 399, from + 399, lines.length);
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");
      return `${a.path} (řádky ${from}-${to} z ${lines.length})\n${body}`;
    },
  },
  {
    name: "list_files",
    description: "Vypíše soubory v projektu (rekurzivně, bez node_modules/.git), max 300.",
    schema: z.object({ dir: z.string().default(".") }),
    run: (a: { dir: string }) => {
      const out: string[] = [];
      walk(inRoot(a.dir), out, 300);
      return out.map((f) => relative(root!, f)).join("\n") || "(prázdné)";
    },
  },
  {
    name: "search_files",
    description: "Najde řádky odpovídající regulárnímu výrazu v souborech projektu (max 100 výsledků).",
    schema: z.object({ pattern: z.string(), dir: z.string().default(".") }),
    run: (a: { pattern: string; dir: string }) => {
      const re = new RegExp(a.pattern, "i");
      const files: string[] = [];
      walk(inRoot(a.dir), files, 5000);
      const hits: string[] = [];
      for (const f of files) {
        if (statSync(f).size > 1_000_000) continue;
        const lines = readFileSync(f, "utf8").split(/\r?\n/);
        lines.forEach((l, i) => {
          if (hits.length < 100 && re.test(l)) hits.push(`${relative(root!, f)}:${i + 1}: ${l.trim().slice(0, 200)}`);
        });
        if (hits.length >= 100) break;
      }
      return hits.join("\n") || "Nic nenalezeno.";
    },
  },
];

if (args["allow-write"]) {
  fileTools.push({
    name: "write_file",
    description: "Zapíše celý obsah souboru. Funguje jen pro cesty, které máš zamčené přes claim_files.",
    schema: z.object({ path: z.string(), content: z.string() }),
    run: async (a: { path: string; content: string }) => {
      const claims = await ruch.get<Claim[]>("/api/claims");
      const p = normalizePath(a.path);
      // The claim must cover the file (same path or a parent directory), not just overlap it.
      if (!claims.some((c) => c.holder === ruch.opts.name && (c.path === p || c.path === "." || p.startsWith(c.path + "/")))) {
        throw new Error(`Soubor ${p} nemáš zamčený. Nejdřív zavolej claim_files.`);
      }
      const full = inRoot(p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, a.content);
      return `Zapsáno ${p} (${a.content.split("\n").length} řádků).`;
    },
  });
}

// ------------------------------------------------------------------ tool definitions for the API

function toInputSchema(schema: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}

const apiTools: Anthropic.Beta.BetaTool[] = [
  ...TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: toInputSchema(t.schema) })),
  ...(root ? fileTools.map((t) => ({ name: t.name, description: t.description, input_schema: toInputSchema(t.schema) })) : []),
];

async function execute(name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const local = fileTools.find((t) => t.name === name);
  if (local) {
    const parsed = local.schema.safeParse(input ?? {});
    if (!parsed.success) return { text: `Neplatné argumenty: ${parsed.error.message}`, isError: true };
    try {
      return { text: await local.run(parsed.data), isError: false };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  }
  return runTool(ruch, name, input);
}

// ------------------------------------------------------------------ one working turn

async function systemPrompt(): Promise<string> {
  const { project } = await ruch.get<{ project: Project }>("/api/me");
  return [
    `Jsi agent "${ruch.opts.name}" v projektu "${project.name}".`,
    project.brief ? `## Zadání projektu\n${project.brief}` : "",
    loadProtocol(),
    roleText!,
    root
      ? "Máš přístup k souborům projektu přes read_file / list_files / search_files. Cesty v evidence piš relativně ke kořeni projektu."
      : "K souborům projektu nemáš přístup – tvrzení o kódu si nech potvrdit od agenta, který ho vidí.",
    "Když v inboxu není nic, co by se týkalo tvé role, nic nepiš a skonči.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function workTurn(inbox: string) {
  const system = await systemPrompt();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Nový stav tvého inboxu v R.U.Ch.:\n\n${inbox}\n\nZpracuj to podle své role.` },
  ];
  for (let step = 0; step < maxSteps; step++) {
    const response = await anthropic.beta.messages.create({
      model: args.model!,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: apiTools,
      messages,
      output_config: { effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      log("Model požadavek odmítl:", response.stop_details?.category ?? "", response.stop_details?.explanation ?? "");
      return;
    }
    // Keep the full content (including thinking blocks) – the conversation is append-only.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "max_tokens" && uses.length === 0) {
      log("Odpověď narazila na max_tokens, končím krok.");
      return;
    }
    if (uses.length === 0) {
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (text) log("Hotovo:", text.slice(0, 300));
      return;
    }
    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const r = await execute(u.name, u.input);
        log(`→ ${u.name}${r.isError ? " (chyba)" : ""}`);
        return { type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  log(`Dosažen limit ${maxSteps} kroků v jednom tahu.`);
  await runTool(ruch, "set_status", { text: `zastaven limitem ${maxSteps} kroků – potřebuju nasměrovat` });
}

// ------------------------------------------------------------------ main loop

const turns: number[] = [];

async function main() {
  await ruch.post("/api/join", { role });
  await runTool(ruch, "set_status", { text: `online (${role})` });
  log(`Připojen(a) k ${ruch.opts.url}, role ${role}, model ${args.model}${root ? `, kořen ${root}` : ""}`);

  for (;;) {
    const ib = await ruch.get<InboxView>("/api/inbox");
    const actionable =
      ib.messages.length > 0 || ib.questions_for_me.length > 0 || ib.my_questions.some((q) => q.status !== "open");
    if (actionable) {
      const hourAgo = Date.now() - 3_600_000;
      while (turns.length && turns[0] < hourAgo) turns.shift();
      if (turns.length >= maxTurnsPerHour) {
        log(`Limit ${maxTurnsPerHour} tahů za hodinu – čekám (šetří API kredity).`);
        await runTool(ruch, "set_status", { text: "pauza – hodinový limit tahů" });
        await new Promise((r) => setTimeout(r, 5 * 60_000));
        continue;
      }
      turns.push(Date.now());
      try {
        await workTurn(inboxText(ib));
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) {
          console.error("Chybí nebo neplatí přihlášení k Claude API (ANTHROPIC_API_KEY nebo `ant auth login`).");
          process.exit(1);
        } else if (e instanceof Anthropic.RateLimitError) {
          log("Rate limit API – čekám minutu.");
          await new Promise((r) => setTimeout(r, 60_000));
        } else if (e instanceof Anthropic.APIError) {
          log(`Chyba API ${e.status}: ${e.message}`);
        } else throw e;
      }
      if (args.once) return;
      continue;
    }
    if (args.once) {
      log("Nic k práci.");
      return;
    }
    await ruch.get("/api/wait?timeout=120");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
