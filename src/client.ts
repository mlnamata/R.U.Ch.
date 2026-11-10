/** Small HTTP client for the hub API (MCP servers and the built-in agent runner). */
export class RuchApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  url: string;
  /** Room key: the agent code (agents) or the owner key (the human). */
  key: string;
  name: string;
  /** Per-agent secret returned by a fresh join. */
  secret?: string;
}

/** Accepts a bare code ("7KQ2-X9MD-4TPA") or an invite link ("https://hub/j/7KQ2-X9MD-4TPA"). */
export function parseInvite(input: string, defaultHub: string): { url: string; key: string } {
  const s = input.trim();
  const m = /^(https?:\/\/[^\s#?]+?)\/(?:j|join)\/([0-9A-Za-z-]+)\/?$/.exec(s);
  if (m) return { url: m[1], key: m[2] };
  const o = /^(https?:\/\/[^\s#?]+?)\/?#(?:o|k)=([0-9A-Za-z-]+)$/.exec(s);
  if (o) return { url: o[1], key: o[2] };
  return { url: defaultHub.replace(/\/$/, ""), key: s };
}

export class RuchClient {
  constructor(readonly opts: ClientOptions) {}

  static fromEnv(env = process.env, overrides: Partial<ClientOptions> = {}): RuchClient {
    const name = overrides.name ?? env.RUCH_AGENT ?? env.RUCH_NAME;
    if (!name) throw new Error("Set the agent name in RUCH_AGENT (e.g. RUCH_AGENT=Alfa).");
    const code = overrides.key ?? env.RUCH_CODE;
    if (!code) throw new Error("Set the room code in RUCH_CODE (create a room on the hub website or with `node .ruch/ruch.mjs new`).");
    const inv = parseInvite(code, overrides.url ?? env.RUCH_URL ?? env.RUCH_HUB ?? "http://127.0.0.1:4317");
    return new RuchClient({ url: inv.url, key: inv.key, name });
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, opts: { text?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.key}`,
      "x-ruch-name": encodeURIComponent(this.opts.name),
    };
    if (opts.text) headers.accept = "text/plain";
    if (this.opts.secret) headers["x-ruch-secret"] = this.opts.secret;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.opts.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
    } catch (e) {
      throw new RuchApiError(0, "hub_unreachable", `R.U.Ch. hub at ${this.opts.url} is not answering (${(e as Error).message}).`);
    }
    const raw = await res.text();
    if (!res.ok) {
      let data: { error?: string; message?: string } = {};
      try {
        data = JSON.parse(raw);
      } catch {
        data = { message: raw };
      }
      throw new RuchApiError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    }
    return (opts.text ? raw : raw ? JSON.parse(raw) : null) as T;
  }

  get = <T = unknown>(path: string) => this.request<T>("GET", path);
  post = <T = unknown>(path: string, body: unknown = {}) => this.request<T>("POST", path, body);
  patch = <T = unknown>(path: string, body: unknown = {}) => this.request<T>("PATCH", path, body);
  /** Same endpoints, but the hub renders compact text for agents (saves tokens). */
  text = (method: string, path: string, body?: unknown) => this.request<string>(method, path, body, { text: true });
}
