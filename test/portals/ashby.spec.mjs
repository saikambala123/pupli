/** Ashby — uuid field names, question text in a div above styled radios. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read, picked } = await runFixture(
  join(ROOT, "test/portals/ashby.html"),
  { url: "https://jobs.ashbyhq.com/superhuman/1234-5678/application" }
);

console.log(`\nAshby — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Ashby", runResult.ats === "ashby", `got ${runResult.ats}`);
check("name", (await read("ab-name")) === "Madhu Kumar", `= ${await read("ab-name")}`);
check("email", (await read("ab-email")) === "madhu.ittech@gmail.com", `= ${await read("ab-email")}`);
check("phone", /630.?555.?0142/.test((await read("ab-phone")) || ""), `= ${await read("ab-phone")}`);
check("LinkedIn despite a uuid field name", (await read("ab-linkedin")) === "https://linkedin.com/in/madhukumar", `= ${await read("ab-linkedin")}`);
check("location", /Stanley/.test((await read("ab-loc")) || ""), `= ${await read("ab-loc")}`);

check("work authorization radio = Yes", String(await picked("edb0c17a-447a-b4c5-8a5afa5ba1a9")) === "Yes", `= ${await picked("edb0c17a-447a-b4c5-8a5afa5ba1a9")}`);
check("sponsorship radio = No", String(await picked("bb91f2e1-9c32-4f77-91aa-0d4f5a7c1e33")) === "No", `= ${await picked("bb91f2e1-9c32-4f77-91aa-0d4f5a7c1e33")}`);
check("how did you hear = LinkedIn", (await read("ab-src")) === "LinkedIn", `= ${await read("ab-src")}`);
check("notice period from saved answers", /2 weeks/i.test((await read("ab-notice")) || ""), `= ${await read("ab-notice")}`);
check("gender from profile", (await read("ab-gender")) === "Man", `= ${await read("ab-gender")}`);

await browser.close();
process.exit(report("Ashby") ? 0 : 1);
