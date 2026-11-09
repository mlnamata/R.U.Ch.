import { resolve } from "node:path";
import { DEFAULT_CONFIG, type HubConfig } from "./hub.js";

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  defaultProject: string;
  projectRoot: string | null;
  /** If set, every API call must send "Authorization: Bearer <token>". */
  token: string | null;
  /** If set, acting as the human additionally requires this token (so agents cannot impersonate the human). */
  humanToken: string | null;
  hub: HubConfig;
}

export function loadServerConfig(env = process.env): ServerConfig {
  return {
    host: env.RUCH_HOST ?? "127.0.0.1",
    port: int(env.RUCH_PORT, 4317),
    dbPath: env.RUCH_DB ?? resolve(process.cwd(), "ruch.db"),
    defaultProject: env.RUCH_PROJECT ?? "default",
    projectRoot: env.RUCH_PROJECT_ROOT ? resolve(env.RUCH_PROJECT_ROOT) : null,
    token: env.RUCH_TOKEN || null,
    humanToken: env.RUCH_HUMAN_TOKEN || null,
    hub: {
      ...DEFAULT_CONFIG,
      maxAgentStreak: int(env.RUCH_MAX_AGENT_STREAK, DEFAULT_CONFIG.maxAgentStreak),
      maxMessagesPerMinute: int(env.RUCH_MAX_MSG_PER_MIN, DEFAULT_CONFIG.maxMessagesPerMinute),
      defaultClaimMinutes: int(env.RUCH_CLAIM_MINUTES, DEFAULT_CONFIG.defaultClaimMinutes),
      humanName: env.RUCH_HUMAN_NAME ?? DEFAULT_CONFIG.humanName,
    },
  };
}
