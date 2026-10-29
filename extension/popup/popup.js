/** Appli-Fill popup: pairing, one-click fill, quick settings. */

const $ = (id) => document.getElementById(id);

const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (res) => resolve(res ?? { ok: false })));

/**
 * [key, label, defaultsOn, description]
 *
 * The two that default to off write something the applicant did not state —
 * an overwrite of an answer already in the form, or a "decline to
 * self-identify" on a voluntary question — so each is a deliberate, opt-in
 * choice. Drafted answers default to on and are highlighted for review.
 *
 * The description matters as much as the label. Several of these change what is
 * submitted on a real application and the label alone did not say how: "Replace
 * answers already in the form" reads harmless until it has overwritten a value
 * the portal filled in correctly from an existing candidate record.
 */
const TOGGLES = [
  ["showOverlay", "Show the status pill", true,
    "A small marker on the page while Appli-Fill is filling."],
  ["trackAutomatically", "Track applications", true,
    "Log the role and company to your dashboard when you submit."],
  ["reuseSavedResponses", "Reuse saved answers", true,
    "Replay answers you have given before onto the same questions."],
  // On by default, as it is in the dashboard: the questions the profile and
  // saved answers leave open are answered from them in one quick request, and
  // every drafted answer is highlighted for review before submitting.
  ["aiAnswers", "Draft answers to new questions", true,
    "Premium. Answers from your profile and saved answers only, and never identity, EEO or record questions. Drafts are highlighted — read them before you submit."],
  ["overwriteExisting", "Replace answers already in the form", false,
    "Off, a value already in a box is left alone — including one the portal prefilled."],
  ["eeoFallbackDecline", "Decline unanswered EEO questions", false,
    "Answers voluntary self-identification with “prefer not to say” when your profile has no value."],
  // There is deliberately no "attach my resume" switch. The upload box is left
  // empty on every application: choosing which résumé to send is the
  // applicant's, and the fill never opens or drives a file upload.
];

let session = null;

/* ------------------------------------------------------------------ */
/*  Opening without a flash                                            */
/* ------------------------------------------------------------------ */

/**
 * The popup opens on the right view, already drawn.
 *
 * It used to open on "Connect your account" — the page's default — and swap to
 * the paired view once the background worker answered, then grow as the page
 * status and pending answers arrived, each step with a fade: the flash and
 * jump on every open. Nothing is shown now until the view is known. The last
 * view is remembered in the popup's own storage, which can be read before the
 * first paint — only what the view needs to draw itself (plan, profile names,
 * settings, a count), never profile details — and is then confirmed from the
 * extension's storage and the worker.
 */
const VIEW_CACHE = "applifill.popup.view";

/** What the main view draws, and nothing else. */
function viewOf(s) {
  if (!s) return null;
  return {
    premium: Boolean(s.premium),
    profile: s.profile ? { _id: s.profile._id, label: s.profile.label } : null,
    profiles: (s.profiles ?? []).map((p) => ({ _id: p._id, label: p.label })),
    settings: s.settings ?? {},
    savedCount: s.responses?.length ?? s.savedCount ?? 0,
  };
}
const sameView = (a, b) => JSON.stringify(viewOf(a)) === JSON.stringify(viewOf(b));

function readViewCache() {
  try { return JSON.parse(localStorage.getItem(VIEW_CACHE) || localStorage.getItem("zapply.popup.view") || "null"); } catch { return null; }
}
function rememberView(value) {
  try { localStorage.setItem(VIEW_CACHE, JSON.stringify(value)); } catch {}
}

/** Drawn from the cache until the real session arrives. */
let bootView = null;
/** Saved answers on the dashboard, from the session or, until it arrives, the cache. */
const savedCount = () => session?.responses?.length ?? bootView?.savedCount ?? 0;

let revealed = false;
function reveal() {
  if (revealed) return;
  revealed = true;
  document.documentElement.classList.remove("is-booting");
}
// Whatever happens below, the popup is never left blank.
setTimeout(reveal, 1200);

/* ------------------------------------------------------------------ */
/*  Pairing view                                                       */
/* ------------------------------------------------------------------ */

function showPairView() {
  $("view-pair").hidden = false;
  $("view-main").hidden = true;
  rememberView({ paired: false });
  // Ask the worker for the packaged default rather than assuming localhost —
  // a released build points at the deployed app, not the user's own machine.
  chrome.storage.local.get("apiBase", ({ apiBase }) => {
    if (apiBase) { $("apiBase").value = apiBase; return; }
    send({ type: "APPLI_FILL_GET_API_BASE" }).then((res) => {
      $("apiBase").value = res?.data?.apiBase || "http://localhost:3000";
    });
  });
}

$("code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  $("pair-error").hidden = true;
});

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("pair-btn").click();
});

$("pair-btn").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (code.length !== 6) {
    $("pair-error").textContent = "Enter all six characters from your dashboard.";
    $("pair-error").hidden = false;
    return;
  }

  $("pair-btn").disabled = true;
  $("pair-btn").textContent = "Connecting…";

  const res = await send({ type: "APPLI_FILL_PAIR", code, apiBase: $("apiBase").value.trim() });

  $("pair-btn").disabled = false;
  $("pair-btn").textContent = "Connect";

  if (!res.ok) {
    $("pair-error").textContent = res.error || "That code didn't work.";
    $("pair-error").hidden = false;
    return;
  }

  session = res.data.session;
  // The first connection on this browser is greeted — once, over the main
  // view as it draws underneath.
  if (!welcomed) {
    welcomed = true;
    try { chrome.storage.local.set({ applifillWelcomed: true }); } catch {}
    showWelcome();
  }
  renderMain();
});

/* ------------------------------------------------------------------ */
/*  Welcome, on the first connection                                   */
/* ------------------------------------------------------------------ */

/** Has this browser been greeted? Unknown counts as yes until storage says. */
let welcomed = true;
try {
  chrome.storage.local.get(["applifillWelcomed", "zapplyWelcomed"], (r) => { welcomed = Boolean(r?.applifillWelcomed ?? r?.zapplyWelcomed); });
} catch {}

/**
 * "Welcome to Appli-Fill Autofill", for three seconds, then the popup as it is
 * every other time. A click lets it go early.
 */
function showWelcome() {
  const el = $("welcome");
  if (!el) return Promise.resolve();
  el.classList.remove("is-leaving");
  el.hidden = false;
  return new Promise((resolve) => {
    let gone = false;
    const leave = () => {
      if (gone) return;
      gone = true;
      el.classList.add("is-leaving");
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove("is-leaving");
        resolve();
      }, 300);
    };
    setTimeout(leave, 3000);
    el.addEventListener("click", leave, { once: true });
  });
}

$("open-dashboard").addEventListener("click", () => send({ type: "APPLI_FILL_OPEN_DASHBOARD" }));
$("open-dashboard-2").addEventListener("click", () => send({ type: "APPLI_FILL_OPEN_DASHBOARD" }));

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

function renderMain() {
  $("view-pair").hidden = true;
  $("view-main").hidden = false;

  // The session once it is here; until then, the view remembered from last time.
  const view = session ? viewOf(session) : bootView;
  if (session) rememberView({ paired: true, view });

  $("plan-badge").hidden = !view?.premium;

  // Profiles
  const select = $("profile-select");
  select.innerHTML = "";
  (view?.profiles ?? []).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p._id;
    opt.textContent = p.label || "Profile";
    opt.selected = p._id === view.profile?._id;
    select.appendChild(opt);
  });
  select.disabled = (view?.profiles?.length ?? 0) < 2;

  // Stats
  refreshPending();
  chrome.storage.local.get("stats", ({ stats }) => {
    $("stat-apps").textContent = stats?.applications ?? 0;
  });

  // Toggles
  const wrap = $("toggles");
  wrap.innerHTML = "";
  TOGGLES.forEach(([key, label, defaultsOn, description]) => {
    const row = document.createElement("label");
    row.className = "toggle";
    const labelEl = document.createElement("span");
    labelEl.className = "toggle__text";
    labelEl.append(label);
    if (description) {
      const note = document.createElement("small");
      note.textContent = description;
      labelEl.appendChild(note);
    }
    row.appendChild(labelEl);
    // Render the modern switch markup:
    //   <span class="switch"><input type="checkbox"><span class="switch__slider"></span></span>
    const switchEl = document.createElement("span");
    switchEl.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    const stored = view?.settings?.[key];
    input.checked = stored === undefined ? Boolean(defaultsOn) : stored === true;
    input.id = `toggle-${key}`;
    input.addEventListener("change", () => saveSetting(key, input.checked));
    const slider = document.createElement("span");
    slider.className = "switch__slider";
    switchEl.appendChild(input);
    switchEl.appendChild(slider);
    row.appendChild(switchEl);
    wrap.appendChild(row);
  });

  refreshPageStatus();
  loadAccountCreds();
}

/* ------------------------------------------------------------------ */
/*  Workday account sign-in / create-account                           */
/* ------------------------------------------------------------------ */

/*
 * Passwords are intentionally NOT entered or stored from this popup. The
 * content script resolves the Saved Answers entry named "Password". This
 * toggle controls only whether a saved password is submitted automatically.
 * Remove the legacy local password key once so an older build cannot continue
 * to act as a fallback.
 */
function loadAccountCreds() {
  chrome.storage.local.get(["applifillAutoSubmitAccount", "zapplyAutoSubmitAccount"], (r) => {
    $("account-autosubmit").checked = (r.applifillAutoSubmitAccount ?? r.zapplyAutoSubmitAccount) !== false;
  });
}

$("account-autosubmit").addEventListener("change", () => {
  chrome.storage.local.set({ applifillAutoSubmitAccount: $("account-autosubmit").checked });
  try { chrome.storage.local.remove(["applifillAccountPassword", "zapplyAccountPassword"]); } catch {}
});
try { chrome.storage.local.remove(["applifillAccountPassword", "zapplyAccountPassword"]); } catch {}


/* ------------------------------------------------------------------ */
/*  Saved answers waiting to sync                                      */
/* ------------------------------------------------------------------ */

/**
 * Answers captured on a form live in a local queue until the user presses
 * "Sync now". Showing the count alone left no way to deal with a queue full of
 * typos or answers meant for one application only, so the count carries a Clear
 * button that empties the queue without uploading it.
 */
/**
 * Answers the applicant edited on the page but has not saved yet.
 *
 * These used to be announced by a bar floating over the application itself,
 * which asked for a decision about a question they were often still in the
 * middle of answering. They are listed here instead, next to the saved answers
 * they would join, where the decision can be made once and with the full list
 * in view.
 */
async function heldAnswers() {
  // Read from extension storage, not from the page. Asking the tab meant the
  // list was empty whenever the content script had not loaded there or had been
  // torn down by a step navigation — which on a Workday application is most of
  // the time, and is why edited answers never appeared here.
  const res = await send({ type: "APPLI_FILL_GET_HELD" });
  return res?.data?.held ?? [];
}

/**
 * Whether the pending list is open.
 *
 * `null` means "decide automatically": open whenever there are manual edits to
 * review. The list used to start collapsed every time the popup opened and
 * every time it was refreshed, so an applicant who had just corrected answers
 * on the page saw a one-line count and nothing else — the edits looked like
 * they had not been captured at all.
 */
let pendingExpanded = null;
/** An inline editor or the add form is open; live refreshes wait for it. */
let editingPending = false;
let refreshQueued = false;

function setPendingOpen(open) {
  $("pending-list").hidden = !open;
  $("view-pending").textContent = open ? "Hide" : "View";
  $("view-pending").setAttribute("aria-expanded", String(open));
}

async function heldCommand(type, question) {
  const questions = question ? [question] : undefined;
  const saving = type === "APPLI_FILL_PENDING_SAVE";
  const res = await send({
    type: saving ? "APPLI_FILL_SAVE_HELD" : "APPLI_FILL_DISCARD_HELD",
    questions,
  });

  /**
   * Saving now uploads, so the session it lands in has to be re-read here.
   * Without this the saved-answer count on screen stayed at its old value and
   * the answer looked like it had gone nowhere — which, before the upload was
   * added, it had.
   */
  if (saving) {
    const refreshed = await send({ type: "APPLI_FILL_GET_SESSION", force: true });
    if (refreshed.ok) session = refreshed.data;
    if (res?.ok && res.synced === false) {
      setStatus(
        "warn",
        "Saved here, not yet on your dashboard",
        res.error || "It's queued — press Sync now when you're back online."
      );
    } else if (res?.ok) {
      const total = session?.responses?.length ?? 0;
      setStatus("ready", "Answer saved", `${total} saved answer${total === 1 ? "" : "s"} ready to reuse.`);
    }
    $("stat-answers").textContent = String(session?.responses?.length ?? 0);
  }
  // Clear the on-page outline too, when there is a page to clear it on.
  try {
    const tab = await activeTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type, question }, () => void chrome.runtime.lastError);
  } catch {}
  // The list stays as it was — open while there is more to review.
  await refreshPending();
}

async function refreshPending() {
  const saved = savedCount();
  const res = await send({ type: "APPLI_FILL_GET_PENDING" });
  const queued = res?.data?.responses ?? [];
  const held = await heldAnswers();
  const pending = queued.length + held.length;

  // This stat is the server-backed Saved Answers count. Pending edits are not
  // saved yet and are shown separately below, so `12+5 saved answers` can
  // never imply that five unsaved/AI-generated values are already stored.
  $("stat-answers").textContent = String(saved);

  const btn = $("clear-pending");
  btn.disabled = false;
  btn.dataset.armed = "";
  btn.textContent = "Clear";
  btn.hidden = pending === 0;
  $("view-pending").hidden = pending === 0;

  // The box also hosts the "add an answer" form, so it stays while that is open.
  $("pending").hidden = pending === 0 && $("add-answer-form").hidden;

  if (!pending) {
    $("pending-note").textContent = $("add-answer-form").hidden ? "" : "Add an answer to reuse on later applications.";
    $("pending-list").innerHTML = "";
    setPendingOpen(false);
    const saveAll = $("save-all-held");
    if (saveAll) saveAll.hidden = true;
  }

  if (pending) {
    // The buttons beside it say what the actions are; a third sentence
    // explaining them only pushed the list itself off the screen.
    const parts = [];
    if (held.length) parts.push(`${held.length} manual edit${held.length === 1 ? "" : "s"} to review`);
    if (queued.length) parts.push(`${queued.length} saved locally · waiting to sync`);
    $("pending-note").textContent = parts.join(" · ");

    // One click for the common case: several answers held across the steps of
    // one application.
    const saveAll = $("save-all-held");
    if (saveAll) {
      saveAll.hidden = held.length < 2;
      saveAll.textContent = `Save all ${held.length}`;
    }
    renderPendingList(queued, held);
    setPendingOpen(pendingExpanded ?? held.length > 0);
  }
  return pending;
}

/**
 * Keep the list current while the popup is open.
 *
 * Answers are captured on the page and written to extension storage; the
 * popup read that storage once, when it opened. An answer changed while the
 * popup was open — or a moment before, while the capture was still settling —
 * therefore did not appear until the popup was closed and opened again.
 */
function scheduleLiveRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(async () => {
    refreshQueued = false;
    // Never rebuild the list under an open editor: that would throw away what
    // the applicant is typing. The refresh runs when the editor closes.
    if (editingPending || $("view-main").hidden) return;
    try { await refreshPending(); } catch {}
  }, 150);
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.heldAnswers || changes.pendingResponses) scheduleLiveRefresh();
  });
} catch {}

/** A small labelled control for the inline editors. */
function editorField(labelText, control) {
  const wrap = document.createElement("label");
  wrap.className = "pending__field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  wrap.append(caption, control);
  return wrap;
}

/**
 * The answer box for an editor: a menu of the question's own choices when the
 * capture recorded them, otherwise a text box sized to the answer.
 */
function answerControl(entry) {
  const answer = String(entry.answer ?? "");
  const options = (Array.isArray(entry.options) ? entry.options : [])
    .map((o) => String(o ?? "").trim()).filter(Boolean);
  if (options.length > 1 && options.length <= 50) {
    const select = document.createElement("select");
    select.className = "input input--sm";
    const choices = options.includes(answer) || !answer ? options : [answer, ...options];
    for (const choice of choices) {
      const opt = document.createElement("option");
      opt.value = choice;
      opt.textContent = choice;
      opt.selected = choice === answer;
      select.appendChild(opt);
    }
    return select;
  }
  const long = answer.length > 60 || /textarea/i.test(String(entry.inputType || ""));
  const box = document.createElement(long ? "textarea" : "input");
  box.className = "input input--sm";
  if (long) box.rows = 3;
  box.value = answer;
  return box;
}

/**
 * Edit one pending answer in place.
 *
 * Saving an edit keeps it: an unsaved answer is saved to the dashboard in the
 * same step, and one already waiting to sync is uploaded again with the
 * correction.
 */
function openEditor(li, entry, bucket) {
  editingPending = true;
  li.classList.add("pending__item--editing");
  li.innerHTML = "";

  const form = document.createElement("form");
  form.className = "pending__edit";

  const longQuestion = String(entry.question ?? "").length > 60;
  const question = document.createElement(longQuestion ? "textarea" : "input");
  question.className = "input input--sm";
  if (longQuestion) question.rows = 3;
  question.value = String(entry.question ?? "");
  const answer = answerControl(entry);

  const error = document.createElement("p");
  error.className = "pending__error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "pending__actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "pending__save";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pending__btn";
  cancel.textContent = "Cancel";
  actions.append(save, cancel);

  form.append(editorField("Question", question), editorField("Answer", answer), error, actions);
  li.appendChild(form);
  setTimeout(() => { try { answer.focus(); } catch {} }, 0);

  const close = async () => {
    editingPending = false;
    await refreshPending();
  };

  cancel.addEventListener("click", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextQuestion = question.value.trim();
    const nextAnswer = String(answer.value ?? "").trim();
    if (!nextAnswer) {
      error.textContent = "Type an answer, or discard this entry instead.";
      error.hidden = false;
      return;
    }
    save.disabled = true;
    save.textContent = "Saving…";
    const res = await send({
      type: "APPLI_FILL_EDIT_PENDING",
      question: entry.question,
      newQuestion: nextQuestion,
      answer: nextAnswer,
    });
    if (!res?.ok) {
      save.disabled = false;
      save.textContent = "Save";
      error.textContent = res?.error || "Couldn't update that answer.";
      error.hidden = false;
      return;
    }
    editingPending = false;
    if (bucket === "held") {
      await heldCommand("APPLI_FILL_PENDING_SAVE", nextQuestion || entry.question);
    } else {
      const refreshed = await send({ type: "APPLI_FILL_GET_SESSION", force: true });
      if (refreshed?.ok) session = refreshed.data;
      setStatus(
        res.synced === false ? "warn" : "ready",
        res.synced === false ? "Updated here, not yet on your dashboard" : "Answer updated",
        res.synced === false ? "It's queued — press Sync now when you're back online." : "Your dashboard has the corrected answer."
      );
      await refreshPending();
    }
  });
}

function editButton(li, entry, bucket) {
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "pending__edit-btn";
  edit.textContent = "Edit";
  edit.setAttribute("aria-label", `Edit the answer for ${entry.question || "this field"}`);
  edit.addEventListener("click", () => openEditor(li, entry, bucket));
  return edit;
}

/**
 * What Sync now would actually upload.
 *
 * The count alone gave no way to tell a useful answer from a typo before
 * committing it to the dashboard — and no way to tell which questions are new
 * against which will overwrite an answer already saved.
 */
/**
 * What kind of control this answer came from.
 *
 * A dropdown answer, a radio answer and a typed answer all rendered as the same
 * unlabelled line, so there was no way to tell which was which — or to notice
 * that a choice answer had been captured against the wrong question.
 */
function typeLabel(inputType) {
  switch (String(inputType || "").toLowerCase()) {
    case "select": return "dropdown";
    case "radio": return "choice";
    case "checkbox": return "checkboxes";
    case "textarea": return "long text";
    case "date": return "date";
    case "number": return "number";
    case "url": return "URL";
    case "tel": return "phone";
    case "email": return "email";
    case "month": return "month";
    case "password": return "password";
    default: return "text";
  }
}

/**
 * One row: the question, the answer, and the control they came from.
 *
 * The question line was previously the only label, and when capture picked up
 * an option label instead of the question — "Prefer not to say" above an answer
 * of "No" — nothing on screen made that visible. Question and answer are now
 * labelled separately, and the option count says how many choices the question
 * offered, so a mis-captured entry is obvious at a glance and can be discarded
 * before it reaches the dashboard.
 */
function renderEntryText(entry, { prefix = "" } = {}) {
  const question = String(entry.question || "").trim();
  const answer = String(entry.answer ?? "").trim();
  const options = Array.isArray(entry.options) ? entry.options.filter(Boolean) : [];

  const text = document.createElement("div");
  text.className = "pending__text";

  const q = document.createElement("span");
  q.className = "pending__q";
  const qLabel = document.createElement("b");
  qLabel.textContent = "Question: ";
  q.appendChild(qLabel);
  q.appendChild(document.createTextNode(question || "(question not detected)"));
  if (!question) q.classList.add("pending__q--missing");

  const kind = document.createElement("span");
  kind.className = "pending__type";
  kind.textContent = typeLabel(entry.inputType);
  q.appendChild(kind);

  const a = document.createElement("span");
  a.className = "pending__a";
  // A password is never shown in the list, only that one is held.
  const secret = String(entry.inputType || "").toLowerCase() === "password" ||
    /\b(pass\s*word|passcode)\b/i.test(question);
  const shown = secret
    ? "\u2022".repeat(Math.min(12, Math.max(8, answer.length)))
    : answer.length > 110 ? `${answer.slice(0, 110)}\u2026` : answer;
  const aLabel = document.createElement("b");
  aLabel.textContent = "Answer: ";
  a.appendChild(aLabel);
  a.appendChild(document.createTextNode(`${prefix}${shown || "(no answer)"}`));

  text.append(q, a);

  if (options.length > 1) {
    const opts = document.createElement("span");
    opts.className = "pending__opts";
    opts.textContent = `of ${options.length} options: ${options.slice(0, 4).join(" · ")}${options.length > 4 ? " \u2026" : ""}`;
    opts.title = options.join(" · ");
    text.appendChild(opts);
  }

  return { text, question };
}

function renderPendingList(queued, held = []) {
  const list = $("pending-list");
  list.innerHTML = "";

  const savedKeys = new Set(
    (session?.responses ?? []).map((r) => normalizeQuestion(r.question || ""))
  );

  // Unsaved edits come first: they are the ones still awaiting a decision.
  held.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "pending__item--held";

    const { text, question } = renderEntryText(entry);
    const tag = document.createElement("span");
    tag.className = "pending__held";
    tag.textContent = " \u00b7 unsaved";
    text.querySelector(".pending__q").appendChild(tag);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "pending__save";
    save.textContent = "Save";
    save.title = "Save this to your dashboard and reuse it on your next application";
    save.disabled = !question;
    save.addEventListener("click", () => heldCommand("APPLI_FILL_PENDING_SAVE", question));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "pending__x";
    drop.textContent = "\u00d7";
    drop.setAttribute("aria-label", `Discard unsaved answer for ${question || "this field"}`);
    drop.addEventListener("click", () => heldCommand("APPLI_FILL_PENDING_DISCARD", question));

    li.append(text, editButton(li, entry, "held"), save, drop);
    list.appendChild(li);
  });

  queued.forEach((entry) => {
    const questionText = String(entry.question || "").trim();
    const updates = savedKeys.has(normalizeQuestion(questionText));

    const li = document.createElement("li");
    const { text, question } = renderEntryText(entry, {
      prefix: updates ? "Replaces saved answer: " : "",
    });

    if (!updates) {
      const tag = document.createElement("span");
      tag.className = "pending__new";
      tag.textContent = " · new";
      text.querySelector(".pending__q").appendChild(tag);
    }

    // Removing one answer without discarding the whole queue.
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pending__x";
    x.textContent = "\u00D7";
    x.title = "Remove this answer";
    x.setAttribute("aria-label", `Remove "${question}" from the sync queue`);
    x.addEventListener("click", async () => {
      x.disabled = true;
      const res = await send({ type: "APPLI_FILL_DELETE_PENDING", question });
      if (!res.ok) {
        x.disabled = false;
        setStatus("warn", "Couldn't remove it", res.error || "Try again in a moment.");
        return;
      }
      // Removing one answer shouldn't hide the rest.
      if (pendingExpanded === null) pendingExpanded = true;
      await refreshPending();
    });

    li.append(text, editButton(li, entry, "queued"), x);
    list.appendChild(li);
  });
}

/** Mirrors the server's normalizeQuestion so "new" vs "replaces" is accurate. */
function normalizeQuestion(q) {
  return String(q)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

$("view-pending").addEventListener("click", () => {
  const open = $("pending-list").hidden;
  // The applicant's own choice now wins over the automatic default.
  pendingExpanded = open;
  setPendingOpen(open);
});

/**
 * Type an answer straight into Appli-Fill.
 *
 * For a question the applicant knows is coming — or one a form asked in a way
 * capture could not read. It is saved to the dashboard's Saved Answers at once
 * and reused wherever the same question appears.
 */
function openAddForm() {
  const form = $("add-answer-form");
  form.hidden = false;
  editingPending = true;
  $("pending").hidden = false;
  $("add-answer-error").hidden = true;
  setTimeout(() => { try { $("add-question").focus(); } catch {} }, 0);
}

function closeAddForm() {
  const form = $("add-answer-form");
  form.hidden = true;
  form.reset();
  editingPending = false;
  refreshPending();
}

$("add-answer").addEventListener("click", openAddForm);
$("add-answer-cancel").addEventListener("click", closeAddForm);
$("add-answer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("add-question").value.trim();
  const answer = $("add-answer-text").value.trim();
  const error = $("add-answer-error");
  const submit = $("add-answer-save");
  submit.disabled = true;
  submit.textContent = "Saving…";
  const res = await send({ type: "APPLI_FILL_ADD_PENDING", question, answer });
  if (!res?.ok) {
    submit.disabled = false;
    submit.textContent = "Save answer";
    error.textContent = res?.error || "Couldn't add that answer.";
    error.hidden = false;
    return;
  }
  submit.disabled = false;
  submit.textContent = "Save answer";
  $("add-answer-form").hidden = true;
  $("add-answer-form").reset();
  editingPending = false;
  // Straight to the dashboard, like pressing Save on a captured answer.
  await heldCommand("APPLI_FILL_PENDING_SAVE", question);
});

$("save-all-held").addEventListener("click", async () => {
  await heldCommand("APPLI_FILL_PENDING_SAVE");
});

$("clear-pending").addEventListener("click", async () => {
  const btn = $("clear-pending");
  // Two-step rather than a confirm() dialog: a popup loses focus when a modal
  // opens, which closes it and cancels the action.
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Sure?";
    setTimeout(() => {
      if (btn.dataset.armed !== "1") return;
      btn.dataset.armed = "";
      btn.textContent = "Clear";
    }, 3500);
    return;
  }

  btn.dataset.armed = "";
  btn.disabled = true;
  btn.textContent = "…";

  const res = await send({ type: "APPLI_FILL_CLEAR_PENDING" });
  await refreshPending();

  if (res.ok) {
    const n = res.data?.cleared ?? 0;
    setStatus("ready", "Pending answers cleared", `${n} unsynced answer${n === 1 ? "" : "s"} discarded. Your dashboard is untouched.`);
  } else {
    setStatus("warn", "Couldn't clear them", res.error || "Try again in a moment.");
  }
});

async function saveSetting(key, value) {
  // A switch flipped in the moment before the session arrived waits for it.
  if (!session) await sessionReady;
  if (!session) return;
  session.settings = { ...(session.settings ?? {}), [key]: value };
  chrome.storage.local.set({ session });
  rememberView({ paired: true, view: viewOf(session) });

  const { apiBase, token } = await new Promise((r) =>
    chrome.storage.local.get(["apiBase", "token"], r)
  );
  fetch(`${apiBase}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}

$("profile-select").addEventListener("change", async (e) => {
  const res = await send({ type: "APPLI_FILL_SET_PROFILE", profileId: e.target.value });
  if (res.ok) session = res.data;
});

/* ------------------------------------------------------------------ */
/*  Page status + fill                                                 */
/* ------------------------------------------------------------------ */

/**
 * Why the questions the profile couldn't answer are still blank. Without this
 * the applicant sees "6 fields need you" and no indication that the feature
 * built to handle exactly those exists, is switched off, or failed.
 */
function aiHint(data) {
  if (!data?.unmatched) return null;
  switch (data.aiSkipped) {
    case "off": return "turn on “Draft answers to new questions” to fill these";
    case "premium": return "AI answers need Premium";
    case "error": return data.aiError || "AI answers unavailable";
    default: return null;
  }
}

function setStatus(tone, title, body = "") {
  $("status-dot").dataset.tone = tone;
  $("status-title").textContent = title;
  $("status-body").textContent = body;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * What the last fill actually did to this page.
 *
 * Three numbers were already being computed and only one of them — a bare
 * "filled" count — reached the popup. That left the two an applicant has to act
 * on invisible: a drafted answer has to be read before it is submitted, and an
 * unmatched field has to be typed in by hand. The bar makes the proportion
 * legible at a glance; the keys name each part.
 */
function showResult(filled, drafted, todo) {
  const total = filled + drafted + todo;
  const panel = $("result");
  if (!panel) return;
  if (!total) { panel.hidden = true; return; }

  const pct = (n) => `${(n / total) * 100}%`;
  $("bar-filled").style.width = pct(filled);
  $("bar-drafted").style.width = pct(drafted);
  $("bar-todo").style.width = pct(todo);

  $("key-filled").textContent = String(filled);
  $("key-drafted").textContent = String(drafted);
  $("key-todo").textContent = String(todo);
  $("key-drafted-row").hidden = drafted === 0;
  $("key-todo-row").hidden = todo === 0;
  panel.hidden = false;
}

async function refreshPageStatus() {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) {
    setStatus("idle", "No page to fill", "Open a job application and try again.");
    $("fill-btn").disabled = true;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "APPLI_FILL_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setStatus("idle", "Appli-Fill isn't running here", "Reload the page if you just installed the extension.");
      $("fill-btn").disabled = false;
      return;
    }

    if (res.duplicate) {
      const when = new Date(res.duplicate.appliedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      setStatus(
        "warn",
        "You already applied to this",
        `Sent ${when} · currently "${res.duplicate.stage}". Fill anyway below.`
      );
      $("fill-btn").disabled = false;
      $("fill-btn").textContent = "Fill it anyway";
      return;
    }

    if (res.lastRun) {
      // Show the filled count whenever a run completed, including the perfect-fill
      // case. Previously this showed "—" when nothing was unmatched and nothing
      // drafted, so a successful fill of 20 fields looked indistinguishable from
      // "nothing happened".
      const filled = Number(res.lastRun.filled ?? 0);
      $("stat-fields").textContent = String(filled);
      showResult(filled, Number(res.lastRun.drafted ?? 0), Number(res.lastRun.unmatched ?? 0));
      const detail = [
        res.ats && `Detected: ${res.ats}`,
        res.lastRun.matchScore != null && `${res.lastRun.profileLabel} · ${res.lastRun.matchScore}% match`,
        res.lastRun.drafted && `${res.lastRun.drafted} drafted — read before submitting`,
      ]
        .filter(Boolean)
        .join(" · ");
      setStatus(
        res.lastRun.unmatched ? "warn" : "ready",
        res.lastRun.unmatched
          ? `${res.lastRun.unmatched} field${res.lastRun.unmatched === 1 ? "" : "s"} need you`
          : (res.lastRun.drafted ? "Review drafted answers" : (filled ? `${filled} field${filled === 1 ? "" : "s"} filled` : "Ready to review")),
        res.lastRun.unmatched ? detail : (res.lastRun.drafted ? detail : "Profile and saved answers applied.")
      );
    } else if (res.isApplication) {
      setStatus("ready", "Application detected", res.ats ? `Detected: ${res.ats}` : "Ready to fill.");
    } else {
      setStatus("idle", "This doesn't look like an application", "You can still fill it manually.");
    }
    $("fill-btn").disabled = false;
  });
}

$("stop-btn").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  await send({ type: "APPLI_FILL_STOP" });
  $("stop-btn").hidden = true;
  $("fill-btn").hidden = false;
  $("fill-btn").disabled = false;
  $("fill-btn").textContent = "Fill this application";
  setStatus("warn", "Autofill stopped", "No more fields will be changed until you click Fill this application again.");
});

$("fill-btn").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;

  $("fill-btn").disabled = true;
  $("fill-btn").textContent = "Filling…";
  $("stop-btn").hidden = false;
  $("stop-btn").disabled = false;

  chrome.tabs.sendMessage(tab.id, { type: "APPLI_FILL_RUN" }, (res) => {
    $("fill-btn").disabled = false;
    $("fill-btn").textContent = "Fill this application";
    $("stop-btn").hidden = true;

    if (chrome.runtime.lastError || !res?.ok) {
      setStatus("warn", "Couldn't fill this page", "Reload it and try again.");
      return;
    }
    // A sign-in or create-account step is not a failure, and saying nothing
    // makes it look like one.
    if (res.data.skipped === "signIn" || res.data.skipped === "createAccount") {
      if (res.data.autoSubmitted) {
        setStatus(
          "ready",
          res.data.skipped === "createAccount" ? "Account form submitted" : "Signed in",
          "Appli-Fill filled and submitted this step. Once the application loads, press Fill."
        );
      } else {
        setStatus(
          "warn",
          res.data.skipped === "createAccount" ? "Create your account first" : "Sign in first",
          res.data.consentNeeded
            ? "Appli-Fill filled your saved email and password. Tick the consent box, press Create Account, then press Fill."
            : res.data.keys?.includes("password")
            ? "Appli-Fill filled your saved email and password, but couldn't find the submit button. Press it yourself, then press Fill."
            : "Appli-Fill doesn't fill sign-in or account pages. Once you're through to the application, press Fill."
        );
      }
      $("fill-btn").disabled = false;
      $("fill-btn").textContent = "Fill this application";
      return;
    }

    $("stat-fields").textContent = String(res.data.filled ?? 0);
    const needsReview = Boolean(res.data.unmatched || res.data.drafted);
    const filledNum = Number(res.data.filled ?? 0);
    setStatus(
      res.data.unmatched ? "warn" : "ready",
      res.data.unmatched
        ? `${res.data.unmatched} field${res.data.unmatched === 1 ? "" : "s"} need you`
        : (res.data.drafted ? "Review drafted answers" : (filledNum ? `${filledNum} field${filledNum === 1 ? "" : "s"} filled` : "Ready to review")),
      res.data.unmatched
        ? [
            `${res.data.detected} fields checked`,
            res.data.matchScore != null && `${res.data.matchScore}% match`,
            aiHint(res.data),
          ].filter(Boolean).join(" · ")
        : (res.data.drafted ? "AI drafted answers are marked on the form." : "Profile and saved answers applied.")
    );
    refreshPending();
    if (!needsReview) setTimeout(() => window.close(), 120);
  });
});

$("sync-btn").addEventListener("click", async () => {
  $("sync-btn").disabled = true;
  $("sync-btn").textContent = "Syncing…";

  // Pushes anything captured on a form, then pulls the dashboard's Saved
  // Answers back down so the next fill can use them.
  const saved = await send({ type: "APPLI_FILL_SYNC_PENDING" });
  const res = await send({ type: "APPLI_FILL_GET_SESSION", force: true });
  if (res.ok) {
    session = res.data;
    renderMain();
  }

  $("sync-btn").disabled = false;
  $("sync-btn").textContent = saved.ok ? "Sync now" : "Sync failed — retry";
  // A successful push empties the queue, so the count and the Clear button
  // have to be re-read here — including when the session pull above failed
  // and renderMain never ran.
  await refreshPending();
  if (saved.ok) {
    const pulled = saved.data?.savedAnswers ?? session?.responses?.length ?? 0;
    const pushed = saved.data?.responsesSaved ?? 0;
    setStatus(
      "ready",
      `${pulled} saved answer${pulled === 1 ? "" : "s"} ready`,
      pushed ? `${pushed} new answer${pushed === 1 ? "" : "s"} uploaded from this browser.` : "Pulled from your dashboard."
    );
  }
});

$("unpair-btn").addEventListener("click", async () => {
  await send({ type: "APPLI_FILL_UNPAIR" });
  session = null;
  $("code").value = "";
  showPairView();
});

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

/**
 * The view remembered from the last time the popup was open is drawn at once,
 * before the first paint, so the popup opens already showing what it will
 * show. The worker then confirms it: an unchanged session leaves the page as
 * it is, a changed one redraws it in place, and a lost connection turns it
 * into the pairing view. With nothing remembered (the very first open) the
 * popup stays hidden until the worker has answered.
 */
let sessionArrived;
const sessionReady = new Promise((resolve) => { sessionArrived = resolve; });

(function drawRememberedView() {
  const cached = readViewCache();
  if (cached?.paired === true && cached.view) {
    bootView = cached.view;
    renderMain();
    reveal();
  } else if (cached?.paired === false) {
    showPairView();
    reveal();
  }
})();

(async function init() {
  const res = await send({ type: "APPLI_FILL_GET_SESSION" });
  if (res.ok && res.data?.profile) {
    const unchanged = !$("view-main").hidden && bootView && sameView(res.data, bootView);
    session = res.data;
    if (unchanged) rememberView({ paired: true, view: viewOf(session) });
    else renderMain();
    // A browser that is already connected has had its start: no welcome for
    // it later, even after a disconnect and a new code.
    if (!welcomed) {
      welcomed = true;
      try { chrome.storage.local.set({ applifillWelcomed: true }); } catch {}
    }
  } else {
    session = null;
    bootView = null;
    showPairView();
  }
  sessionArrived();
  reveal();
})();
