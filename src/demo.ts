#!/usr/bin/env node
/** Creates a room on a running hub with a short sample conversation and prints the links. */
import { RuchClient } from "./client.js";
import { runTool } from "./tools.js";

const url = (process.env.RUCH_HUB ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const res = await fetch(`${url}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Demo: šifrované API klíče" }),
});
const room = (await res.json()) as { agent_code: string; owner_url: string; invite_url: string; human: string; message?: string };
if (!res.ok) throw new Error(room.message);

const mk = (name: string) => new RuchClient({ url, key: room.agent_code, name });
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

const created = await t(architekt, "thread", {
  action: "new",
  title: "Šifrované API klíče v tabulce projects",
  text: `Úkol od @${room.human}: ukládat API klíče projektů šifrovaně.\nNávrh: sloupec api_key_id odkazující do Supabase Vault, klíč nikdy neposíláme na klienta. @Koder implementuj migraci, @Kritik pak review.`,
});
const thread = Number(/T(\d+)/.exec(created)![1]);
await t(architekt, "memory", { action: "save", kind: "fact", title: "Tajné klíče se ukládají přes Supabase Vault", text: "Do tabulek ukládáme jen ID secretu (uuid), klíč je ve Vaultu." });
await t(koder, "status", { text: "píšu migraci pro api_key_id" });
await t(koder, "files", { action: "claim", paths: ["supabase/migrations/"], reason: "migrace api_key_id" });
await t(koder, "send", {
  thread,
  kind: "status",
  text: "Migrace hotová: `ALTER TABLE projects ADD COLUMN api_key_id uuid REFERENCES vault.secrets(id);` + RLS politika jen pro vlastníka.",
  evidence: ["$ supabase db reset | Finished supabase db reset."],
  confidence: "certain",
});
await t(koder, "ask", {
  to: "human",
  thread,
  question: "Mají se stávající nešifrované klíče automaticky přesunout do Vaultu, nebo je uživatelé zadají znovu?",
  options: ["Automaticky přesunout migrací", "Smazat a nechat uživatele zadat znovu"],
  blocking: true,
});
await t(kritik, "send", { thread, kind: "review", text: "@Koder blokující: RLS politika chybí pro DELETE. Drobnost: index na api_key_id.", confidence: "likely" });
await t(koder, "files", { action: "release" });
await t(kritik, "task", { action: "new", title: "Doplnit RLS pro DELETE na projects", to: "Koder", thread });

console.log(`Demo místnost je připravená.
  Tvoje stránka:   ${room.owner_url}
  Pozvánka agentů: ${room.invite_url}`);
