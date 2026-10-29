/**
 * A company's own careers page: no adapter matches, and two decoy forms
 * (site search, newsletter) sit above the application form in the document.
 */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/generic.html"),
  { url: "https://www.vantage.example/careers/site-reliability-engineer" }
);

console.log(`\nGeneric careers page — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("falls through to the generic adapter", runResult.ats === "generic", `got ${runResult.ats}`);

check("application first name", (await read("g-first")) === "Madhu", `= ${await read("g-first")}`);
check("application last name", (await read("g-last")) === "Kumar", `= ${await read("g-last")}`);
check("application email", (await read("g-email")) === "madhu.ittech@gmail.com", `= ${await read("g-email")}`);
check("application phone", /630.?555.?0142/.test((await read("g-phone")) || ""), `= ${await read("g-phone")}`);
check("application city", (await read("g-city")) === "Stanley", `= ${await read("g-city")}`);
check("application country", (await read("g-country")) === "United States", `= ${await read("g-country")}`);
check("application LinkedIn", (await read("g-linkedin")) === "https://linkedin.com/in/madhukumar", `= ${await read("g-linkedin")}`);
check("notice period from saved answers", /2 weeks/i.test((await read("g-notice")) || ""), `= ${await read("g-notice")}`);
check("salary expectation", /160000/.test((await read("g-salary")) || ""), `= ${await read("g-salary")}`);
check("right to work", (await read("g-auth")) === "Yes", `= ${await read("g-auth")}`);

check("the site search box was left alone", (await read("site-q")) === "", `= ${await read("site-q")}`);
check("the newsletter email was left alone", (await read("nl-email")) === "", `= ${await read("nl-email")}`);
check("the newsletter name was left alone", (await read("nl-name")) === "", `= ${await read("nl-name")}`);

await browser.close();
process.exit(report("Generic careers page") ? 0 : 1);
