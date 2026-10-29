/**
 * Where the engine looks for the application.
 *
 *   node test/scope.spec.mjs
 *
 * The reported bug: "profile saved data is not at all using in some
 * applications". The cause was scoping. An adapter's `formSelector` won
 * outright — whatever it matched became the entire search area, and the rest of
 * the page was consulted only when it matched nothing at all.
 *
 * Most modern career portals render the application outside any <form> while
 * the page still contains one for site search, a newsletter box or a login
 * widget. The scan locked onto that form, found a single search input, and the
 * profile went completely unused. Not "partly filled" — zero fields.
 *
 * These cases pin both halves of the fix: widen when the matched form clearly
 * isn't the application, and stay scoped when it is.
 */

import { chromium } from "playwright";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const TMP = join(ROOT, "test/fixtures/_scope.html");

const PROFILE = {
  _id: "p1",
  label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar",
    email: "madhu.ittech@gmail.com", phone: "+1 630 555 0142",
    city: "Stanley", state: "North Carolina", zip: "28164", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No" },
  eeo: {},
  experience: [], education: [], documents: [],
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});

/** Loads a page, runs one fill, and reports what was scanned and written. */
async function fill(html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));

  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          const reply =
            msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } :
            msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } :
            { ok: true, data: {} };
          setTimeout(() => cb && cb(reply), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile: PROFILE });

  await writeFile(TMP, html);
  await page.goto(pathToFileURL(TMP).href);

  for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
  }

  const out = await page.evaluate(async () => {
    const adapter = window.APPLI_FILL_ATS.detect();
    const scanned = window.__applifill.collectFields(adapter).map((f) => f.el.id || f.el.name || f.el.tagName);
    const res = await window.__applifill.run({ manual: true });
    const value = (id) => document.getElementById(id)?.value ?? null;
    return {
      scanned,
      filled: res?.data?.filled ?? 0,
      unmatched: res?.data?.unmatched ?? 0,
      values: {
        fn: value("fn"), ln: value("ln"), em: value("em"), ph: value("ph"),
        q: value("q"), nl: value("nl"), user: value("user"),
      },
    };
  });

  await page.close();
  return out;
}

/* ------------------------------------------------------------------ */
/*  1. The reported bug: application outside a form, search box in one  */
/* ------------------------------------------------------------------ */
{
  const out = await fill(`<!doctype html><html><body>
    <header>
      <form role="search" action="/search"><input id="q" type="text" name="q" placeholder="Search jobs" /></form>
    </header>
    <main>
      <h1>Apply for Senior Engineer</h1>
      <div id="app-root">
        <label>First Name <input id="fn" type="text" name="firstName" /></label>
        <label>Last Name <input id="ln" type="text" name="lastName" /></label>
        <label>Email <input id="em" type="email" name="email" /></label>
        <label>Phone <input id="ph" type="tel" name="phone" /></label>
        <input type="file" id="cv" />
      </div>
    </main>
  </body></html>`);

  check("a form-less application is scanned at all", out.scanned.length >= 4, `scanned: ${out.scanned.join(", ") || "nothing"}`);
  check("first name is filled from the profile", out.values.fn === "Madhu", `got "${out.values.fn}"`);
  check("last name is filled from the profile", out.values.ln === "Kumar", `got "${out.values.ln}"`);
  check("email is filled from the profile", out.values.em === "madhu.ittech@gmail.com", `got "${out.values.em}"`);
  check("phone is filled from the profile", out.values.ph === "+1 630 555 0142", `got "${out.values.ph}"`);
  check("the site's search box is left alone", out.values.q === "", `got "${out.values.q}"`);
  check("the search box is not counted as a field needing the user", !out.scanned.includes("q"), `scanned: ${out.scanned.join(", ")}`);
}

/* ------------------------------------------------------------------ */
/*  2. Page furniture is skipped even when the scan widens             */
/* ------------------------------------------------------------------ */
{
  const out = await fill(`<!doctype html><html><body>
    <form id="newsletter-signup"><input id="nl" type="email" name="newsletter_email" placeholder="Subscribe" /></form>
    <form id="login-form"><input id="user" type="text" name="username" /></form>
    <section>
      <label>First Name <input id="fn" type="text" name="firstName" /></label>
      <label>Last Name <input id="ln" type="text" name="lastName" /></label>
      <label>Email Address <input id="em" type="email" name="email" /></label>
      <label>Mobile Phone <input id="ph" type="tel" name="phone" /></label>
    </section>
  </body></html>`);

  check("the application beside a newsletter box is filled", out.values.fn === "Madhu" && out.values.em === "madhu.ittech@gmail.com", JSON.stringify(out.values));
  check("the newsletter box is not filled with the applicant's email", !out.values.nl, `got "${out.values.nl}"`);
  check("the login box is not filled", !out.values.user, `got "${out.values.user}"`);
}

/* ------------------------------------------------------------------ */
/*  3. A real application form still scopes the scan to itself         */
/* ------------------------------------------------------------------ */
{
  const out = await fill(`<!doctype html><html><body>
    <form id="application_form">
      <label>First Name <input id="fn" type="text" name="firstName" /></label>
      <label>Last Name <input id="ln" type="text" name="lastName" /></label>
      <label>Email <input id="em" type="email" name="email" /></label>
      <label>Phone <input id="ph" type="tel" name="phone" /></label>
      <label>City <input id="city" type="text" name="city" /></label>
    </form>
    <aside>
      <label>Unrelated marketing question <input id="aside1" type="text" name="marketing_pref" /></label>
    </aside>
  </body></html>`);

  check("a genuine application form is still filled", out.values.fn === "Madhu" && out.values.ph === "+1 630 555 0142", JSON.stringify(out.values));
  check(
    "the scan stays inside the application form",
    !out.scanned.includes("aside1") && !out.scanned.includes("marketing_pref"),
    `scanned: ${out.scanned.join(", ")}`
  );
}

await rm(TMP, { force: true });
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
