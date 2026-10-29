/**
 * End-to-end check of the AI parsing pipeline against a stub Gemini server.
 * No API key and no network needed.
 *
 *   node scripts/test-resume-pipeline.mjs [resume.pdf]
 *
 * Exercises the five failure modes that used to silently produce wrong data:
 *   ok              - normal response
 *   tier-denied     - the newest model 403s for this key; an older one works
 *   bad-key         - the API key itself is rejected
 *   reject-v3       - deployment rejects the Gemini 3.x request shape
 *   truncate        - response cut off mid-JSON (finishReason MAX_TOKENS)
 *   hallucinate     - model invents an employer, school, skill, email and link
 *   empty-maxtokens - reasoning tokens consume the whole output budget
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import http from "node:http";
register("./ts-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

// --- mock Gemini ---
let scenario = "ok";
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [
        { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      ]}));
    }
    const model = decodeURIComponent(req.url.split("/models/")[1].split(":")[0]);
    const parsed = JSON.parse(body);
    seen.push({ model, cfg: parsed.generationConfig, chars: JSON.stringify(parsed.contents).length });

    const reply = (obj, finishReason = "STOP") => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] }));
    };

    // A model the key's tier cannot reach: 403 PERMISSION_DENIED.
    if (scenario === "tier-denied" && model !== "gemini-2.5-flash") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED",
        message: `You do not have permission to access the Model ${model} or it may not exist.` } }));
    }
    // The API key itself is rejected: every model must fail fast.
    if (scenario === "bad-key") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED",
        message: "API key not valid. Please pass a valid API key." } }));
    }
    if (scenario === "reject-v3" && parsed.generationConfig?.responseFormat) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON payload received. Unknown name \"responseFormat\" at 'generation_config'." } }));
    }
    if (scenario === "truncate") {
      return reply(`{"experience":[{"company":"Stripe","title":"Principal Platform Engineer","startDate":"2023-01","endDate":"","current":true,"description":"x"},{"company":"Airbnb","title":"Staff Software Engineer","startDate":"2020-06","endDate":"2022-12","current":false,"description":"y"},{"company":"Ly`, "MAX_TOKENS");
    }
    if (scenario === "hallucinate") {
      return reply({ personal:{firstName:"Marcus",lastName:"Whitfield",email:"fake@evil.com",phone:"+1 999 000 1111"},
        summary:"", experience:[{company:"Stripe",title:"Principal Platform Engineer",startDate:"2023-01",endDate:"",current:true,description:""},
                                {company:"Initech",title:"Overlord",startDate:"2019-01",endDate:"2020-01",current:false,description:""}],
        education:[{school:"Hogwarts",degree:"MSc",fieldOfStudy:"Wizardry",startDate:"",endDate:"",current:false}],
        skills:["Go","Rust","Telekinesis"], certifications:[], websites:[{label:"LinkedIn",url:"https://linkedin.com/in/mdwhitfield"},{label:"Other",url:"https://evil.example/x"}] });
    }
    if (scenario === "empty-maxtokens") { res.writeHead(200,{"content-type":"application/json"}); return res.end(JSON.stringify({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[]}}]})); }

    // default: a plausible good answer built from the request text
    const isExpOnly = body.includes("return ONLY the \\\"experience\\\" array") || body.includes('return ONLY the "experience" array');
    const exp = [{company:"Stripe",title:"Principal Platform Engineer",startDate:"2023-01",endDate:"",current:true,description:"Led the migration"},
                 {company:"Airbnb",title:"Staff Software Engineer",startDate:"2020-06",endDate:"2022-12",current:false,description:"Owned the pricing"}];
    if (isExpOnly) return reply({ experience: exp });
    return reply({ personal:{firstName:"Marcus",lastName:"Whitfield",email:"marcus.whitfield@protonmail.com",phone:"(415) 555-0148"},
      summary:"", targetRole:"", experience: exp,
      education:[{school:"Carnegie Mellon University",degree:"Master of Science",fieldOfStudy:"Computer Science",startDate:"2012-01",endDate:"2014-01",current:false}],
      skills:["Go","Rust"], certifications:[], websites:[] });
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

process.env.GOOGLE_API_KEY = "test-key";
process.env.GEMINI_API_ROOT_OVERRIDE = `http://127.0.0.1:${port}/models`;

const { parseResumeDocument } = await import("../src/lib/resume-parse.ts");
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/test-resume-pipeline.mjs <resume file>"); process.exit(1); }
const buffer = readFileSync(file);
const run = () => parseResumeDocument({ buffer, mimeType: file.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", filename: file });

for (const s of ["ok", "tier-denied", "bad-key", "reject-v3", "truncate", "hallucinate", "empty-maxtokens"]) {
  scenario = s; seen.length = 0;
  try {
    const r = await run();
    console.log(`\n[${s}] source=${r._meta.source} model=${r._meta.model} strategy=${r._meta.strategy} aiUsed=${r._meta.aiUsed}`);
    console.log(`   exp=${(r.experience||[]).map(e=>e.company).join(", ")}`);
    console.log(`   edu=${(r.education||[]).map(e=>e.school||"(blank)").join(", ")}`);
    console.log(`   email=${r.personal?.email} skills=${(r.skills||[]).join(",")}`);
    console.log(`   links=${(r.websites||[]).map(w=>w.url).join(" ")}`);
    if (r._meta.warnings.length) console.log(`   warnings: ${r._meta.warnings.join(" | ")}`);
    console.log(`   calls: ${seen.map(x=>`${x.model}${x.cfg?.responseFormat?"[v3]":x.cfg?.responseSchema?"[legacy]":"[plain]"}`).join(" ")}`);
  } catch (e) { console.log(`\n[${s}] THREW: ${e.message}`); }
}
server.close();
