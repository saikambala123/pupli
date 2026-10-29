/** Oracle HCM / Recruiting — four address lines and a row of boxes to leave blank. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/oraclehcm.html"),
  { url: "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1234/apply" }
);

console.log(`\nOracle HCM — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Oracle HCM", runResult.ats === "oraclehcm", `got ${runResult.ats}`);
check("first name", (await read("or-first")) === "Madhu", `= ${await read("or-first")}`);
check("last name", (await read("or-last")) === "Kumar", `= ${await read("or-last")}`);
check("email", (await read("or-email")) === "madhu.ittech@gmail.com", `= ${await read("or-email")}`);
check("country phone code", (await read("or-cc")) === "+1", `= ${await read("or-cc")}`);
check("contact number is the phone, not the code", /630.?555.?0142/.test((await read("or-phone")) || ""), `= ${await read("or-phone")}`);

check("country/region is the country", (await read("or-country")) === "United States", `= ${await read("or-country")}`);
check("state is the state", (await read("or-state")) === "North Carolina", `= ${await read("or-state")}`);
check("address line 1 is the street only", (await read("or-a1")) === "1703 High Point Terrace", `= ${await read("or-a1")}`);
check("address line 2 is the apartment", (await read("or-a2")) === "Apt 4B", `= ${await read("or-a2")}`);
check("address line 3 left blank", !(await read("or-a3")), `= ${await read("or-a3")}`);
check("address line 4 left blank", !(await read("or-a4")), `= ${await read("or-a4")}`);
check("city", (await read("or-city")) === "Stanley", `= ${await read("or-city")}`);
check("postal code", (await read("or-zip")) === "28164", `= ${await read("or-zip")}`);
check("county left blank", !(await read("or-county")), `= ${await read("or-county")}`);
check("tax district left blank", !(await read("or-taxd")), `= ${await read("or-taxd")}`);
check("second last name left blank", !(await read("or-last2")), `= ${await read("or-last2")}`);
check("suffix left blank", !(await read("or-suffix")), `= ${await read("or-suffix")}`);
check("extension left blank", !(await read("or-ext")), `= ${await read("or-ext")}`);
check("employee ID left blank", !(await read("or-empid")), `= ${await read("or-empid")}`);

check("employer", (await read("or-emp")) === "Northern Trust Bank", `= ${await read("or-emp")}`);
check("job title", (await read("or-job")) === "Senior DevOps Engineer", `= ${await read("or-job")}`);
check("work authorization", (await read("or-auth")) === "Yes", `= ${await read("or-auth")}`);
check("sponsorship", (await read("or-spon")) === "No", `= ${await read("or-spon")}`);
check("referral source", (await read("or-src")) === "LinkedIn", `= ${await read("or-src")}`);

await browser.close();
process.exit(report("Oracle HCM") ? 0 : 1);
