/** Taleo — legacy table layout, machine ids, labels in a sibling cell. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/taleo.html"),
  { url: "https://acme.taleo.net/careersection/ex/jobapply.ftl" }
);

console.log(`\nTaleo — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as Taleo", runResult.ats === "taleo", `got ${runResult.ats}`);
check("first name", (await read("ftlf_1_1_0")) === "Madhu", `= ${await read("ftlf_1_1_0")}`);
check("middle initial fits maxlength=1", (await read("ftlf_1_2_0")) === "R", `= ${await read("ftlf_1_2_0")}`);
check("last name", (await read("ftlf_1_3_0")) === "Kumar", `= ${await read("ftlf_1_3_0")}`);
check("e-mail address", (await read("ftlf_1_4_0")) === "madhu.ittech@gmail.com", `= ${await read("ftlf_1_4_0")}`);
check("primary number", /630.?555.?0142/.test((await read("ftlf_1_5_0")) || ""), `= ${await read("ftlf_1_5_0")}`);
// Taleo shows one address box, so the apartment has nowhere else to go and
// belongs on this line. (iCIMS, which does show Line 2, must not repeat it —
// see icims.spec.mjs.)
check("address line 1 carries street + apartment", (await read("ftlf_1_6_0")) === "1703 High Point Terrace, Apt 4B", `= ${await read("ftlf_1_6_0")}`);
check("city", (await read("ftlf_1_7_0")) === "Stanley", `= ${await read("ftlf_1_7_0")}`);
check("state select", (await read("ftlf_1_8_0")) === "North Carolina", `= ${await read("ftlf_1_8_0")}`);
check("zip", (await read("ftlf_1_9_0")) === "28164", `= ${await read("ftlf_1_9_0")}`);
check("country select", (await read("ftlf_1_10_0")) === "United States", `= ${await read("ftlf_1_10_0")}`);
check("eligible to work = Yes", (await read("ftlf_2_1_0")) === "Yes", `= ${await read("ftlf_2_1_0")}`);
check("sponsorship = No", (await read("ftlf_2_2_0")) === "No", `= ${await read("ftlf_2_2_0")}`);
check("most recent employer", (await read("ftlf_3_1_0")) === "Northern Trust Bank", `= ${await read("ftlf_3_1_0")}`);
check("most recent job title", (await read("ftlf_3_2_0")) === "Senior DevOps Engineer", `= ${await read("ftlf_3_2_0")}`);
check("highest education = Master's Degree", (await read("ftlf_4_1_0")) === "Master's Degree", `= ${await read("ftlf_4_1_0")}`);
check("school", (await read("ftlf_4_2_0")) === "Northwestern Polytechnic University", `= ${await read("ftlf_4_2_0")}`);
check("how did you hear = LinkedIn", (await read("ftlf_5_1_0")) === "LinkedIn", `= ${await read("ftlf_5_1_0")}`);

await browser.close();
process.exit(report("Taleo") ? 0 : 1);
