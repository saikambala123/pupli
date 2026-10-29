/** iCIMS — numbered "(1)" / "(2)" experience blocks, separate address lines. */
import { join } from "node:path";
import { runFixture, check, report, ROOT } from "./harness.mjs";

const { browser, runResult, read } = await runFixture(
  join(ROOT, "test/portals/icims.html"),
  { url: "https://careers-acme.icims.com/jobs/1234/login" }
);

console.log(`\niCIMS — detected "${runResult.ats}", ${runResult.filled} filled, ${runResult.unmatchedCount} left\n`);
if (process.env.ZDEBUG) console.log(JSON.stringify(runResult.unmatched, null, 2));

check("detected as iCIMS", runResult.ats === "icims", `got ${runResult.ats}`);
check("first name", (await read("fn")) === "Madhu", `= ${await read("fn")}`);
check("last name", (await read("ln")) === "Kumar", `= ${await read("ln")}`);
check("email", (await read("em")) === "madhu.ittech@gmail.com", `= ${await read("em")}`);
check("mobile phone", /630.?555.?0142/.test((await read("mp")) || ""), `= ${await read("mp")}`);
check("street address is line 1 only", (await read("ad")) === "1703 High Point Terrace", `= ${await read("ad")}`);
check("address line 2 is the apartment", (await read("ad2")) === "Apt 4B", `= ${await read("ad2")}`);
check("city", (await read("ct")) === "Stanley", `= ${await read("ct")}`);
check("state", (await read("st")) === "North Carolina", `= ${await read("st")}`);
check("postal code", (await read("zp")) === "28164", `= ${await read("zp")}`);

check("experience row 1 employer", (await read("e1c")) === "Northern Trust Bank", `= ${await read("e1c")}`);
check("experience row 1 title", (await read("e1t")) === "Senior DevOps Engineer", `= ${await read("e1t")}`);
check("experience row 2 employer is the second job", (await read("e2c")) === "Cognizant", `= ${await read("e2c")}`);
check("experience row 2 title is the second job", (await read("e2t")) === "IAM Security Engineer", `= ${await read("e2t")}`);
check("experience row 1 start date", /2025/.test((await read("e1s")) || ""), `= ${await read("e1s")}`);
check("experience row 2 end date", /2025/.test((await read("e2e")) || ""), `= ${await read("e2e")}`);

check("school", (await read("sc")) === "Northwestern Polytechnic University", `= ${await read("sc")}`);
check("degree", (await read("dg")) === "Master's Degree", `= ${await read("dg")}`);
check("major", (await read("mj")) === "Computer Science", `= ${await read("mj")}`);

check("work authorization", (await read("wa")) === "Yes", `= ${await read("wa")}`);
check("sponsorship", (await read("sp")) === "No", `= ${await read("sp")}`);
check("relocate", (await read("rl")) === "Yes", `= ${await read("rl")}`);
check("desired salary", /160000/.test((await read("sal")) || ""), `= ${await read("sal")}`);
check("source", (await read("src")) === "LinkedIn", `= ${await read("src")}`);

await browser.close();
process.exit(report("iCIMS") ? 0 : 1);
