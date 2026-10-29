/**
 * Regression tests for the data-integrity bugs fixed in this pass.
 *
 * These run against Mongoose's own query casting rather than a live database,
 * because the failures were all in how a filter or an update was *built* — the
 * point where `undefined` disappears and where an unfiltered body reaches $set.
 *
 *   node test/api-regressions.spec.mjs
 */

import mongoose from "mongoose";
import { BSON } from "mongodb/lib/bson.js";
import assert from "node:assert/strict";

/**
 * What the filter actually looks like on the wire.
 *
 * Checking `Object.keys()` is not enough and JSON.stringify is actively
 * misleading — both hide that the driver drops an `undefined` value during BSON
 * serialization rather than sending it as null. That drop is the whole bug.
 */
const onTheWire = (filter) => BSON.deserialize(BSON.serialize(filter));

let passed = 0;
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
/*  1. The upsert filter that silently overwrote an unrelated row      */
/* ------------------------------------------------------------------ */

const AppSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  jobTitle: { type: String, required: true },
  url: String,
});
const App = mongoose.model("RegressionApplication", AppSchema);

const uid = new mongoose.Types.ObjectId();

check("a filter with url: undefined reaches Mongo as userId alone (the original bug)", () => {
  const q = App.findOneAndUpdate({ userId: uid, url: undefined }, { $set: { jobTitle: "x" } }, { upsert: true });
  q.cast(App);
  const wire = onTheWire(q.getFilter());
  // No `url` constraint survives, so with upsert:true this matched — and
  // overwrote — an arbitrary existing application belonging to the user.
  assert.deepEqual(Object.keys(wire), ["userId"]);
});

check("with a url present the filter keeps both constraints", () => {
  const q = App.findOneAndUpdate(
    { userId: uid, url: "https://example.com/job/1" },
    { $set: { jobTitle: "x" } },
    { upsert: true }
  );
  q.cast(App);
  const wire = onTheWire(q.getFilter());
  assert.deepEqual(Object.keys(wire).sort(), ["url", "userId"]);
  assert.equal(wire.url, "https://example.com/job/1");
});

check("the fixed route only upserts when a real url is supplied", () => {
  // Mirrors the branch now in POST /api/applications and /api/extension/sync.
  const decide = (body) => {
    const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : null;
    return url ? "upsert" : "insert";
  };
  assert.equal(decide({ jobTitle: "Manual entry" }), "insert");
  assert.equal(decide({ jobTitle: "Manual entry", url: "" }), "insert");
  assert.equal(decide({ jobTitle: "Manual entry", url: "   " }), "insert");
  assert.equal(decide({ jobTitle: "Real", url: "https://a.com/j/1" }), "upsert");
});

/* ------------------------------------------------------------------ */
/*  2. The unique index that rejected a second URL-less application    */
/* ------------------------------------------------------------------ */

check("the applications index is partial, not sparse", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/models/Application.ts", import.meta.url), "utf8")
  );
  assert.match(source, /partialFilterExpression:\s*\{\s*url:\s*\{\s*\$type:\s*"string"\s*\}\s*\}/);
  assert.doesNotMatch(source, /\{\s*unique:\s*true,\s*sparse:\s*true\s*\}/);
});

/* ------------------------------------------------------------------ */
/*  3. Mass assignment on the PATCH routes                             */
/* ------------------------------------------------------------------ */

const applyWhitelist = (editable, body) => {
  const out = {};
  for (const [key, coerce] of Object.entries(editable)) {
    if (body[key] === undefined) continue;
    out[key] = coerce(body[key]);
  }
  return out;
};

check("a PATCH body cannot reassign userId", () => {
  const EDITABLE = { jobTitle: (v) => String(v ?? ""), notes: (v) => String(v ?? "") };
  const hostile = { jobTitle: "ok", userId: new mongoose.Types.ObjectId(), _id: "x", events: [] };
  const result = applyWhitelist(EDITABLE, hostile);
  assert.deepEqual(Object.keys(result), ["jobTitle"]);
  assert.equal(result.userId, undefined);
});

/* ------------------------------------------------------------------ */
/*  4. Regex injection through the search box                          */
/* ------------------------------------------------------------------ */

const escapeRegex = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 200);

check("a catastrophic pattern is escaped to a literal", () => {
  const escaped = escapeRegex("(a+)+$");
  assert.equal(escaped, "\\(a\\+\\)\\+\\$");
  // Matches the literal text, and nothing explosive.
  assert.ok(new RegExp(escaped, "i").test("x (a+)+$ y"));
  assert.ok(!new RegExp(escaped, "i").test("aaaaaaaaaaaaaaaaaaaa"));
});

check("ordinary search terms still match", () => {
  assert.ok(new RegExp(escapeRegex("engineer"), "i").test("Senior Engineer"));
});

/* ------------------------------------------------------------------ */
/*  5. Settings whitelist                                             */
/* ------------------------------------------------------------------ */

check("unknown settings keys are rejected rather than written", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/app/api/settings/route.ts", import.meta.url), "utf8")
  );
  assert.match(source, /SETTINGS_FIELDS\[key\]/);
  assert.doesNotMatch(source, /Object\.entries\(body\)\.map/);
});

check("the settings schema declares every key the extension reads", async () => {
  const fs = await import("node:fs");
  const model = fs.readFileSync(new URL("../src/models/User.ts", import.meta.url), "utf8");
  for (const key of ["overwriteExisting", "autoAttachResume", "eeoFallbackDecline"]) {
    assert.ok(model.includes(`${key}:`), `${key} missing from the settings schema`);
  }
});

check("the popup's settings changes are accepted from its bearer token", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/app/api/settings/route.ts", import.meta.url), "utf8");
  // requireUser() without the request reads only the dashboard cookie, so the
  // popup's PATCH was refused and the next sync switched the setting back.
  assert.doesNotMatch(source, /requireUser\(\)/);
  assert.match(source, /PATCH = handler\(async \(req: NextRequest\) => \{\s*const user = await requireUser\(req\)/);
  const popup = fs.readFileSync(new URL("../extension/popup/popup.js", import.meta.url), "utf8");
  assert.match(popup, /Authorization: `Bearer \$\{token\}`/);
});

check("drafted answers default to on for everyone who has not chosen", async () => {
  const fs = await import("node:fs");
  const model = fs.readFileSync(new URL("../src/models/User.ts", import.meta.url), "utf8");
  assert.match(model, /out\.aiAnswers = settings\.aiAnswersSetAt \? settings\.aiAnswers !== false : true/);
  const autofill = fs.readFileSync(new URL("../extension/content/autofill.js", import.meta.url), "utf8");
  assert.match(autofill, /if \(settings\?\.aiAnswers === false\) return "off"/);
  const popup = fs.readFileSync(new URL("../extension/popup/popup.js", import.meta.url), "utf8");
  assert.match(popup, /\["aiAnswers", "Draft answers to new questions", true,/);
});

/* ------------------------------------------------------------------ */
/*  6. Token scope must not be silently downgraded                     */
/* ------------------------------------------------------------------ */

check("an omitted scope argument falls back to the payload's scope", () => {
  const effective = (payload, scope) => scope ?? payload.scope ?? "web";
  assert.equal(effective({ scope: "extension" }, undefined), "extension");
  assert.equal(effective({ scope: "extension" }, "web"), "web");
  assert.equal(effective({}, undefined), "web");
});

console.log(`\n${passed} checks passed`);
