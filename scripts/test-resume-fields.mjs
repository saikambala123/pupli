/**
 * Field-hygiene unit tests: dates must never sit in the Company field and an
 * employer must never sit in the Location field.
 *
 *   node scripts/test-resume-fields.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./ts-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));
const B = "../src/lib/";
const { peelDates, trailingLocation, vendorPlace, bareDeliveryCentre, parseSkills } = await import(B + "resume-fallback.ts");
let pass=0, fail=0;
const eq=(l,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;if(!ok)console.log(`FAIL ${l}\n  got  ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`)};

// dates written inline with the employer
eq("company+range", peelDates("Regions Bank Feb 2026-Till Date").text, "Regions Bank");
eq("range parsed",  peelDates("Regions Bank Feb 2026-Till Date").range?.current, true);
eq("hyphen range",  peelDates("BFS Sep-2025-Feb 2026").text, "BFS");
eq("trailing year",  peelDates("Osmania University 2013").text, "Osmania University");
eq("clean untouched", peelDates("Infosys Limited").text, "Infosys Limited");

// employer + place in one string
eq("employer+place", trailingLocation("ALLY Financials, Detroit, MI"), {head:"ALLY Financials", location:"Detroit, MI"});
eq("place alone",    trailingLocation("San Francisco, CA"), {head:"San Francisco, CA", location:""});
eq("corp suffix",    trailingLocation("Cognizant Technology Solutions, Inc."), {head:"Cognizant Technology Solutions, Inc.", location:""});
eq("school+place",   trailingLocation("Wilmington University, New Castle, DE"), {head:"Wilmington University", location:"New Castle, DE"});
eq("india",          trailingLocation("Infosys Limited, Hyderabad, India"), {head:"Infosys Limited", location:"Hyderabad, India"});
eq("not a region",   trailingLocation("Acme, Foo, Bar"), {head:"Acme, Foo, Bar", location:""});

// vendor tails on consulting resumes
eq("vendor tail",    trailingLocation("Bank of America, Charlotte, NC (TCS) Hyderabad-INDIA"), {head:"Bank of America", location:"Charlotte, NC"});
eq("vendor no space", trailingLocation("Archer Daniels Midland Company (TCS)Hyderabad-INDIA"), {head:"Archer Daniels Midland Company", location:""});
eq("vendor + comma", trailingLocation("Charles Schwab & Co., Inc, Clayton, MO (Infosys) Hyderabad-INDIA"), {head:"Charles Schwab & Co., Inc", location:"Clayton, MO"});
eq("bell south",     trailingLocation("Bell South, Atlanta, GA (Logic gate) Hyderabad-INDIA"), {head:"Bell South", location:"Atlanta, GA"});

// dates written inline with a labelled employer
eq("till date",      peelDates("Regions Bank   Feb 2026-Till Date").text.trim(), "Regions Bank");
eq("april dash",     peelDates("Nation Wide   April-2025 - Aug 2025").text.trim(), "Nation Wide");

// the vendor city is a real work location when no client site is named
eq("vendor city",    vendorPlace("Archer Daniels Midland Company (TCS)Hyderabad-INDIA"), "Hyderabad, India");
eq("vendor city 2",  vendorPlace("Bell South, Atlanta, GA (Logic gate) Hyderabad-INDIA"), "Hyderabad, India");
eq("no vendor",      vendorPlace("Infosys Limited, Hyderabad, India"), "");
eq("bare centre",    bareDeliveryCentre("Hyderabad-INDIA"), "Hyderabad, India");
eq("not a centre",   bareDeliveryCentre("Full-time"), "");

// a tabulated skills matrix is still a skills list
eq("skills matrix", parseSkills([
  "Skill   Years of Experience   Last Used",
  "Experience using database query tools and writing SQL.   8 years   2026",
  "Salesforce CPQ   9 years   2026",
  "Tosca DI   2.5 Years   2026",
]), ["Experience using database query tools and writing SQL", "Salesforce CPQ", "Tosca DI"]);
eq("plain skill line", parseSkills(["Java, Spring Boot, MySQL"]), ["Java", "Spring Boot", "MySQL"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
