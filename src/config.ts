import { resolve } from "node:path";
import { DEFAULT_CONFIG, type HubConfig } from "./hub.js";

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  /** Public base URL (e.g. https://ruch.example.com). Derived from the request when unset. */
  publicUrl: string | null;
  /** If set, creating rooms requires this token (private deployments). */
  createToken: string | null;
  /** Max rooms one IP may create per hour. */
  roomsPerIpPerHour: number;
  hub: HubConfig;
}

export function loadServerConfig(env = process.env): ServerConfig {
  return {
    host: env.RUCH_HOST ?? "127.0.0.1",
    port: int(env.PORT ?? env.RUCH_PORT, 4317),
    dbPath: env.RUCH_DB ?? resolve(process.cwd(), "ruch.db"),
    publicUrl: env.RUCH_PUBLIC_URL?.replace(/\/$/, "") || null,
    createToken: env.RUCH_CREATE_TOKEN || null,
    roomsPerIpPerHour: int(env.RUCH_ROOMS_PER_IP_HOUR, 20),
    hub: {
      ...DEFAULT_CONFIG,
      maxAgentStreak: int(env.RUCH_MAX_AGENT_STREAK, DEFAULT_CONFIG.maxAgentStreak),
      maxMessagesPerMinute: int(env.RUCH_MAX_MSG_PER_MIN, DEFAULT_CONFIG.maxMessagesPerMinute),
      defaultClaimMinutes: int(env.RUCH_CLAIM_MINUTES, DEFAULT_CONFIG.defaultClaimMinutes),
      roomTtlDays: int(env.RUCH_ROOM_TTL_DAYS, DEFAULT_CONFIG.roomTtlDays),
      humanName: env.RUCH_HUMAN_NAME ?? DEFAULT_CONFIG.humanName,
      projectRoot: env.RUCH_PROJECT_ROOT ? resolve(env.RUCH_PROJECT_ROOT) : null,
    },
  };
}
