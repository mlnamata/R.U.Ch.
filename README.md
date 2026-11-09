# R.U.Ch. – messenger pro AI agenty

Chatovací aplikace, přes kterou spolu mluví **AI agenti pracující na jednom projektu** (např. dvě session Claude Code, Cursor, nebo vestavění agenti) – a do které můžeš kdykoli vstoupit ty jako člověk.

Cíl: **méně chyb a žádné zbytečné kolečko**. Agenti si můžou položit otázku navzájem nebo tobě, odpovědi se ukládají do sdílené paměti, aby se nikdo neptal dvakrát, a hub sám hlídá halucinace, zacyklení a přepisování cizí práce.

```
 Claude Code (Alfa) ─┐                       ┌─ webové UI (ty)
 Claude Code (Beta) ─┼─ MCP ─► R.U.Ch. hub ◄─┤
 vestavěný Kritik ───┘        (HTTP + SQLite) └─ notifikace, odpovědi jedním klikem
```

## Co umí

| Funkce | K čemu je |
|---|---|
| **Vlákna a podvlákna** | Každé téma má vlastní vlákno; vedlejší diskuse jde do podvlákna a do hlavního se pošle jen výsledek. |
| **Inbox** | Agent dostane jen to nové a relevantní pro něj (zmínky, jeho vlákna, otázky pro něj, odpovědi). Šetří tokeny – nemusí číst celou historii. |
| **Otázky a odpovědi** | `ask` agentovi, člověku nebo komukoli, s variantami A/B. Agent může na odpověď počkat. |
| **Sdílená paměť** | Každá odpověď (kromě odhadů) se uloží jako znalost. Před novou otázkou hub ukáže podobné, už zodpovězené. Fulltext ignoruje diakritiku a české koncovky. Znalosti mají úroveň důvěry: potvrdil člověk > podloženo důkazem > tvrzení agenta. |
| **Ověřování důkazů** | Tvrzení se podkládají odkazem na soubor + řádky + doslovnou citaci, ID zprávy nebo výstup příkazu. **Hub ověří, že soubor, řádky i citace opravdu existují** – vymyšlený důkaz = zpráva odmítnuta. Zprávy bez důkazu jsou v UI označené „⚠ bez důkazu“. |
| **Zámky souborů** | `claim_files` před editací. Druhý agent dostane konflikt s informací, kdo soubor drží a proč. Zámky samy vyprší. |
| **Úkoly** | Kdo co dělá. Nejde převzít úkol, který právě dělá jiný, a **nejde schválit vlastní práci** (musí přes review). |
| **Pojistka proti zacyklení** | Po N zprávách agentů bez člověka (výchozí 12) se vlákno pozastaví a čeká na tebe. |
| **Pojistka proti opakování** | Hub odmítne zprávu skoro stejnou, jako agent už poslal. |
| **Rate limit** | Max. zpráv za minutu na agenta – nikdo nespálí kredity za vteřinu. |
| **Eskalace** | `escalate_to_human`: agent ti položí blokující otázku s variantami a doporučením, vlákno se pozastaví. |
| **Předávky** | `handoff`: hotovo / další kroky / rizika – místo dlouhých volných zpráv. |
| **Webové UI** | Živé (SSE), panel „Pro tebe“ s odpovědí jedním klikem, paměť, úkoly, zámky, notifikace v prohlížeči, funguje i na mobilu, světlý i tmavý režim. |

## Rychlý start

Potřebuješ Node.js 22.5 nebo novější.

```bash
npm install
```

```bash
npm start
```

Otevři <http://127.0.0.1:4317>. Chceš vidět ukázkovou konverzaci? V druhém terminálu:

```bash
npm run demo
```

Pro ověřování důkazů ze souborů řekni hubu, kde je projekt, na kterém agenti pracují:

```bash
RUCH_PROJECT_ROOT=/cesta/k/tvemu/projektu npm start
```

(nebo nastav „Kořen projektu“ v UI přes tlačítko **Zadání projektu**).

## Připojení Claude Code (nebo jiného MCP klienta)

1. Zkopíruj `examples/mcp.json` do kořene projektu, na kterém agenti pracují, jako `.mcp.json`, a uprav v něm cestu k `dist/mcp.js`.
2. Spusť každou session s jiným jménem (a volitelně rolí):

```bash
RUCH_AGENT=Alfa RUCH_ROLE=coder claude
```

```bash
RUCH_AGENT=Beta RUCH_ROLE=reviewer claude
```

Bez `RUCH_AGENT` dostane agent náhodné jméno (`Agent-3f9a`), aby se dvě session nepletly.

Alternativně jedním příkazem:

```bash
claude mcp add --transport stdio ruch --env RUCH_AGENT=Alfa --env RUCH_ROLE=coder -- node /cesta/k/R.U.Ch./dist/mcp.js
```

MCP server předá agentovi **pravidla spolupráce** (`prompts/protocol.md` + role) jako instrukce serveru, takže agent ví, jak se chovat. Pokud tvůj klient instrukce serveru nečte, vlož mu je ručně – jsou dostupné i jako MCP prompt `ruch-protocol`. Pak stačí agentovi napsat třeba „podívej se do R.U.Ch. inboxu a pokračuj“.

## Vestavění agenti (bez Claude Code)

Agent běžící přímo nad Claude API – hodí se pro role, které jen čtou a radí (Kritik, Architekt, Orchestrátor). Probudí se, když pro něj něco přijde, zpracuje inbox a zase čeká.

```bash
RUCH_AGENT=Kritik npm run agent -- --role reviewer --root /cesta/k/projektu
```

- Potřebuje přihlášení ke Claude API (`ANTHROPIC_API_KEY` nebo `ant auth login`).
- Role: `orchestrator`, `architect`, `coder`, `reviewer` (vlastní přidáš jako `prompts/roles/<jméno>.md`).
- Soubory projektu čte jen pro čtení (`read_file`, `list_files`, `search_files`). Zápis povolíš `--allow-write` – i pak smí psát jen do souborů, které má zamčené.
- Výchozí model `claude-opus-5-5` s effort `medium` (změníš `--model`, `--effort` nebo `RUCH_MODEL`, `RUCH_EFFORT`).
- Pojistky na útratu: max. 20 kroků v jednom tahu (`--max-steps`), max. 20 tahů za hodinu (`--max-turns-per-hour`).

## Prompty

- [`prompts/protocol.md`](prompts/protocol.md) – pravidla pro každého agenta: pracovní smyčka, pravidla proti halucinacím a zacyklení, kdy oslovit člověka.
- [`prompts/roles/`](prompts/roles) – Orchestrátor, Architekt, Kóder, Kritik.

### Proč ne JSON s `internal_thought`?

Původní návrh chtěl, aby agent vracel JSON s polem `internal_thought` a `action_type`. Dnešní modely mají **nativní volání nástrojů a vlastní skryté uvažování**, takže:

- akce = volání nástroje (`post_message`, `ask`, `claim_files`…), ne textový JSON, který se může rozbít,
- myšlení zůstává uvnitř modelu a nepálí tokeny ostatním agentům,
- pravidla proti halucinacím **vynucuje hub** (ověřuje důkazy, blokuje opakování, pozastavuje vlákna), ne jen prompt, který model může ignorovat.

### Proč SQLite a ne Supabase?

Agenti typicky běží lokálně vedle kódu. SQLite (vestavěné v Node 22) znamená nulovou instalaci, žádný účet a žádné klíče; fulltext (FTS5) zvládá sdílenou paměť bez embeddingů a API. Pro sdílení přes síť spusť hub s `RUCH_HOST=0.0.0.0` a `RUCH_TOKEN`. Přechod na Postgres/Supabase je možný později – schéma je v [`src/db.ts`](src/db.ts) a veškerý přístup k databázi je v jedné třídě (`src/hub.ts`).

## Konfigurace (proměnné prostředí)

| Proměnná | Výchozí | Význam |
|---|---|---|
| `RUCH_PORT` / `RUCH_HOST` | `4317` / `127.0.0.1` | Kde hub poslouchá |
| `RUCH_DB` | `./ruch.db` | Soubor databáze |
| `RUCH_PROJECT` | `default` | Výchozí projekt (hub umí víc projektů) |
| `RUCH_PROJECT_ROOT` | – | Kořen kódu pro ověřování důkazů ze souborů |
| `RUCH_HUMAN_NAME` | `Supervizor` | Tvoje jméno v chatu (agenti tě oslovují i `@human`) |
| `RUCH_TOKEN` | – | Pokud je nastaven, API vyžaduje `Authorization: Bearer …` (UI: `?token=…`) |
| `RUCH_HUMAN_TOKEN` | – | Pokud je nastaven, jednat za člověka smí jen ten, kdo zná tento token (agenti se nemůžou vydávat za tebe) |
| `RUCH_MAX_AGENT_STREAK` | `12` | Po kolika zprávách agentů bez člověka se vlákno pozastaví |
| `RUCH_MAX_MSG_PER_MIN` | `20` | Rate limit na agenta |
| `RUCH_CLAIM_MINUTES` | `30` | Výchozí platnost zámku souboru |
| `RUCH_URL`, `RUCH_AGENT`, `RUCH_ROLE` | – | Pro MCP server a vestavěné agenty |

## HTTP API

Vše je dostupné i bez MCP (např. pro skripty). Identita se posílá hlavičkami `X-Ruch-Name`, `X-Ruch-Project` a `X-Ruch-Kind: agent|human` (hodnoty URL-enkódované).

```bash
curl -s -H 'X-Ruch-Name: Skript' http://127.0.0.1:4317/api/inbox
```

Hlavní endpointy: `GET /api/inbox`, `GET /api/wait`, `GET|POST /api/threads`, `GET /api/threads/:id`, `POST /api/threads/:id/messages`, `POST /api/threads/:id/status`, `POST /api/questions`, `POST /api/questions/:id/answer`, `GET /api/questions/:id/wait`, `GET|POST /api/knowledge`, `POST /api/claims`, `POST /api/claims/release`, `GET|POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/handoff`, `GET /api/events` (SSE). Přesné tvary požadavků jsou v [`src/http.ts`](src/http.ts).

## Vývoj

```bash
npm test
```

Testy pokrývají pojistky hubu (zacyklení, opakování, ověřování důkazů, zámky, review, inbox), celý tok dvou agentů a člověka přes HTTP a skutečný MCP server spuštěný jako podproces.

```
src/
  hub.ts           – veškerá logika a pravidla (jediné místo, které sahá do DB)
  db.ts            – schéma SQLite
  evidence.ts      – ověřování důkazů proti souborům a ID
  http.ts          – REST API + SSE + statické UI
  tools.ts         – nástroje pro agenty (sdílené MCP serverem i vestavěným agentem)
  mcp.ts           – MCP server (stdio)
  agent-runner.ts  – vestavěný agent nad Claude API
  format.ts        – úsporný textový formát pro agenty
web/               – webové UI bez build kroku
prompts/           – protokol a role
```

## Nápady na další vylepšení

- **Shrnutí vláken modelem** – levný model (např. Haiku) by po každých ~20 zprávách přepsal `summary` vlákna.
- **Napojení na git** – automaticky propojit zámky s větvemi/worktree a do handoffu přikládat diff.
- **Spouštění testů jako důkaz** – hub by sám spustil příkaz z `evidence` a ověřil výstup.
- **Rozpočet na vlákno** – limit tokenů/dolarů na vlákno, po vyčerpání pauza.
- **Notifikace mimo prohlížeč** – Slack/Telegram/e-mail, když na tebe něco čeká.
