/** SAP SuccessFactors — question text lives in an aria-describedby node. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/successfactors.html"),
  { url: "https://career5.successfactors.eu/careers/apply" }
);

console.log(`\nSuccessFactors — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as SAP SuccessFactors", /successfactors/i.test(runResult.ats || ""), `got ${runResult.ats}`);
check("first name", (await read("sf-fn")) === "Madhu", `= ${await read("sf-fn")}`);
check("last name", (await read("sf-ln")) === "Kumar", `= ${await read("sf-ln")}`);
check("e-mail", (await read("sf-em")) === "madhu.ittech@gmail.com", `= ${await read("sf-em")}`);
check("day time number", /630.?555.?0142/.test((await read("sf-ph")) || ""), `= ${await read("sf-ph")}`);
check("street address", (await read("sf-addr")) === "1703 High Point Terrace, Apt 4B", `= ${await read("sf-addr")}`);
check("city", (await read("sf-city")) === "Stanley", `= ${await read("sf-city")}`);
check("postal code", (await read("sf-zip")) === "28164", `= ${await read("sf-zip")}`);
check("country", (await read("sf-cty")) === "United States", `= ${await read("sf-cty")}`);
check("work authorization", (await read("sf-auth")) === "Yes", `= ${await read("sf-auth")}`);
check("sponsorship", (await read("sf-spon")) === "No", `= ${await read("sf-spon")}`);
check("source", (await read("sf-src")) === "LinkedIn", `= ${await read("sf-src")}`);

await browser.close();
process.exit(report("SAP SuccessFactors") ? 0 : 1);
