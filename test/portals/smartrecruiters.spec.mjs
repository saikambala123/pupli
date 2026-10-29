/** SmartRecruiters — floating labels rendered *after* the input they describe. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/smartrecruiters.html"),
  { url: "https://jobs.smartrecruiters.com/Globex/743999-cloud-architect" }
);

console.log(`\nSmartRecruiters — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as SmartRecruiters", runResult.ats === "smartrecruiters", `got ${runResult.ats}`);
check("first name", (await read("sr-first")) === "Madhu", `= ${await read("sr-first")}`);
check("last name", (await read("sr-last")) === "Kumar", `= ${await read("sr-last")}`);
check("email", (await read("sr-email")) === "madhu.ittech@gmail.com", `= ${await read("sr-email")}`);
check("phone", /630.?555.?0142/.test((await read("sr-phone")) || ""), `= ${await read("sr-phone")}`);
check("location", /Stanley/.test((await read("sr-loc")) || ""), `= ${await read("sr-loc")}`);
check("country", (await read("sr-country")) === "United States", `= ${await read("sr-country")}`);
check("current company", (await read("sr-comp")) === "Northern Trust Bank", `= ${await read("sr-comp")}`);
check("current job title", (await read("sr-job")) === "Senior DevOps Engineer", `= ${await read("sr-job")}`);
check("work authorization", (await read("sr-auth")) === "Yes", `= ${await read("sr-auth")}`);
check("sponsorship", (await read("sr-spon")) === "No", `= ${await read("sr-spon")}`);
// "Why are you interested in this role?" is not close enough to the saved
// "Why do you want to work here?" for the fuzzy matcher's floor, and guessing
// across that gap is how a wrong answer gets submitted. With AI off it is left
// for the applicant; with AI on the route's own memory lookup offers it to the
// model. Either way it must not be filled with something else.
check("a rephrased open question is left blank, not guessed", !(await read("sr-why")), `= ${await read("sr-why")}`);

await browser.close();
process.exit(report("SmartRecruiters") ? 0 : 1);
