/**
 * Regression tests for the second repair pass — the defects that only showed up
 * once the app was actually running and driven, not while reading it.
 *
 *   node test/ui-regressions.spec.mjs
 *
 * These are source-level assertions rather than a rendered-DOM harness: each one
 * pins the specific construct that caused the bug, so reintroducing it fails
 * here instead of in front of a user.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

let passed = 0;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * The fixes carry comments quoting the construct they replaced, so a naive
 * text match finds the old pattern inside the explanation of why it's gone and
 * reports a fixed bug as still present. Match against code only.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ */
/*  Client fetch: no bare res.json(), no unchecked writes             */
/* ------------------------------------------------------------------ */

const CLIENT_COMPONENTS = [
  "src/components/dashboard/ApplicationTable.tsx",
  "src/components/dashboard/ResponsesManager.tsx",
  "src/components/dashboard/ProfileWorkspace.tsx",
  "src/components/dashboard/ProfileEditor.tsx",
  "src/components/dashboard/SettingsPanel.tsx",
  "src/components/dashboard/PremiumPanel.tsx",
  "src/components/marketing/AuthForm.tsx",
];

check("no dashboard component parses a response body outside a guard", () => {
  for (const file of CLIENT_COMPONENTS) {
    const src = code(file);
    // `await res.json()` with no `.catch` is the construct that threw on an
    // HTML 502 body and skipped the setBusy(false) that followed it.
    const bare = src.match(/await\s+res\.json\(\)(?!\s*\.catch)/g) ?? [];
    assert.equal(bare.length, 0, `${file} still has ${bare.length} bare await res.json()`);
  }
});

check("the shared client helper never rejects", () => {
  const src = code("src/lib/client-api.ts");
  assert.match(src, /catch\s*\{\s*return\s*\{\s*ok:\s*false/, "fetch failure must resolve, not throw");
  assert.match(src, /res\.json\(\)\.catch\(\(\)\s*=>\s*null\)/, "a non-JSON body must not throw");
});

check("optimistic writes roll back when the request fails", () => {
  for (const file of [
    "src/components/dashboard/ApplicationTable.tsx",
    "src/components/dashboard/ResponsesManager.tsx",
  ]) {
    const src = read(file);
    assert.match(src, /const before = rows;/, `${file} must snapshot rows before an optimistic write`);
    assert.match(src, /setRows\(before\)/, `${file} must restore rows on failure`);
  }
});

/* ------------------------------------------------------------------ */
/*  Upsert endpoints returning an existing row                        */
/* ------------------------------------------------------------------ */

check("created rows replace a matching row instead of duplicating it", () => {
  for (const file of [
    "src/components/dashboard/ApplicationTable.tsx",
    "src/components/dashboard/ResponsesManager.tsx",
  ]) {
    const src = read(file);
    assert.match(
      src,
      /findIndex\(\(r\) => r\._id === row\._id\)/,
      `${file} must check for an existing _id — POST upserts, so it can return a row already on screen`
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Profile duplication                                               */
/* ------------------------------------------------------------------ */

check("POST /api/profiles seeds every profile section, not just contact details", () => {
  const src = read("src/app/api/profiles/route.ts");
  for (const key of ["experience", "education", "skills", "workAuth", "compensation", "eeo"]) {
    assert.ok(src.includes(`"${key}"`), `${key} must be seedable or "Duplicate profile" loses it`);
  }
});

check("a part-filled profile row survives a save", () => {
  const src = read("src/lib/profile-shape.ts");
  assert.match(
    src,
    /filter\(\(e\) => e\.company \|\| e\.title \|\| e\.description/,
    "an experience row with only a description must not be dropped"
  );
  assert.match(
    src,
    /filter\(\(e\) => e\.school \|\| e\.degree \|\| e\.fieldOfStudy/,
    "a part-filled education row must not be dropped"
  );
});

/* ------------------------------------------------------------------ */
/*  Timezone                                                          */
/* ------------------------------------------------------------------ */

check("activity buckets use the local calendar, not UTC", () => {
  const src = code("src/lib/utils.ts");
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0,\s*10\)/, "UTC day keys misplace evening applications");
  assert.match(src, /export function localDateKey/);
});

check("localDateKey brackets the day correctly either side of midnight", () => {
  // The TS module can't be imported here without a compiler, so assert the
  // logic instead: the key must be built from local getters, never getUTC*.
  const src = code("src/lib/utils.ts");
  const body = src.slice(src.indexOf("export function localDateKey"));
  assert.match(body, /getFullYear\(\)/);
  assert.match(body, /getMonth\(\)/);
  assert.match(body, /getDate\(\)/);
  assert.doesNotMatch(body.slice(0, 400), /getUTC/);
});

check("the greeting and today count are computed client-side", () => {
  // The Overview's markup moved into OverviewView; the page only fetches.
  const page = code("src/app/dashboard/page.tsx") + code("src/components/dashboard/OverviewView.tsx");
  assert.doesNotMatch(page, /function greeting\(\)/, "server-side greeting uses the server's clock");
  assert.match(page, /TodaySummary/);
  assert.match(read("src/components/dashboard/TodaySummary.tsx"), /"use client"/);
});

/* ------------------------------------------------------------------ */
/*  Overview: nothing may be pushed past the edge of the window        */
/* ------------------------------------------------------------------ */

// Reported with a screenshot: "Connect the extension" and "Profile strength"
// cut off at the right edge behind a horizontal scrollbar. A bare `fr` track
// is `minmax(auto, 1fr)`: it cannot shrink below the longest unbroken line in
// it, so one long company name in Recent applications widened the main column
// and pushed the right-hand cards out of the window.
check("no dashboard grid track can be widened by its content", () => {
  const files = [
    "src/components/dashboard/OverviewView.tsx",
    "src/components/dashboard/DashboardShell.tsx",
    "src/components/dashboard/ApplicationTable.tsx",
    "src/components/dashboard/ProfileEditor.tsx",
  ];
  for (const file of files) {
    const src = code(file);
    const tracks = src.match(/grid-cols-\[[^\]]+\]/g) ?? [];
    for (const t of tracks) {
      // Every flexible track is wrapped: minmax(0,1fr), never a bare 1fr/1.5fr.
      const bare = t.replace(/minmax\([^)]*\)/g, "").match(/(^|[\[_])\d*\.?\d+fr\b/);
      assert.equal(bare, null, `${file}: ${t} has a bare fr track`);
    }
  }
});

check("the dashboard content column and the Overview columns can shrink", () => {
  const shell = code("src/components/dashboard/DashboardShell.tsx");
  assert.match(shell, /min-w-0/, "the content column needs min-w-0");
  const view = code("src/components/dashboard/OverviewView.tsx");
  assert.match(view, /grid-cols-\[minmax\(0,1fr\)_minmax\(0,300px\)\]/, "main + rail tracks");
  assert.ok((view.match(/min-w-0/g) ?? []).length >= 8, "cards and rows carry min-w-0");
  assert.match(code("src/app/dashboard/layout.tsx"), /DashboardShell/);
});

check("a connected extension is not asked to pair again", () => {
  const card = code("src/components/dashboard/PairExtension.tsx");
  assert.match(card, /Extension connected/);
  assert.match(card, /Pair another browser/);
  assert.match(code("src/app/api/extension/pair/route.ts"), /extensionPairedAt/);
  assert.match(code("src/app/api/extension/bootstrap/route.ts"), /extensionSeenAt/);
});

/* ------------------------------------------------------------------ */
/*  Reloading a dashboard page                                         */
/* ------------------------------------------------------------------ */

// Reported with a screenshot: /dashboard/responses showed "Application error:
// a server-side exception has occurred" on reload.
check("a stale database connection is checked and replaced, not reused", () => {
  const db = code("src/lib/db.ts");
  assert.match(db, /mongoose\.connection\.readyState/, "the cached connection must be checked before reuse");
  assert.match(db, /command\(\{ ping: 1 \}\)/, "an idle connection is pinged");
  assert.match(db, /export async function resetDB/);
  assert.match(db, /export async function withDbRetry/);
  assert.match(code("src/lib/auth.ts"), /withDbRetry\(\(\) => User\.findById/, "the user lookup behind every page retries once");
});

check("dashboard pages send a signed-out visitor to sign in instead of throwing", () => {
  for (const page of ["page", "profile/page", "applications/page", "responses/page", "settings/page", "premium/page"]) {
    const src = code(`src/app/dashboard/${page}.tsx`);
    assert.doesNotMatch(src, /requireUser\(/, `${page} still throws a 401 from a page`);
    assert.match(src, /requirePageUser\(\)/, `${page} must use requirePageUser`);
  }
  assert.match(code("src/lib/auth.ts"), /if \(!user\) redirect\("\/auth"\)/);
});

check("a page that fails to load shows a way forward, not a dead end", () => {
  for (const file of ["src/app/dashboard/error.tsx", "src/app/error.tsx", "src/app/global-error.tsx"]) {
    const src = read(file);
    assert.match(src, /"use client"/, `${file} must be a client component`);
    assert.match(src, /ErrorPanel/, `${file} must render the recovery panel`);
  }
  const panel = code("src/components/ui/ErrorPanel.tsx");
  assert.match(panel, /router\.refresh\(\);\s*reset\(\);/, "Try again must re-run the server components");
  assert.match(panel, /AUTO_RETRY_GAP_MS/, "one automatic retry, never a loop");
  assert.match(panel, /Sign in again/);
});

check("saved passwords are never shown on the Saved answers page", () => {
  const src = code("src/components/dashboard/ResponsesManager.tsx");
  assert.match(src, /function isSecret/);
  assert.match(src, /question=\{r\.question\}/);
});

/* ------------------------------------------------------------------ */
/*  Smaller correctness fixes                                         */
/* ------------------------------------------------------------------ */

check("the resume file input resets so the same file can be picked twice", () => {
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  const uploads = src.match(/e\.target\.value = ""/g) ?? [];
  assert.ok(uploads.length >= 2, "both file inputs must clear their value before use");
});

check("the free-text start date is not bound to an <input type=\"date\">", () => {
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  assert.doesNotMatch(
    src,
    /label="Available start date" type="date"/,
    'a date input renders "Immediately" as blank'
  );
});

check("clipboard success is only claimed when the write resolved", () => {
  const src = code("src/components/dashboard/PairExtension.tsx");
  assert.doesNotMatch(src, /navigator\.clipboard\?\.writeText/, "optional chaining hid the failure");
  assert.match(src, /await navigator\.clipboard\.writeText/);
  assert.match(src, /catch\s*\{/);
});

check("a database outage is reported as 503 with a cause, not an opaque 500", () => {
  const src = read("src/lib/api.ts");
  assert.match(src, /MongooseServerSelectionError/);
  assert.match(src, /503/);
  assert.match(src, /Atlas/i, "the message should name the usual cause");
});

/* ------------------------------------------------------------------ */
/*  Footer links resolve                                              */
/* ------------------------------------------------------------------ */

check("every legal link in the footer has a page behind it", () => {
  const footer = code("src/components/marketing/Footer.tsx");
  const hrefs = [...footer.matchAll(/href:\s*"(\/[a-z-]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (href === "/") continue;
    const path = `src/app${href}/page.tsx`;
    assert.doesNotThrow(() => read(path), `${href} is linked from the footer but ${path} does not exist`);
  }
});

/* ------------------------------------------------------------------ */
/*  EEO: sexual orientation and transgender                           */
/* ------------------------------------------------------------------ */

/**
 * Applications ask both (Ashby's demographic survey, Greenhouse's and Lever's
 * voluntary surveys), and the profile had nowhere to keep either answer. The
 * editor offers them, the schema keeps them — a key missing from a Mongoose
 * sub-schema is silently dropped on save — and every choice the editor offers
 * is one the extension knows how to answer.
 */
const EEO_FIELDS = { sexualOrientation: "Sexual orientation", transgender: "Do you identify as transgender?" };

check("the profile schema keeps sexual orientation and transgender", () => {
  const src = code("src/models/Profile.ts");
  const eeo = src.slice(src.indexOf("const EeoSchema"), src.indexOf("const WorkAuthSchema"));
  for (const key of Object.keys(EEO_FIELDS)) assert.match(eeo, new RegExp(`\\b${key}:\\s*String`), `EeoSchema has no ${key}`);
});

check("the profile editor asks both in the EEO section", () => {
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  const eeo = src.slice(src.indexOf('section === "eeo"'));
  for (const [key, label] of Object.entries(EEO_FIELDS)) {
    assert.match(eeo, new RegExp(`label="${label.replace(/[?]/g, "\\?")}"[\\s\\S]{0,200}?setPath\\("eeo\\.${key}"`), `no ${label} select bound to eeo.${key}`);
  }
});

// Every choice the editor offers is one the extension answers.
{
  const vm = await import("node:vm");
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("extension/lib/field-map.js"), sandbox, { filename: "field-map.js" });
  const rules = sandbox.window.APPLI_FILL_FIELD_MAP ?? [];
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  for (const key of Object.keys(EEO_FIELDS)) {
    check(`  ${key}: the rule reads the profile and knows every option`, () => {
      const rule = rules.find((r) => r.key === key);
      assert.ok(rule, `no ${key} rule in field-map.js`);
      const m = src.match(new RegExp(`setPath\\("eeo\\.${key}", v\\)\\}\\s*options=\\{\\[([^\\]]+)\\]`));
      assert.ok(m, `no options list for eeo.${key}`);
      const offered = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      for (const choice of offered) {
        assert.equal(rule.value({ eeo: { [key]: choice } }), choice, `${key} does not read "${choice}" from the profile`);
        assert.ok(Array.isArray(rule.options?.[choice]), `${key} has no synonyms for "${choice}"`);
      }
      assert.equal(rule.value({ eeo: { declineToSelfIdentify: true } }), "I don't wish to answer", `${key} ignores decline-to-self-identify`);
    });
  }
}

console.log(`\n${passed} checks passed`);
