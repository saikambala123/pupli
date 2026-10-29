/** Workable — fieldset/legend questions, including a multi-select checkbox group. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read, picked } = await runFixture(
  join(ROOT, "test/portals/workable.html"),
  { url: "https://apply.workable.com/acme/j/ABCDEF1234/apply/" }
);

console.log(`\nWorkable — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Workable", runResult.ats === "workable", `got ${runResult.ats}`);
check("first name", (await read("wk-first")) === "Madhu", `= ${await read("wk-first")}`);
check("last name", (await read("wk-last")) === "Kumar", `= ${await read("wk-last")}`);
check("email", (await read("wk-email")) === "madhu.ittech@gmail.com", `= ${await read("wk-email")}`);
check("phone", /630.?555.?0142/.test((await read("wk-phone")) || ""), `= ${await read("wk-phone")}`);
check("location", /Stanley/.test((await read("wk-loc")) || ""), `= ${await read("wk-loc")}`);
check("summary", /DevOps and IAM/.test((await read("wk-sum")) || ""), `= ${await read("wk-sum")}`);
check("LinkedIn", (await read("wk-li")) === "https://linkedin.com/in/madhukumar", `= ${await read("wk-li")}`);
check("GitHub", (await read("wk-gh")) === "https://github.com/madhukumar", `= ${await read("wk-gh")}`);
check("Portfolio", (await read("wk-pf")) === "https://madhukumar.dev", `= ${await read("wk-pf")}`);
check("education level", /Master/.test((await read("wk-edu")) || ""), `= ${await read("wk-edu")}`);
check("years of experience", /^\d+$/.test((await read("wk-exp")) || ""), `= ${await read("wk-exp")}`);
check("work authorization = Yes", String(await picked("q_auth")) === "Yes", `= ${await picked("q_auth")}`);
check("sponsorship = No", String(await picked("q_spon")) === "No", `= ${await picked("q_spon")}`);

// Nothing in the profile says which of these four the applicant has used, and
// the AI pass is off, so the group must be left alone rather than guessed at.
check("skills checkbox group left for the applicant", (await picked("q_skills")) === null, `= ${await picked("q_skills")}`);

await browser.close();
process.exit(report("Workable") ? 0 : 1);
