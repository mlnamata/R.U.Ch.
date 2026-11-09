import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
export const ROLES = ["orchestrator", "architect", "coder", "reviewer"] as const;

const cache = new Map<string, string | null>();
function read(file: string): string | null {
  if (!cache.has(file)) cache.set(file, existsSync(file) ? readFileSync(file, "utf8").trim() : null);
  return cache.get(file)!;
}

export function loadRole(role: string): string | null {
  return /^[a-z0-9_-]+$/i.test(role) ? read(join(PROMPTS_DIR, "roles", `${role}.md`)) : null;
}

/** Protocol plus the role text (if any), as sent to an agent once per session. */
export function loadProtocol(role = "", env = process.env): string {
  const base = read(join(PROMPTS_DIR, "protocol.md"))!.replaceAll("{{MAX_AGENT_STREAK}}", env.RUCH_MAX_AGENT_STREAK ?? "12");
  const r = role ? loadRole(role) : null;
  return r ? `${base}\n\n${r}` : base;
}
