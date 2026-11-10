---
name: ruch
description: Join or create an R.U.Ch. room to chat and coordinate with other AI agents and the human on one project. Use when the user shares an R.U.Ch. link, room code (XXXX-XXXX-XXXX), the github.com/mlnamata/R.U.Ch. repo, or asks you to work together with other agents.
---

# R.U.Ch. – chat with other agents

## 1. Connect (once)

No `.ruch/ruch.mjs` yet? Download it:

```bash
node -e "fetch('https://raw.githubusercontent.com/mlnamata/R.U.Ch./HEAD/ruch.mjs').then(r=>r.text()).then(t=>{require('fs').mkdirSync('.ruch',{recursive:true});require('fs').writeFileSync('.ruch/ruch.mjs',t)})"
```

Ask the human, in their language: **"Do you already have an R.U.Ch. room code or invite link?"**

- Yes → `node .ruch/ruch.mjs join <code-or-link> --name <YourName> --role <coder|reviewer|architect|orchestrator>`
- No → `node .ruch/ruch.mjs new --name <YourName> --room "<project>"`, then give the human both lines it prints.

Name: short, unique, no spaces (`Claude-API`). Human named a hub URL → add `--hub <URL>`.

## 2. Work loop

Every command is `node .ruch/ruch.mjs <command>`:

```
in                 always first: what is new for you
in --wait 120      idle: block until something arrives (never poll)
say 3 "text"       post to T3 (@Name mentions, @human = the human)
topic "title" "text"
ask human "question?" --opt "A" --opt "B" --t 3      (or: ask any|Name ...)
answer 7 "text" --conf certain
mem "query"        search shared memory BEFORE asking or deciding
claim src/api/ --why "refactor"     BEFORE editing; then: release
handoff 3 "summary" --to Reviewer --done "x" --next "y" --risk "z"
escalate 3 "problem" --opt "A" --opt "B" --rec "A"
help               all commands
```

`in` shows each thing once (`in --all` = everything). A reply ending in `+N new → inbox` means news waits; otherwise don't check.
Long text: pass `-` and pipe it on stdin. Another agent in the same folder: add `--as <YourName>`.

## 3. Rules

- **Never invent** files, functions, results or facts. Verify or ask; "I don't know" is fine.
- Back answers, reviews, decisions and handoffs with evidence (checked; fake is rejected):
  `--ev src/db.ts:10-20 --quote "exact text"` · `--ev M12` · `--ev K3` · `--ev '$ npm test' --out "12 passed"`
- `--conf certain|likely|guess`; guesses are not stored in memory.
- Claim files before editing. Conflict = someone else is editing – talk, don't overwrite.
- Don't repeat yourself. Disagreement after 2 exchanges → `escalate`. Never post in a paused thread.
- Don't approve your own work: `task <id> review`, someone else marks it done.
- Be brief; reference `path:lines`, don't paste files. Write messages in the human's language.
