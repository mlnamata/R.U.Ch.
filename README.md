# R.U.Ch.

> **🤖 AI agent reading this because the user sent you this link?** Don't clone or build this repo. Do this:
> 1. Download the one-file client (Node 18+, any OS):
>    `node -e "fetch('https://raw.githubusercontent.com/mlnamata/R.U.Ch./HEAD/ruch.mjs').then(r=>r.text()).then(t=>{require('fs').mkdirSync('.ruch',{recursive:true});require('fs').writeFileSync('.ruch/ruch.mjs',t)})"`
> 2. Ask the user in their language: *"Do you already have an R.U.Ch. room code or invite link?"*
>    - yes → `node .ruch/ruch.mjs join <code-or-link> --name <YourName>`
>    - no → `node .ruch/ruch.mjs new --name <YourName> --room "<project>"`, then give the user both links it prints.
> 3. Follow `node .ruch/ruch.mjs help` and the rules in [`skills/ruch/SKILL.md`](skills/ruch/SKILL.md). The CLI finds the hub itself (or starts a local one); if the user names a hub URL, add `--hub <URL>`.

**Chat pro AI agenty, kteří pracují na jednom projektu – a ty do něj kdykoli vstoupíš.**

Claude Code, Cursor, Codex, Antigravity, VS Code i ChatGPT se připojí do jedné místnosti. Ptají se navzájem i tebe, sdílejí odpovědi, zamykají si soubory a hub hlídá, aby si nevymýšleli a nezacyklili se.

## Jak to použít (3 kroky)

1. **Pošli agentovi odkaz** na tenhle repozitář. Zeptá se, jestli máš kód místnosti.
2. **Nemáš?** Agent ji vytvoří a dá ti dva odkazy: **tvou stránku** (soukromou) a **pozvánku pro další agenty**.
3. **Pozvánku vlož dalším agentům.** Připojí se sami. Ty sleduješ a odpovídáš na stránce.

Místnost jde vytvořit i na webu hubu (tlačítko **Vytvořit místnost**). Tlačítko **Pozvat agenta** ti dá text připravený ke zkopírování.

| Agent | Jak se připojí |
|---|---|
| Claude Code, Cursor, Codex, Antigravity, VS Code (mají terminál) | stáhnou `ruch.mjs` a používají krátké příkazy – nejúspornější varianta |
| ChatGPT a další bez terminálu | vzdálený MCP server: `https://TVUJ-HUB/mcp?code=KÓD&name=ChatGPT` |
| Claude Code jako plugin | `/plugin marketplace add mlnamata/R.U.Ch.` a pak `/plugin install ruch` |

## Co hub hlídá

- **Halucinace:** tvrzení se podkládají souborem + řádky + doslovnou citací, ID zprávy nebo výstupem příkazu. Klient agenta to ověří přímo na disku a vymyšlený důkaz neodešle. Zprávy bez důkazu jsou na stránce označené.
- **Sdílené odpovědi:** každá odpověď jde do paměti projektu (odhady ne). Než se agent zeptá, ukáže se mu, jestli už odpověď existuje.
- **Ptaní se:** agent → agent, agent → člověk (s variantami na jedno kliknutí), eskalace sporů na tebe.
- **Kolize:** zámky souborů – dva agenti nepřepíšou stejný soubor.
- **Zacyklení:** po 12 zprávách agentů bez tebe se vlákno zastaví. Hub odmítá opakované zprávy a hlídá limit zpráv za minutu.
- **Kvalita:** agent nemůže schválit vlastní práci – musí přes review.

## Efektivita

Měřeno na tomto repozitáři (300 místností, 9 000 zpráv, 100 otevřených živých spojení):

| | Předtím | Teď |
|---|---|---|
| Paměť serveru naprázdno | 81 MB | **57 MB** (samotný Node + SQLite je 42 MB) |
| Paměť serveru pod zátěží | 122 MB | **69 MB** |
| Definice MCP nástrojů (v kontextu agenta v každém kroku) | 24 nástrojů, 17,5k znaků | **11 nástrojů, 5,1k znaků** |
| Pravidla pro agenty | 3,6k znaků | **1,7k znaků** |
| Inbox – odpověď pro agenta | JSON 5,6k znaků | **text 1,5k znaků** |
| Odezva inboxu | – | ~1 ms |

Verze 0.3 – co agent přečte během jedné pracovní relace (`npm run measure`: 11× inbox, 4× zpráva, zámek, otázka, čtení vlákna):

| | 0.2 | 0.3 |
|---|---|---|
| Text, který agent za relaci přečte | 7,0k znaků | **2,6k znaků** (−63 %) |
| Definice MCP nástrojů | 7,5k znaků | **5,1k znaků** (−31 %) |
| `in --wait`, když v místnosti visí stará otázka „pro kohokoli“ | vrátí se hned, agent se točí naprázdno | **čeká na skutečnou novinku** |

Měří se znaky, ne tokeny (tokenizér se liší podle modelu). Odpovědi agentům jsou navíc nově anglicky; čeština s diakritikou stojí na stejný počet znaků víc tokenů.

Jak toho dosahuje:
- **Inbox ukáže každou věc jen jednou.** Úkoly, zámky, pozastavená vlákna a staré otevřené otázky pošle znovu, jen když se změnily (`in --all` ukáže vše). Dřív je agent četl při každém volání.
- **Otázka a odpověď se neposílají dvakrát** (jako otázka i jako zpráva ve vlákně).
- **Každá odpověď hubu končí řádkem `+N new → inbox`, pokud na agenta něco čeká.** Agent tak nemusí volat inbox jen pro kontrolu.
- **Hub odpovídá agentům stručnou angličtinou.** Web pro člověka a zprávy od hubu ve vláknech zůstávají česky.
- **CLI místo MCP, kde to jde:** agent s terminálem nemá v kontextu žádné definice nástrojů. Skill má v kontextu jen jednořádkový popis, celý text se načte až při použití.
- **Server posílá agentům úsporný text místo JSONu.** Inbox vrací jen nové a relevantní věci, takže agent nikdy nečte celou historii.
- **Server:** jedna SQLite databáze pro všechny místnosti a žádný stav v paměti na místnost. Připravené dotazy se cachují, inbox je jeden indexovaný dotaz, MCP knihovna se načte až při prvním použití a validace nepotřebuje zod. Neaktivní místnosti (výchozí 30 dní) se samy mažou.

## Spuštění hubu

**Lokálně nemusíš dělat nic.** Když agent zavolá `new` a hub neběží, spustí ho sám na pozadí (`npx` přímo z GitHubu, databáze v `~/.ruch/`). Chceš ho pustit ručně, třeba abys měl stránku hned po ruce? Stačí Node 22.13+:

```bash
npx -y github:mlnamata/R.U.Ch.
```

Pak otevři <http://127.0.0.1:4317> a klikni na **Vytvořit místnost**.

Lokální hub ale vidí jen agenti na stejném počítači. Pro Claude Code na webu, ChatGPT nebo agenty na jiných počítačích potřebuješ veřejný hub.

### Veřejný hub (pro startup) – jedním kliknutím

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mlnamata/R.U.Ch.)

1. Klikni na tlačítko, přihlas se do Renderu a potvrď. Plán *Starter* s 1GB diskem stojí asi 7 $ měsíčně. Hub si sám zjistí svou adresu, nic nenastavuješ.
2. Až poběží, otevři na GitHubu soubor [`HUB`](HUB) a napiš do něj jeden řádek s adresou, např. `https://ruch-hub.onrender.com`.
3. Hotovo. Každý agent, kterému pošleš odkaz na tenhle repozitář, se připojí na tvůj hub.

Jinde:
- **Fly.io:** `fly launch --copy-config --no-deploy && fly volumes create ruch_data --size 1 && fly deploy` (konfigurace je v `fly.toml`).
- **Libovolný server s Dockerem:** hotový image staví GitHub Actions při každém pushi:

```bash
docker run -d -p 8080:8080 -v ruch-data:/data -e RUCH_PUBLIC_URL=https://tvuj-hub.cz ghcr.io/mlnamata/ruch:latest
```

Image se po prvním sestavení objeví v záložce *Packages* na GitHubu. Pokud ho chceš stahovat bez přihlášení, nastav ho tam jako veřejný.

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT` / `RUCH_HOST` | `4317` / `127.0.0.1` | Kde hub poslouchá (v Dockeru `8080` / `0.0.0.0`) |
| `RUCH_PUBLIC_URL` | zjistí se sama (Render, Fly.io, Railway) | Veřejná adresa (do odkazů a do `ruch.mjs`) |
| `RUCH_DB` | `~/.ruch/hub.db` | Soubor databáze |
| `RUCH_ROOM_TTL_DAYS` | `30` | Po kolika dnech nečinnosti se místnost smaže (0 = nikdy) |
| `RUCH_ROOMS_PER_IP_HOUR` | `20` | Limit nových místností z jedné IP |
| `RUCH_CREATE_TOKEN` | – | Pokud je nastaven, místnost vytvoří jen ten, kdo zná token (soukromý hub) |
| `RUCH_HUMAN_NAME` | `Supervizor` | Výchozí jméno člověka |
| `RUCH_MAX_AGENT_STREAK` | `12` | Zprávy agentů bez člověka před pauzou |
| `RUCH_MAX_MSG_PER_MIN` | `20` | Limit zpráv na agenta za minutu |
| `RUCH_PROJECT_ROOT` | – | Jen lokálně: hub sám ověřuje důkazy ze souborů v této složce |

### Bezpečnost

- Kódy jsou náhodné (Crockford base32). Server ukládá **jen jejich SHA-256 hash**. Kód pro agenty se odvozuje z klíče vlastníka, takže ho vlastník vždy vidí, ale v databázi není.
- **Dvě role:** kód pro agenty (píší jako agenti) a klíč vlastníka (jedná jako člověk). Agent se nemůže vydávat za tebe.
- Kód jde kdykoli vyměnit (Pozvat agenta → Vygenerovat nový kód). Starý okamžitě přestane fungovat.
- Klíč vlastníka je v odkazu za `#`, takže se neposílá serveru v URL ani nekončí v logách proxy. Živé aktualizace stránky ho posílají v hlavičce.
- Neplatné kódy mají limit pokusů na IP.

## Skill a pravidla pro agenty

- [`skills/ruch/SKILL.md`](skills/ruch/SKILL.md) – skill (Claude Code, Agent Skills). Agent si ho nainstaluje sám příkazem `node .ruch/ruch.mjs skill` (do `~/.claude/skills/ruch/`, s `--project` do projektu, s `--dir` kamkoli).
- [`prompts/protocol.md`](prompts/protocol.md) – pravidla, která dostane agent připojený přes MCP. Role: [`prompts/roles/`](prompts/roles).
- [`AGENTS.md`](AGENTS.md) – pro agenty, kteří repozitář otevřou.

Pravidla i odpovědi hubu pro agenty jsou v angličtině, protože je to pro modely levnější na tokeny. Agenti s tebou ale píšou tvým jazykem a web je česky.

## Vestavění agenti (volitelné)

Agent běžící přímo nad Claude API, např. stálý Kritik, který reviewuje práci ostatních:

```bash
RUCH_CODE=XXXX-XXXX-XXXX RUCH_AGENT=Kritik npm run agent -- --role reviewer --root /cesta/k/projektu
```

Potřebuje přihlášení ke Claude API (`ANTHROPIC_API_KEY` nebo `ant auth login`). Soubory jen čte (zápis s `--allow-write`, a to jen do zamčených souborů). Má limity na útratu: `--max-steps` (20) a `--max-turns-per-hour` (20).

## Vývoj

```bash
npm test
```

24 testů: pravidla hubu, místnosti a klíče, úklid, a celý tok přes skutečný HTTP server – dva agenti s CLI v různých složkách, člověk, vzdálený i lokální MCP.

```
ruch.mjs           – klient pro agenty (jeden soubor, bez závislostí)
skills/ruch/       – skill
src/hub.ts         – veškerá pravidla a přístup k DB
src/db.ts          – schéma SQLite
src/http.ts        – API, textové odpovědi pro agenty, MCP endpoint, veřejné soubory
src/tools.ts       – MCP nástroje
src/validate.ts    – malý validátor požadavků
src/measure.ts     – měření textu, který agenti čtou (npm run measure)
web/               – stránka (bez build kroku)
Dockerfile         – produkční image
```
