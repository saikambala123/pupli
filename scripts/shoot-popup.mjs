/**
 * Renders the popup in both states and writes screenshots.
 *
 *   node scripts/shoot-popup.mjs [outDir]
 *
 * The extension APIs are stubbed with a representative session so the paired
 * view shows real content rather than empty placeholders.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = process.argv[2] || join(ROOT, "screenshots");
await mkdir(OUT, { recursive: true });

const SESSION = {
  premium: true,
  profile: { _id: "p1", label: "Default profile" },
  profiles: [{ _id: "p1", label: "Default profile" }, { _id: "p2", label: "Data roles" }],
  responses: new Array(23).fill({ question: "q", answer: "a" }),
  settings: { showOverlay: true, trackAutomatically: true, reuseSavedResponses: true, aiAnswers: true },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});

async function shoot(name, { paired }) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript(({ session, paired }) => {
    const store = { apiBase: "https://applifill.app", stats: { applications: 42 }, applifillAutoSubmitAccount: true };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          const data =
            msg?.type === "APPLI_FILL_GET_SESSION" ? (paired ? session : null) :
            msg?.type === "APPLI_FILL_GET_API_BASE" ? { apiBase: "https://applifill.app" } :
            msg?.type === "APPLI_FILL_GET_PENDING" ? { responses: [] } :
            msg?.type === "APPLI_FILL_GET_HELD" ? { held: [] } : {};
          setTimeout(() => cb && cb({ ok: Boolean(paired) || msg?.type !== "APPLI_FILL_GET_SESSION", data }), 0);
        },
        onMessage: { addListener() {} },
      },
      storage: { local: {
        get(keys, cb) { cb(store); },
        set() {}, remove() {},
      } },
      tabs: {
        // The popup awaits this one, so it must return a promise.
        query() { return Promise.resolve([{ id: 1, url: "https://job-boards.greenhouse.io/northwind/jobs/4821" }]); },
        sendMessage(_id, _m, cb) {
          cb && cb({ isApplication: true, ats: "greenhouse",
            lastRun: { filled: 18, drafted: 3, unmatched: 2, profileLabel: "Default profile", matchScore: 87 } });
        },
        create() {},
      },
    };
  }, { session: SESSION, paired });

  await page.goto(pathToFileURL(join(ROOT, "extension/popup/popup.html")).href);
  await page.waitForTimeout(600);
  if (paired) await page.evaluate(() => document.getElementById("settings-panel")?.setAttribute("open", ""));
  await page.waitForTimeout(250);
  const box = await page.evaluate(() => ({ h: Math.ceil(document.body.scrollHeight) }));
  await page.setViewportSize({ width: 420, height: Math.max(360, box.h + 8) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, name), fullPage: true });
  console.log(`wrote ${join(OUT, name)}  (${box.h}px tall)`);
  await page.close();
}

await shoot("popup-pair.png", { paired: false });
await shoot("popup.png", { paired: true });
await browser.close();
