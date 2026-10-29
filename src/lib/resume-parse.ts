/**
 * Resume parsing orchestration.
 *
 * The old flow was: extract text -> one 18-second, 3500-token Gemini call ->
 * if anything at all went wrong, silently substitute a regex parse and return
 * it as though it were the real answer. Users saw plausible-looking but wrong
 * work history and education and had no way to tell that the AI never ran.
 *
 * The flow now:
 *   1. extract text with layout preserved (resume-text.ts)
 *   2. pick a strategy from the document's size and text quality
 *      - normal resume  -> one schema-constrained pass
 *      - long resume    -> profile pass and experience pass, concurrently, so
 *                          each gets a full output budget within one round trip
 *      - very long      -> the experience pass is chunked and run in parallel
 *      - scanned/garbled-> Gemini reads the original file with vision
 *   3. detect a short answer (truncated output, or fewer roles than the
 *      document visibly contains) and run a targeted recovery pass
 *   4. verify every value against the source text before returning it
 *   5. report what happened in `_meta` instead of hiding it
 */

import {
  aiEnabled,
  askAISchema,
  askAISchemaWithFile,
  parseBudgetMs,
} from "./ai";
import {
  extractResumeDetailed,
  detectResumeFileKind,
  type ExtractedResume,
} from "./resume-text";
import {
  fallbackParseResumeText,
  splitSections,
  extractContacts,
  peelDates,
  trailingLocation,
  DATE_RANGE_RE,
  type Section,
} from "./resume-fallback";
import {
  RESUME_SCHEMA,
  EXPERIENCE_SCHEMA,
  PROFILE_SCHEMA,
  RESUME_SYSTEM,
  EXPERIENCE_SYSTEM,
  PROFILE_SYSTEM,
} from "./resume-schema";

/** Above this many characters we split the work across concurrent passes. */
const SINGLE_PASS_LIMIT = 14_000;
/** Above this, the experience pass itself is chunked. */
const CHUNK_LIMIT = 60_000;
const CHUNK_SIZE = 42_000;
const MAX_CHUNKS = 4;
/** Hard ceiling on characters sent to the model - well inside the context window. */
const MAX_TEXT_CHARS = 600_000;

export type ParseSource = "ai" | "ai+recovery" | "ai-vision" | "ai-partial" | "local";

export type ParseMeta = {
  source: ParseSource;
  model: string;
  fileKind: string;
  pages: number;
  chars: number;
  textQuality: number;
  strategy: string;
  durationMs: number;
  warnings: string[];
  /** false when the AI never produced a usable answer. */
  aiUsed: boolean;
};

type Parsed = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => Date.now();

function alphanumeric(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function digitsOf(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Isolate the experience region so the experience pass is not diluted. */
function experienceRegion(sections: Section[]): string {
  const region = sections
    .filter((s) => s.name === "experience" || s.name === "projects" || s.name === "volunteer")
    .map((s) => `${s.heading}\n${s.lines.join("\n")}`)
    .join("\n\n")
    .trim();
  return region;
}

/** Count the entry headers a human would see, as a completeness yardstick. */
function countLikelyRoles(region: string): number {
  if (!region) return 0;
  let count = 0;
  for (const line of region.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 160) continue;
    if (/^\s*(?:[•▪◦‣∙·*]|[-–—]\s)/.test(trimmed)) continue; // bullets are not headers
    if (DATE_RANGE_RE.test(trimmed)) count += 1;
  }
  return count;
}

/** Split on blank lines so a chunk never cuts through the middle of a job. */
function chunkText(text: string, size: number, max: number): string[] {
  if (text.length <= size) return [text];
  const blocks = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > size) {
      chunks.push(current);
      current = block;
      if (chunks.length >= max - 1) break;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, max);
}

function boundText(text: string): { text: string; truncatedInput: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncatedInput: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncatedInput: true };
}

function promptFor(text: string, label = "Resume"): string {
  return `${label} text (verbatim, layout preserved):\n<<<RESUME\n${text}\nRESUME>>>\n\nExtract every entry. Do not stop early.`;
}

/* ------------------------------------------------------------------ */
/* Verification - the step that stops wrong data reaching the profile  */
/* ------------------------------------------------------------------ */

type Verification = { result: Parsed; warnings: string[] };

function verifyAgainstSource(parsed: Parsed, sourceText: string): Verification {
  const warnings: string[] = [];
  const haystack = alphanumeric(sourceText);
  const haystackDigits = digitsOf(sourceText);
  const result: Parsed = { ...parsed };

  const grounded = (value: unknown, minLength = 4): boolean => {
    const key = alphanumeric(String(value ?? ""));
    if (!key) return false;
    if (key.length < minLength) return true; // too short to judge
    if (haystack.includes(key)) return true;
    // Tolerate a dropped suffix such as "Inc" or a joined/expanded word.
    return key.length > 8 && haystack.includes(key.slice(0, Math.ceil(key.length * 0.8)));
  };

  /* ---- personal ---- */
  const personal = { ...(parsed.personal ?? {}) };
  const contacts = extractContacts(sourceText);

  if (personal.email && !haystack.includes(alphanumeric(personal.email))) {
    warnings.push("The extracted email was not found in the document; used the address printed on the resume instead.");
    personal.email = contacts.emails[0] ?? "";
  }
  if (!personal.email && contacts.emails[0]) personal.email = contacts.emails[0];

  if (personal.phone) {
    const digits = digitsOf(personal.phone);
    if (digits.length >= 7 && !haystackDigits.includes(digits)) {
      warnings.push("The extracted phone number was not found in the document; used the number printed on the resume instead.");
      personal.phone = contacts.phones[0] ?? "";
    }
  }
  if (!personal.phone && contacts.phones[0]) personal.phone = contacts.phones[0];

  for (const key of ["firstName", "lastName", "middleName"]) {
    if (personal[key] && !grounded(personal[key], 3)) {
      warnings.push(`Removed a ${key} that does not appear in the document.`);
      personal[key] = "";
    }
  }
  result.personal = personal;

  /* ---- experience ---- */
  const experience = Array.isArray(parsed.experience) ? parsed.experience : [];
  const keptExperience = experience.filter((entry: any) => {
    const company = String(entry?.company ?? "").trim();
    const title = String(entry?.title ?? "").trim();
    if (!company && !title) return false;
    const companyOk = !company || grounded(company);
    const titleOk = !title || grounded(title);
    if (!companyOk && !titleOk) {
      warnings.push(`Removed an invented role: "${title || company}".`);
      return false;
    }
    return true;
  });
  result.experience = sortByRecency(dedupeEntries(keptExperience.map(tidyRole).map(cleanDates), (e) =>
    `${alphanumeric(e.company)}|${alphanumeric(e.title)}|${e.startDate ?? ""}`
  ));

  /* ---- education ---- */
  const education = Array.isArray(parsed.education) ? parsed.education : [];
  const keptEducation: any[] = [];
  for (const entry of education) {
    const school = String(entry?.school ?? "").trim();
    const degree = String(entry?.degree ?? "").trim();
    if (!school && !degree) continue;

    if (school && !grounded(school)) {
      if (!degree || !grounded(degree)) {
        warnings.push(`Removed an invented education entry: "${school}".`);
        continue;
      }
      // The credential checks out but the institution does not - blank the
      // institution rather than presenting a name the resume never contained.
      warnings.push(`"${school}" was not found in the document, so the school was left blank.`);
      keptEducation.push({ ...entry, school: "" });
      continue;
    }
    keptEducation.push(entry);
  }
  result.education = sortByRecency(dedupeEntries(keptEducation.map(cleanDates), (e) =>
    `${alphanumeric(e.school)}|${alphanumeric(e.degree)}`
  ));

  /* ---- skills and certifications ---- */
  if (Array.isArray(parsed.skills)) {
    const before = parsed.skills.length;
    result.skills = parsed.skills
      .map((s: any) => typeof s === "string" ? s : String(s?.name ?? s?.skill ?? s?.label ?? s?.value ?? ""))
      .map((s: string) => s.replace(/^[-–—•*\s]+/, "").replace(/\s+/g, " ").trim())
      .filter((s: string) => s.length >= 2 && s.length <= 120)
      .filter((s: string) => grounded(s, s.length <= 3 ? 2 : 3));
    if (result.skills.length < before) {
      warnings.push(`Removed ${before - result.skills.length} skill(s) not present in the document.`);
    }
  }
  if (Array.isArray(parsed.certifications)) {
    result.certifications = parsed.certifications.filter((c: any) => grounded(c, 5));
  }

  /* ---- websites ---- */
  if (Array.isArray(parsed.websites)) {
    result.websites = parsed.websites.filter((w: any) => {
      const url = String(w?.url ?? "");
      if (!url) return false;
      const host = url.replace(/^https?:\/\//i, "").split("/")[0];
      return haystack.includes(alphanumeric(host));
    });
  }

  /* ---- summary ---- */
  if (parsed.summary && String(parsed.summary).length > 40) {
    const head = alphanumeric(String(parsed.summary).slice(0, 60));
    if (head && !haystack.includes(head.slice(0, 40))) {
      warnings.push("The summary did not match the document text and was dropped.");
      result.summary = "";
    }
  }

  return { result, warnings };
}

/**
 * Keep each experience field holding only what it is meant to hold.
 *
 * The model mostly gets this right, but when a resume writes
 * "Client: Regions Bank Feb 2026-Till Date" on one line it sometimes copies
 * the whole string into `company`, and "Microsoft   Redmond, WA" occasionally
 * lands wholesale in `location`. Correcting it here means a slip in either the
 * AI pass or the offline pass can never reach the profile.
 */
function tidyRole(entry: Record<string, any>): Record<string, any> {
  const out = { ...entry };

  // A date belongs in startDate/endDate, never in the employer or the title.
  for (const key of ["company", "title"] as const) {
    const value = String(out[key] ?? "").trim();
    if (!value) continue;
    const peeled = peelDates(value);
    if (peeled.text && peeled.text !== value) {
      out[key] = peeled.text;
      if (!out.startDate && peeled.range?.startDate) out.startDate = peeled.range.startDate;
      if (!out.endDate && peeled.range?.endDate) out.endDate = peeled.range.endDate;
      if (peeled.range?.current) out.current = true;
    }
  }

  // "ALLY Financials, Detroit, MI" in the employer field carries a place.
  const company = String(out.company ?? "").trim();
  if (company) {
    const split = trailingLocation(company);
    if (split.location && split.head) {
      out.company = split.head;
      if (!String(out.location ?? "").trim()) out.location = split.location;
    }
  }

  // "What you did" must not repeat the entry's own heading. A first line that
  // only restates the employer, the title or the dates is layout bleed-through
  // (the "Web Application Developer   Jun 2018" that appeared at the top of
  // the description), not something the candidate did.
  const description = String(out.description ?? "");
  if (description.trim()) {
    const heading = [out.company, out.title, out.location]
      .map((v) => alphanumeric(String(v ?? "")))
      .filter(Boolean);
    const lines = description.split("\n");
    while (lines.length) {
      const first = lines[0].trim();
      const bare = alphanumeric(peelDates(first).text);
      const isHeadingEcho =
        !first || (first.length <= 90 && (!bare || heading.includes(bare)));
      if (!isHeadingEcho) break;
      lines.shift();
    }
    out.description = lines.join("\n").trim();
  }

  // The employer is not a location. Strip it, and drop what remains if the
  // field held nothing else.
  const location = String(out.location ?? "").trim();
  const finalCompany = String(out.company ?? "").trim();
  if (location && finalCompany && location.toLowerCase().includes(finalCompany.toLowerCase())) {
    const stripped = location
      .replace(new RegExp(finalCompany.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "")
      .replace(/^[\s,;|·•-]+|[\s,;|·•-]+$/g, "")
      .trim();
    out.location = stripped;
  }

  return out;
}

/** Clamp impossible dates and keep `current` consistent with `endDate`. */
function cleanDates<T extends Record<string, any>>(entry: T): T {
  const out: Record<string, any> = { ...entry };
  const thisYear = new Date().getFullYear();

  const sane = (value: unknown): string => {
    const s = String(value ?? "").trim();
    const m = s.match(/^(\d{4})-(\d{2})$/);
    if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : "";
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year < 1940 || year > thisYear + 8) return "";
    if (month < 1 || month > 12) return `${m[1]}-01`;
    return s;
  };

  out.startDate = sane(out.startDate);
  out.endDate = sane(out.endDate);

  // "Present" belongs in `current`, never in `endDate`.
  if (/present|current|now|ongoing|till/i.test(String(entry.endDate ?? ""))) {
    out.current = true;
    out.endDate = "";
  }
  if (out.current === true) out.endDate = "";
  if (out.endDate) out.current = false;

  // A range that runs backwards is a mis-read; keep the earlier one as start.
  if (out.startDate && out.endDate && out.startDate > out.endDate) {
    const start = out.endDate;
    out.endDate = out.startDate;
    out.startDate = start;
  }
  return out as T;
}

function dedupeEntries<T extends Record<string, any>>(entries: T[], keyOf: (e: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key.replace(/\|/g, "")) continue;
    const existing = byKey.get(key);
    // Keep whichever copy carries more detail.
    if (!existing || JSON.stringify(entry).length > JSON.stringify(existing).length) {
      byKey.set(key, entry);
    }
  }
  const out: T[] = [];
  byKey.forEach((value) => out.push(value));
  return out;
}

function sortByRecency<T extends Record<string, any>>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (b.current && !a.current) return 1;
    const aKey = String(a.endDate || a.startDate || "");
    const bKey = String(b.endDate || b.startDate || "");
    if (aKey && bKey && aKey !== bKey) return bKey.localeCompare(aKey);
    return String(b.startDate ?? "").localeCompare(String(a.startDate ?? ""));
  });
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

const ARRAY_KEYS = ["skills", "certifications", "education", "experience", "websites"] as const;
const OBJECT_KEYS = ["personal", "workAuth", "compensation", "eeo"] as const;

/** `primary` wins; `secondary` only fills what primary left empty. */
function mergeParses(primary: Parsed, secondary: Parsed): Parsed {
  const result: Parsed = { ...secondary, ...primary };

  for (const key of OBJECT_KEYS) {
    const a = (primary?.[key] ?? {}) as Record<string, unknown>;
    const b = (secondary?.[key] ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...b };
    for (const [k, v] of Object.entries(a)) {
      if (v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) merged[k] = v;
    }
    result[key] = merged;
  }

  for (const key of ARRAY_KEYS) {
    const a = Array.isArray(primary?.[key]) ? primary[key] : [];
    const b = Array.isArray(secondary?.[key]) ? secondary[key] : [];
    if (key === "skills" || key === "certifications") {
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const item of [...a, ...b]) {
        const value = typeof item === "string" ? item : String(item?.name ?? item?.skill ?? item?.label ?? item?.value ?? "");
        const clean = value.replace(/^[-–—•*\s]+/, "").replace(/\s+/g, " ").trim();
        const k = clean.toLowerCase().replace(/[^a-z0-9+#.]/g, "");
        if (!clean || seen.has(k)) continue;
        seen.add(k);
        merged.push(clean);
      }
      result[key] = merged.slice(0, key === "skills" ? 180 : 80);
    } else {
      result[key] = a.length ? a : b;
    }
  }

  for (const key of ["summary", "targetRole"]) {
    if (!result[key] && secondary?.[key]) result[key] = secondary[key];
  }
  return result;
}

/** Add roles the primary pass missed entirely, matched by employer. */
function unionExperience(primary: any[], extra: any[]): any[] {
  const seen = new Set(
    primary.map((e) => `${alphanumeric(e?.company)}|${alphanumeric(e?.title)}`)
  );
  const companies = new Set(primary.map((e) => alphanumeric(e?.company)).filter(Boolean));
  const out = [...primary];

  for (const entry of extra) {
    const key = `${alphanumeric(entry?.company)}|${alphanumeric(entry?.title)}`;
    if (seen.has(key)) continue;
    // Same employer with a different title is a real second entry (promotion),
    // but only trust that when the primary pass produced nothing for it.
    const company = alphanumeric(entry?.company);
    if (company && companies.has(company) && !entry?.title) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AI passes                                                           */
/* ------------------------------------------------------------------ */

type PassOutcome = { data: Parsed; truncated: boolean; model: string };

async function runFullPass(text: string, deadline: number): Promise<PassOutcome> {
  const { data, truncated, model } = await askAISchema<Parsed>(
    RESUME_SYSTEM,
    promptFor(text),
    RESUME_SCHEMA,
    { deadline, maxTokens: 32768, timeoutMs: Math.max(6000, deadline - now()) }
  );
  return { data: data ?? {}, truncated, model };
}

async function runProfilePass(text: string, deadline: number): Promise<PassOutcome> {
  const { data, truncated, model } = await askAISchema<Parsed>(
    PROFILE_SYSTEM,
    promptFor(text),
    PROFILE_SCHEMA,
    { deadline, maxTokens: 16384, timeoutMs: Math.max(6000, deadline - now()) }
  );
  return { data: data ?? {}, truncated, model };
}

async function runExperiencePass(text: string, deadline: number, label = "Resume"): Promise<PassOutcome> {
  const { data, truncated, model } = await askAISchema<Parsed>(
    EXPERIENCE_SYSTEM,
    promptFor(text, label),
    EXPERIENCE_SCHEMA,
    { deadline, maxTokens: 32768, timeoutMs: Math.max(6000, deadline - now()) }
  );
  return { data: data ?? {}, truncated, model };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export type ParseResumeInput = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** Absolute deadline in ms. Defaults to the platform budget. */
  deadline?: number;
  /** Accepted for backwards compatibility; the schema now drives extraction. */
  system?: string;
  shape?: string;
};

export async function parseResumeDocument(input: ParseResumeInput): Promise<Parsed> {
  const started = now();
  const deadline = input.deadline ?? started + parseBudgetMs();
  const warnings: string[] = [];

  let extracted: ExtractedResume;
  try {
    extracted = await extractResumeDetailed(input);
  } catch (err: any) {
    // A file we cannot read at all is only recoverable through vision.
    const kind = detectResumeFileKind(input.buffer, input.mimeType, input.filename);
    if (kind === "pdf" && aiEnabled()) {
      extracted = { text: "", kind, pages: 0, quality: 0, notes: ["extract-threw"] };
    } else {
      throw err;
    }
  }

  // Normalized source text used to ground merged skills against the resume.
  // This must live in parseResumeDocument because the final skill merge below
  // runs outside verifyAgainstSource, where its local `haystack` does not exist.
  const haystack = alphanumeric(extracted.text);

  const meta: ParseMeta = {
    source: "local",
    model: "",
    fileKind: extracted.kind,
    pages: extracted.pages,
    chars: extracted.text.length,
    textQuality: Number(extracted.quality.toFixed(2)),
    strategy: "none",
    durationMs: 0,
    warnings,
    aiUsed: false,
  };

  const finish = (data: Parsed): Parsed => {
    meta.durationMs = now() - started;
    return { ...data, _meta: meta };
  };

  /* ---------- no AI configured ---------- */
  if (!aiEnabled()) {
    if (!extracted.text.trim()) {
      throw new Error(
        extracted.kind === "image" || extracted.kind === "pdf"
          ? "This looks like a scanned resume. Reading it needs AI, which is not configured on this deployment."
          : "We couldn't read any text from that file."
      );
    }
    meta.strategy = "local-only";
    warnings.push("AI parsing is not configured, so this profile came from basic text extraction and may be incomplete.");
    return finish(fallbackParseResumeText(extracted.text));
  }

  /* ---------- scanned / image / unreadable: let the model see the file ---------- */
  const needsVision =
    extracted.kind === "image" ||
    !extracted.text.trim() ||
    extracted.text.trim().length < 200 ||
    (extracted.kind === "pdf" && extracted.quality < 0.5);

  if (needsVision) {
    const visionMime =
      extracted.kind === "image"
        ? input.mimeType || "image/jpeg"
        : "application/pdf";

    if (extracted.kind === "image" || extracted.kind === "pdf") {
      try {
        meta.strategy = "vision";
        const { data, model } = await askAISchemaWithFile<Parsed>(
          `${RESUME_SYSTEM}\n\nThe attached file is a resume. Read every page, using OCR where the text is an image. Transcribe exactly what is printed.`,
          input.buffer,
          visionMime,
          RESUME_SCHEMA,
          { deadline, timeoutMs: Math.max(8000, deadline - now()) }
        );
        meta.source = "ai-vision";
        meta.model = model;
        meta.aiUsed = true;
        if (extracted.text.trim()) {
          const verified = verifyAgainstSource(data, extracted.text);
          warnings.push(...verified.warnings);
          return finish(verified.result);
        }
        // Nothing to verify against, so trust the transcription but tidy it.
        const tidied: Parsed = { ...data };
        tidied.experience = sortByRecency(
          dedupeEntries((Array.isArray(data.experience) ? data.experience : []).map(tidyRole).map(cleanDates), (e) =>
            `${alphanumeric(e.company)}|${alphanumeric(e.title)}|${e.startDate ?? ""}`)
        );
        tidied.education = sortByRecency(
          dedupeEntries((Array.isArray(data.education) ? data.education : []).map(cleanDates), (e) =>
            `${alphanumeric(e.school)}|${alphanumeric(e.degree)}`)
        );
        return finish(tidied);
      } catch (err: any) {
        console.error("[resume-parse] vision pass failed", err);
        if (!extracted.text.trim()) {
          throw new Error(
            "We couldn't read this file. If it is a scan or a photo, try a clearer image or export the resume as a text-based PDF."
          );
        }
        warnings.push("Reading the original file failed, so the extracted text was used instead.");
      }
    }
  }

  /* ---------- text route ---------- */
  if (extracted.text.trim().length < 40) {
    // Reached only when the vision path was unavailable or failed.
    throw new Error(
      "We couldn't read any text from that file. If it is a scan or a photo, upload a clearer image or export a text-based PDF."
    );
  }

  const { text: bounded, truncatedInput } = boundText(extracted.text);
  if (truncatedInput) {
    warnings.push(`This document is unusually long; the first ${MAX_TEXT_CHARS.toLocaleString()} characters were parsed.`);
  }
  if (extracted.quality < 0.65) {
    warnings.push("The text layer in this file is low quality, so some values may need checking.");
  }

  const sections = splitSections(bounded);
  const region = experienceRegion(sections);
  const expectedRoles = countLikelyRoles(region || bounded);
  const localParse = fallbackParseResumeText(bounded);

  let primary: Parsed = {};
  let truncated = false;
  let model = "";
  let aiFailed = false;

  try {
    if (bounded.length <= SINGLE_PASS_LIMIT) {
      meta.strategy = "single-pass";
      const pass = await runFullPass(bounded, deadline);
      primary = pass.data;
      truncated = pass.truncated;
      model = pass.model;
    } else {
      // Two independent passes in parallel: same wall clock as one call, but
      // each gets its own full output budget, which is what stops long
      // resumes from losing their older roles.
      const expText = region.length > 400 ? region : bounded;
      const needsChunking = expText.length > CHUNK_LIMIT;
      meta.strategy = needsChunking ? "parallel-chunked" : "parallel-two-pass";

      const experienceInputs = needsChunking ? chunkText(expText, CHUNK_SIZE, MAX_CHUNKS) : [expText];
      if (needsChunking) warnings.push(`Work history was read in ${experienceInputs.length} parts.`);

      const jobs: Array<Promise<PassOutcome>> = [
        runProfilePass(bounded, deadline),
        ...experienceInputs.map((chunk, index) =>
          runExperiencePass(chunk, deadline, experienceInputs.length > 1 ? `Resume part ${index + 1}` : "Resume")
        ),
      ];

      const settled = await Promise.allSettled(jobs);
      const [profileResult, ...experienceResults] = settled;

      if (profileResult.status === "fulfilled") {
        primary = { ...profileResult.value.data };
        truncated = truncated || profileResult.value.truncated;
        model = profileResult.value.model;
      } else {
        warnings.push("The contact and education pass failed; those sections came from text extraction.");
      }

      const roles: any[] = [];
      let anyExperience = false;
      for (const result of experienceResults) {
        if (result.status !== "fulfilled") continue;
        anyExperience = true;
        truncated = truncated || result.value.truncated;
        model = model || result.value.model;
        const list = Array.isArray(result.value.data?.experience) ? result.value.data.experience : [];
        roles.push(...list);
      }
      if (!anyExperience) warnings.push("The work history pass failed; work history came from text extraction.");
      primary.experience = roles;

      // Both concurrent passes failed. `Promise.allSettled` swallows their
      // rejections, so say so explicitly rather than reporting a successful
      // AI parse that produced nothing.
      if (profileResult.status !== "fulfilled" && !anyExperience) {
        aiFailed = true;
        const reason =
          profileResult.status === "rejected"
            ? String((profileResult.reason as any)?.message ?? profileResult.reason)
            : "unknown error";
        warnings.push(`AI parsing failed (${reason.slice(0, 140)}). This profile came from basic text extraction.`);
      }
    }
  } catch (err: any) {
    console.error("[resume-parse] AI pass failed", err);
    aiFailed = true;
    warnings.push(`AI parsing failed (${String(err?.message ?? "unknown error").slice(0, 140)}). This profile came from basic text extraction.`);
  }

  const roleCount = Array.isArray(primary.experience) ? primary.experience.length : 0;

  /* ---------- recovery pass for short or truncated answers ---------- */
  const looksShort = expectedRoles >= 2 && roleCount > 0 && roleCount < Math.ceil(expectedRoles * 0.7);
  if (!aiFailed && (truncated || looksShort) && region && now() < deadline - 8000) {
    try {
      meta.strategy += "+recovery";
      const listed = (primary.experience ?? [])
        .map((e: any) => `- ${e?.title ?? "?"} at ${e?.company ?? "?"}`)
        .join("\n");
      const recovery = await askAISchema<Parsed>(
        EXPERIENCE_SYSTEM,
        `${promptFor(region)}\n\nThese roles have already been captured:\n${listed || "(none)"}\n\nReturn the COMPLETE experience array for this text, including the roles listed above and every role that is missing from that list.`,
        EXPERIENCE_SCHEMA,
        { deadline, maxTokens: 32768, timeoutMs: Math.max(6000, deadline - now()) }
      );
      const recovered = Array.isArray(recovery.data?.experience) ? recovery.data.experience : [];
      if (recovered.length) {
        primary.experience = unionExperience(primary.experience ?? [], recovered);
        meta.source = "ai+recovery";
      }
    } catch (err) {
      console.error("[resume-parse] recovery pass failed", err);
      warnings.push("Some older roles may be missing - please check the work history before saving.");
    }
  }

  /* ---------- verify, then fill gaps from local extraction ---------- */
  if (aiFailed) {
    meta.strategy = meta.strategy === "none" ? "local-only" : `${meta.strategy}+local`;
    return finish(localParse);
  }

  meta.aiUsed = true;
  meta.model = model;
  if (meta.source === "local") meta.source = "ai";

  const verified = verifyAgainstSource(primary, bounded);
  warnings.push(...verified.warnings);

  const merged = mergeParses(verified.result, localParse);

  // If the model returned nothing for work history but the document clearly
  // has some, fall back rather than showing an empty section.
  if (!merged.experience?.length && Array.isArray(localParse.experience) && localParse.experience.length) {
    merged.experience = sortByRecency((localParse.experience as any[]).map(tidyRole).map(cleanDates));
    warnings.push("Work history came from text extraction - please review it before saving.");
    meta.source = "ai-partial";
  }
  if (!merged.education?.length && Array.isArray(localParse.education) && localParse.education.length) {
    merged.education = sortByRecency((localParse.education as any[]).map(cleanDates));
    warnings.push("Education came from text extraction - please review it before saving.");
    meta.source = "ai-partial";
  }

  // Keep every grounded skill from both the AI pass and the deterministic text
  // pass. This prevents short skills such as C, R, Go, AWS, and AI from being
  // lost just because one parser normalised them differently.
  const skillSeen = new Set<string>();
  const allSkills = [...(Array.isArray(merged.skills) ? merged.skills : []), ...(Array.isArray(localParse.skills) ? localParse.skills : [])];
  merged.skills = allSkills
    .map((s: any) => String(s?.name ?? s?.skill ?? s?.label ?? s?.value ?? s ?? "").replace(/\s+/g, " ").trim())
    .filter((s: string) => s.length >= 2 && s.length <= 120)
    .filter((s: string) => {
      const k = s.toLowerCase().replace(/[^a-z0-9+#.]/g, "");
      if (!k || skillSeen.has(k)) return false;
      skillSeen.add(k);
      return alphanumeric(s).length < 3 || haystack.includes(alphanumeric(s)) || haystack.includes(alphanumeric(s).slice(0, Math.max(2, Math.ceil(alphanumeric(s).length * 0.8))));
    })
    .slice(0, 180);

  return finish(merged);
}
