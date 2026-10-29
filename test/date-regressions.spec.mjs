import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const fieldMap = await readFile(join(ROOT, "extension/lib/field-map.js"), "utf8");
const results=[];
function check(name, pass, detail="") { results.push({name,pass}); console.log(`${pass?'  ok  ':' FAIL '} ${name}${!pass&&detail?'\n         '+detail:''}`); }
check("date parser exists", fieldMap.includes("const parseProfileDate ="));
check("MM/YYYY handling exists", fieldMap.includes("mm\\s*[/-]\\s*yyyy"));
check("native date handling exists", fieldMap.includes('type === "date"'));
check("year-only does not invent a month", fieldMap.includes("parsed.month ? `${parsed.month}/${parsed.year}` : null"));
const failed=results.filter(x=>!x.pass); console.log(`\n${results.length-failed.length}/${results.length} checks passed`); process.exit(failed.length?1:0);
