// R.U.Ch. web UI – vanilla JS, no build step.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const saved = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const save = (k, v) => {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
};

const S = {
  key: null, // owner key of the open room (from #o=…)
  me: null,
  role: null,
  agentCode: null,
  state: null,
  threadId: null,
  thread: null,
  replyTo: null,
  filter: "",
};

// Rooms this browser owns, so the human can come back without the link.
const rooms = () => { try { return JSON.parse(saved("ruch.rooms") || "[]"); } catch { return []; } };
function rememberRoom(key, name) {
  const list = rooms().filter((r) => r.key !== key);
  list.unshift({ key, name, at: Date.now() });
  save("ruch.rooms", JSON.stringify(list.slice(0, 30)));
}

// ------------------------------------------------------------------ API

async function api(method, path, body) {
  const headers = { authorization: "Bearer " + S.key };
  if (S.me) headers["x-ruch-name"] = encodeURIComponent(S.me);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function toast(text, error = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = "toast" + (error ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), error ? 7000 : 2500);
}

async function act(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ rendering helpers

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Minimal, safe formatting: ``` blocks, `code`, @mentions, **bold**. */
function rich(text) {
  const parts = String(text).split(/```(?:[\w-]*\n)?/);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>`;
      return esc(p)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])@([\p{L}\p{N}_.-]+)/gu, '$1<span class="mention">@$2</span>');
    })
    .join("");
}

function time(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString("cs", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS = { open: "otevřené", human_needed: "čeká na tebe", resolved: "uzavřené" };
const KIND = { question: "otázka", answer: "odpověď", decision: "rozhodnutí", handoff: "předávka", review: "review", status: "stav" };
const EV = { verified: "✓ důkazy ověřeny", unchecked: "? důkazy neověřitelné", missing: "⚠ bez důkazu", invalid: "✗ neplatné důkazy" };
const CONF = { certain: "jisté", likely: "pravděpodobné", guess: "odhad" };

function evidenceLabel(e) {
  switch (e.type) {
    case "file": return e.path + (e.lines ? ":" + e.lines : "");
    case "message": return "M" + e.id;
    case "knowledge": return "K" + e.id;
    case "command": return "$ " + e.command;
    case "url": return e.url;
  }
  return "?";
}

// ------------------------------------------------------------------ state & lists

async function loadState() {
  S.state = await api("GET", "/api/state");
  renderAll();
}

function renderAll() {
  const st = S.state;
  $("#project-name").textContent = "· " + st.project.name;
  $("#me").textContent = S.me;
  renderThreads();
  renderParticipants();
  renderTodo();
  renderKnowledge(st.knowledge);
  renderTasks();
  renderClaims();
}

function renderThreads() {
  const list = $("#thread-list");
  const rows = S.state.threads.filter((t) => !S.filter || t.status === S.filter);
  list.innerHTML = rows.length
    ? rows
        .map(
          (t) => `<li class="${t.status}"><button data-id="${t.id}" class="${t.id === S.threadId ? "active" : ""}">
            <span class="t-title">${esc(t.title)}</span>
            <span class="t-meta">T${t.id} · ${STATUS[t.status]} · ${t.message_count} zpráv${t.open_questions ? ` · ${t.open_questions} otázek` : ""}${t.parent_id ? ` · pod T${t.parent_id}` : ""}</span>
          </button></li>`,
        )
        .join("")
    : `<li class="muted small" style="padding:8px 14px">Žádná vlákna.</li>`;
}

function renderParticipants() {
  $("#participants").innerHTML = S.state.participants
    .map(
      (p) => `<li><span class="dot ${p.online ? "on" : ""}" title="${p.online ? "online" : "offline"}"></span><strong>${esc(p.name)}</strong>
        <span class="muted small">${p.kind === "human" ? "člověk" : esc(p.role || "agent")}</span>
        ${p.status_text ? `<span class="p-status">${esc(p.status_text)}</span>` : ""}</li>`,
    )
    .join("");
  const sel = $("#task-assignee");
  const cur = sel.value;
  sel.innerHTML = `<option value="">nepřiřazeno</option>` + S.state.participants.map((p) => `<option>${esc(p.name)}</option>`).join("");
  sel.value = cur;
}

function renderTodo() {
  const st = S.state;
  const qs = st.questions.filter((q) => q.target === S.me || q.target === null);
  const paused = st.threads.filter((t) => t.status === "human_needed");
  const count = qs.length + paused.filter((t) => !qs.some((q) => q.thread_id === t.id)).length;
  for (const id of ["#todo-count", "#todo-count-m"]) {
    $(id).hidden = count === 0;
    $(id).textContent = count;
  }
  document.title = (count ? `(${count}) ` : "") + "R.U.Ch.";
  const cards = [];
  for (const q of qs) {
    cards.push(`<li class="card ${q.blocking ? "blocking" : ""}">
      <div class="meta">Q${q.id} · ${esc(q.asked_by)} → ${q.target ? "tobě" : "komukoli"} · <button class="link" data-open-thread="${q.thread_id}">T${q.thread_id}</button>${q.blocking ? " · <strong>blokuje práci</strong>" : ""}</div>
      <div class="body">${rich(q.body)}</div>
      <form class="answer-form" data-qid="${q.id}">
        ${q.options.length ? `<div class="row">${q.options.map((o, i) => `<button type="button" class="small" data-choice="${esc(String.fromCharCode(65 + i) + ") " + o)}">${String.fromCharCode(65 + i)}) ${esc(o)}</button>`).join("")}</div>` : ""}
        <textarea name="body" rows="2" placeholder="${q.options.length ? "Volitelně doplň…" : "Tvoje odpověď…"}"></textarea>
        <div class="row"><button class="primary small">Odpovědět</button><button type="button" class="ghost small" data-cancel="${q.id}">Zrušit otázku</button></div>
      </form></li>`);
  }
  for (const t of paused) {
    if (qs.some((q) => q.thread_id === t.id)) continue;
    cards.push(`<li class="card blocking"><div class="meta">T${t.id} pozastaveno</div>
      <h3>${esc(t.title)}</h3><div class="body">${esc(t.status_reason || "Agenti potřebují tvůj vstup.")}</div>
      <div class="row"><button class="small" data-open-thread="${t.id}">Otevřít</button><button class="small" data-resume="${t.id}">Nech je pokračovat</button></div></li>`);
  }
  $("#todo").innerHTML = cards.length ? `<ul class="cards">${cards.join("")}</ul>` : `<p class="muted">Nic na tebe nečeká. Agenti pracují sami.</p>`;
}

function renderKnowledge(rows) {
  const trust = { human: "potvrdil člověk", evidence: "podloženo", agent: "tvrzení agenta" };
  $("#knowledge").innerHTML = rows.length
    ? rows
        .map(
          (k) => `<li class="card ${k.status}">
        <div class="meta">K${k.id} · ${esc(k.kind)} · <span class="trust ${k.trust}">${trust[k.trust]}</span>${k.author ? " · " + esc(k.author) : ""}</div>
        <h3>${esc(k.title)}</h3><div class="body">${rich(k.body)}</div>
        ${k.status === "disputed" ? `<div class="meta">⚠ zpochybněno: ${esc(k.status_note)}</div>` : ""}
        <div class="row">${k.trust !== "human" ? `<button class="small" data-verify="${k.id}">Potvrdit</button>` : ""}
        ${k.status !== "disputed" ? `<button class="ghost small" data-dispute="${k.id}">Zpochybnit</button>` : ""}
        ${k.source_message_id ? `<span class="chip">z M${k.source_message_id}</span>` : ""}</div></li>`,
        )
        .join("")
    : `<li class="muted small">Paměť je zatím prázdná. Plní se odpověďmi na otázky a rozhodnutími.</li>`;
}

function renderTasks() {
  const order = ["doing", "review", "blocked", "todo", "done"];
  const label = { todo: "k udělání", doing: "pracuje se", review: "ke kontrole", done: "hotovo", blocked: "blokováno" };
  $("#tasks").innerHTML = S.state.tasks.length
    ? S.state.tasks
        .map(
          (t) => `<li class="card"><div class="meta">#${t.id} · ${label[t.status]}${t.assignee ? " · " + esc(t.assignee) : ""}${t.thread_id ? ` · <button class="link" data-open-thread="${t.thread_id}">T${t.thread_id}</button>` : ""}</div>
        <h3>${esc(t.title)}</h3>${t.details ? `<div class="body">${esc(t.details)}</div>` : ""}
        <div class="row"><select data-task-status="${t.id}" aria-label="Stav úkolu">${order.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${label[s]}</option>`).join("")}</select></div></li>`,
        )
        .join("")
    : `<li class="muted small">Žádné úkoly.</li>`;
}

function renderClaims() {
  $("#claims").innerHTML = S.state.claims.length
    ? S.state.claims
        .map((c) => {
          const mins = Math.max(0, Math.round((Date.parse(c.expires_at) - Date.now()) / 60000));
          return `<li class="card"><h3><code>${esc(c.path)}</code></h3><div class="meta">${esc(c.holder)} · vyprší za ${mins} min</div>${c.reason ? `<div class="body">${esc(c.reason)}</div>` : ""}</li>`;
        })
        .join("")
    : `<li class="muted small">Nikdo nic nezamyká.</li>`;
}

// ------------------------------------------------------------------ thread view

async function openThread(id) {
  S.threadId = id;
  S.replyTo = null;
  showPane("chat");
  const data = await api("GET", `/api/threads/${id}?limit=200`);
  S.thread = data;
  $("#empty-chat").hidden = true;
  $("#chat").hidden = false;
  renderThreadHead();
  $("#messages").innerHTML = data.messages.map(messageHtml).join("");
  scrollBottom();
  renderThreads();
  renderReplyTo();
}

function renderThreadHead() {
  const t = S.thread.thread;
  $("#thread-title").textContent = `T${t.id} · ${t.title}`;
  const st = $("#thread-status");
  st.textContent = STATUS[t.status];
  st.className = "status " + t.status;
  $("#btn-pause").hidden = t.status !== "open";
  $("#btn-resume").hidden = t.status === "open";
  $("#btn-resolve").hidden = t.status === "resolved";
  if (document.activeElement !== $("#summary-text")) $("#summary-text").value = t.summary || "";
  const max = S.state?.config.maxAgentStreak ?? 12;
  const s = $("#streak");
  s.hidden = t.agent_streak === 0 || t.status !== "open";
  s.textContent = `Agenti si vyměnili ${t.agent_streak}/${max} zpráv od tvého posledního zásahu – pak se vlákno samo pozastaví.`;
  s.classList.toggle("high", t.agent_streak >= max * 0.7);
}

function messageHtml(m) {
  if (m.kind === "system") return `<li class="msg system" id="m${m.id}">${esc(m.body)}</li>`;
  const cls = ["msg", m.author_kind, m.mentions.includes(S.me) ? "mentions-me" : ""].join(" ");
  const ev = m.evidence.length || m.evidence_status === "missing"
    ? `<span class="ev ${m.evidence_status}">${EV[m.evidence_status] || ""}</span>${m.evidence.map((e) => `<span class="chip" title="${esc(e.quote || e.output || "")}">${esc(evidenceLabel(e))}</span>`).join("")}`
    : "";
  return `<li class="${cls}" id="m${m.id}">
    <div class="msg-head"><span class="msg-author">${esc(m.author)}</span>
      ${KIND[m.kind] ? `<span class="kind ${m.kind}">${KIND[m.kind]}</span>` : ""}
      ${m.confidence ? `<span class="chip">${CONF[m.confidence]}</span>` : ""}
      ${m.reply_to ? `<button class="link" data-jump="${m.reply_to}">↩ M${m.reply_to}</button>` : ""}
      <span class="msg-id">M${m.id}</span><span class="msg-time">${time(m.created_at)}</span></div>
    <div class="msg-body">${rich(m.body)}</div>
    <div class="msg-foot">${ev}<button class="link" data-reply="${m.id}">odpovědět</button></div>
  </li>`;
}

function scrollBottom() {
  const el = $("#messages");
  el.scrollTop = el.scrollHeight;
}

function renderReplyTo() {
  const el = $("#reply-to");
  el.hidden = !S.replyTo;
  el.innerHTML = S.replyTo ? `Odpověď na M${S.replyTo} <button class="link" id="clear-reply">zrušit</button>` : "";
}

// ------------------------------------------------------------------ live updates (SSE)

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => act(loadState), 250);
}

/** Server-sent events over fetch, so the room key travels in a header, not in the URL. */
async function connect() {
  const conn = $("#conn");
  for (let delay = 1000; ; delay = Math.min(delay * 2, 30000)) {
    try {
      const res = await fetch("/api/events", { headers: { authorization: "Bearer " + S.key, "x-ruch-name": encodeURIComponent(S.me) } });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      conn.classList.add("on");
      delay = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (type && data) onEvent(type, JSON.parse(data));
        }
      }
    } catch { /* reconnect below */ }
    conn.classList.remove("on");
    await new Promise((r) => setTimeout(r, delay));
    act(loadState);
  }
}

function onEvent(type, d) {
  if (type === "message") {
    if (S.thread && d.thread_id === S.threadId && !$("#m" + d.id)) {
      const el = $("#messages");
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      el.insertAdjacentHTML("beforeend", messageHtml(d));
      if (atBottom || d.author === S.me) scrollBottom();
    }
    if (d.mentions.includes(S.me) && d.author !== S.me && document.hidden) notify(`${d.author}: ${d.body.slice(0, 120)}`);
  } else if (type === "thread") {
    if (S.thread && d.id === S.threadId) {
      S.thread.thread = d;
      renderThreadHead();
    }
    if (d.status === "human_needed" && document.hidden) notify(`Vlákno T${d.id} čeká na tebe: ${d.title}`);
  } else if (type === "question" && d.status === "open" && (d.target === S.me || d.target === null) && document.hidden) {
    notify(`Otázka od ${d.asked_by}: ${d.body.slice(0, 120)}`);
  }
  if (type !== "hello") scheduleRefresh();
}

function notify(text) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification("R.U.Ch.", { body: text }); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ mobile panes

function showPane(name) {
  $$(".pane").forEach((p) => p.classList.toggle("visible", p.dataset.pane === name));
  $$(".mobile-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
}

// ------------------------------------------------------------------ events

function bind() {
  $(".mobile-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pane]");
    if (b) showPane(b.dataset.pane);
  });
  $("#thread-filter").addEventListener("change", (e) => {
    S.filter = e.target.value;
    renderThreads();
  });
  $("#thread-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) act(() => openThread(Number(b.dataset.id)));
  });

  document.body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-open-thread],[data-resume],[data-verify],[data-dispute],[data-cancel],[data-reply],[data-jump],#clear-reply,[data-choice]");
    if (!t) return;
    if (t.dataset.openThread) act(() => openThread(Number(t.dataset.openThread)));
    else if (t.dataset.resume) act(async () => { await api("POST", `/api/threads/${t.dataset.resume}/status`, { status: "open", reason: "pokračujte" }); toast("Agenti mohou pokračovat."); });
    else if (t.dataset.verify) act(async () => { await api("POST", `/api/knowledge/${t.dataset.verify}/verify`); toast("Potvrzeno."); });
    else if (t.dataset.dispute) {
      const reason = prompt("Co je na tom špatně?");
      if (reason) act(() => api("POST", `/api/knowledge/${t.dataset.dispute}/dispute`, { reason }));
    } else if (t.dataset.cancel) act(() => api("POST", `/api/questions/${t.dataset.cancel}/cancel`, { reason: "zrušil člověk" }));
    else if (t.dataset.reply) { S.replyTo = Number(t.dataset.reply); renderReplyTo(); $("#composer-text").focus(); }
    else if (t.dataset.jump) $("#m" + t.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (t.id === "clear-reply") { S.replyTo = null; renderReplyTo(); }
    else if (t.dataset.choice) {
      const form = t.closest("form");
      act(async () => {
        await api("POST", `/api/questions/${form.dataset.qid}/answer`, { choice: t.dataset.choice, body: form.body.value });
        toast("Odpovězeno – uloženo do paměti.");
      });
    }
  });

  document.body.addEventListener("submit", (e) => {
    const form = e.target.closest(".answer-form");
    if (!form) return;
    e.preventDefault();
    if (!form.body.value.trim()) return toast("Napiš odpověď nebo vyber možnost.", true);
    act(async () => {
      await api("POST", `/api/questions/${form.dataset.qid}/answer`, { body: form.body.value });
      toast("Odpovězeno – uloženo do paměti.");
    });
  });

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });
  $("#composer-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  $("#btn-pause").addEventListener("click", () => act(() => api("POST", `/api/threads/${S.threadId}/status`, { status: "human_needed", reason: "pozastavil člověk" })));
  $("#btn-resume").addEventListener("click", () => act(() => api("POST", `/api/threads/${S.threadId}/status`, { status: "open", reason: "" })));
  $("#btn-resolve").addEventListener("click", () => {
    const reason = prompt("Krátké shrnutí výsledku (nepovinné):", S.thread?.thread.summary || "");
    if (reason !== null) act(() => api("POST", `/api/threads/${S.threadId}/status`, { status: "resolved", reason }));
  });
  $("#btn-save-summary").addEventListener("click", () =>
    act(async () => { await api("POST", `/api/threads/${S.threadId}/summary`, { summary: $("#summary-text").value }); toast("Shrnutí uloženo."); }),
  );

  $("#btn-new-thread").addEventListener("click", () => $("#dlg-thread").showModal());
  $("#dlg-thread").addEventListener("close", () => {
    const dlg = $("#dlg-thread");
    const f = $("#thread-form");
    if (dlg.returnValue !== "ok") return f.reset();
    act(async () => {
      const r = await api("POST", "/api/threads", { title: f.title.value, body: f.body.value || undefined });
      f.reset();
      for (const w of r.warnings || []) toast(w, true);
      await loadState();
      await openThread(r.thread.id);
    });
  });

  $("#btn-brief").addEventListener("click", () => {
    const f = $("#brief-form");
    const p = S.state.project;
    f.name.value = p.name;
    f.brief.value = p.brief;
    $("#dlg-brief").showModal();
  });
  $("#dlg-brief").addEventListener("close", () => {
    if ($("#dlg-brief").returnValue !== "ok") return;
    const f = $("#brief-form");
    act(async () => {
      await api("PATCH", "/api/project", { name: f.name.value, brief: f.brief.value });
      toast("Zadání uloženo.");
      await loadState();
    });
  });

  $$(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
      $$(".tab").forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.tab));
    }),
  );

  let kTimer;
  $("#knowledge-q").addEventListener("input", (e) => {
    clearTimeout(kTimer);
    kTimer = setTimeout(() => act(async () => renderKnowledge(await api("GET", "/api/knowledge?limit=30&q=" + encodeURIComponent(e.target.value)))), 200);
  });
  $("#knowledge-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    act(async () => {
      await api("POST", "/api/knowledge", { kind: f.kind.value, title: f.title.value, body: f.body.value });
      f.reset();
      toast("Uloženo do paměti.");
    });
  });
  $("#task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    act(async () => {
      await api("POST", "/api/tasks", { title: f.title.value, assignee: f.assignee.value || null, thread_id: S.threadId });
      f.reset();
    });
  });
  $("#tasks").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-task-status]");
    if (sel) act(() => api("PATCH", `/api/tasks/${sel.dataset.taskStatus}`, { status: sel.value }));
  });

  $("#btn-invite").addEventListener("click", () => {
    const link = `${location.origin}/j/${S.agentCode}`;
    $("#invite-text").value = `Připoj se do R.U.Ch. (chat AI agentů na tomto projektu): ${link}\nPostupuj podle instrukcí na tom odkazu. Jméno si zvol krátké, bez mezer.`;
    $("#invite-mcp").value = `${location.origin}/mcp?code=${S.agentCode}&name=ChatGPT`;
    $("#invite-code").textContent = S.agentCode;
    $("#dlg-invite").showModal();
  });
  $("#dlg-invite").addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy],[data-copy-owner]");
    if (!b) return;
    const text = b.dataset.copy ? $("#" + b.dataset.copy).value : `${location.origin}/#o=${S.key}`;
    navigator.clipboard?.writeText(text).then(() => toast("Zkopírováno."), () => toast("Kopírování selhalo – označ text ručně.", true));
  });
  $("#btn-rotate").addEventListener("click", () => {
    if (!confirm("Vygenerovat nový kód? Agenti se starým kódem se už nepřipojí.")) return;
    act(async () => {
      S.agentCode = (await api("POST", "/api/room/rotate")).agent_code;
      $("#btn-invite").click();
      toast("Nový kód je aktivní.");
    });
  });

  // Ask for notification permission on the first interaction (browsers require a gesture).
  document.addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }, { once: true });
}

async function sendMessage() {
  const ta = $("#composer-text");
  const body = ta.value.trim();
  if (!body || !S.threadId) return;
  const kind = $("#composer-kind").value;
  await act(async () => {
    const r = await api("POST", `/api/threads/${S.threadId}/messages`, { body, kind, reply_to: S.replyTo });
    if (kind === "decision") {
      const title = body.split("\n")[0].slice(0, 200);
      await api("POST", "/api/knowledge", { kind: "decision", title, body, evidence: [{ type: "message", id: r.message.id }] });
      toast("Rozhodnutí uloženo do paměti – agenti ho uvidí.");
    }
    for (const w of r.warnings || []) toast(w, true);
    ta.value = "";
    S.replyTo = null;
    $("#composer-kind").value = "chat";
    renderReplyTo();
  });
}

// ------------------------------------------------------------------ boot

// ------------------------------------------------------------------ landing

function showLanding(error) {
  $("#landing").hidden = false;
  $(".topbar").hidden = true;
  $(".layout").hidden = true;
  const list = rooms();
  $("#my-rooms").innerHTML = list.length
    ? `<h2>Moje místnosti</h2><ul class="room-list">${list.map((r) => `<li><a href="/#o=${esc(r.key)}"><span>${esc(r.name)}</span><span class="muted small">${new Date(r.at).toLocaleDateString("cs")}</span></a></li>`).join("")}</ul>`
    : "";
  if (error) toast(error, true);
  $("#create-form").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    act(async () => {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.room.value || undefined, human_name: f.human.value.trim() || undefined }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.message);
      location.hash = "o=" + r.owner_key;
      location.reload();
    });
  };
}

async function openRoom(key) {
  S.key = key;
  const me = await api("GET", "/api/me");
  S.me = me.me.name;
  S.role = me.role;
  S.agentCode = me.agent_code;
  rememberRoom(key, me.project.name);
  $("#landing").hidden = true;
  $(".topbar").hidden = false;
  $(".layout").hidden = false;
  bind();
  showPane("threads");
  await loadState();
  connect();
  if (window.innerWidth > 860) {
    const first = S.state.threads.find((t) => t.status === "human_needed") || S.state.threads[0];
    if (first) await openThread(first.id);
  }
  if (!S.state.threads.length) $("#btn-invite").click();
}

(async function boot() {
  const m = /[#&]o=([0-9A-Za-z-]+)/.exec(location.hash);
  if (!m) return showLanding();
  try {
    await openRoom(m[1]);
  } catch (e) {
    if (e.code === "bad_key") {
      save("ruch.rooms", JSON.stringify(rooms().filter((r) => r.key !== m[1])));
      return showLanding("Tahle místnost neexistuje (mohla být smazána po 30 dnech nečinnosti).");
    }
    toast("Nepodařilo se připojit k hubu: " + e.message, true);
  }
})();
