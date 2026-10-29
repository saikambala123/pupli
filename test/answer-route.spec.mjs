/**
 * The answer route's two pure decisions, tested without a database or a model:
 * which reply counts as naming a menu option, and how a question's words are
 * turned into a regular expression.
 *
 *   node test/answer-route.spec.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = await readFile(join(ROOT, "src/app/api/ai/answer/route.ts"), "utf8");
// The pure half of the route — prompt, limits, reply handling — lives here.
const LIB_SOURCE = await readFile(join(ROOT, "src/lib/answer-batch.ts"), "utf8");

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(` FAIL  ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ */
/*  snapToOption — lifted from the route so the rules stay in one place */
/* ------------------------------------------------------------------ */

/** The text of one function in the route source, matched brace by brace. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`${name} is not in the route source`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`${name} is not closed`);
}

// The route is TypeScript; the annotations are stripped so the same code can be
// exercised here. Nothing else about it changes.
const snapToOption = new Function(
  "reply",
  "options",
  functionBody(LIB_SOURCE, "snapToOption")
    .replace(/:\s*string\s*\|\s*null/g, "")
    .replace(/:\s*string\[\]/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*unknown\b/g, "")
);

const YESNO = ["Yes", "No"];
const EEO = [
  "I identify as one or more of the classifications of a protected veteran",
  "I am not a protected veteran",
  "I don't wish to answer",
];

check("an exact option is returned unchanged", () => {
  assert.equal(snapToOption("Yes", YESNO), "Yes");
});

check("case and punctuation differences still name the option", () => {
  assert.equal(snapToOption("yes", YESNO), "Yes");
  assert.equal(snapToOption("  YES.  ", YESNO), "Yes");
  assert.equal(snapToOption("I dont wish to answer", EEO), "I don't wish to answer");
});

check("an option quoted inside a sentence is recovered", () => {
  assert.equal(snapToOption('I would answer "No" to this.', YESNO), "No");
});

check("a reply naming two options is refused rather than guessed", () => {
  assert.equal(snapToOption("Either Yes or No depending on the team", YESNO), null);
});

check("a reply that names nothing on the menu is refused", () => {
  assert.equal(snapToOption("Maybe", YESNO), null);
  assert.equal(snapToOption("", YESNO), null);
  assert.equal(snapToOption(null, YESNO), null);
});

check("a longer option is not confused with a shorter one it contains", () => {
  assert.equal(snapToOption("I am not a protected veteran", EEO), "I am not a protected veteran");
});

/* ------------------------------------------------------------------ */
/*  The memory lookup's regular expression                             */
/* ------------------------------------------------------------------ */

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

check("regex metacharacters in a question are escaped, not executed", () => {
  const words = ["(salary)", "a+b*c", "what?"].map(escape);
  // Would throw "Invalid regular expression" unescaped, which is what silently
  // turned the saved-answer memory off for questions containing punctuation.
  const re = new RegExp(words.join("|"));
  assert.ok(re.test("(salary)"));
  assert.ok(!re.test("salary"));
});

check("the route escapes before building the expression", () => {
  assert.match(SOURCE, /\.map\(\(w\) => w\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g, "\\\\\$&"\)\)/);
});

check("a single-choice reply is snapped before it is returned", () => {
  assert.match(SOURCE, /if \(!hasCategories && Array\.isArray\(options\) && options\.length\)/);
});

/* ------------------------------------------------------------------ */
/*  A page of questions in one call                                    */
/* ------------------------------------------------------------------ */

// The library is TypeScript; the compiler that ships with the project turns
// it into a module this test can import, unchanged in behaviour.
const ts = (await import("typescript")).default;
const compiled = ts.transpileModule(LIB_SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const lib = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

check("the route answers a page of questions with one model call", () => {
  assert.match(SOURCE, /Array\.isArray\(\(body as any\)\.questions\)\) return answerPage/);
  assert.match(SOURCE, /askAIJSON<[\s\S]{0,120}?>\(\s*BATCH_SYSTEM/);
  assert.match(SOURCE, /deadline: started \+ BATCH_BUDGET_MS/);
  assert.match(SOURCE, /export const maxDuration = 30/);
});

check("questions are bounded and cleaned", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, question: `Question number ${i}?`, options: ["Yes", "No", "Yes"] }));
  const out = lib.sanitizeQuestions(many);
  assert.equal(out.length, 40);
  assert.deepEqual(out[0].options, ["Yes", "No"]);
  assert.equal(lib.sanitizeQuestions("nope").length, 0);
  assert.equal(lib.sanitizeQuestions([{ question: "" }, null, 5]).length, 0);
  const dup = lib.sanitizeQuestions([{ id: "a", question: "One?" }, { id: "a", question: "Two?" }]);
  assert.notEqual(dup[0].id, dup[1].id, "a repeated id is replaced, so answers cannot collide");
});

check("identity, self-identification and record questions are never put to the model", () => {
  for (const q of [
    "What is your gender?", "Are you a protected veteran?", "Employee ID",
    "Have you ever been convicted of a felony?", "Have you ever been terminated from a job?",
    "Do you have a medical condition that…", "What is your date of birth?",
  ]) assert.equal(lib.askable(q), false, q);
  for (const q of ["Are you willing to travel up to 25% of the time?", "Why are you interested in this role?"]) {
    assert.equal(lib.askable(q), true, q);
  }
});

check("saved passwords never reach the prompt", () => {
  const memory = lib.rankMemory([
    { question: "Password", answer: "hunter2!" },
    { question: "Verify New Password", answer: "hunter2!" },
    { question: "Do you have any relatives employed by GDIT?", answer: "No" },
  ], ["Do you have any relatives employed by Leidos?"]);
  assert.deepEqual(memory.map((m) => m.answer), ["No"]);
});

check("the most relevant saved answers are chosen when there are many", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ question: `Unrelated preference number ${i}`, answer: "x" }));
  rows.push({ question: "Are you willing to travel up to 50% of the time?", answer: "Yes" });
  const memory = lib.rankMemory(rows, ["Are you willing to travel up to 25% of the time?"], 40);
  assert.ok(memory.some((m) => /travel/.test(m.question)));
  assert.ok(memory.length <= 40);
});

check("the prompt carries today's date, the options and every question id", () => {
  const questions = lib.sanitizeQuestions([
    { id: "q1", question: "Are you willing to travel?", options: ["Yes", "No"], fieldType: "select" },
    { id: "q2", question: "Why this role?", fieldType: "textarea", maxWords: 130 },
    { id: "q3", question: "Which clouds?", options: ["AWS", "Azure"], fieldType: "checkbox", multiple: true },
  ]);
  const prompt = lib.batchPrompt({ profileContext: "Name: A B", memory: [], questions, jobTitle: "Engineer", company: "Leidos", today: "2026-09-24" });
  assert.match(prompt, /Today's date: 2026-09-24/);
  assert.match(prompt, /q1 \[single choice\]/);
  assert.match(prompt, /Options: "Yes" \| "No"/);
  assert.match(prompt, /q2 \[free text, at most 130 words\]/);
  assert.match(prompt, /q3 \[multi-select\]/);
  assert.match(lib.BATCH_SYSTEM, /never invent/);
});

check("replies are made safe for the question they answer", () => {
  const [menu, text, multi, categories] = lib.sanitizeQuestions([
    { id: "a", question: "Travel?", options: ["Yes", "No"], fieldType: "select" },
    { id: "b", question: "Why?", fieldType: "textarea", maxWords: 10 },
    { id: "c", question: "Clouds?", options: ["Amazon Web Services", "Microsoft Azure"], fieldType: "checkbox", multiple: true },
    { id: "d", question: "How did you hear?", options: ["Job Board (category, has sub-options)", "Referral"], fieldType: "select" },
  ]);
  assert.equal(lib.normalizeBatchAnswer(menu, "yes."), "Yes");
  assert.equal(lib.normalizeBatchAnswer(menu, "Maybe"), "", "an answer not on the menu is dropped, never guessed");
  assert.equal(lib.normalizeBatchAnswer(menu, "N/A"), "");
  assert.deepEqual(lib.normalizeBatchAnswer(multi, ["amazon web services", "GCP"]), ["Amazon Web Services"]);
  assert.deepEqual(lib.normalizeBatchAnswer(multi, "Amazon Web Services, Microsoft Azure"), ["Amazon Web Services", "Microsoft Azure"]);
  assert.equal(lib.normalizeBatchAnswer(categories, "LinkedIn"), "LinkedIn", "a value inside a category is allowed");
  assert.equal(lib.normalizeBatchAnswer(text, "Unknown"), "");
  const long = lib.normalizeBatchAnswer(text, "one two three four five six seven eight nine ten eleven twelve thirteen fourteen");
  assert.ok(long.split(" ").length <= 12, long);
  assert.equal(lib.normalizeBatchAnswer(text, "**I build** platforms."), "I build platforms.");
});

check("the output budget grows with the page and stays bounded", () => {
  const few = lib.sanitizeQuestions([{ question: "Travel?", options: ["Yes", "No"] }]);
  const many = lib.sanitizeQuestions(Array.from({ length: 40 }, (_, i) => ({ question: `Essay ${i}?`, fieldType: "textarea", maxWords: 200 })));
  assert.equal(lib.tokenBudget(few), 512);
  assert.equal(lib.tokenBudget(many), 6000);
});

console.log(`\n${passed} checks passed`);
