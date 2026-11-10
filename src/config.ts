import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  /** Bearer token for /api/admin/* (operator metrics). Unset = admin API off. */
  adminToken: string | null;
  /** Directory for daily database backups. Unset = no backups. */
  backupDir: string | null;
  /** Behind a reverse proxy (Render, Fly, nginx): take the client IP from the proxy headers. */
  trustProxy: boolean;
  /** Max live (SSE) connections per room. */
  maxStreamsPerRoom: number;
  /** Shown on the Terms and Privacy pages. */
  operator: { name: string; contact: string; country: string };
  hub: HubConfig;
}

export function loadServerConfig(env = process.env): ServerConfig {
  return {
    host: env.RUCH_HOST ?? "127.0.0.1",
    port: int(env.PORT ?? env.RUCH_PORT, 4317),
    dbPath: env.RUCH_DB ?? defaultDb(),
    publicUrl: publicUrl(env),
    createToken: env.RUCH_CREATE_TOKEN || null,
    roomsPerIpPerHour: int(env.RUCH_ROOMS_PER_IP_HOUR, 20),
    adminToken: env.RUCH_ADMIN_TOKEN || null,
    backupDir: env.RUCH_BACKUP_DIR || null,
    trustProxy: env.RUCH_TRUST_PROXY ? env.RUCH_TRUST_PROXY === "1" : !!(env.RENDER || env.FLY_APP_NAME || env.RAILWAY_PUBLIC_DOMAIN),
    maxStreamsPerRoom: int(env.RUCH_MAX_STREAMS_PER_ROOM, 20),
    operator: {
      name: env.RUCH_OPERATOR_NAME || "[operator name]",
      contact: env.RUCH_OPERATOR_CONTACT || "[contact e-mail]",
      country: env.RUCH_OPERATOR_COUNTRY || "Czech Republic",
    },
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

/** ~/.ruch/hub.db – keeps the database out of whatever folder the hub was started in. */
function defaultDb() {
  const dir = join(homedir(), ".ruch");
  mkdirSync(dir, { recursive: true });
  return join(dir, "hub.db");
}

/** Explicit RUCH_PUBLIC_URL, or what the hosting platform tells us (Render, Fly.io, Railway). */
function publicUrl(env: NodeJS.ProcessEnv): string | null {
  const url =
    env.RUCH_PUBLIC_URL ||
    env.RENDER_EXTERNAL_URL ||
    (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : "") ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return url ? url.replace(/\/$/, "") : null;
}
