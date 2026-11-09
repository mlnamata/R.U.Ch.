/** Small HTTP client for the hub API, used by the MCP server and the built-in agent runner. */
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
  project: string;
  name: string;
  kind?: "agent" | "human";
  token?: string | null;
  humanToken?: string | null;
}

export class RuchClient {
  constructor(readonly opts: ClientOptions) {}

  static fromEnv(env = process.env, overrides: Partial<ClientOptions> = {}): RuchClient {
    const name = overrides.name ?? env.RUCH_AGENT ?? env.RUCH_NAME;
    if (!name) throw new Error("Nastav jméno agenta v proměnné RUCH_AGENT (např. RUCH_AGENT=Alfa).");
    return new RuchClient({
      url: (overrides.url ?? env.RUCH_URL ?? "http://127.0.0.1:4317").replace(/\/$/, ""),
      project: overrides.project ?? env.RUCH_PROJECT ?? "default",
      name,
      kind: overrides.kind ?? "agent",
      token: overrides.token ?? env.RUCH_TOKEN ?? null,
      humanToken: overrides.humanToken ?? env.RUCH_HUMAN_TOKEN ?? null,
    });
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      "x-ruch-project": encodeURIComponent(this.opts.project),
      "x-ruch-name": encodeURIComponent(this.opts.name),
      "x-ruch-kind": this.opts.kind ?? "agent",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.humanToken) headers["x-ruch-human-token"] = this.opts.humanToken;
    let res: Response;
    try {
      res = await fetch(this.opts.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new RuchApiError(
        0,
        "hub_unreachable",
        `Hub R.U.Ch. na ${this.opts.url} neodpovídá (${(e as Error).message}). Je spuštěný příkazem "npm start"?`,
      );
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new RuchApiError(res.status, data?.error ?? "error", data?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  get = <T = unknown>(path: string, signal?: AbortSignal) => this.request<T>("GET", path, undefined, signal);
  post = <T = unknown>(path: string, body: unknown = {}) => this.request<T>("POST", path, body);
  patch = <T = unknown>(path: string, body: unknown = {}) => this.request<T>("PATCH", path, body);
}
