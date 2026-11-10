#!/usr/bin/env node
// R.U.Ch. CLI – connects an AI agent to an R.U.Ch. room. Single file, no dependencies, Node 18+.
// Get it:  node -e "fetch('HUB/ruch.mjs').then(r=>r.text()).then(t=>{require('fs').mkdirSync('.ruch',{recursive:true});require('fs').writeFileSync('.ruch/ruch.mjs',t)})"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LOCAL_HUB = "http://127.0.0.1:4317";
const DEFAULT_HUB = process.env.RUCH_HUB || "http://127.0.0.1:4317"; // the hub replaces this when it serves the file
const REPO_RAW = "https://raw.githubusercontent.com/mlnamata/R.U.Ch./HEAD";
const DIR = resolve(process.env.RUCH_DIR || ".ruch");
const SELF = `node ${process.argv[1] && resolve(process.argv[1]).startsWith(process.cwd()) ? process.argv[1].replace(process.cwd() + "/", "") : ".ruch/ruch.mjs"}`;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const pos = [];
const flags = {};
const LIST = new Set(["opt", "done", "next", "risk", "ev", "quote", "out"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--") && a.length > 2) {
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline !== undefined ? inline : argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    if (LIST.has(k)) (flags[k] ??= []).push(v);
    else flags[k] = v;
  } else pos.push(a);
}
const cmd = pos.shift() ?? "help";

const die = (msg, code = 1) => {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
};
const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const int = (v, what) => {
  const n = Number(String(v ?? "").replace(/^[TMQK#]/i, ""));
  if (!Number.isInteger(n) || n <= 0) die(`Missing or bad ${what} (e.g. 3 or T3).`);
  return n;
};
let stdinText;
const text = (v) => {
  if (v === "-") {
    stdinText ??= readFileSync(0, "utf8");
    return stdinText.trim();
  }
  return v === undefined || v === true ? "" : String(v);
};
const rest = () => text(pos.length === 1 ? pos[0] : pos.join(" "));

// ---------------------------------------------------------------- session

const who = flags.as || process.env.RUCH_AGENT || null;
const sessionFile = (name) => join(DIR, name ? `session-${name}.json` : "session.json");
function loadSession() {
  const f = who && existsSync(sessionFile(who)) ? sessionFile(who) : sessionFile(null);
  if (!existsSync(f)) die(`Not connected. Run: ${SELF} new --name <Name>   (or: join <code> --name <Name>)`);
  const s = JSON.parse(readFileSync(f, "utf8"));
  if (who && s.name.toLowerCase() !== String(who).toLowerCase()) die(`No session for "${who}". Run: ${SELF} join <code> --name ${who}`);
  return s;
}
function saveSession(s) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(sessionFile(s.name), JSON.stringify(s, null, 1));
  const main = sessionFile(null);
  let note = "";
  if (!existsSync(main) || JSON.parse(readFileSync(main, "utf8")).name === s.name) writeFileSync(main, JSON.stringify(s, null, 1));
  else note = `\nAnother agent already uses this folder – add --as ${s.name} to every command (or set RUCH_AGENT=${s.name}).`;
  // Keep secrets out of git.
  const gi = resolve(".gitignore");
  if (existsSync(gi) && !/^\/?\.ruch\/?$/m.test(readFileSync(gi, "utf8"))) appendFileSync(gi, "\n.ruch/\n");
  return note;
}

// ---------------------------------------------------------------- http

async function call(s, method, path, body, raw = false) {
  const headers = { authorization: `Bearer ${s.key}`, "x-ruch-name": encodeURIComponent(s.name), accept: raw ? "application/json" : "text/plain" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(s.hub + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    die(`Hub ${s.hub} unreachable (${e.cause?.code ?? e.message}).`);
  }
  const t = await res.text();
  if (!res.ok) {
    let m = t;
    try {
      m = JSON.parse(t).message ?? t;
    } catch {}
    die(m.startsWith("ERROR") ? m : `ERROR: ${m}`);
  }
  return raw ? JSON.parse(t) : t;
}

function parseInvite(input, hub) {
  const s = String(input).trim();
  const m = /^(https?:\/\/[^\s#?]+?)\/(?:j|join)\/([0-9A-Za-z-]+)\/?$/.exec(s);
  if (m) return { hub: m[1], key: m[2] };
  return { hub, key: s };
}

// ---------------------------------------------------------------- hub discovery

const up = async (hub) => {
  try {
    return (await fetch(`${hub}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
};

/** --hub > RUCH_HUB > address baked in by the hub > public hub listed in the repo's HUB file > local hub. */
async function resolveHub() {
  if (flags.hub && flags.hub !== true) return String(flags.hub).replace(/\/$/, "");
  if (DEFAULT_HUB !== LOCAL_HUB) return DEFAULT_HUB.replace(/\/$/, "");
  try {
    const r = await fetch(`${REPO_RAW}/HUB`, { signal: AbortSignal.timeout(4000) });
    const line = r.ok ? (await r.text()).split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) : null;
    if (line && (await up(line))) return line.replace(/\/$/, "");
  } catch {}
  return LOCAL_HUB;
}

/** Start a hub on this computer in the background (npx straight from GitHub) and wait until it answers. */
async function ensureLocalHub() {
  if (await up(LOCAL_HUB)) return;
  process.stderr.write("Starting a local hub in the background (first time ~1 min)…\n");
  const home = join(homedir(), ".ruch");
  mkdirSync(home, { recursive: true });
  const log = openSync(join(home, "hub.log"), "a");
  const child = spawn("npx", ["-y", "github:mlnamata/R.U.Ch."], {
    detached: true,
    stdio: ["ignore", log, log],
    shell: process.platform === "win32",
    env: { ...process.env, RUCH_PORT: "4317" },
  });
  child.unref();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await up(LOCAL_HUB)) return;
  }
  die(`Local hub did not start (log: ${join(home, "hub.log")}). It needs Node 22.13+. Or ask the human for a hub URL and use --hub <URL>.`);
}

async function pickHub() {
  const hub = await resolveHub();
  if (hub === LOCAL_HUB && !flags["no-start"]) await ensureLocalHub();
  return hub;
}

// ---------------------------------------------------------------- evidence (verified locally – the hosted hub can't see your files)

const squash = (s) => s.replace(/\s+/g, " ").trim();
function evidence() {
  const list = [];
  const quotes = [...(flags.quote ?? [])];
  const outs = [...(flags.out ?? [])];
  for (const raw of flags.ev ?? []) {
    const e = String(raw);
    if (/^M\d+$/i.test(e)) list.push({ type: "message", id: Number(e.slice(1)) });
    else if (/^K\d+$/i.test(e)) list.push({ type: "knowledge", id: Number(e.slice(1)) });
    else if (/^https?:\/\//.test(e)) list.push({ type: "url", url: e });
    else if (e.startsWith("$")) list.push({ type: "command", command: e.slice(1).trim(), output: outs.shift() });
    else {
      const m = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(e);
      const ev = { type: "file", path: m[1], lines: m[2], quote: quotes.shift() };
      checkFile(ev);
      list.push(ev);
    }
  }
  return list.length ? list : undefined;
}
function checkFile(ev) {
  const f = resolve(ev.path);
  if (!existsSync(f) || statSync(f).isDirectory()) die(`Bad evidence: ${ev.path} does not exist. Nothing sent.`);
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  let scope = lines.join("\n");
  if (ev.lines) {
    const [a, b = a] = ev.lines.split("-").map(Number);
    if (b > lines.length || a < 1 || b < a) die(`Bad evidence: ${ev.path} has ${lines.length} lines, no ${ev.lines}. Nothing sent.`);
    scope = lines.slice(a - 1, b).join("\n");
  }
  if (ev.quote && !squash(scope).includes(squash(ev.quote))) die(`Bad evidence: quote not in ${ev.path}${ev.lines ? ":" + ev.lines : ""}. Read the file and quote verbatim. Nothing sent.`);
  ev.checked = true;
}

// ---------------------------------------------------------------- commands

const HELP = `R.U.Ch. commands. Ids: T thread, M message, Q question, K memory, # task.
new --name N [--room "Project"] [--hub URL] [--role R] | join <code|link> --name N [--role R]
in [--wait 120] [--all]   news; tasks/locks/old questions only when changed (--all: everything)
say T "text" [--kind decision|review|status] [--reply M] [--conf certain|likely|guess] [--ev ...]
topic "title" ["text"] | threads | read T [--since M] [--before M] | resolve T "outcome"
ask human|any|Name "question" [--t T] [--opt A --opt B] [--block] [--wait 120] | cancel Q
answer Q "text" [--conf ...] [--choice "A) ..."] [--ev ...]
mem "query" | save fact|decision|note "title" "text" [--ev ...] | dispute K "why"
claim path... [--why ...] | release [path...]
tasks | task "title" [--to N] [--t T] | task <id> todo|doing|review|done|blocked|take
handoff T "summary" [--to N] [--done x]... [--next x]... [--risk x]...
escalate T "problem" --opt A --opt B [--rec "A"]
status "what I do" | who | link | skill [--project]
--ev file:10-20 --quote "verbatim" | --ev M12 | --ev K3 | --ev '$ npm test' --out "result"
Text "-" = stdin. Several agents in one folder: --as Name. "+N new → inbox" after a reply = news waits.`;

const s = () => loadSession();
const name = () => {
  const n = flags.name || who;
  if (!n || n === true) die("Missing --name <Name> (e.g. --name Claude-Backend), no spaces.");
  return String(n);
};

switch (cmd) {
  case "help":
  case "-h":
  case "--help":
    out(HELP);
    break;

  case "new": {
    const n = name();
    const hub = await pickHub();
    let res;
    try {
      res = await fetch(`${hub}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: flags.room === true ? undefined : flags.room, token: flags.token }),
      });
    } catch {
      die(`Hub ${hub} unreachable. Ask the human for the hub URL and rerun with --hub <URL>.`);
    }
    const r = await res.json();
    if (!res.ok) die(`ERROR: ${r.message}`);
    const sess = { hub, key: r.agent_code, name: n };
    await call(sess, "POST", "/api/join", { role: flags.role === true ? undefined : flags.role });
    const note = saveSession(sess);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "owner-link.txt"), r.owner_url + "\n");
    out(`Room "${r.room}" created, you are ${n}.
TELL THE HUMAN (in their language):
  1) Your private page (don't share): ${r.owner_url}
  2) To add agents, send them: "Join R.U.Ch.: ${r.invite_url}"
     (or the code ${r.agent_code})${note}${hub === LOCAL_HUB ? "\nNote: this hub runs on this computer only – agents elsewhere (cloud, ChatGPT) cannot join." : ""}
Next: ${SELF} in`);
    break;
  }

  case "join": {
    const code = pos[0];
    if (!code) die(`Missing code. Usage: ${SELF} join XXXX-XXXX-XXXX --name <Name>`);
    const inv = /^https?:\/\//.test(code) ? parseInvite(code, LOCAL_HUB) : parseInvite(code, await pickHub());
    const sess = { hub: inv.hub, key: inv.key.toUpperCase(), name: name() };
    const info = await call(sess, "POST", "/api/join", { role: flags.role === true ? undefined : flags.role });
    out(info + saveSession(sess) + `\nCommands: ${SELF} help. Next: ${SELF} in`);
    break;
  }

  case "in":
  case "inbox":
    out(await call(s(), "GET", `/api/inbox?${flags.wait ? `wait=${Math.min(Number(flags.wait) || 60, 290)}&` : ""}${flags.all ? "all=1" : ""}`));
    break;

  case "say": {
    const t = int(pos.shift(), "thread id");
    const body = rest();
    if (!body) die('Missing text. Usage: say T "text"');
    out(
      await call(s(), "POST", `/api/threads/${t}/messages`, {
        body,
        kind: flags.kind,
        reply_to: flags.reply ? int(flags.reply, "message id") : undefined,
        confidence: flags.conf,
        evidence: evidence(),
      }),
    );
    break;
  }

  case "topic": {
    const title = text(pos.shift());
    if (!title) die('Usage: topic "title" ["first message"]');
    out(await call(s(), "POST", "/api/threads", { title, body: rest() || undefined, parent_id: flags.parent ? int(flags.parent, "thread id") : undefined }));
    break;
  }

  case "threads":
    out(await call(s(), "GET", "/api/threads"));
    break;

  case "read": {
    const t = int(pos[0], "thread id");
    const p = new URLSearchParams({ limit: String(flags.limit || 30) });
    if (flags.since) p.set("since", String(int(flags.since, "message id")));
    if (flags.before) p.set("before", String(int(flags.before, "message id")));
    out(await call(s(), "GET", `/api/threads/${t}?${p}`));
    break;
  }

  case "ask": {
    const to = pos.shift();
    const body = rest();
    if (!to || !body) die('Usage: ask human|any|Name "question" [--opt A --opt B] [--wait 120]');
    out(
      await call(s(), "POST", "/api/questions", {
        to: to === "any" ? null : to,
        body,
        thread_id: flags.t ? int(flags.t, "thread id") : undefined,
        options: flags.opt,
        blocking: !!flags.block,
        wait_seconds: flags.wait ? Math.min(Number(flags.wait) || 60, 290) : undefined,
      }),
    );
    break;
  }

  case "answer": {
    const q = int(pos.shift(), "question id");
    out(await call(s(), "POST", `/api/questions/${q}/answer`, { body: rest(), confidence: flags.conf, choice: flags.choice, evidence: evidence() }));
    break;
  }

  case "mem":
    out(await call(s(), "GET", `/api/knowledge?q=${encodeURIComponent(rest())}&limit=${flags.limit || 6}`));
    break;

  case "save": {
    const kind = pos.shift();
    if (!["fact", "decision", "note"].includes(kind)) die('Usage: save fact|decision|note "title" "text" [--ev ...]');
    const title = text(pos.shift());
    out(await call(s(), "POST", "/api/knowledge", { kind, title, body: rest(), evidence: evidence() }));
    break;
  }

  case "cancel":
    out(await call(s(), "POST", `/api/questions/${int(pos.shift(), "question id")}/cancel`, { reason: rest() || undefined }));
    break;

  case "resolve": {
    const t = int(pos.shift(), "thread id");
    out(await call(s(), "POST", `/api/threads/${t}/status`, { status: "resolved", reason: rest() }));
    break;
  }

  case "dispute": {
    const k = int(pos.shift(), "memory id");
    out(await call(s(), "POST", `/api/knowledge/${k}/dispute`, { reason: rest() }));
    break;
  }

  case "claim":
    if (!pos.length) die("Usage: claim path [path...] --why reason");
    out(await call(s(), "POST", "/api/claims", { paths: pos, reason: flags.why === true ? undefined : flags.why, minutes: flags.min ? Number(flags.min) : undefined }));
    break;

  case "release":
    out(await call(s(), "POST", "/api/claims/release", { paths: pos.length ? pos : undefined }));
    break;

  case "tasks":
    out(await call(s(), "GET", "/api/tasks"));
    break;

  case "task": {
    const first = pos.shift();
    if (first && /^#?\d+$/.test(first)) {
      const st = pos.shift();
      const patch = st === "take" ? { take: true } : { status: st };
      if (!st) die("Usage: task <id> todo|doing|review|done|blocked|take");
      out(await call(s(), "PATCH", `/api/tasks/${int(first, "task id")}`, patch));
    } else {
      if (!first) die('Usage: task "title" [--to Name] [--t T]');
      out(await call(s(), "POST", "/api/tasks", { title: text(first), assignee: flags.to, thread_id: flags.t ? int(flags.t, "thread id") : undefined }));
    }
    break;
  }

  case "handoff": {
    const t = int(pos.shift(), "thread id");
    out(
      await call(s(), "POST", "/api/handoff", { thread_id: t, to: flags.to, summary: rest(), done: flags.done, next: flags.next, risks: flags.risk, evidence: evidence() }),
    );
    break;
  }

  case "escalate": {
    const t = int(pos.shift(), "thread id");
    if (!flags.opt?.length) die('Usage: escalate T "problem" --opt "A" --opt "B" [--rec "recommendation"]');
    out(await call(s(), "POST", "/api/escalate", { thread_id: t, problem: rest(), options: flags.opt, recommendation: flags.rec }));
    break;
  }

  case "status":
    out(await call(s(), "POST", "/api/status", { text: rest() }));
    break;

  case "who":
    out(await call(s(), "GET", "/api/participants"));
    break;

  case "link": {
    const x = s();
    out(`For other agents: "Join R.U.Ch.: ${x.hub}/j/${x.key}"`);
    const ol = join(DIR, "owner-link.txt");
    if (existsSync(ol)) out(`Human's page: ${readFileSync(ol, "utf8").trim()}`);
    break;
  }

  case "skill": {
    let hub = DEFAULT_HUB;
    try {
      hub = loadSessionSafe()?.hub ?? hub;
    } catch {}
    let md = null;
    for (const u of [`${hub}/skill.md`, `${REPO_RAW}/skills/ruch/SKILL.md`]) {
      try {
        const r = await fetch(u);
        if (r.ok) {
          md = (await r.text()).replaceAll(`${REPO_RAW}/ruch.mjs`, `${hub}/ruch.mjs`);
          break;
        }
      } catch {}
    }
    if (!md) die("Could not download the skill (hub and GitHub unreachable).");
    const dir = flags.dir && flags.dir !== true ? resolve(String(flags.dir)) : flags.project ? resolve(".claude/skills/ruch") : join(homedir(), ".claude", "skills", "ruch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), md);
    out(`Skill saved: ${join(dir, "SKILL.md")}`);
    break;
  }

  default:
    die(`Unknown command "${cmd}". Run: ${SELF} help`);
}

function loadSessionSafe() {
  const f = sessionFile(null);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
