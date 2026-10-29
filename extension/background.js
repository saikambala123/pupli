/**
 * APPLI_FILL BACKGROUND SERVICE WORKER
 * --------------------------------
 * Owns the bearer token and the cached session. Content scripts never talk to
 * the API directly — they ask the worker, which keeps credentials out of pages
 * and lets one fetch serve every tab.
 */

/**
 * The deployment this extension talks to.
 *
 * This used to default to http://localhost:3000, which meant a published build
 * pointed every fresh install at a server on the user's own machine: pairing
 * failed with "Can't reach Appli-Fill" until they found the API field in the popup
 * and retyped the URL. `npm run ext:build` rewrites this line from
 * NEXT_PUBLIC_APP_URL, and the popup can still override it for local dev.
 */
const DEFAULT_API = "https://zapply.vercel.app"; /* build:api-base */
// Short, because this is how long a settings change in the dashboard takes to
// reach the extension. Anything longer and toggles look broken.
const CACHE_TTL_MS = 60 * 1000;
// Beyond this we block on the network rather than serve a stale profile.
const STALE_MAX_MS = 30 * 60 * 1000;
// Floor between background refreshes triggered by tab activity.
const REFRESH_THROTTLE_MS = 60 * 1000;
let refreshing = null;
let lastRefreshAt = 0;

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  remove: (keys) => new Promise((r) => chrome.storage.local.remove(keys, r)),
};

async function apiBase() {
  const { apiBase } = await store.get("apiBase");
  return (apiBase || DEFAULT_API).replace(/\/+$/, "");
}

async function authHeaders() {
  const { token } = await store.get("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const base = await apiBase();
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...(options.headers ?? {}),
  };

  // Never let a dead network connection leave the popup/content script waiting
  // forever. Serverless deployments can occasionally stall before returning a
  // response; the extension should fail fast and keep the form usable.
  // A caller that knows its request is slower by nature (a page of drafted
  // answers) says so with `timeoutMs`; it is not passed on to fetch.
  const { timeoutMs = 15_000, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}${path}`, { ...init, headers, signal: init.signal ?? controller.signal });
    const json = await res.json().catch(() => ({}));

    if (res.status === 401) {
      await store.remove(["token", "session", "sessionAt"]);
      setBadge("!", "#E5484D");
      return { ok: false, error: "Your Appli-Fill session expired. Pair again from the dashboard." };
    }
    if (!res.ok) return { ok: false, error: json.error || `Request failed (${res.status})` };
    return { ok: true, data: json.data };
  } catch (err) {
    const message = err?.name === "AbortError"
      ? "Appli-Fill took too long to respond. Check your connection and try again."
      : "Can't reach Appli-Fill. Check your connection and try again.";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/*  Session cache                                                      */
/* ------------------------------------------------------------------ */

/** Bootstrap payload, cached so a burst of tabs costs one request. */
async function getSession({ force = false } = {}) {
  const { session, sessionAt, token } = await store.get(["session", "sessionAt", "token"]);
  if (!token) return null;

  const age = sessionAt ? Date.now() - sessionAt : Infinity;

  if (session && age < CACHE_TTL_MS && !force) return session;

  // Stale-while-revalidate: an autofill shouldn't wait on the network, but the
  // cache also shouldn't go stale for minutes. Serve what we have and refresh
  // behind it, so the next fill uses current settings and saved answers.
  if (session && age < STALE_MAX_MS && !force) {
    refreshSession();
    return session;
  }

  const res = await api("/api/extension/bootstrap");
  if (!res.ok) return session ?? null;

  const active =
    res.data.profiles.find((p) => p._id === res.data.activeProfileId) ??
    res.data.profiles.find((p) => p.isDefault) ??
    res.data.profiles[0] ??
    null;

  const next = {
    user: res.data.user,
    premium: res.data.user?.premium ?? false,
    settings: res.data.settings ?? {},
    profiles: res.data.profiles ?? [],
    profile: active,
    responses: res.data.responses ?? [],
    syncedAt: res.data.syncedAt,
  };

  await store.set({ session: next, sessionAt: Date.now() });
  setBadge(next.profile ? "" : "!", next.profile ? "#00858A" : "#FFB020");
  return next;
}

/** Background refresh, deduped so ten tabs don't trigger ten fetches. */
function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = getSession({ force: true })
    .catch(() => null)
    .finally(() => { refreshing = null; lastRefreshAt = Date.now(); });
  return refreshing;
}

/**
 * Refresh triggered by browsing activity rather than by a user action.
 *
 * `tabs.onActivated` fires on every tab switch, and it called the unthrottled
 * refresh — so a normal session of flicking between tabs fired a bootstrap
 * request each time, hammering the API for a payload that changes rarely.
 */
function maybeRefreshSession() {
  if (refreshing) return;
  if (Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  refreshSession();
}

/**
 * The badge is the only thing that tells the applicant an answer is waiting.
 *
 * It counts both buckets: answers held after an edit and answers already queued
 * for sync. Without it, held answers sat in storage with nothing anywhere on
 * screen to say so — the applicant had to think to open the popup.
 */
async function refreshBadge() {
  try {
    const { heldAnswers, pendingResponses } = await store.get(["heldAnswers", "pendingResponses"]);
    const total = (heldAnswers?.length ?? 0) + (pendingResponses?.length ?? 0);
    setBadge(total ? String(Math.min(99, total)) : "", (heldAnswers?.length ?? 0) ? "#FFB020" : "#C94D0B");
  } catch {}
}

function setBadge(text, color = "#C94D0B") {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

/**
 * The key two phrasings of the same question share.
 *
 * Deliberately identical to normalizeQuestion() on the server, so an answer that
 * will *replace* a saved one is queued once here and lands on that same record
 * when it syncs, rather than arriving as a second, competing entry.
 */
/**
 * Upload whatever is waiting locally, and clear it only if the server took it.
 *
 * Saving an answer moved it from `heldAnswers` into `pendingResponses` and
 * stopped there, so it sat in the browser until the applicant happened to press
 * "Sync now" — which is why an answer saved on one application was not there to
 * be reused on the next one. Both the Save path and the Sync button run this.
 */
async function pushQueue() {
  const { pendingResponses, token } = await store.get(["pendingResponses", "token"]);
  const responses = pendingResponses ?? [];
  if (!token) return { ok: false, error: "Pair the extension from your dashboard first.", pushed: 0 };
  if (!responses.length) return { ok: true, data: { responsesSaved: 0 }, pushed: 0 };

  const res = await api("/api/extension/sync", {
    method: "POST",
    body: JSON.stringify({ responses }),
  });

  if (res.ok) {
    // Remove only keys the server explicitly confirmed. Previously every 200
    // response cleared the local queue, including a perfectly valid HTTP 200
    // with responsesSaved=0 when the question was rejected by validation. That
    // made the answer disappear from Pending while never reaching Saved Answers.
    const reported = Array.isArray(res.data?.savedKeys) ? res.data.savedKeys : null;
    const { pendingResponses: now } = await store.get("pendingResponses");
    let remaining;
    if (reported) {
      const confirmed = new Set(reported);
      remaining = (now ?? []).filter((r) => !confirmed.has(queueKey(r.question)));
    } else if ((res.data?.responsesSaved ?? 0) >= responses.length) {
      /**
       * A server that does not say *which* answers it wrote.
       *
       * Requiring `savedKeys` is right when the field is there — it is what
       * stops a rejected answer being dropped. But an older deployment omits it
       * entirely, and then nothing is ever confirmed: the queue never empties,
       * the same answers are re-uploaded on every sync, and Pending never
       * clears however many times the applicant presses Sync. When the server
       * reports it wrote at least as many as were offered, take it at its word
       * for the batch that was just sent.
       */
      const uploaded = new Set(responses.map((r) => queueKey(r.question)));
      remaining = (now ?? []).filter((r) => !uploaded.has(queueKey(r.question)));
    } else {
      remaining = now ?? [];
    }
    if (remaining.length) await store.set({ pendingResponses: remaining });
    else await store.remove(["pendingResponses"]);
  }
  // The server reports what it actually wrote; the local count is only what we
  // offered it. A response with zero confirmed keys is not a successful sync.
  const confirmedCount = res.ok ? (res.data?.responsesSaved ?? 0) : 0;
  return {
    ...res,
    ok: res.ok && (confirmedCount > 0 || responses.length === 0),
    pushed: confirmedCount,
    error: res.ok && responses.length && confirmedCount === 0
      ? "Appli-Fill could not save these answers. They remain pending; review the question and try Sync again."
      : res.error,
  };
}

function queueKey(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * A dismissal identifies the answer that was turned down, not the question.
 *
 * Keyed on the question alone, "no thanks" to one bad capture silenced that
 * question for the life of the install.
 */
function dismissalKey(question, answer) {
  const q = queueKey(question);
  const a = String(answer ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  return q ? `${q}::${a}` : "";
}

/**
 * An answer read off a question's wrapper instead of its box.
 *
 * Up to 1.15.0 the field scan collected Lever's <li> wrappers as text boxes,
 * and an <li>'s `value` is its list number — so "Full name", "Current
 * location" and "Current company" were held in Pending Saved Answers with the
 * answer "0". Never held again, and cleared from storage on update.
 */
const WRAPPER_QUESTION_RE =
  /^(full\s*name|name|e-?mail|phone|current\s*location|location|current\s*company|company|org|resume(\s*\/\s*cv)?|cv|linkedin(\s*url)?|github(\s*url)?|portfolio(\s*url)?|twitter(\s*url)?|other\s*website|website)\b/i;

function isWrapperJunk(r) {
  return String(r?.answer ?? "").trim() === "0" && WRAPPER_QUESTION_RE.test(String(r?.question ?? "").trim());
}

/** Dismissals lapse, so a rejected answer can never mute a question for good. */
const DISMISSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalises the stored shape and drops anything expired.
 *
 * Older builds stored a bare array of question keys. Those are discarded rather
 * than migrated: they are precisely the permanent blocks that stopped answers
 * being captured, so an upgrade should clear them.
 */
function pruneDismissals(stored) {
  if (!stored || Array.isArray(stored)) return {};
  const cutoff = Date.now() - DISMISSAL_TTL_MS;
  const out = {};
  for (const [key, at] of Object.entries(stored)) {
    if (typeof at === "number" && at > cutoff) out[key] = at;
  }
  return out;
}

/**
 * The session as the content script should see it: the dashboard's saved
 * answers plus anything saved in this browser that has not reached the server.
 *
 * Autofill reads `session.responses`, and that list came only from a successful
 * bootstrap fetch. So an answer saved while offline — or while the sync request
 * was failing for any other reason — was invisible to the very next
 * application, which is the "I saved it and it still didn't fill" case. The
 * queue is merged in at read time only; it is never written back into the
 * cached session, or syncing it would upload the same answer twice.
 *
 * A local answer wins over the server's copy of the same question: it is the
 * newer of the two, being the edit that has not been uploaded yet.
 */
async function sessionForFill(session) {
  if (!session) return session;
  try {
    const { pendingResponses } = await store.get("pendingResponses");
    const queued = pendingResponses ?? [];
    if (!queued.length) return session;

    const merged = new Map(
      (session.responses ?? []).map((r) => [queueKey(r.question), r])
    );
    for (const r of queued) {
      const key = queueKey(r.question);
      if (!key || !String(r.answer ?? "").trim()) continue;
      merged.set(key, {
        ...(merged.get(key) ?? {}),
        question: r.question,
        answer: r.answer,
        inputType: r.inputType,
        options: r.options ?? [],
        // Where it was answered, so the same question from another company is
        // still recognised before the answer has been uploaded.
        ...(r.domain ? { lastDomain: r.domain } : {}),
        ...(r.company ? { lastCompany: r.company } : {}),
        normalizedKey: key,
        // Marked so nothing downstream mistakes it for a synced record.
        pendingLocal: true,
      });
    }
    return { ...session, responses: Array.from(merged.values()) };
  } catch {
    return session;
  }
}

/* ------------------------------------------------------------------ */
/*  Message router                                                     */
/* ------------------------------------------------------------------ */

// Address each content-script frame through the extension channel. Cross-origin
// iCIMS applications and nested iForms cannot receive a same-origin page relay.
const activeFillTabs = new Map();
async function fillApplicationFrames(tabId) {
  if (activeFillTabs.has(tabId)) return {ok: false, error: "Already filling."};
  const controller = {stopped: false};
  activeFillTabs.set(tabId, controller);
  try {
  const frames = await chrome.scripting.executeScript({
    target: {tabId, allFrames: true},
    func: () => ({url: location.href, visible: document.visibilityState !== "hidden"}),
  });
  const topUrl = frames.find((f) => f.frameId === 0)?.result?.url || "";
  const origin = (url) => { try { return new URL(url).origin; } catch { return ""; } };
  const candidates = frames.filter((frame) => {
    if (frame.frameId === 0) return true;
    if (!frame.result?.visible) return false;
    const url = frame.result?.url || "";
    if (origin(url) === origin(topUrl)) return true;
    try {
      return /(^|\.)(?:icims\.com|myworkdayjobs\.com|successfactors\.(?:com|eu)|sapsf\.(?:com|eu)|oraclecloud\.com)$/i.test(new URL(url).hostname) || /^about:(?:blank|srcdoc)$/.test(url);
    } catch { return false; }
  });
  const message = (frameId, type) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {type, frameDispatch: true}, {frameId}, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response || null);
    });
  });
  const results = [];
  // Menus in separate documents still share browser focus. Finish one frame
  // before touching another so a nested iForm cannot close the parent's menu.
  for (const frame of candidates) {
    if (controller.stopped) break;
    const status = await message(frame.frameId, "APPLI_FILL_STATUS");
    if (!status?.ok || (frame.frameId !== 0 && !status.isApplication)) continue;
    if (frame.frameId === 0 && !status.isApplication && candidates.length > 1) continue;
    if (controller.stopped) break;
    results.push(await message(frame.frameId, "APPLI_FILL_RUN"));
  }
  const good = results.filter((r) => r?.ok && r.data);
  if (!good.length && controller.stopped) return {ok: true, data: {filled: 0, detected: 0, unmatched: 0, keys: [], stopped: true}};
  if (!good.length) return {ok: false, error: "No application frame responded. Reload the application and try again."};
  if (good.length === 1) return {ok: true, data: {...good[0].data, stopped: controller.stopped || good[0].data.stopped}};
  const data = {...(good.find((r) => !r.data.skipped)?.data || good[0].data)};
  for (const key of ["filled", "failed", "unmatched", "detected", "drafted"]) data[key] = good.reduce((n,r) => n + Number(r.data[key] || 0), 0);
  data.keys = [...new Set(good.flatMap((r) => r.data.keys || []))];
  data.durationMs = good.reduce((n, r) => n + Number(r.data.durationMs || 0), 0);
  data.stopped = controller.stopped;
  return {ok: true, data};
  } finally { activeFillTabs.delete(tabId); }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // Older open tabs can finish their request during an extension update.
  if (typeof msg?.type === "string" && msg.type.startsWith("ZAPPLY_")) msg = { ...msg, type: msg.type.replace(/^ZAPPLY_/, "APPLI_FILL_") };
  (async () => {
    switch (msg?.type) {
      case "APPLI_FILL_FILL_TAB": {
        if (!sender?.tab?.id || (sender.frameId ?? 0) !== 0) return respond({ok: false, error: "A toolbar action is required."});
        return respond(await fillApplicationFrames(sender.tab.id));
      }
      case "APPLI_FILL_STOP": {
        const tab = sender?.tab || (await chrome.tabs.query({active: true, currentWindow: true}))[0];
        if (!tab?.id) return respond({ok: false});
        const active = activeFillTabs.get(tab.id);
        if (active) active.stopped = true;
        chrome.tabs.sendMessage(tab.id, {type: "APPLI_FILL_STOP"}, () => void chrome.runtime.lastError);
        return respond({ok: true});
      }
      /* --- pairing --- */
      case "APPLI_FILL_PAIR": {
        const base = (msg.apiBase || (await apiBase())).replace(/\/+$/, "");
        await store.set({ apiBase: base });
        try {
          const res = await fetch(`${base}/api/extension/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: msg.code }),
          });
          const json = await res.json();
          if (!res.ok) return respond({ ok: false, error: json.error });

          await store.set({ token: json.data.token, user: json.data.user });
          const session = await getSession({ force: true });
          return respond({ ok: true, data: { user: json.data.user, session } });
        } catch {
          return respond({ ok: false, error: "Couldn't reach that Appli-Fill URL." });
        }
      }

      case "APPLI_FILL_UNPAIR": {
        await store.remove(["token", "user", "session", "sessionAt", "pendingResponses", "heldAnswers", "dismissedAnswers"]);
        setBadge("");
        return respond({ ok: true });
      }

      /* --- session --- */
      case "APPLI_FILL_GET_SESSION": {
        const session = await getSession({ force: msg.force });
        if (!session) return respond({ ok: false, error: "not-connected" });
        return respond({ ok: true, data: await sessionForFill(session) });
      }

      case "APPLI_FILL_SET_PROFILE": {
        const { session } = await store.get("session");
        if (!session) return respond({ ok: false, error: "not-connected" });
        const profile = session.profiles.find((p) => p._id === msg.profileId);
        if (profile) {
          session.profile = profile;
          await store.set({ session });
        }
        return respond({ ok: true, data: session });
      }

      /* --- pending saved answers: local until the user clicks Sync now --- */
      /**
       * --- held answers: edited on a page, not yet saved ---
       *
       * These used to live in a plain Map inside the content script. A Workday
       * application navigates on every step, and each navigation tears the
       * content script down and takes the Map with it — so by the time the
       * applicant opened the popup there was nothing left to offer them, which
       * is why saving an answer appeared to do nothing at all.
       *
       * They live here now, in the same storage as the sync queue, and survive
       * navigation, reload and closing the tab. Nothing is uploaded from here:
       * saving moves an answer into `pendingResponses`, which is still only
       * sent on an explicit Sync.
       */
      case "APPLI_FILL_HOLD_ANSWERS": {
        const { heldAnswers, dismissedAnswers } = await store.get(["heldAnswers", "dismissedAnswers"]);
        /**
         * A dismissal turns down *that answer*, not the question forever.
         *
         * Discarding used to record the question's key alone, and capture then
         * skipped that key from then on with no expiry. Pressing Clear once
         * therefore blacklisted every question in the list permanently: the
         * applicant answered the same question properly on the next
         * application, nothing was captured, nothing reached Saved Answers, and
         * from the outside the whole feature had simply stopped working. It was
         * unrecoverable without unpairing, because nothing in the UI mentions
         * this list.
         *
         * A dismissal is now keyed by question *and* answer, so the rejected
         * value stays rejected while a different answer to the same question is
         * captured normally. Entries also expire, so a stale "no" cannot silence
         * a question indefinitely.
         */
        const dismissed = pruneDismissals(dismissedAnswers);
        const merged = new Map((heldAnswers ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of (msg.items ?? [])) {
          if (!r?.question || !String(r.answer ?? "").trim()) continue;
          if (isWrapperJunk(r)) continue;
          const key = queueKey(r.question);
          if (!key) continue;
          /**
           * A dismissal stops the same capture bouncing back — not a new edit.
           *
           * Every capture used to be checked against the dismissal list with no
           * regard to *when* it happened, so an applicant who had once cleared
           * "No" for a question and later deliberately chose "No" again on
           * another application saw nothing appear in Pending. That was one of
           * the ways a manual edit "didn't show". An edit the content script
           * stamps as made after the dismissal is a fresh decision: it is held,
           * and the dismissal it supersedes is lifted.
           */
          const dKey = dismissalKey(r.question, r.answer);
          const dismissedAt = dismissed[dKey];
          if (dismissedAt) {
            const editedAt = Number(r.editedAt) || 0;
            if (!(editedAt > dismissedAt)) continue;
            delete dismissed[dKey];
          }
          merged.set(key, { ...r, heldAt: Date.now() });
        }
        const held = Array.from(merged.values()).slice(-200);
        await store.set({ heldAnswers: held, dismissedAnswers: dismissed });
        await refreshBadge();
        return respond({ ok: true, held: held.length });
      }

      case "APPLI_FILL_GET_HELD": {
        const { heldAnswers } = await store.get("heldAnswers");
        return respond({ ok: true, data: { held: heldAnswers ?? [] } });
      }

      /**
       * Edit a pending answer in place — from the popup.
       *
       * The pending list could only be saved or discarded, so a capture with
       * the wrong wording, or an answer the applicant wanted to change before
       * saving, had to be discarded and re-answered on a live application. The
       * answer (and, if given, the question) of one entry is replaced here, in
       * whichever bucket it sits — held for review or queued for sync.
       *
       *   { type, question, answer, newQuestion? }
       */
      case "APPLI_FILL_EDIT_PENDING": {
        const question = String(msg.question ?? "").trim();
        const answer = String(msg.answer ?? "").trim();
        const newQuestion = String(msg.newQuestion ?? "").trim() || question;
        if (!question || !answer) return respond({ ok: false, error: "A question and an answer are both needed." });
        if (newQuestion.length < 5 || !queueKey(newQuestion)) {
          return respond({ ok: false, error: "The question is too short to be matched on another application." });
        }

        const { heldAnswers, pendingResponses } = await store.get(["heldAnswers", "pendingResponses"]);
        const target = queueKey(question);
        const nextKey = queueKey(newQuestion);
        let found = false;

        const edit = (list, stamp) => {
          const out = [];
          for (const r of list ?? []) {
            if (queueKey(r.question) === target && !found) {
              found = true;
              out.push({ ...r, question: newQuestion, answer, editedAt: Date.now(), [stamp]: Date.now(), source: "user" });
            } else if (queueKey(r.question) !== nextKey || nextKey === target) {
              out.push(r);
            }
          }
          return out;
        };

        const held = edit(heldAnswers, "heldAt");
        const wasHeld = found;
        const queued = found ? (pendingResponses ?? []) : edit(pendingResponses, "queuedAt");
        if (!found) return respond({ ok: false, error: "That answer is no longer pending." });

        await store.set({ heldAnswers: held, pendingResponses: queued });

        // An answer already saved locally is uploaded again with the correction,
        // so the dashboard never keeps the version the applicant just fixed.
        let synced = null;
        if (!wasHeld) {
          const pushed = await pushQueue();
          synced = pushed.ok;
          if (pushed.ok) await getSession({ force: true });
        }
        await refreshBadge();
        return respond({ ok: true, held: wasHeld, synced });
      }

      /**
       * An answer typed straight into the popup.
       *
       * Held like any captured edit, so it is reviewed and saved the same way,
       * and reaches the dashboard's Saved Answers on Save.
       */
      case "APPLI_FILL_ADD_PENDING": {
        const question = String(msg.question ?? "").trim();
        const answer = String(msg.answer ?? "").trim();
        if (question.length < 5 || !queueKey(question)) {
          return respond({ ok: false, error: "Type the question as it appears on the application." });
        }
        if (!answer) return respond({ ok: false, error: "Type the answer to save." });
        const { heldAnswers } = await store.get("heldAnswers");
        const merged = new Map((heldAnswers ?? []).map((r) => [queueKey(r.question), r]));
        merged.set(queueKey(question), {
          question, answer, inputType: msg.inputType || "text", options: [],
          source: "user", editedAt: Date.now(), heldAt: Date.now(), manual: true,
        });
        await store.set({ heldAnswers: Array.from(merged.values()).slice(-200) });
        await refreshBadge();
        return respond({ ok: true });
      }

      /** Move held answers into the sync queue. `questions` omitted = all. */
      case "APPLI_FILL_SAVE_HELD": {
        const { heldAnswers, pendingResponses } = await store.get(["heldAnswers", "pendingResponses"]);
        const wanted = msg.questions?.length
          ? new Set(msg.questions.map((q) => queueKey(q)))
          : null;
        const held = heldAnswers ?? [];
        const moving = held.filter((r) => !wanted || wanted.has(queueKey(r.question)));
        const keeping = held.filter((r) => wanted && !wanted.has(queueKey(r.question)));

        const merged = new Map((pendingResponses ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of moving) merged.set(queueKey(r.question), { ...r, queuedAt: Date.now() });

        // Saving an answer withdraws any earlier rejection of it.
        const { dismissedAnswers: previouslyDismissed } = await store.get("dismissedAnswers");
        const stillDismissed = pruneDismissals(previouslyDismissed);
        moving.forEach((r) => { delete stillDismissed[dismissalKey(r.question, r.answer)]; });

        await store.set({
          heldAnswers: keeping,
          pendingResponses: Array.from(merged.values()).slice(-500),
          dismissedAnswers: stillDismissed,
        });

        /**
         * Save means saved.
         *
         * Moving the answer into the local queue and stopping there is why
         * pressing Save appeared to do nothing: the answer never reached the
         * dashboard, so it was not in Saved Answers to be reused, and the next
         * application filled without it. The upload runs here, and the session
         * is re-read straight afterwards so the answer is available to the very
         * next fill in this browser without another round trip.
         *
         * A failure is not an error the applicant has to act on — the answer
         * stays in the queue and the Sync button retries it.
         */
        const pushed = await pushQueue();
        if (pushed.ok) await getSession({ force: true });
        await refreshBadge();

        return respond({
          ok: true,
          saved: moving.length,
          synced: pushed.ok,
          uploaded: pushed.pushed ?? 0,
          error: pushed.ok ? undefined : pushed.error,
        });
      }

      case "APPLI_FILL_DISCARD_HELD": {
        const { heldAnswers, dismissedAnswers } = await store.get(["heldAnswers", "dismissedAnswers"]);
        const held = heldAnswers ?? [];
        const wanted = msg.questions?.length ? new Set(msg.questions.map((q) => queueKey(q))) : null;
        const dropping = wanted ? held.filter((r) => wanted.has(queueKey(r.question))) : held;
        const keeping = wanted ? held.filter((r) => !wanted.has(queueKey(r.question))) : [];

        // Only the answer being dropped is remembered as unwanted. Recording
        // the bare question here is what silenced it on every later
        // application, including when the applicant answered it correctly.
        const dismissed = pruneDismissals(dismissedAnswers);
        const now = Date.now();
        // An answer the applicant undid on the page (by putting Appli-Fill's
        // answer back) was withdrawn, not rejected: nothing to remember.
        if (!msg.withdrawn) {
          dropping.forEach((r) => {
            const k = dismissalKey(r.question, r.answer);
            if (k) dismissed[k] = now;
          });
        }

        const trimmed = Object.fromEntries(
          Object.entries(dismissed).sort((a, b) => b[1] - a[1]).slice(0, 500)
        );

        await store.set({ heldAnswers: keeping, dismissedAnswers: trimmed });
        await refreshBadge();
        return respond({ ok: true, dismissed: Object.keys(trimmed).length });
      }

      case "APPLI_FILL_QUEUE_RESPONSES": {
        const { pendingResponses } = await store.get("pendingResponses");
        // Merged on the same normalisation the server uses, so re-answering one
        // question replaces its queued entry instead of adding a near-duplicate
        // that differs only by an asterisk or stray punctuation.
        const merged = new Map((pendingResponses ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of (msg.responses ?? [])) {
          if (!r?.question || !String(r.answer ?? "").trim()) continue;
          const key = queueKey(r.question);
          if (!key) continue;
          merged.set(key, { ...r, queuedAt: Date.now() });
        }
        await store.set({ pendingResponses: Array.from(merged.values()).slice(-500) });
        await refreshBadge();
        return respond({ ok: true, pending: merged.size });
      }

      case "APPLI_FILL_GET_PENDING": {
        const { pendingResponses } = await store.get("pendingResponses");
        return respond({ ok: true, data: { responses: pendingResponses ?? [] } });
      }

      /**
       * Discard the local queue without uploading it.
       *
       * The queue fills up with whatever was typed into a form, which includes
       * typos and answers that only ever made sense for one posting. Until now
       * the only way out of it was to sync — pushing all of that into the
       * dashboard's Saved Answers, where it would be reused on the next
       * application. This drops the queue and touches nothing on the server:
       * answers already saved in the dashboard are unaffected.
       */
      /**
       * Drop one queued answer, leaving the rest of the queue alone.
       *
       * Clear was all-or-nothing, so a single bad answer meant discarding
       * everything else waiting with it. Matched on the same normalisation the
       * queue is keyed by, so the entry removed is the one shown.
       */
      case "APPLI_FILL_DELETE_PENDING": {
        const { pendingResponses } = await store.get("pendingResponses");
        const queue = pendingResponses ?? [];
        const target = queueKey(msg.question);
        const kept = queue.filter((r) => queueKey(r.question) !== target);
        await store.set({ pendingResponses: kept });
        const { session } = await store.get("session");
        setBadge(
          kept.length ? String(Math.min(99, kept.length)) : (session?.profile ? "" : "!"),
          kept.length ? "#FFB020" : (session?.profile ? "#00858A" : "#FFB020")
        );
        return respond({ ok: true, data: { removed: queue.length - kept.length, pending: kept.length } });
      }

      case "APPLI_FILL_CLEAR_PENDING": {
        const { pendingResponses, heldAnswers } = await store.get(["pendingResponses", "heldAnswers"]);
        /**
         * Clear means clear.
         *
         * This only removed `pendingResponses`. Held answers were added later
         * and live in their own key, so they survived every Clear and were
         * counted and listed again the moment the popup reopened — the same
         * answers coming back "again and again" however many times Clear was
         * confirmed.
         */
        const cleared = (pendingResponses?.length ?? 0) + (heldAnswers?.length ?? 0);
        /**
         * Clear empties the list. It does not mute the questions.
         *
         * Each cleared *answer* is remembered so the identical capture cannot
         * bounce straight back, but the question stays open: answer it again,
         * or differently, and the new answer is captured normally. The previous
         * version recorded the bare question with no expiry, so one Clear
         * stopped those questions ever being captured again — and since the
         * list filled itself with untouched fields, Clear was the obvious thing
         * to press. That combination is what made saving answers look
         * permanently broken.
         */
        const { dismissedAnswers } = await store.get("dismissedAnswers");
        const dismissed = pruneDismissals(dismissedAnswers);
        const now = Date.now();
        (heldAnswers ?? []).forEach((r) => {
          const k = dismissalKey(r.question, r.answer);
          if (k) dismissed[k] = now;
        });
        const trimmed = Object.fromEntries(
          Object.entries(dismissed).sort((a, b) => b[1] - a[1]).slice(0, 500)
        );
        await store.remove(["pendingResponses", "heldAnswers"]);
        await store.set({ dismissedAnswers: trimmed });
        await refreshBadge();
        return respond({ ok: true, data: { cleared } });
      }

      /**
       * Sync now is two-way, and the pull half is the half that matters most:
       * answers the user typed into the dashboard's Saved Answers tab only
       * reach the extension through a bootstrap fetch. The old version returned
       * early whenever the local queue happened to be empty, so a user who had
       * only *added* answers in the dashboard pressed Sync now and pulled
       * nothing. The refresh now always runs.
       */
      case "APPLI_FILL_SYNC_PENDING": {
        const pushed = await pushQueue();

        const session = await getSession({ force: true });
        const pulled = session?.responses?.length ?? 0;

        if (pushed.ok && session) await refreshBadge();
        else setBadge("!", "#E5484D");

        if (!pushed.ok) return respond({ ok: false, error: pushed.error });
        if (!session) return respond({ ok: false, error: "Couldn't reach Appli-Fill to load your saved answers." });

        return respond({
          ok: true,
          data: {
            // What the server confirmed it wrote, not what we handed it.
            responsesSaved: pushed.pushed ?? 0,
            savedAnswers: pulled,
            syncedAt: session.syncedAt ?? new Date().toISOString(),
          },
        });
      }

      /* --- application tracking sync (never receives saved-response auto flushes) --- */
      case "APPLI_FILL_SYNC": {
        const payload = { ...(msg.payload ?? {}), responses: [] };
        const res = await api("/api/extension/sync", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (res.ok && msg.payload?.application) {
          const { stats } = await store.get("stats");
          const next = { ...(stats ?? { applications: 0 }) };
          next.applications = (next.applications ?? 0) + 1;
          await store.set({ stats: next });
        }
        return respond(res);
      }

      /* --- premium: profile scoring --- */
      case "APPLI_FILL_SCORE": {
        return respond(await api("/api/ai/score", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- premium: generated answer --- */
      case "APPLI_FILL_ANSWER": {
        return respond(await api("/api/ai/answer", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- every open question on the page, answered in one call --- */
      case "APPLI_FILL_ANSWER_BATCH": {
        return respond(await api("/api/ai/answer", {
          method: "POST",
          body: JSON.stringify(msg.payload),
          // The route answers within ~20s and returns whatever it has by then.
          timeoutMs: 28_000,
        }));
      }

      /* --- duplicate detection --- */
      case "APPLI_FILL_CHECK": {
        return respond(await api("/api/extension/check", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- the packaged default, so the popup doesn't hardcode localhost --- */
      case "APPLI_FILL_GET_API_BASE": {
        return respond({ ok: true, data: { apiBase: await apiBase(), packagedDefault: DEFAULT_API } });
      }

      case "APPLI_FILL_OPEN_DASHBOARD": {
        chrome.tabs.create({ url: `${await apiBase()}/dashboard` });
        return respond({ ok: true });
      }

      default:
        return respond({ ok: false, error: "Unknown message." });
    }
  })();

  return true; // keep the channel open for the async work above
});

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { apiBase: existing } = await store.get("apiBase");
  if (!existing) await store.set({ apiBase: DEFAULT_API });

  if (reason === "install") {
    chrome.tabs.create({ url: `${await apiBase()}/auth?mode=signup` });
    setBadge("1", "#FFB020");
  }

  // Answers an older build read off Lever's question wrappers ("Full name: 0").
  if (reason === "update") {
    try {
      const { heldAnswers } = await store.get("heldAnswers");
      const kept = (heldAnswers ?? []).filter((r) => !isWrapperJunk(r));
      if (kept.length !== (heldAnswers ?? []).length) {
        await store.set({ heldAnswers: kept });
        await refreshBadge();
      }
    } catch {}
  }
});

chrome.runtime.onStartup.addListener(() => getSession({ force: true }));

// Returning from the dashboard to a job page should pick up whatever changed —
// but at most once a minute, not on every tab switch.
chrome.tabs.onActivated.addListener(() => maybeRefreshSession());

/** Keyboard shortcut — fill the active tab on demand. */
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "run-autofill") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "APPLI_FILL_RUN" });
});
