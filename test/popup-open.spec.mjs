/**
 * The popup opening: no flash, no sideways jump, and a welcome on first connect.
 *
 *   node test/popup-open.spec.mjs
 *
 * Reported with two screen recordings (1 October 2026):
 *
 *   - Opening the popup on an application flashed "Connect your account" —
 *     the page's default view — before the paired view replaced it, each view
 *     fading in: the popup "blinks like an error" on every open.
 *   - Opening Fill settings made the popup taller than the 600px a popup may
 *     be; the window grew a scrollbar, the browser widened the window to make
 *     room for it, and a popup anchored to its icon grows leftwards — so it
 *     moved left, and back right when the settings closed.
 *
 * And asked for: "Welcome to Appli-Fill Autofill", animated, for three seconds
 * after the first connection — only then — before the popup as usual.
 *
 * The popup is rendered against an in-memory extension API whose worker takes
 * a moment to answer, as a sleeping service worker does.
 */

import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const POPUP = pathToFileURL(join(EXT, "popup/popup.html")).href;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

// Real scrollbars, as a popup window has — headless hides them by default.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
  ignoreDefaultArgs: ["--hide-scrollbars"],
});

const SESSION = {
  premium: true,
  profile: { _id: "p1", label: "Default profile" },
  profiles: [{ _id: "p1", label: "Default profile" }],
  responses: Array.from({ length: 10 }, (_, i) => ({ question: `Question ${i}`, answer: "Yes" })),
  settings: { showOverlay: true, trackAutomatically: true, reuseSavedResponses: true },
};

/**
 * The fake extension API. `state` lives on the Node side of each context, so a
 * second page in the same context is "the popup opened again".
 */
function installApi({ paired, workerDelay }) {
  return ({ paired, workerDelay, session }) => {
    const store = window.__store = JSON.parse(localStorage.getItem("__fakeStore") || "null") ||
      { apiBase: "https://applifill.test", stats: { applications: 4 }, heldAnswers: [], pendingResponses: [] };
    if (paired && !store.token) store.token = "t0k";
    const persist = () => { try { localStorage.setItem("__fakeStore", JSON.stringify(store)); } catch {} };
    window.__sent = [];
    window.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          window.__sent.push(msg?.type);
          let reply = { ok: true, data: {} };
          let wait = 0;
          switch (msg?.type) {
            case "APPLI_FILL_GET_SESSION":
              wait = workerDelay;
              reply = store.token ? { ok: true, data: session } : { ok: false, error: "not-connected" };
              setTimeout(() => { window.__answeredAt = window.__answeredAt ?? Math.round(performance.now()); }, wait);
              break;
            case "APPLI_FILL_PAIR":
              wait = 150;
              store.token = "t0k"; persist();
              reply = { ok: true, data: { user: { email: "p@example.com" }, session } };
              break;
            case "APPLI_FILL_UNPAIR":
              delete store.token; persist();
              break;
            case "APPLI_FILL_GET_PENDING": reply = { ok: true, data: { responses: [] } }; break;
            case "APPLI_FILL_GET_HELD": reply = { ok: true, data: { held: [] } }; break;
            case "APPLI_FILL_GET_API_BASE": reply = { ok: true, data: { apiBase: "https://applifill.test" } }; break;
            default: break;
          }
          setTimeout(() => cb && cb(reply), wait);
        },
      },
      storage: {
        local: {
          get(keys, cb) {
            const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
            const out = {};
            list.forEach((k) => { if (k in store) out[k] = store[k]; });
            setTimeout(() => cb && cb(out), 5);
          },
          set(obj, cb) { Object.assign(store, obj); persist(); cb && cb(); },
          remove(keys, cb) { [].concat(keys).forEach((k) => delete store[k]); persist(); cb && cb(); },
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        query() { return Promise.resolve([{ id: 1, url: "https://seic.wd1.myworkdayjobs.com/job/apply" }]); },
        sendMessage(_id, _m, cb) { cb && cb({ ok: true, isApplication: true, ats: "Workday" }); },
        create() {},
      },
    };

    // What each frame shows, from the first one.
    window.__frames = [];
    const sample = () => {
      const body = document.body;
      if (body) {
        const shown = (id) => {
          const el = document.getElementById(id);
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        };
        const visible = getComputedStyle(body).visibility !== "hidden" &&
          !document.documentElement.classList.contains("is-booting");
        window.__frames.push({
          t: Math.round(performance.now()), visible,
          pair: visible && shown("view-pair"), main: visible && shown("view-main"),
          welcome: visible && shown("welcome"),
        });
      }
      if (performance.now() < 5000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  };
}

async function openPopup(context, { paired, workerDelay = 260 }) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(installApi({ paired, workerDelay }), { paired, workerDelay, session: SESSION });
  await page.goto(POPUP);
  return page;
}

const frames = (page) => page.evaluate(() => window.__frames);

/* ------------------------------------------------------------------ */
console.log("\nopening the popup, connected, for the first time");
{
  const context = await browser.newContext({ viewport: { width: 384, height: 600 } });
  let page = await openPopup(context, { paired: true });
  await page.waitForTimeout(900);
  let f = await frames(page);
  check("\"Connect your account\" is never shown to a connected browser", !f.some((x) => x.pair), JSON.stringify(f.filter((x) => x.pair).slice(0, 3)));
  check("  nothing is shown until the right view is known", f.filter((x) => x.visible).every((x) => x.main),
    JSON.stringify(f.slice(0, 6)));
  check("  then the paired view", f.at(-1)?.main === true, JSON.stringify(f.at(-1)));
  const anim = await page.evaluate(() => getComputedStyle(document.getElementById("view-main")).animationName);
  check("  with no fade on the way in", anim === "none", `animation: ${anim}`);
  await page.close();

  console.log("\nopening it again");
  page = await openPopup(context, { paired: true });
  await page.waitForTimeout(900);
  f = await frames(page);
  const answeredAt = await page.evaluate(() => window.__answeredAt);
  const shown = f.filter((x) => x.visible);
  check("the paired view is drawn at once, without waiting for the worker", shown[0]?.main === true && shown[0].t < answeredAt,
    JSON.stringify({ first: shown[0], answeredAt }));
  check("  and every frame after it is the same view — no flash, no swap",
    shown.every((x) => x.main && !x.pair) && f.findIndex((x) => x.visible) === f.length - shown.length,
    JSON.stringify(f.slice(0, 4)));
  const drawn = await page.evaluate(() => ({
    badge: !document.getElementById("plan-badge").hidden,
    profile: document.getElementById("profile-select").selectedOptions[0]?.textContent,
    answers: document.getElementById("stat-answers").textContent,
  }));
  check("  already showing the plan, the profile and the saved answers",
    drawn.badge && drawn.profile === "Default profile" && drawn.answers === "10", JSON.stringify(drawn));
  await page.close();
  await context.close();
}

/* ------------------------------------------------------------------ */
console.log("\nopening the popup, not connected");
{
  const context = await browser.newContext({ viewport: { width: 384, height: 600 } });
  const page = await openPopup(context, { paired: false });
  await page.waitForTimeout(900);
  const f = await frames(page);
  check("the paired view is never shown", !f.some((x) => x.main), JSON.stringify(f.filter((x) => x.main).slice(0, 3)));
  check("  \"Connect your account\" once the worker has answered", f.at(-1)?.pair === true, JSON.stringify(f.at(-1)));
  await page.close();
  await context.close();
}

/* ------------------------------------------------------------------ */
console.log("\nopening Fill settings");
{
  const context = await browser.newContext({ viewport: { width: 400, height: 600 } });
  const page = await openPopup(context, { paired: true, workerDelay: 0 });
  await page.waitForTimeout(600);
  const measure = () => page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    body: Math.round(document.body.getBoundingClientRect().width),
    content: Math.round(document.getElementById("view-main").getBoundingClientRect().width),
    left: Math.round(document.getElementById("view-main").getBoundingClientRect().left),
    pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    bodyHeight: Math.round(document.body.getBoundingClientRect().height),
    bodyScrolls: document.body.scrollHeight > document.body.clientHeight,
  }));
  const closed = await measure();
  await page.click("#settings-panel summary");
  await page.waitForTimeout(250);
  const open = await measure();
  await page.click("#settings-panel summary");
  await page.waitForTimeout(250);
  const closedAgain = await measure();
  check("the popup is no wider with the settings open", open.body === closed.body && open.viewport === closed.viewport,
    JSON.stringify({ closed, open }));
  check("  and its contents do not move sideways", open.content === closed.content && open.left === closed.left,
    JSON.stringify({ closed, open }));
  check("  the popup itself never scrolls, the settings scroll inside it", !open.pageScrolls && open.bodyHeight <= 600 && open.bodyScrolls,
    JSON.stringify(open));
  check("  closed again, it is as it was", JSON.stringify(closedAgain) === JSON.stringify(closed), JSON.stringify({ closed, closedAgain }));
  await page.close();
  await context.close();
}

/* ------------------------------------------------------------------ */
console.log("\nconnecting for the first time");
{
  const context = await browser.newContext({ viewport: { width: 384, height: 600 } });
  const page = await openPopup(context, { paired: false, workerDelay: 50 });
  await page.waitForTimeout(400);
  await page.fill("#code", "ABC123");
  await page.click("#pair-btn");
  await page.waitForTimeout(700);
  let w = await page.evaluate(() => {
    const el = document.getElementById("welcome");
    return { shown: !el.hidden && getComputedStyle(el).display !== "none", text: el.innerText.replace(/\s+/g, " ").trim() };
  });
  check("\"Welcome to Appli-Fill Autofill\" is shown", w.shown && /Welcome to Appli-Fill Autofill/.test(w.text), JSON.stringify(w));
  const covers = await page.evaluate(() => {
    const r = document.getElementById("welcome").getBoundingClientRect();
    return r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
  });
  check("  over the whole popup", covers);
  const moving = await page.evaluate(() =>
    document.getAnimations().filter((a) => a.effect?.target?.closest?.("#welcome")).length);
  check("  animated", moving >= 3, `${moving} animations`);
  await page.waitForTimeout(1300);
  w = await page.evaluate(() => !document.getElementById("welcome").hidden);
  check("  still there two seconds in", w === true);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    welcome: !document.getElementById("welcome").hidden,
    main: !document.getElementById("view-main").hidden,
  }));
  check("gone after three seconds, leaving the popup as usual", !after.welcome && after.main, JSON.stringify(after));

  // Disconnect and connect again: no second welcome.
  await page.click("#unpair-btn");
  await page.waitForTimeout(300);
  await page.fill("#code", "XYZ789");
  await page.click("#pair-btn");
  await page.waitForTimeout(600);
  const again = await page.evaluate(() => ({
    welcome: !document.getElementById("welcome").hidden,
    main: !document.getElementById("view-main").hidden,
  }));
  check("connecting again later shows the popup straight away, without the welcome", !again.welcome && again.main, JSON.stringify(again));
  await page.close();

  const reopened = await openPopup(context, { paired: true });
  await reopened.waitForTimeout(700);
  const f = await frames(reopened);
  check("an ordinary open never shows it", !f.some((x) => x.welcome), JSON.stringify(f.filter((x) => x.welcome).slice(0, 2)));
  await reopened.close();
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
