/**
 * Compact plain-text rendering for agents. Text is cheaper in tokens than JSON
 * and IDs are prefixed (T=thread, M=message, Q=question, K=knowledge, #=task)
 * so agents can refer to them unambiguously.
 */
import type { Claim, Evidence, Knowledge, Message, Question, Task, Thread } from "./types.js";

const MAX_BODY = 600;

function clip(s: string, max: number, more = "") {
  return s.length > max ? `${s.slice(0, max)} …[+${s.length - max} chars${more}]` : s;
}

const EVIDENCE_LABEL: Record<string, string> = {
  verified: " ✓",
  unchecked: " ?",
  missing: "no proof",
  invalid: " ✗",
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

/** Proof suffix: {file:1-9, M3 ✓} = verified, ? = not checkable, {no proof} = a factual message without any. */
function proof(m: Message): string {
  if (m.evidence.length) return ` {${m.evidence.map(evidenceText).join(", ")}${EVIDENCE_LABEL[m.evidence_status]}}`;
  return m.evidence_status === "missing" ? ` {${EVIDENCE_LABEL.missing}}` : "";
}

export function messageLine(m: Message, opts: { full?: boolean } = {}): string {
  const head = [`M${m.id}`, m.author, m.kind !== "chat" ? `(${m.kind})` : "", m.confidence ? `[${m.confidence}]` : ""]
    .filter(Boolean)
    .join(" ");
  const reply = m.reply_to ? ` ↩M${m.reply_to}` : "";
  return `${head}${reply}: ${opts.full ? m.body : clip(m.body, MAX_BODY, `, read T${m.thread_id}`)}${proof(m)}`;
}

export function threadHeader(t: Thread & { message_count?: number; open_questions?: number }): string {
  const status = { open: "open", human_needed: "PAUSED for human", resolved: "resolved" }[t.status];
  const extra = [
    t.message_count !== undefined ? `${t.message_count} msgs` : "",
    t.open_questions ? `${t.open_questions} open Q` : "",
    t.parent_id ? `under T${t.parent_id}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `T${t.id} "${t.title}" ${status}${extra ? ` (${extra})` : ""}${t.status_reason && t.status !== "open" ? ` – ${t.status_reason}` : ""}`;
}

const options = (q: Question) => (q.options.length ? ` ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(" | ")}` : "");

export function questionLine(q: Question): string {
  const state =
    q.status === "answered" ? ` ✓ ${q.answered_by}: ${clip(q.answer ?? "", MAX_BODY)}${q.knowledge_id ? ` (K${q.knowledge_id})` : ""}` : q.status === "cancelled" ? " (cancelled)" : "";
  return `Q${q.id} T${q.thread_id} ${q.asked_by}→${q.target ?? "any"}${q.blocking ? " BLOCKING" : ""}: ${q.body}${options(q)}${state}`;
}

export function knowledgeLine(k: Knowledge): string {
  const trust = { human: "human-confirmed", evidence: "proven", agent: "agent claim" }[k.trust];
  const status = k.status === "disputed" ? ` ⚠ DISPUTED (${k.status_note})` : k.status === "superseded" ? ` (replaced by K${k.superseded_by})` : "";
  return `K${k.id} [${k.kind}, ${trust}]${status} ${k.title}\n  ${clip(k.body, 800).replace(/\n/g, "\n  ")}`;
}

export function claimLine(c: Claim, own = false): string {
  const mins = Math.max(0, Math.round((Date.parse(c.expires_at) - Date.now()) / 60000));
  return `${c.path}${own ? "" : ` ${c.holder}`}${c.reason ? ` (${c.reason})` : ""} ${mins}m`;
}

export function taskLine(t: Task): string {
  return `#${t.id} ${t.status} ${t.title}${t.assignee ? ` – ${t.assignee}` : " – unassigned"}${t.thread_id ? ` T${t.thread_id}` : ""}`;
}

export interface InboxView {
  me: { name: string };
  cursor: { from: number; to: number };
  /** Questions with a higher id have not been shown to this participant yet. */
  q_cursor: number;
  /** Standing sections that differ from what the participant saw last time. */
  changed: { open: boolean; waiting: boolean; paused: boolean; tasks: boolean; my_claims: boolean; others_claims: boolean };
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

/**
 * Only what is new: unseen questions, answers and messages in full; standing state (old open questions,
 * tasks, locks, paused threads) only when it changed since the last call.
 */
export function inboxText(ib: InboxView): string {
  const out: string[] = [];
  const byId = new Map(ib.messages.map((m) => [m.id, m]));
  // A question or answer listed as such is not repeated as a message.
  const covered = new Set<number>();

  const fresh = ib.questions_for_me.filter((q) => q.id > ib.q_cursor);
  if (fresh.length) {
    for (const q of fresh) covered.add(q.message_id);
    out.push("Questions for you (answer them):", ...fresh.map(questionLine));
  }
  const answered = ib.my_questions.filter((q) => q.status === "answered");
  if (answered.length) {
    out.push("Answers to your questions:");
    for (const q of answered) {
      const m = q.answer_message_id ? byId.get(q.answer_message_id) : undefined;
      if (m) covered.add(m.id);
      const body = (q.answer ?? "").replace(/^@\S+ /, "");
      out.push(
        `Q${q.id} "${clip(q.body, 80)}" ✓ ${q.answered_by}${m?.confidence ? ` [${m.confidence}]` : ""}: ${clip(body, MAX_BODY, `, read T${q.thread_id}`)}${m ? proof(m) : ""}${q.knowledge_id ? ` (K${q.knowledge_id})` : ""}`,
      );
    }
  }
  const messages = ib.messages.filter((m) => !covered.has(m.id));
  let lastThread = -1;
  for (const m of messages) {
    if (m.thread_id !== lastThread) {
      out.push(`T${m.thread_id}:`);
      lastThread = m.thread_id;
    }
    out.push(" " + messageLine(m));
  }
  if (ib.more) out.push("… more waiting, run inbox again.");
  // Threads whose messages are already listed above need no second mention.
  const shown = new Set(ib.messages.map((m) => m.thread_id));
  const threads = ib.new_threads.filter((t) => !shown.has(t.id));
  if (threads.length) out.push("New threads: " + threads.map((t) => `T${t.id} "${t.title}" (${t.by ?? "?"})`).join(", "));

  // `gone` = say so when the section emptied (a released lock is news; an answered question was already announced).
  const section = (on: boolean, title: string, lines: string[], inline = false, gone = false) => {
    if (!on || (!lines.length && !gone)) return;
    if (!lines.length) out.push(`${title}: none`);
    else if (inline) out.push(`${title}: ${lines.join(" ")}`);
    else out.push(`${title}:`, ...lines.map((l) => " " + l));
  };
  section(ib.changed.open, "Still open for you", ib.questions_for_me.filter((q) => q.id <= ib.q_cursor).map((q) => `Q${q.id}`), true);
  section(ib.changed.waiting, "Your unanswered", ib.my_questions.filter((q) => q.status === "open").map((q) => `Q${q.id}`), true);
  section(ib.changed.paused, "Paused for human (don't post)", ib.paused_threads.map((t) => `T${t.id} "${t.title}" – ${t.reason}`));
  section(ib.changed.tasks, "Your tasks", ib.my_tasks.map(taskLine));
  section(ib.changed.my_claims, "Your locks", ib.my_claims.map((c) => claimLine(c, true)), false, true);
  section(ib.changed.others_claims, "Locked by others (don't edit)", ib.others_claims.map((c) => claimLine(c)), false, true);
  return out.length ? out.join("\n") : "Nothing new.";
}

export function threadText(view: {
  thread: Thread;
  messages: Message[];
  total: number;
  open_questions: Question[];
  subthreads: { id: number; title: string; status: string }[];
}): string {
  const t = view.thread;
  const out = [threadHeader(t)];
  if (t.summary) out.push(`Summary: ${t.summary}`);
  if (view.total > view.messages.length && view.messages.length) {
    out.push(`(${view.messages.length} of ${view.total}; older: --before ${view.messages[0].id})`);
  }
  out.push(...view.messages.map((m) => messageLine(m, { full: true })));
  if (view.open_questions.length) out.push("Open questions:", ...view.open_questions.map(questionLine));
  if (view.subthreads.length) out.push("Subthreads: " + view.subthreads.map((s) => `T${s.id} "${s.title}" (${s.status})`).join(", "));
  return out.join("\n");
}
