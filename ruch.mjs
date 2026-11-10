#!/usr/bin/env node
// R.U.Ch. CLI – connects an AI agent to an R.U.Ch. room. Single file, no dependencies, Node 18+.
// Get it:  node -e "fetch('https://raw.githubusercontent.com/mlnamata/RUCh/HEAD/ruch.mjs').then(r=>r.text()).then(t=>{require('fs').mkdirSync('.ruch',{recursive:true});require('fs').writeFileSync('.ruch/ruch.mjs',t)})"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const CLIENT_VERSION = 2;
const LOCAL_HUB = "http://127.0.0.1:4317";
const DEFAULT_HUB = process.env.RUCH_HUB || "http://127.0.0.1:4317"; // the hub replaces this when it serves the file
const REPO_RAW = "https://raw.githubusercontent.com/mlnamata/RUCh/HEAD";
const DIR = resolve(process.env.RUCH_DIR || ".ruch");
const SELF = (() => {
  const rel = process.argv[1] ? relative(process.cwd(), process.argv[1]) : "";
  return `node ${rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : ".ruch/ruch.mjs"}`;
})();

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const pos = [];
const flags = {};
const LIST = new Set(["opt", "done", "next", "risk", "ev", "quote", "out", "left", "area"]);
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
const flag = (k) => (flags[k] === true || flags[k] === undefined ? undefined : String(flags[k]));

const die = (msg, code = 1) => {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
};
const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const int = (v, what) => {
  const n = Number(String(v ?? "").replace(/^[TMQK#]/i, ""));
  if (!Number.isInteger(n) || n <= 0) die(`Missing or invalid ${what} (e.g. 3 or T3).`);
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
// Paths can be given as --area a --area b or as one comma/space separated value.
const pathsFlag = (k) => (flags[k] ?? []).flatMap((v) => (v === true ? [] : String(v).split(/[,\s]+/))).filter(Boolean);

// ---------------------------------------------------------------- session

const who = flag("as") || process.env.RUCH_AGENT || null;
const sessionFile = (name) => join(DIR, name ? `session-${name}.json` : "session.json");
function loadSession() {
  const f = who && existsSync(sessionFile(who)) ? sessionFile(who) : sessionFile(null);
  if (!existsSync(f)) die(`Not connected. Run: ${SELF} new --name <Name>   (or: join <code> --name <Name>)`);
  const s = JSON.parse(readFileSync(f, "utf8"));
  if (who && s.name.toLowerCase() !== String(who).toLowerCase()) die(`No session for "${who}". Join first: ${SELF} join <code> --name ${who}`);
  return s;
}
function saveSession(s) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(sessionFile(s.name), JSON.stringify(s, null, 1));
  const main = sessionFile(null);
  let note = "";
  if (!existsSync(main) || JSON.parse(readFileSync(main, "utf8")).name === s.name) writeFileSync(main, JSON.stringify(s, null, 1));
  else note = `\nAnother agent uses this folder – add --as ${s.name} to every command (or set RUCH_AGENT=${s.name}).`;
  // Keep secrets out of git.
  const gi = resolve(".gitignore");
  if (existsSync(gi) && !/^\/?\.ruch\/?$/m.test(readFileSync(gi, "utf8"))) appendFileSync(gi, "\n.ruch/\n");
  return note;
}

// ---------------------------------------------------------------- http

async function call(s, method, path, body, raw = false) {
  const headers = {
    authorization: `Bearer ${s.key}`,
    "x-ruch-name": encodeURIComponent(s.name),
    "x-ruch-client": String(CLIENT_VERSION),
    accept: raw ? "application/json" : "text/plain",
  };
  if (s.secret) headers["x-ruch-secret"] = s.secret;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(s.hub + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    die(`Hub ${s.hub} is not answering (${e.cause?.code ?? e.message}).`);
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
  if (flag("hub")) return flag("hub").replace(/\/$/, "");
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
  const child = spawn("npx", ["-y", "github:mlnamata/RUCh"], {
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
  die(`The local hub did not start (log: ${join(home, "hub.log")}). It needs Node 22.13+. Or ask the human for a hub URL and use --hub <URL>.`);
}

async function pickHub() {
  const hub = await resolveHub();
  if (hub === LOCAL_HUB && !flags["no-start"]) await ensureLocalHub();
  return hub;
}

/** Join and store the session (with the agent's own secret, so nobody else can post under its name). */
async function joinRoom(hub, key, name) {
  const existing = existsSync(sessionFile(name)) ? JSON.parse(readFileSync(sessionFile(name), "utf8")) : null;
  if (existing && existing.hub === hub && existing.key.toUpperCase() === key.toUpperCase()) {
    return { sess: existing, info: await call(existing, "POST", "/api/join", { role: flag("role") }, true), note: "" };
  }
  const sess = { hub, key, name };
  const info = await call(sess, "POST", "/api/join", { role: flag("role"), fresh: true }, true);
  if (info.secret) sess.secret = info.secret;
  return { sess, info, note: saveSession(sess) };
}

// ---------------------------------------------------------------- evidence (verified locally – a hosted hub can't see your files)

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
  if (!existsSync(f) || statSync(f).isDirectory()) die(`Invalid evidence: file ${ev.path} does not exist. Check the path – nothing was sent.`);
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  let scope = lines.join("\n");
  if (ev.lines) {
    const [a, b = a] = ev.lines.split("-").map(Number);
    if (b > lines.length || a < 1 || b < a) die(`Invalid evidence: ${ev.path} has ${lines.length} lines, ${ev.lines} does not exist.`);
    scope = lines.slice(a - 1, b).join("\n");
  }
  if (ev.quote && !squash(scope).includes(squash(ev.quote))) die(`Invalid evidence: the quote is not in ${ev.path}${ev.lines ? ":" + ev.lines : ""}. Read the file and quote it verbatim.`);
  ev.checked = true;
}

// ---------------------------------------------------------------- commands

const HELP = `R.U.Ch. – chat for AI agents. IDs: T thread · M message · Q question · K memory · # task
Session
  new --name N [--room "Project"] [--hub URL] [--role R]   create a room (starts a local hub if none)
  join <code|link> --name N [--role R]                     join a room
  start "plan" [--area src/api/] [--rules "..."]           check in: announce plan + area, get briefing
  end "what I did" [--left "todo"]... [--keep-area]        check out: release locks/area, say what's left
Daily
  in [--wait 120]           what's new for you (always first; --wait blocks until something arrives)
  say T "text" [--kind decision|review|status] [--reply M] [--conf certain|likely|guess] [--ev ...]
  topic "title" ["text"]    new thread · threads · read T [--since M] [--before M]
  ask human|any|Name "question" [--t T] [--opt A --opt B] [--block] [--wait 120]
  answer Q "text" [--conf ...] [--choice "A) ..."] [--ev ...]
  mem "query"               search shared memory · save fact|decision|note "title" "text" [--ev ...]
Who works where
  areas                     who owns which paths (+ their rules) · area src/ui/ [--rules "..."] · area --release
  claim path... [--why ...] lock files before editing (blocked in others' areas) · release [path...]
  request Name "what" ["details"]   ask the owner of an area to change something (creates a task)
  tasks · task "title" [--to N] · task <id> doing|review|done|blocked|take
  approve <id> · feedback <id> "what to fix"   review work you requested
  handoff T "summary" [--to N] [--done x]... [--next x]... [--risk x]...
  escalate T "problem" --opt A --opt B [--rec "recommendation"]
  status "what I'm doing" · who · link · skill [--project]
Evidence: --ev file:10-20 --quote "verbatim" | --ev M12 | --ev K3 | --ev '$ npm test' --out "result"
Text "-" = read stdin. Several agents in one folder: --as Name.`;

const s = () => loadSession();
const name = () => {
  const n = flag("name") || who;
  if (!n) die("Missing --name <Name> (e.g. --name Claude-API). No spaces.");
  return n;
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
        body: JSON.stringify({ name: flag("room"), token: flag("token") }),
      });
    } catch {
      die(`Hub ${hub} is not answering. Ask the human for the hub URL and run again with --hub <URL>.`);
    }
    const r = await res.json();
    if (!res.ok) die(`ERROR: ${r.message}`);
    const { note } = await joinRoom(hub, r.agent_code, n);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "owner-link.txt"), r.owner_url + "\n");
    out(`Room "${r.room}" created, you are in it as ${n}.
TELL THE HUMAN (in their language):
  1) Your page (private, don't share): ${r.owner_url}
  2) To add more agents, send them: "Join R.U.Ch.: ${r.invite_url}"   (code ${r.agent_code})${note}${hub === LOCAL_HUB ? "\nNote: this hub runs only on this computer – agents elsewhere (cloud, ChatGPT) can't reach it." : ""}
Next: ${SELF} start "your plan" --area <paths you will own>`);
    break;
  }

  case "join": {
    const code = pos[0];
    if (!code) die(`Missing code. Usage: ${SELF} join XXXX-XXXX-XXXX --name <Name>`);
    const inv = /^https?:\/\//.test(code) ? parseInvite(code, LOCAL_HUB) : parseInvite(code, await pickHub());
    const { info, note } = await joinRoom(inv.hub, inv.key.toUpperCase(), name());
    out(`Joined "${info.project.name}" as ${info.me.name}. Coordination thread: T${info.coordination_thread}.${info.project.brief ? `\nBrief: ${info.project.brief}` : ""}${note}
Next: ${SELF} start "your plan" --area <paths you will own>   (rules: ${SELF} help)`);
    break;
  }

  case "start": {
    const plan = rest();
    if (!plan) die('Usage: start "what I will do" [--area src/api/] [--rules "..."]');
    const area = pathsFlag("area");
    out(await call(s(), "POST", "/api/start", { plan, paths: area.length ? area : undefined, rules: flag("rules"), description: flag("desc") }));
    break;
  }

  case "end": {
    const summary = rest();
    if (!summary) die('Usage: end "what I did" [--left "what is left"]... [--keep-area]');
    out(await call(s(), "POST", "/api/end", { summary, left: flags.left?.filter((x) => x !== true), keep_area: !!flags["keep-area"] }));
    break;
  }

  case "areas":
    out(await call(s(), "GET", "/api/areas"));
    break;

  case "area":
    if (flags.release) out(await call(s(), "DELETE", "/api/areas"));
    else {
      if (!pos.length) die('Usage: area <path>... [--rules "..."] [--desc "..."]  ·  area --release');
      out(await call(s(), "POST", "/api/areas", { paths: pos.flatMap((p) => p.split(",")).filter(Boolean), rules: flag("rules"), description: flag("desc") }));
    }
    break;

  case "request": {
    const to = pos.shift();
    const what = text(pos.shift());
    if (!to || !what) die('Usage: request <Name> "what you need" ["details"] [--t T]');
    out(await call(s(), "POST", "/api/requests", { to, what, details: rest() || undefined, thread_id: flags.t ? int(flags.t, "thread") : undefined }));
    break;
  }

  case "approve":
    out(await call(s(), "PATCH", `/api/tasks/${int(pos[0], "task")}`, { status: "done" }));
    break;

  case "feedback": {
    const id = int(pos.shift(), "task");
    const t = rest();
    if (!t) die('Usage: feedback <id> "what to fix"');
    out(await call(s(), "POST", `/api/tasks/${id}/feedback`, { text: t }));
    break;
  }

  case "in":
  case "inbox":
    out(await call(s(), "GET", `/api/inbox${flags.wait ? `?wait=${Math.min(Number(flags.wait) || 60, 290)}` : ""}`));
    break;

  case "say": {
    const t = int(pos.shift(), "thread");
    const body = rest();
    if (!body) die('Missing text. Usage: say T "text"');
    out(
      await call(s(), "POST", `/api/threads/${t}/messages`, {
        body,
        kind: flag("kind"),
        reply_to: flags.reply ? int(flags.reply, "message") : undefined,
        confidence: flag("conf"),
        evidence: evidence(),
      }),
    );
    break;
  }

  case "topic": {
    const title = text(pos.shift());
    if (!title) die('Usage: topic "title" ["first message"]');
    out(await call(s(), "POST", "/api/threads", { title, body: rest() || undefined, parent_id: flags.parent ? int(flags.parent, "thread") : undefined }));
    break;
  }

  case "threads":
    out(await call(s(), "GET", "/api/threads"));
    break;

  case "read": {
    const t = int(pos[0], "thread");
    const p = new URLSearchParams({ limit: String(flag("limit") || 30) });
    if (flags.since) p.set("since", String(int(flags.since, "message")));
    if (flags.before) p.set("before", String(int(flags.before, "message")));
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
        thread_id: flags.t ? int(flags.t, "thread") : undefined,
        options: flags.opt?.filter((x) => x !== true),
        blocking: !!flags.block,
        wait_seconds: flags.wait ? Math.min(Number(flags.wait) || 60, 290) : undefined,
      }),
    );
    break;
  }

  case "answer": {
    const q = int(pos.shift(), "question");
    out(await call(s(), "POST", `/api/questions/${q}/answer`, { body: rest(), confidence: flag("conf"), choice: flag("choice"), evidence: evidence() }));
    break;
  }

  case "cancel":
    out(await call(s(), "POST", `/api/questions/${int(pos.shift(), "question")}/cancel`, { reason: rest() }));
    break;

  case "mem":
    out(await call(s(), "GET", `/api/knowledge?q=${encodeURIComponent(rest())}&limit=${flag("limit") || 6}`));
    break;

  case "save": {
    const kind = pos.shift();
    if (!["fact", "decision", "note"].includes(kind)) die('Usage: save fact|decision|note "title" "text" [--ev ...]');
    const title = text(pos.shift());
    out(await call(s(), "POST", "/api/knowledge", { kind, title, body: rest(), evidence: evidence() }));
    break;
  }

  case "dispute":
    out(await call(s(), "POST", `/api/knowledge/${int(pos.shift(), "memory entry")}/dispute`, { reason: rest() }));
    break;

  case "claim":
    if (!pos.length) die("Usage: claim path [path...] --why reason [--force]");
    out(await call(s(), "POST", "/api/claims", { paths: pos, reason: flag("why"), minutes: flags.min ? Number(flags.min) : undefined, force: !!flags.force }));
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
      if (!st) die("Usage: task <id> todo|doing|review|done|blocked|take");
      out(await call(s(), "PATCH", `/api/tasks/${int(first, "task")}`, st === "take" ? { take: true } : { status: st }));
    } else {
      if (!first) die('Usage: task "title" [--to Name] [--t T]');
      out(await call(s(), "POST", "/api/tasks", { title: text(first), assignee: flag("to"), thread_id: flags.t ? int(flags.t, "thread") : undefined }));
    }
    break;
  }

  case "handoff": {
    const t = int(pos.shift(), "thread");
    out(await call(s(), "POST", "/api/handoff", { thread_id: t, to: flag("to"), summary: rest(), done: flags.done, next: flags.next, risks: flags.risk, evidence: evidence() }));
    break;
  }

  case "escalate": {
    const t = int(pos.shift(), "thread");
    if (!flags.opt?.length) die('Usage: escalate T "problem" --opt "option A" --opt "option B" [--rec "recommendation"]');
    out(await call(s(), "POST", "/api/escalate", { thread_id: t, problem: rest(), options: flags.opt, recommendation: flag("rec") }));
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
    out(`For more agents: "Join R.U.Ch.: ${x.hub}/j/${x.key}"`);
    const ol = join(DIR, "owner-link.txt");
    if (existsSync(ol)) out(`Human's page: ${readFileSync(ol, "utf8").trim()}`);
    break;
  }

  case "skill": {
    const f = sessionFile(null);
    const hub = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).hub : DEFAULT_HUB;
    let md = null;
    for (const u of [`${hub}/skill.md`, `${REPO_RAW}/skills/ruch/SKILL.md`]) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          md = (await r.text()).replaceAll(`${REPO_RAW}/ruch.mjs`, `${hub}/ruch.mjs`);
          break;
        }
      } catch {}
    }
    if (!md) die("Could not download the skill (neither the hub nor GitHub answered).");
    const dir = flag("dir") ? resolve(flag("dir")) : flags.project ? resolve(".claude/skills/ruch") : join(homedir(), ".claude", "skills", "ruch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), md);
    out(`Skill saved: ${join(dir, "SKILL.md")}`);
    break;
  }

  default:
    die(`Unknown command "${cmd}".\n\n${HELP}`);
}
