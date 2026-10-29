/** Greenhouse — job-boards.greenhouse.io shaped form. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read, hidden } = await runFixture(
  join(ROOT, "test/portals/greenhouse.html"),
  { url: "https://job-boards.greenhouse.io/northwind/jobs/4821" }
);

console.log(`\nGreenhouse — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Greenhouse", runResult.ats === "greenhouse", `got ${runResult.ats}`);
check("first name", (await read("first_name")) === "Madhu", `= ${await read("first_name")}`);
check("last name", (await read("last_name")) === "Kumar", `= ${await read("last_name")}`);
check("email", (await read("email")) === "madhu.ittech@gmail.com", `= ${await read("email")}`);
check("phone", /630.?555.?0142/.test((await read("phone")) || ""), `= ${await read("phone")}`);
check("location (city)", (await read("job_application_location")) === "Stanley", `= ${await read("job_application_location")}`);
check("LinkedIn url", (await read("urls_LinkedIn")) === "https://linkedin.com/in/madhukumar", `= ${await read("urls_LinkedIn")}`);
check("Website url", (await read("urls_Website")) === "https://madhukumar.dev", `= ${await read("urls_Website")}`);

check("sponsorship react-select submits No", (await hidden("gh-sponsorship")) === "No", `= ${await hidden("gh-sponsorship")}`);
check("work authorization react-select submits Yes", (await hidden("gh-authorized")) === "Yes", `= ${await hidden("gh-authorized")}`);
check("how did you hear submits LinkedIn", (await hidden("gh-hear")) === "LinkedIn", `= ${await hidden("gh-hear")}`);

check("years of experience answered", /^[0-9]+$/.test((await read("q-years")) || ""), `= ${await read("q-years")}`);
check("why-work-here from saved answers", /identity problem/.test((await read("q-why")) || ""), `= ${await read("q-why")}`);

check("gender from profile", (await hidden("gh-gender")) === "Man", `= ${await hidden("gh-gender")}`);
check("hispanic/latino from profile", (await hidden("gh-hispanic")) === "No", `= ${await hidden("gh-hispanic")}`);
check("veteran status from profile", (await hidden("gh-veteran")) === "I am not a protected veteran", `= ${await hidden("gh-veteran")}`);
check("disability status from profile", /^No, I do not have a disability/.test((await hidden("gh-disability")) || ""), `= ${await hidden("gh-disability")}`);

check("the board search box was left alone", (await read("q")) === "", `search box = ${await read("q")}`);

await browser.close();
process.exit(report("Greenhouse") ? 0 : 1);
