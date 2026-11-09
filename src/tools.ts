/**
 * The agent-facing tool set. Defined once and used by both the MCP server
 * (Claude Code, Cursor, … connect through it) and the built-in agent runner.
 */
import { z } from "zod";
import type { RuchClient } from "./client.js";
import {
  claimLine,
  inboxText,
  knowledgeLine,
  messageLine,
  questionLine,
  taskLine,
  threadHeader,
  threadText,
  type InboxView,
} from "./format.js";
import type { Claim, Knowledge, Message, Question, Task, Thread } from "./types.js";

export const evidenceSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("file"),
        path: z.string().describe("Cesta relativně ke kořeni projektu"),
        lines: z.string().optional().describe('Rozsah řádků, např. "10-25"'),
        quote: z.string().optional().describe("Doslovná citace ze souboru – hub ověří, že v něm opravdu je"),
      }),
      z.object({ type: z.literal("message"), id: z.number().int().describe("ID zprávy (číslo z M123)") }),
      z.object({ type: z.literal("knowledge"), id: z.number().int().describe("ID znalosti (číslo z K12)") }),
      z.object({
        type: z.literal("command"),
        command: z.string().describe("Příkaz, který jsi spustil(a)"),
        output: z.string().optional().describe("Relevantní část výstupu"),
      }),
      z.object({ type: z.literal("url"), url: z.string() }),
    ]),
  )
  .describe("Důkazy pro tvrzení ve zprávě. Neexistující soubor/řádky/citace nebo ID = zpráva je odmítnuta.");

const confidence = z
  .enum(["certain", "likely", "guess"])
  .describe("certain = ověřil(a) jsem; likely = silně předpokládám; guess = odhad (neukládá se do paměti)");

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Read-only tools do not change hub state. */
  readOnly?: boolean;
  run: (client: RuchClient, args: z.infer<S>) => Promise<string>;
}

function tool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

function withWarnings(text: string, warnings?: string[]) {
  return warnings?.length ? `${text}\nUpozornění:\n${warnings.map((w) => `- ${w}`).join("\n")}` : text;
}

export const TOOLS: ToolDef[] = [
  tool({
    name: "inbox",
    description:
      "Vrátí vše NOVÉ a relevantní pro tebe od posledního volání: zprávy kde tě někdo zmínil nebo ve vláknech, kde se účastníš, otázky pro tebe, odpovědi na tvoje otázky, tvoje úkoly a zamčené soubory. Volej na začátku každého pracovního kroku a před tím, než něco oznámíš jako hotové.",
    readOnly: true,
    schema: z.object({}),
    run: async (c) => inboxText(await c.get<InboxView>("/api/inbox")),
  }),
  tool({
    name: "wait_for_activity",
    description:
      "Počká (max timeout_seconds), dokud pro tebe nepřijde něco nového (zmínka, otázka, odpověď). Pak zavolej inbox. Používej místo opakovaného dotazování.",
    readOnly: true,
    schema: z.object({ timeout_seconds: z.number().int().min(1).max(300).default(120) }),
    run: async (c, a) => {
      const r = await c.get<{ activity: boolean }>(`/api/wait?timeout=${a.timeout_seconds}`);
      return r.activity ? "Je tu nová aktivita – zavolej inbox." : "Nic nového během čekání.";
    },
  }),
  tool({
    name: "list_threads",
    description: "Seznam vláken (konverzací) v projektu se stavem.",
    readOnly: true,
    schema: z.object({ status: z.enum(["open", "human_needed", "resolved"]).optional() }),
    run: async (c, a) => {
      const rows = await c.get<(Thread & { message_count: number; open_questions: number })[]>(
        `/api/threads${a.status ? `?status=${a.status}` : ""}`,
      );
      return rows.length ? rows.map(threadHeader).join("\n") : "Žádná vlákna.";
    },
  }),
  tool({
    name: "read_thread",
    description: "Přečte vlákno (shrnutí + posledních N zpráv + otevřené otázky). Pro jen nové zprávy použij since_message_id.",
    readOnly: true,
    schema: z.object({
      thread_id: z.number().int(),
      since_message_id: z.number().int().optional(),
      before_message_id: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).default(30),
    }),
    run: async (c, a) => {
      const q = new URLSearchParams({ limit: String(a.limit) });
      if (a.since_message_id !== undefined) q.set("since", String(a.since_message_id));
      if (a.before_message_id !== undefined) q.set("before", String(a.before_message_id));
      return threadText(await c.get(`/api/threads/${a.thread_id}?${q}`));
    },
  }),
  tool({
    name: "create_thread",
    description:
      "Založí nové vlákno pro nové téma/úkol. Pro vedlejší diskusi (aby se nezahltilo hlavní vlákno) nastav parent_thread_id – do hlavního vlákna pak pošli jen výsledek.",
    schema: z.object({
      title: z.string().describe("Krátký výstižný název"),
      body: z.string().optional().describe("První zpráva"),
      parent_thread_id: z.number().int().optional(),
      mentions: z.array(z.string()).optional(),
    }),
    run: async (c, a) => {
      const r = await c.post<{ thread: Thread; message: Message | null; warnings: string[] }>("/api/threads", {
        title: a.title,
        body: a.body,
        parent_id: a.parent_thread_id ?? null,
        mentions: a.mentions,
      });
      return withWarnings(`Vytvořeno ${threadHeader(r.thread)}${r.message ? ` se zprávou M${r.message.id}` : ""}`, r.warnings);
    },
  }),
  tool({
    name: "post_message",
    description:
      'Pošle zprávu do vlákna. Zmiň adresáta přes @Jméno (člověk = @human). kind: chat (běžné), decision (rozhodnutí), review (výsledek kontroly), status (průběh). Tvrzení o kódu podlož evidence – hub ověří, že soubor/řádky/citace existují, a zprávu s vymyšleným důkazem odmítne.',
    schema: z.object({
      thread_id: z.number().int(),
      body: z.string(),
      kind: z.enum(["chat", "decision", "review", "status"]).default("chat"),
      mentions: z.array(z.string()).optional(),
      reply_to: z.number().int().optional().describe("ID zprávy, na kterou reaguješ"),
      evidence: evidenceSchema.optional(),
      confidence: confidence.optional(),
    }),
    run: async (c, a) => {
      const r = await c.post<{ message: Message; warnings: string[]; thread: Thread }>(`/api/threads/${a.thread_id}/messages`, a);
      return withWarnings(`Odesláno: ${messageLine(r.message)}\nStav vlákna: ${threadHeader(r.thread)}`, r.warnings);
    },
  }),
  tool({
    name: "ask",
    description:
      'Položí otázku jinému agentovi (to: jméno), člověku (to: "human") nebo komukoli (to vynech). Nejdřív ukáže podobné už zodpovězené otázky ze sdílené paměti. Pro rozhodnutí mezi variantami dej options. Se wait_seconds > 0 rovnou počká na odpověď.',
    schema: z.object({
      question: z.string().describe("Konkrétní otázka se vším kontextem, který adresát potřebuje"),
      to: z.string().optional(),
      thread_id: z.number().int().optional().describe("Vlákno, kam otázka patří; bez něj se založí nové"),
      options: z.array(z.string()).max(6).optional(),
      blocking: z.boolean().default(false).describe("true = bez odpovědi nemůžeš pokračovat"),
      wait_seconds: z.number().int().min(0).max(300).default(0),
    }),
    run: async (c, a) => {
      const r = await c.post<{ question: Question; similar_knowledge: Knowledge[]; warnings: string[] }>("/api/questions", {
        to: a.to ?? null,
        body: a.question,
        thread_id: a.thread_id ?? null,
        options: a.options,
        blocking: a.blocking,
      });
      let text = `Položeno: ${questionLine(r.question)}`;
      if (r.similar_knowledge.length) {
        text +=
          "\n\nPodobné věci už ve sdílené paměti jsou – pokud odpovídají, otázku zruš (cancel_question):\n" +
          r.similar_knowledge.map(knowledgeLine).join("\n");
      }
      if (a.wait_seconds > 0) {
        const q = await c.get<Question>(`/api/questions/${r.question.id}/wait?timeout=${a.wait_seconds}`);
        text += q.status === "open" ? `\n\nZatím bez odpovědi (Q${q.id}). Pokračuj jinou prací, odpověď přijde do inboxu.` : `\n\n${questionLine(q)}`;
      }
      return withWarnings(text, r.warnings);
    },
  }),
  tool({
    name: "answer",
    description:
      "Odpoví na otázku Q. Odpověď se uloží do sdílené paměti, aby se nikdo nemusel ptát znovu (kromě confidence=guess). Pokud odpověď neznáš jistě, napiš to a dej confidence guess – NEVYMÝŠLEJ.",
    schema: z.object({
      question_id: z.number().int(),
      answer: z.string(),
      confidence,
      choice: z.string().optional().describe("Zvolená možnost, pokud otázka měla options"),
      evidence: evidenceSchema.optional(),
    }),
    run: async (c, a) => {
      const r = await c.post<{ question: Question; warnings: string[] }>(`/api/questions/${a.question_id}/answer`, {
        body: a.answer,
        confidence: a.confidence,
        choice: a.choice,
        evidence: a.evidence,
      });
      return withWarnings(`Odpovězeno: ${questionLine(r.question)}`, r.warnings);
    },
  }),
  tool({
    name: "wait_for_answer",
    description: "Počká na odpověď na tvoji otázku (max timeout_seconds).",
    readOnly: true,
    schema: z.object({ question_id: z.number().int(), timeout_seconds: z.number().int().min(1).max(300).default(120) }),
    run: async (c, a) => {
      const q = await c.get<Question>(`/api/questions/${a.question_id}/wait?timeout=${a.timeout_seconds}`);
      return q.status === "open" ? `Q${q.id} zatím bez odpovědi.` : questionLine(q);
    },
  }),
  tool({
    name: "cancel_question",
    description: "Zruší tvoji otevřenou otázku (např. když jsi odpověď našel(a) ve sdílené paměti).",
    schema: z.object({ question_id: z.number().int(), reason: z.string().optional() }),
    run: async (c, a) => questionLine(await c.post<Question>(`/api/questions/${a.question_id}/cancel`, { reason: a.reason })),
  }),
  tool({
    name: "search_knowledge",
    description:
      "Prohledá sdílenou paměť projektu (odpovědi, rozhodnutí, fakta). VŽDY použij před tím, než se zeptáš nebo navrhneš něco, co už mohlo být rozhodnuto. Znalosti potvrzené člověkem mají přednost.",
    readOnly: true,
    schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(6) }),
    run: async (c, a) => {
      const rows = await c.get<Knowledge[]>(`/api/knowledge?q=${encodeURIComponent(a.query)}&limit=${a.limit}`);
      return rows.length ? rows.map(knowledgeLine).join("\n") : "Ve sdílené paměti nic takového není.";
    },
  }),
  tool({
    name: "save_knowledge",
    description:
      "Uloží ověřený poznatek do sdílené paměti: fact (fakt o projektu), decision (rozhodnutí – musí mít evidence, např. zprávu kde se na něm shodli), note (poznámka). Ukládej jen to, co je pravda a hodí se ostatním. Zastaralý záznam nahraď přes supersedes.",
    schema: z.object({
      kind: z.enum(["fact", "decision", "note"]),
      title: z.string(),
      body: z.string(),
      tags: z.string().optional(),
      evidence: evidenceSchema.optional(),
      supersedes: z.number().int().optional().describe("ID znalosti, kterou tahle nahrazuje"),
    }),
    run: async (c, a) => knowledgeLine(await c.post<Knowledge>("/api/knowledge", a)),
  }),
  tool({
    name: "dispute_knowledge",
    description: "Označí znalost ve sdílené paměti jako zpochybněnou (je špatně nebo zastaralá) s důvodem.",
    schema: z.object({ knowledge_id: z.number().int(), reason: z.string() }),
    run: async (c, a) => knowledgeLine(await c.post<Knowledge>(`/api/knowledge/${a.knowledge_id}/dispute`, { reason: a.reason })),
  }),
  tool({
    name: "claim_files",
    description:
      "Zamkne soubory/složky, které budeš upravovat, aby je jiný agent současně nepřepsal. Volej PŘED editací. Pokud je drží někdo jiný, dostaneš konflikt – domluv se s ním, needituj.",
    schema: z.object({
      paths: z.array(z.string()).min(1).describe('Soubory nebo složky relativně ke kořeni, např. ["src/db.ts", "src/api/"]'),
      reason: z.string().describe("Co s nimi děláš"),
      minutes: z.number().int().min(1).max(240).optional(),
      thread_id: z.number().int().optional(),
    }),
    run: async (c, a) => {
      const r = await c.post<{ granted: string[]; conflicts: Claim[]; expires_at: string }>("/api/claims", a);
      const out: string[] = [];
      if (r.granted.length) out.push(`Zamčeno do ${r.expires_at}: ${r.granted.join(", ")}`);
      if (r.conflicts.length) out.push("KONFLIKT – tyto drží někdo jiný, needituj je:", ...r.conflicts.map(claimLine));
      return out.join("\n") || "Nic nezamčeno.";
    },
  }),
  tool({
    name: "release_files",
    description: "Uvolní tvoje zámky (bez paths = všechny). Volej hned po dokončení úprav.",
    schema: z.object({ paths: z.array(z.string()).optional() }),
    run: async (c, a) => `Uvolněno zámků: ${(await c.post<{ released: number }>("/api/claims/release", a)).released}`,
  }),
  tool({
    name: "check_files",
    description: "Zjistí, jestli soubory nedrží jiný agent (bez zamykání).",
    readOnly: true,
    schema: z.object({ paths: z.array(z.string()).min(1) }),
    run: async (c, a) => {
      const r = await c.post<{ conflicts: Claim[] }>("/api/claims/check", a);
      return r.conflicts.length ? r.conflicts.map(claimLine).join("\n") : "Volné – nikdo jiný je nedrží.";
    },
  }),
  tool({
    name: "list_tasks",
    description: "Seznam úkolů projektu (kdo co dělá).",
    readOnly: true,
    schema: z.object({ status: z.enum(["todo", "doing", "review", "done", "blocked"]).optional() }),
    run: async (c, a) => {
      const rows = await c.get<Task[]>(`/api/tasks${a.status ? `?status=${a.status}` : ""}`);
      return rows.length ? rows.map(taskLine).join("\n") : "Žádné úkoly.";
    },
  }),
  tool({
    name: "create_task",
    description: "Vytvoří úkol (volitelně přiřazený).",
    schema: z.object({
      title: z.string(),
      details: z.string().optional(),
      assignee: z.string().optional(),
      thread_id: z.number().int().optional(),
    }),
    run: async (c, a) => taskLine(await c.post<Task>("/api/tasks", a)),
  }),
  tool({
    name: "update_task",
    description:
      'Změní úkol. take=true převezme úkol (odmítne se, pokud ho právě dělá někdo jiný). Hotovou práci dej do "review" – "done" smí nastavit jen jiný agent nebo člověk po kontrole.',
    schema: z.object({
      task_id: z.number().int(),
      status: z.enum(["todo", "doing", "review", "done", "blocked"]).optional(),
      take: z.boolean().optional(),
      assignee: z.string().optional(),
      details: z.string().optional(),
    }),
    run: async (c, a) => {
      const { task_id, ...patch } = a;
      return taskLine(await c.patch<Task>(`/api/tasks/${task_id}`, patch));
    },
  }),
  tool({
    name: "handoff",
    description:
      "Strukturovaně předá práci jinému agentovi: co je hotové, co dál, jaká jsou rizika. Používej místo dlouhých volných zpráv.",
    schema: z.object({
      thread_id: z.number().int(),
      to: z.string().optional(),
      summary: z.string(),
      done: z.array(z.string()).optional(),
      next: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      evidence: evidenceSchema.optional(),
    }),
    run: async (c, a) => {
      const r = await c.post<{ message: Message; warnings: string[] }>("/api/handoff", a);
      return withWarnings(`Předáno: ${messageLine(r.message)}`, r.warnings);
    },
  }),
  tool({
    name: "escalate_to_human",
    description:
      "Eskaluje na člověka: položí mu blokující otázku s variantami a pozastaví vlákno. Použij při neshodě s jiným agentem (po 2 výměnách bez posunu), při nejasném zadání nebo před nevratným krokem.",
    schema: z.object({
      thread_id: z.number().int(),
      problem: z.string().describe("Stručně: v čem je problém a proč to nerozhodneš sám/sama"),
      options: z.array(z.string()).min(1).max(6).describe("Varianty řešení, ideálně s dopady"),
      recommendation: z.string().optional(),
    }),
    run: async (c, a) => {
      const body = a.problem + (a.recommendation ? `\nDoporučuji: ${a.recommendation}` : "");
      const r = await c.post<{ question: Question }>("/api/questions", {
        to: "human",
        body,
        thread_id: a.thread_id,
        options: a.options,
        blocking: true,
      });
      await c.post(`/api/threads/${a.thread_id}/status`, { status: "human_needed", reason: `čeká na odpověď Q${r.question.id}` });
      return `Eskalováno jako Q${r.question.id}, vlákno T${a.thread_id} pozastaveno. Do tohoto vlákna nepiš, dokud člověk neodpoví; mezitím dělej jinou práci nebo použij wait_for_answer.`;
    },
  }),
  tool({
    name: "update_thread_summary",
    description:
      "Přepíše krátké shrnutí vlákna (stav, rozhodnutí, otevřené body). Udržuj ho aktuální – noví účastníci pak nemusí číst celou historii.",
    schema: z.object({ thread_id: z.number().int(), summary: z.string().max(4000) }),
    run: async (c, a) => threadHeader(await c.post<Thread>(`/api/threads/${a.thread_id}/summary`, { summary: a.summary })),
  }),
  tool({
    name: "resolve_thread",
    description: "Uzavře vlákno se shrnutím výsledku. Jen když je práce opravdu hotová a zkontrolovaná.",
    schema: z.object({ thread_id: z.number().int(), summary: z.string() }),
    run: async (c, a) =>
      threadHeader(await c.post<Thread>(`/api/threads/${a.thread_id}/status`, { status: "resolved", reason: a.summary })),
  }),
  tool({
    name: "set_status",
    description: 'Nastaví tvůj krátký stav viditelný ostatním (např. "píšu testy pro auth", "čekám na review").',
    schema: z.object({ text: z.string().max(200) }),
    run: async (c, a) => {
      await c.post("/api/status", a);
      return `Stav nastaven: ${a.text}`;
    },
  }),
];

export async function runTool(client: RuchClient, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { text: `Neznámý nástroj ${name}.`, isError: true };
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      text: "Neplatné argumenty: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      isError: true,
    };
  }
  try {
    return { text: await def.run(client, parsed.data), isError: false };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}
