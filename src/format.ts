/**
 * Compact plain-text rendering for agents. Text is cheaper in tokens than JSON, and
 * room-local IDs are prefixed (T thread, M message, Q question, K memory, # task).
 */
import type { Claim, Evidence, Knowledge, Message, Question, Task, Thread } from "./types.js";

const MAX_BODY = 1500;

function clip(s: string, max = MAX_BODY) {
  return s.length > max ? s.slice(0, max) + ` …[cut, ${s.length} chars – read the thread]` : s;
}

const EVIDENCE_LABEL: Record<string, string> = {
  verified: "✓verified",
  unchecked: "?unchecked",
  missing: "⚠no evidence",
  invalid: "✗invalid",
  none: "",
};

export function evidenceText(e: Evidence): string {
  switch (e.type) {
    case "file":
      return `${e.path}${e.lines ? `:${e.lines}` : ""}`;
    case "message":
      return `M${e.id}`;
    case "knowledge":
      return `K${e.id}`;
    case "command":
      return `$ ${e.command}`;
    case "url":
      return e.url;
  }
}

export function messageLine(m: Message, opts: { full?: boolean } = {}): string {
  const head = [`M${m.id}`, m.author, m.kind !== "chat" && m.kind !== "system" ? `(${m.kind})` : "", m.confidence ? `[${m.confidence}]` : ""].filter(Boolean).join(" ");
  const ev = m.evidence.length
    ? ` {${m.evidence.map(evidenceText).join(", ")} ${EVIDENCE_LABEL[m.evidence_status]}}`
    : m.evidence_status === "missing"
      ? ` {${EVIDENCE_LABEL.missing}}`
      : "";
  const reply = m.reply_to ? ` ↩M${m.reply_to}` : "";
  return `${head}${reply}: ${opts.full ? m.body : clip(m.body)}${ev}`;
}

export function threadHeader(t: Thread & { open_questions?: number }): string {
  const status = { open: "open", human_needed: "⏸ WAITING FOR HUMAN", resolved: "✓ resolved" }[t.status];
  const extra = [`${t.message_count} msgs`, t.open_questions ? `${t.open_questions} open Q` : "", t.parent_id ? `sub of T${t.parent_id}` : ""].filter(Boolean).join(", ");
  return `T${t.id} "${t.title}" – ${status} (${extra})${t.status_reason && t.status !== "open" ? ` – ${t.status_reason}` : ""}`;
}

export function questionLine(q: Question): string {
  const to = q.target ? `→ ${q.target}` : "→ anyone";
  const opts = q.options.length ? ` Options: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(" | ")}` : "";
  const state =
    q.status === "answered"
      ? ` ✓ ${q.answered_by} answered: ${clip(q.answer ?? "", 600)}${q.knowledge_id ? ` (saved as K${q.knowledge_id})` : ""}`
      : q.status === "cancelled"
        ? " (cancelled)"
        : "";
  return `Q${q.id} [T${q.thread_id}] ${q.asked_by} ${to}${q.blocking ? " (BLOCKING)" : ""}: ${q.body}${opts}${state}`;
}

export function knowledgeLine(k: Knowledge): string {
  const trust = { human: "human-confirmed", evidence: "evidence-backed", agent: "agent claim" }[k.trust];
  const status = k.status === "disputed" ? ` ⚠DISPUTED (${k.status_note})` : k.status === "superseded" ? ` (replaced by K${k.superseded_by})` : "";
  return `K${k.id} [${k.kind}, ${trust}]${status} ${k.title}\n   ${clip(k.body, 800).replace(/\n/g, "\n   ")}`;
}

export function claimLine(c: Claim): string {
  const mins = Math.max(0, Math.round((Date.parse(c.expires_at) - Date.now()) / 60000));
  return `${c.path} – ${c.holder}${c.reason ? ` (${c.reason})` : ""}, ${mins} min left`;
}

export function taskLine(t: Task): string {
  const by = t.created_by && t.created_by !== t.assignee ? `, from ${t.created_by}` : "";
  return `#${t.id} [${t.status}] ${t.title} – ${t.assignee ?? "unassigned"}${by}${t.thread_id ? ` (T${t.thread_id})` : ""}`;
}

export interface Area {
  owner: string;
  paths: string[];
  description: string;
  rules: string;
}

export function areaLine(a: Area): string {
  return `${a.owner}: ${a.paths.join(", ")}${a.description ? ` – ${a.description}` : ""}${a.rules ? `\n   rules: ${a.rules}` : ""}`;
}

export interface InboxView {
  me: { name: string };
  cursor: { from: number; to: number };
  messages: Message[];
  more: boolean;
  new_threads: { id: number; title: string; by: string | null }[];
  questions_for_me: Question[];
  my_questions: Question[];
  paused_threads: { id: number; title: string; reason: string }[];
  my_tasks: Task[];
  my_claims: Claim[];
  others_claims: Claim[];
}

export function inboxText(ib: InboxView): string {
  const out: string[] = [];
  if (ib.questions_for_me.length) out.push("## Questions for you (answer them first)", ...ib.questions_for_me.map(questionLine), "");
  const answered = ib.my_questions.filter((q) => q.status !== "open");
  const waiting = ib.my_questions.filter((q) => q.status === "open");
  if (answered.length) out.push("## Answers to your questions", ...answered.map(questionLine), "");
  if (ib.messages.length) {
    out.push("## New messages");
    let lastThread = -1;
    for (const m of ib.messages) {
      if (m.thread_id !== lastThread) {
        out.push(`[T${m.thread_id}]`);
        lastThread = m.thread_id;
      }
      out.push("  " + messageLine(m));
    }
    if (ib.more) out.push("  … more waiting, read the inbox again.");
    out.push("");
  }
  // Threads whose messages are already listed above need no second mention.
  const shown = new Set(ib.messages.map((m) => m.thread_id));
  const fresh = ib.new_threads.filter((t) => !shown.has(t.id));
  if (fresh.length) out.push("## New threads", ...fresh.map((t) => `T${t.id} "${t.title}" (${t.by ?? "hub"})`), "");
  if (ib.paused_threads.length) out.push("## Waiting for the human (don't post there)", ...ib.paused_threads.map((t) => `T${t.id} "${t.title}" – ${t.reason}`), "");
  if (waiting.length) out.push("## Your unanswered questions", ...waiting.map(questionLine), "");
  if (ib.my_tasks.length) out.push("## Your tasks", ...ib.my_tasks.map(taskLine), "");
  if (ib.my_claims.length) out.push("## Your file locks", ...ib.my_claims.map(claimLine), "");
  if (ib.others_claims.length) out.push("## Locked by others (don't edit)", ...ib.others_claims.map(claimLine), "");
  if (out.length === 0) return `Nothing new for ${ib.me.name}.`;
  return out.join("\n").trim();
}

export function threadText(view: { thread: Thread; messages: Message[]; total: number; open_questions: Question[]; subthreads: { id: number; title: string; status: string }[] }): string {
  const t = view.thread;
  const out = [threadHeader(t)];
  if (t.summary) out.push(`Summary: ${t.summary}`);
  if (view.total > view.messages.length && view.messages.length) out.push(`(showing ${view.messages.length} of ${view.total}; older: --before ${view.messages[0].id})`);
  out.push("", ...view.messages.map((m) => messageLine(m, { full: true })));
  if (view.open_questions.length) out.push("", "Open questions:", ...view.open_questions.map(questionLine));
  if (view.subthreads.length) out.push("", "Sub-threads:", ...view.subthreads.map((s) => `T${s.id} "${s.title}" (${s.status})`));
  return out.join("\n");
}

export interface Briefing {
  areas: Area[];
  agents: { name: string; role: string; status_text: string; online: boolean; kind: string }[];
  requests_for_me: Task[];
  to_review: Task[];
  recent: Message[];
  coordination_thread: number;
}

/** What an agent sees right after `start`: who owns what, their rules, work waiting for it. */
export function briefingText(b: Briefing, me: string): string {
  const out: string[] = [];
  const others = b.areas.filter((a) => a.owner !== me);
  const mine = b.areas.find((a) => a.owner === me);
  out.push(mine ? `Your area: ${mine.paths.join(", ")}` : "You have no area – take one with `area <paths>` before editing shared code.");
  out.push("## Areas of others (don't edit – send a request)", ...(others.length ? others.map(areaLine) : ["(none)"]));
  const team = b.agents.filter((a) => a.kind === "agent");
  if (team.length) out.push("## Team", ...team.map((a) => `${a.name}${a.role ? ` (${a.role})` : ""}${a.online ? "" : " offline"}${a.status_text ? ` – ${a.status_text}` : ""}`));
  if (b.requests_for_me.length) out.push("## Requests/tasks for you", ...b.requests_for_me.map(taskLine));
  if (b.to_review.length) out.push("## Waiting for your review (task <id> done | feedback <id> \"...\")", ...b.to_review.map(taskLine));
  if (b.recent.length) out.push(`## Recent in coordination T${b.coordination_thread}`, ...b.recent.map((m) => "  " + messageLine(m)));
  return out.join("\n");
}
