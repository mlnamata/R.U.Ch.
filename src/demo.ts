#!/usr/bin/env node
/** Fills a running hub with a short sample conversation so you can see how the UI works. */
import { RuchClient } from "./client.js";
import { runTool } from "./tools.js";

const url = process.env.RUCH_URL ?? "http://127.0.0.1:4317";
const project = process.env.RUCH_PROJECT ?? "default";
const human = process.env.RUCH_HUMAN_NAME ?? "Supervizor";
const mk = (name: string) => new RuchClient({ url, project, name, token: process.env.RUCH_TOKEN ?? null });

async function t(c: RuchClient, name: string, args: unknown) {
  const r = await runTool(c, name, args);
  if (r.isError) throw new Error(`${c.opts.name}.${name}: ${r.text}`);
  return r.text;
}

const architekt = mk("Architekt");
const koder = mk("Koder");
const kritik = mk("Kritik");
await architekt.post("/api/join", { role: "architect" });
await koder.post("/api/join", { role: "coder" });
await kritik.post("/api/join", { role: "reviewer" });

const created = await t(architekt, "create_thread", {
  title: "Šifrované API klíče v tabulce projects",
  body: `Úkol od @${human}: ukládat API klíče projektů šifrovaně.\nNávrh: sloupec api_key_id odkazující do Supabase Vault, klíč nikdy neposíláme na klienta. @Koder implementuj migraci, @Kritik pak review.`,
});
const thread = Number(/T(\d+)/.exec(created)![1]);
await t(architekt, "save_knowledge", {
  kind: "fact",
  title: "Tajné klíče se ukládají přes Supabase Vault",
  body: "Do tabulek ukládáme jen ID secretu (uuid), samotný klíč je ve Vaultu.",
});
await t(koder, "set_status", { text: "píšu migraci pro api_key_id" });
await t(koder, "claim_files", { paths: ["supabase/migrations/"], reason: "migrace api_key_id", thread_id: thread });
await t(koder, "post_message", {
  thread_id: thread,
  body: "Migrace hotová: `ALTER TABLE projects ADD COLUMN api_key_id uuid REFERENCES vault.secrets(id);` + RLS politika jen pro vlastníka projektu.",
  kind: "status",
  evidence: [{ type: "command", command: "supabase db reset", output: "Finished supabase db reset." }],
  confidence: "certain",
});
await t(koder, "ask", {
  to: "human",
  thread_id: thread,
  question: "Mají se stávající nešifrované klíče automaticky přesunout do Vaultu, nebo je uživatelé zadají znovu?",
  options: ["Automaticky přesunout migrací", "Smazat a nechat uživatele zadat znovu"],
  blocking: true,
});
await t(kritik, "post_message", {
  thread_id: thread,
  kind: "review",
  body: "@Koder blokující: RLS politika chybí pro DELETE – vlastník nemůže klíč odebrat. Drobnost: přidat index na api_key_id.",
  confidence: "likely",
});
await t(koder, "release_files", {});
await t(kritik, "create_task", { title: "Doplnit RLS pro DELETE na projects", assignee: "Koder", thread_id: thread });

console.log(`Demo připraveno ve vlákně T${thread}. Otevři ${url}`);
