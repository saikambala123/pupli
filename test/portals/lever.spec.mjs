/** Lever — jobs.lever.co shaped form (label-wrapped inputs, radio cards). */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read, picked } = await runFixture(
  join(ROOT, "test/portals/lever.html"),
  { url: "https://jobs.lever.co/acme/1234-5678/apply" }
);

console.log(`\nLever — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Lever", runResult.ats === "lever", `got ${runResult.ats}`);
check("full name", (await read("name")) === "Madhu Kumar", `= ${await read("name")}`);
check("email", (await read("email")) === "madhu.ittech@gmail.com", `= ${await read("email")}`);
check("phone", /630.?555.?0142/.test((await read("phone")) || ""), `= ${await read("phone")}`);
check("current company", (await read("org")) === "Northern Trust Bank", `= ${await read("org")}`);
check("LinkedIn", (await read("urls[LinkedIn]")) === "https://linkedin.com/in/madhukumar", `= ${await read("urls[LinkedIn]")}`);
check("GitHub", (await read("urls[GitHub]")) === "https://github.com/madhukumar", `= ${await read("urls[GitHub]")}`);
check("Portfolio", (await read("urls[Portfolio]")) === "https://madhukumar.dev", `= ${await read("urls[Portfolio]")}`);

check("work authorization radio = Yes", String(await picked("cards[auth][field0]")) === "Yes", `= ${await picked("cards[auth][field0]")}`);
check("sponsorship radio = No", String(await picked("cards[auth][field1]")) === "No", `= ${await picked("cards[auth][field1]")}`);
check("relocate radio = Yes", String(await picked("cards[auth][field2]")) === "Yes", `= ${await picked("cards[auth][field2]")}`);

check("salary expectations", /160000/.test((await read("cards[comp][field0]")) || ""), `= ${await read("cards[comp][field0]")}`);
check("why-work-here from saved answers", /identity problem/.test((await read("cards[why][field0]")) || ""), `= ${await read("cards[why][field0]")}`);
check("how did you hear select", (await read("cards[src][field0]")) === "LinkedIn", `= ${await read("cards[src][field0]")}`);

await browser.close();
process.exit(report("Lever") ? 0 : 1);
