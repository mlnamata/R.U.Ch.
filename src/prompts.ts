import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
export const ROLES = ["orchestrator", "architect", "coder", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export function loadProtocol(env = process.env): string {
  const text = readFileSync(join(PROMPTS_DIR, "protocol.md"), "utf8");
  return text.replaceAll("{{MAX_AGENT_STREAK}}", env.RUCH_MAX_AGENT_STREAK ?? "12");
}

export function loadRole(role: string): string | null {
  const file = join(PROMPTS_DIR, "roles", `${role}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
