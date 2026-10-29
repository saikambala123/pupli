import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const fieldMap = await readFile(new URL("../extension/lib/field-map.js", import.meta.url), "utf8");
const sandbox = { window: {}, globalThis: {}, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fieldMap, sandbox, { filename: "field-map.js" });
const rule = sandbox.window.APPLI_FILL_FIELD_MAP.find((r) => r.key === "howDidYouHear");
if (!rule || rule.value() !== "LinkedIn") throw new Error("howDidYouHear is not hard-coded to LinkedIn");
if (rule.options?.LinkedIn?.includes("other")) throw new Error("LinkedIn mapping must not fall back to Other");

const popup = await readFile(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
if (/id=["']account-password["']|id=["']account-save-btn["']|Job-site password/i.test(popup)) {
  throw new Error("separate password field/save control still exists in popup");
}
const autofill = await readFile(new URL("../extension/content/autofill.js", import.meta.url), "utf8");
if (/applifillAccountPassword/.test(autofill)) throw new Error("content script still uses a local password key");
if (!/resolveSavedPassword\(\)/.test(autofill)) throw new Error("saved Password resolver missing");
console.log("Static regression checks passed: saved Password only + canonical LinkedIn source.");
