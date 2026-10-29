/**
 * Offline check for the resume pipeline.
 *
 *   node scripts/test-resume-parsing.mjs <file> [<file> ...]
 *
 * Runs text extraction and the deterministic parser without calling Gemini, so
 * you can see exactly what the model will be given and what the offline path
 * produces. Set GOOGLE_API_KEY to also exercise the full AI parse.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./ts-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const { extractResumeDetailed } = await import("../src/lib/resume-text.ts");
const { fallbackParseResumeText } = await import("../src/lib/resume-fallback.ts");
const { normalizeParsedResume } = await import("../src/lib/profile-shape.ts");

const MIME = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
};

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/test-resume-parsing.mjs <resume file> [...]");
  process.exit(1);
}

for (const file of files) {
  const buffer = readFileSync(file);
  const name = basename(file);
  console.log(`\n${"=".repeat(72)}\n${name}  (${(buffer.length / 1024).toFixed(1)} KB)\n${"=".repeat(72)}`);

  const extracted = await extractResumeDetailed({
    buffer,
    mimeType: MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    filename: name,
  });

  console.log(`kind=${extracted.kind} pages=${extracted.pages} chars=${extracted.text.length} quality=${extracted.quality.toFixed(2)} notes=[${extracted.notes.join(", ")}]`);
  console.log("\n--- extracted text (first 1800 chars) ---");
  console.log(extracted.text.slice(0, 1800));

  const parsed = normalizeParsedResume(fallbackParseResumeText(extracted.text));
  console.log("\n--- deterministic parse ---");
  console.log(`name: ${parsed.personal.firstName} ${parsed.personal.lastName}`);
  console.log(`email: ${parsed.personal.email}   phone: ${parsed.personal.phoneCountryCode} ${parsed.personal.phone}`);
  console.log(`experience (${parsed.experience.length}):`);
  for (const e of parsed.experience) {
    console.log(`   • ${e.title || "—"} @ ${e.company || "—"}  [${e.startDate || "?"} → ${e.current ? "present" : e.endDate || "?"}]  ${e.employmentType || ""} ${e.location || ""}`);
  }
  console.log(`education (${parsed.education.length}):`);
  for (const e of parsed.education) {
    console.log(`   • ${e.degree || "—"} ${e.fieldOfStudy ? `in ${e.fieldOfStudy}` : ""} @ ${e.school || "—"}  [${e.startDate || "?"} → ${e.endDate || "?"}] gpa=${e.gpa || "-"}`);
  }
  console.log(`skills (${parsed.skills.length}): ${parsed.skills.slice(0, 18).join(", ")}`);
  console.log(`certs (${parsed.certifications.length}): ${parsed.certifications.join(" | ")}`);
  console.log(`links (${parsed.websites.length}): ${parsed.websites.map((w) => `${w.label}=${w.url}`).join("  ")}`);

  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    const { parseResumeDocument } = await import("../src/lib/resume-parse.ts");
    const ai = await parseResumeDocument({
      buffer,
      mimeType: MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      filename: name,
    });
    const shaped = normalizeParsedResume(ai);
    console.log("\n--- AI parse ---");
    console.log(JSON.stringify({ _meta: ai._meta, ...shaped }, null, 2));
  }
}
