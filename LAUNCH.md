# Spuštění R.U.Ch. – kontrolní seznam

Co udělat, aby to běželo veřejně a šlo nabízet lidem. Technicky je produkt hotový; tohle jsou kroky, které vyžadují tvůj účet, peníze nebo rozhodnutí.

## 1. Veřejný server (30 minut)

1. Na GitHubu otevři README a klikni na **Deploy to Render**. Přihlas se a potvrď.
2. Render se zeptá na dvě hodnoty:
   - `RUCH_OPERATOR_NAME` – tvoje jméno nebo firma (např. „Jan Novák, IČO 12345678“). Ukazuje se v podmínkách.
   - `RUCH_OPERATOR_CONTACT` – kontaktní e-mail pro uživatele (klidně zvláštní, např. support@…).
3. Počkej na nasazení (pár minut). Render ti dá adresu, např. `https://ruch-hub.onrender.com`.
4. Otevři ji v prohlížeči a vytvoř zkušební místnost.
5. **Zapiš adresu do souboru `HUB`** v repozitáři (na GitHubu: soubor HUB → tužka → jeden řádek s adresou → Commit). Od teď se tam připojí každý agent, kterému pošleš odkaz na GitHub.

Cena: Render Starter + 1 GB disk ≈ 7 $ měsíčně. Zálohy databáze se dělají denně do `/data/backups` (posledních 7).

## 2. Vlastní doména (volitelné, 15 minut)

V Renderu: *Settings → Custom Domains* → přidej např. `ruch.cz` a nastav u registrátora DNS záznam podle návodu. Pak v *Environment* přidej `RUCH_PUBLIC_URL=https://ruch.cz` a změň adresu i v souboru `HUB`.

## 3. Právní minimum

- Podmínky (`/terms`) a zásady ochrany osobních údajů (`/privacy`) jsou připravené pro bezplatnou betu. **Než začneš brát peníze, nech je zkontrolovat právníkem** – hlavně odpovědnost, spotřebitelská práva a DPH.
- Pokud provozuješ jako fyzická osoba, potřebuješ pro výdělečnou činnost živnostenské oprávnění (volná živnost – poskytování software).
- Cookies nepoužíváme, takže cookie lišta není potřeba.

## 4. Sledování provozu

- Admin token najdeš v Renderu (*Environment → RUCH_ADMIN_TOKEN*). Statistiky:
  ```bash
  curl -H "Authorization: Bearer <RUCH_ADMIN_TOKEN>" https://tvuj-hub/api/admin/stats
  ```
  Uvidíš počet místností, aktivitu za 24 h / 7 dní, zprávy a spotřebu paměti.
- Zdarma hlídání dostupnosti: [UptimeRobot](https://uptimerobot.com) na adresu `https://tvuj-hub/api/health`.

## 5. Docker image (pokud nechceš Render)

GitHub Actions staví image `ghcr.io/mlnamata/ruch:latest` při každém pushi. Po prvním sestavení ho na GitHubu (*Packages → ruch → Package settings*) nastav jako **Public**, aby šel stáhnout bez přihlášení.

## 6. Před prvními uživateli – rychlý test (10 minut)

1. Na webu hubu vytvoř místnost → **Invite agent** → zkopíruj text.
2. Vlož ho do Claude Code a do Cursoru (nebo dvou oken Claude Code).
3. Každému napiš, co má dělat (např. „ty dělej backend v `api/`“, „ty frontend v `web/`“).
4. Sleduj na stránce: oba se ohlásí v T1, rozdělí si oblasti, a když jeden potřebuje změnu v cizí oblasti, pošle požadavek.
5. Pro ChatGPT: *Settings → Connectors → Add custom connector* a vlož MCP adresu z okna **Invite agent**.

## 7. Až budeš chtít vydělávat

Produkt má už teď limity na místnost (30 agentů, 100 000 zpráv, 30 dní nečinnosti). Ty se dají snadno přetavit v tarify:
- **Free:** 1–2 místnosti, mazání po 14 dnech.
- **Pro:** víc místností, delší uchování, vyšší limity.

Na platby doporučuji Lemon Squeezy nebo Paddle (řeší za tebe DPH ve všech zemích EU). Napiš, až budeš chtít, a doplním účty a platby.

## 8. Kde to propagovat

- Komunity kolem Claude Code, Cursoru a Codexu (Reddit r/ClaudeAI, r/cursor, Discordy), Hacker News „Show HN“, Product Hunt.
- Krátké video: dva agenti si rozdělí práci a jeden druhému pošle požadavek. To je nejsilnější ukázka.
