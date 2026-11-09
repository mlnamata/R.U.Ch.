/**
 * Compact plain-text rendering for agents. Text is cheaper in tokens than JSON
 * and IDs are prefixed (T=thread, M=message, Q=question, K=knowledge, #=task)
 * so agents can refer to them unambiguously.
 */
import type { Claim, Evidence, Knowledge, Message, Question, Task, Thread } from "./types.js";

const MAX_BODY = 1500;

function clip(s: string, max = MAX_BODY) {
  return s.length > max ? s.slice(0, max) + ` …[zkráceno, ${s.length} znaků]` : s;
}

const EVIDENCE_LABEL: Record<string, string> = {
  verified: "✓ ověřeno",
  unchecked: "? neověřitelné",
  missing: "⚠ bez důkazu",
  invalid: "✗ neplatné",
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
  const head = [`M${m.id}`, m.author, m.kind !== "chat" ? `(${m.kind})` : "", m.confidence ? `[${m.confidence}]` : ""]
    .filter(Boolean)
    .join(" ");
  const ev = m.evidence.length ? ` {důkazy: ${m.evidence.map(evidenceText).join(", ")} ${EVIDENCE_LABEL[m.evidence_status]}}` : m.evidence_status === "missing" ? ` {${EVIDENCE_LABEL.missing}}` : "";
  const reply = m.reply_to ? ` ↩M${m.reply_to}` : "";
  return `${head}${reply}: ${opts.full ? m.body : clip(m.body)}${ev}`;
}

export function threadHeader(t: Thread & { message_count?: number; open_questions?: number }): string {
  const status = { open: "otevřené", human_needed: "⏸ ČEKÁ NA ČLOVĚKA", resolved: "✓ uzavřené" }[t.status];
  const extra = [
    t.message_count !== undefined ? `${t.message_count} zpráv` : "",
    t.open_questions ? `${t.open_questions} otevřených otázek` : "",
    t.parent_id ? `podvlákno T${t.parent_id}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `T${t.id} "${t.title}" – ${status}${extra ? ` (${extra})` : ""}${t.status_reason && t.status !== "open" ? ` – ${t.status_reason}` : ""}`;
}

export function questionLine(q: Question): string {
  const to = q.target ? `→ ${q.target}` : "→ kdokoli";
  const opts = q.options.length ? ` Možnosti: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(" | ")}` : "";
  const state =
    q.status === "answered" ? ` ✓ odpověděl(a) ${q.answered_by}: ${clip(q.answer ?? "", 600)}${q.knowledge_id ? ` (uloženo jako K${q.knowledge_id})` : ""}` : q.status === "cancelled" ? " (zrušeno)" : "";
  return `Q${q.id} [T${q.thread_id}] ${q.asked_by} ${to}${q.blocking ? " (BLOKUJÍCÍ)" : ""}: ${q.body}${opts}${state}`;
}

export function knowledgeLine(k: Knowledge): string {
  const trust = { human: "potvrdil člověk", evidence: "podloženo důkazem", agent: "tvrzení agenta" }[k.trust];
  const status = k.status === "disputed" ? ` ⚠ ZPOCHYBNĚNO (${k.status_note})` : k.status === "superseded" ? ` (nahrazeno K${k.superseded_by})` : "";
  return `K${k.id} [${k.kind}, ${trust}]${status} ${k.title}\n   ${clip(k.body, 800).replace(/\n/g, "\n   ")}`;
}

export function claimLine(c: Claim): string {
  const mins = Math.max(0, Math.round((Date.parse(c.expires_at) - Date.now()) / 60000));
  return `${c.path} – drží ${c.holder}${c.reason ? ` (${c.reason})` : ""}, vyprší za ${mins} min`;
}

export function taskLine(t: Task): string {
  return `#${t.id} [${t.status}] ${t.title}${t.assignee ? ` – ${t.assignee}` : " – nepřiřazeno"}${t.thread_id ? ` (T${t.thread_id})` : ""}`;
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
  if (ib.questions_for_me.length) {
    out.push("## Otázky pro tebe (odpověz)", ...ib.questions_for_me.map(questionLine), "");
  }
  const answered = ib.my_questions.filter((q) => q.status !== "open");
  const waiting = ib.my_questions.filter((q) => q.status === "open");
  if (answered.length) out.push("## Odpovědi na tvoje otázky", ...answered.map(questionLine), "");
  if (ib.messages.length) {
    out.push("## Nové zprávy");
    let lastThread = -1;
    for (const m of ib.messages) {
      if (m.thread_id !== lastThread) {
        out.push(`[T${m.thread_id}]`);
        lastThread = m.thread_id;
      }
      out.push("  " + messageLine(m));
    }
    if (ib.more) out.push("  … další zprávy čekají, načti inbox znovu.");
    out.push("");
  }
  // Threads whose messages are already listed above need no second mention.
  const shown = new Set(ib.messages.map((m) => m.thread_id));
  const fresh = ib.new_threads.filter((t) => !shown.has(t.id));
  if (fresh.length) out.push("## Nová vlákna", ...fresh.map((t) => `T${t.id} "${t.title}" (${t.by ?? "?"})`), "");
  if (ib.paused_threads.length) {
    out.push("## Vlákna čekající na člověka (do nich nepiš)", ...ib.paused_threads.map((t) => `T${t.id} "${t.title}" – ${t.reason}`), "");
  }
  if (waiting.length) out.push("## Tvoje otázky bez odpovědi", ...waiting.map(questionLine), "");
  if (ib.my_tasks.length) out.push("## Tvoje úkoly", ...ib.my_tasks.map(taskLine), "");
  if (ib.my_claims.length) out.push("## Tvoje zámky souborů", ...ib.my_claims.map(claimLine), "");
  if (ib.others_claims.length) out.push("## Soubory zamčené ostatními (needituj je)", ...ib.others_claims.map(claimLine), "");
  if (out.length === 0) return `Nic nového pro ${ib.me.name}.`;
  return out.join("\n").trim();
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
  if (t.summary) out.push(`Shrnutí: ${t.summary}`);
  if (view.total > view.messages.length && view.messages.length) {
    out.push(`(zobrazeno ${view.messages.length} z ${view.total} zpráv; starší: before=${view.messages[0].id})`);
  }
  out.push("", ...view.messages.map((m) => messageLine(m, { full: true })));
  if (view.open_questions.length) out.push("", "Otevřené otázky:", ...view.open_questions.map(questionLine));
  if (view.subthreads.length) out.push("", "Podvlákna:", ...view.subthreads.map((s) => `T${s.id} "${s.title}" (${s.status})`));
  return out.join("\n");
}
