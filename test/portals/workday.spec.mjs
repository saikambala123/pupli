/** Workday — button dropdowns that open a listbox rendered at the end of body. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/workday.html"),
  { url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Security-Engineer/apply" }
);

console.log(`\nWorkday — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Workday", runResult.ats === "workday", `got ${runResult.ats}`);
check("first name", (await read("wd-first")) === "Madhu", `= ${await read("wd-first")}`);
check("last name", (await read("wd-last")) === "Kumar", `= ${await read("wd-last")}`);

check("country dropdown resolves to the US entry", /United States/.test((await read("wd-cty")) || ""), `= ${await read("wd-cty")}`);
check("address line 1 is the street only", (await read("wd-a1")) === "1703 High Point Terrace", `= ${await read("wd-a1")}`);
check("address line 2 is the apartment", (await read("wd-a2")) === "Apt 4B", `= ${await read("wd-a2")}`);
check("city", (await read("wd-city")) === "Stanley", `= ${await read("wd-city")}`);
check("state dropdown", (await read("wd-st")) === "North Carolina", `= ${await read("wd-st")}`);
check("postal code", (await read("wd-zip")) === "28164", `= ${await read("wd-zip")}`);

check("phone device type", (await read("wd-pdt")) === "Mobile", `= ${await read("wd-pdt")}`);
check("country phone code picks the US entry", /\+1/.test((await read("wd-cc")) || ""), `= ${await read("wd-cc")}`);
check("phone number is the number, not the code", /630.?555.?0142/.test((await read("wd-ph")) || ""), `= ${await read("wd-ph")}`);
check("phone extension left blank", !(await read("wd-ext")), `= ${await read("wd-ext")}`);

check("how did you hear resolves LinkedIn to Social Media", /social media/i.test((await read("wd-src")) || ""), `= ${await read("wd-src")}`);
check("work authorization = Yes", (await read("wd-auth")) === "Yes", `= ${await read("wd-auth")}`);
check("sponsorship = No", (await read("wd-spon")) === "No", `= ${await read("wd-spon")}`);

await browser.close();
process.exit(report("Workday") ? 0 : 1);
