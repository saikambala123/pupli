/**
 * Deterministic resume parsing.
 *
 * Two jobs:
 *  1. the offline path when Gemini is unreachable or unconfigured, and
 *  2. the grounding source that verifies the model's answer.
 *
 * The version this replaces was the direct cause of the bad education data:
 * it treated EVERY line under an "Education" heading as a separate school, so
 * a GPA line, a coursework line and a date line each became their own
 * institution. Experience was just as loose - any line containing a date range
 * became a job, with the title and company guessed by splitting on whatever
 * punctuation happened to be there.
 *
 * This version segments the document into blocks first and classifies each
 * block as a whole, which is how a human reads a resume.
 */

import { normaliseExtractedText } from "./resume-text";
import { fieldFromDegree } from "./profile-shape";

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export type SectionName =
  | "summary" | "experience" | "education" | "skills" | "certifications"
  | "projects" | "links" | "awards" | "publications" | "volunteer"
  | "languages" | "interests" | "references" | "contact" | "other";

const SECTION_PATTERNS: Array<[SectionName, RegExp]> = [
  ["summary", /^(professional\s+)?(summary|profile|objective|about( me)?|career\s+(summary|objective|profile)|personal\s+(statement|profile)|overview|introduction)$/],
  ["experience", /^(work|professional|employment|industry|relevant|career)?\s*(experience|history|background|employment|record)$/],
  ["experience", /^(experience|employment|work history|professional background|career history|positions? held|professional experience|work experience)$/],
  ["education", /^(education|academics?|academic (background|qualifications?|history|record)|educational (background|qualifications?)|qualifications?|scholastic record)$/],
  ["skills", /^(technical\s+)?(skills?|competenc(y|ies)|expertise|proficienc(y|ies)|technologies|tech stack|core competencies|areas of expertise|technical proficiency|skills? (&|and) (abilities|competencies)|toolkit)$/],
  ["certifications", /^(certifications?|licenses?|licences?|credentials?|certificates?|courses?|training|professional development|certifications? (&|and) licen[cs]es)$/],
  ["projects", /^(projects?|personal projects?|key projects?|selected projects?|academic projects?|side projects?|portfolio)$/],
  ["links", /^(links?|profiles?|social|online presence|websites?|contact links?)$/],
  ["awards", /^(awards?|honou?rs?|achievements?|accomplishments?|recognition|awards? (&|and) honou?rs?)$/],
  ["publications", /^(publications?|papers?|research|patents?|conferences?|talks?)$/],
  ["volunteer", /^(volunteer(ing)?|community( (service|involvement))?|extracurriculars?|activities|leadership)$/],
  ["languages", /^(languages?|language proficiency)$/],
  ["interests", /^(interests?|hobbies|personal interests?)$/],
  ["references", /^(references?|referees?)$/],
];

const SECTION_LOOKUP_LIMIT = 60;

/** Qualifiers people put in front of a heading: "SELECTED PUBLICATIONS". */
const HEADING_QUALIFIERS = /^(selected|key|relevant|additional|other|notable|core|technical|academic|professional|major|recent|previous|related|summary of)\s+/;

function normaliseHeading(line: string): string {
  return line
    .replace(/^[•\-*–_=~#>\s]+/, "")
    .replace(/[:：]\s*$/, "")
    .replace(/[•\-*–_=~#\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A heading is short, has no sentence punctuation, and matches a known name. */
export function headingFor(line: string): SectionName | null {
  const raw = line.trim();
  if (!raw || raw.length > SECTION_LOOKUP_LIMIT) return null;
  if (/[.!?]\s*$/.test(raw)) return null;
  if (/@|https?:\/\//i.test(raw)) return null;

  const key = normaliseHeading(raw);
  if (!key || key.length < 3) return null;

  // Try the heading as written, then without a leading qualifier, then just
  // its first part - "SELECTED PUBLICATIONS", "EDUCATION & CERTIFICATIONS".
  const candidates = [key];

  // A table header is a heading too: "Skill   Years of Experience   Last Used"
  // introduces a skills table, and its first column names the section.
  const firstColumn = raw.split(/\s{2,}|\s*\|\s*/)[0];
  if (firstColumn && firstColumn !== raw) {
    const columnKey = normaliseHeading(firstColumn);
    if (columnKey && columnKey.length >= 3) candidates.push(columnKey);
  }
  const unqualified = key.replace(HEADING_QUALIFIERS, "");
  if (unqualified !== key) candidates.push(unqualified);
  for (const base of [...candidates]) {
    const head = base.split(/\s*(?:&|\band\b|\/|\||,)\s*/)[0];
    if (head && head !== base) candidates.push(head);
  }

  for (const candidate of candidates) {
    for (const [name, pattern] of SECTION_PATTERNS) {
      if (pattern.test(candidate)) return name;
    }
  }
  return null;
}

export type Section = { name: SectionName; heading: string; lines: string[] };

/** Split a resume into labelled sections. Everything before the first heading is "contact". */
export function splitSections(text: string): Section[] {
  const lines = normaliseExtractedText(text).split("\n");
  const sections: Section[] = [{ name: "contact", heading: "", lines: [] }];

  for (const line of lines) {
    const heading = headingFor(line);
    if (heading) {
      sections.push({ name: heading, heading: line.trim(), lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  return sections.filter((s) => s.lines.some((l) => l.trim()) || s.heading);
}

export function sectionText(sections: Section[], ...names: SectionName[]): string {
  return sections
    .filter((s) => names.includes(s.name))
    .map((s) => s.lines.join("\n"))
    .join("\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12,
};

const MONTH_WORDS = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const PRESENT_WORDS = "present|current|now|to date|till date|till now|ongoing|date|présent";

const DATE_TOKEN = `(?:(?:${MONTH_WORDS})[a-z]*\\.?[\\s,.\\-]*(?:'|’)?\\d{2,4}|\\d{1,2}[\\/.\\-]\\d{4}|\\d{4}[\\/.\\-]\\d{1,2}|(?:19|20)\\d{2})`;

export const DATE_RANGE_RE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to|until|through|›|»)\\s*(${PRESENT_WORDS}|${DATE_TOKEN})`,
  "i"
);

const SINGLE_DATE_RE = new RegExp(`\\b(${DATE_TOKEN})\\b`, "i");

/** "March 2021", "03/2021", "2021", "Mar '21" -> "2021-03". */
export function toMonth(value: string): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (new RegExp(`^(?:${PRESENT_WORDS})$`, "i").test(s)) return "";
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);

  const named = s.toLowerCase().match(new RegExp(`^(${MONTH_WORDS})[a-z]*\\.?[\\s,.\\-]*(?:'|’)?(\\d{2,4})$`, "i"));
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const year = expandYear(named[2]);
    if (month && year) return `${year}-${String(month).padStart(2, "0")}`;
  }

  const slash = s.match(/^(\d{1,2})[\/.\-](\d{4})$/);
  if (slash) {
    const month = Number(slash[1]);
    if (month >= 1 && month <= 12) return `${slash[2]}-${String(month).padStart(2, "0")}`;
  }

  const isoish = s.match(/^(\d{4})[\/.\-](\d{1,2})$/);
  if (isoish) {
    const month = Number(isoish[2]);
    if (month >= 1 && month <= 12) return `${isoish[1]}-${String(month).padStart(2, "0")}`;
  }

  const yearOnly = s.match(/^(?:19|20)\d{2}$/);
  if (yearOnly) return `${s}-01`;

  const embedded = s.match(/\b((?:19|20)\d{2})\b/);
  return embedded ? `${embedded[1]}-01` : "";
}

function expandYear(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  if (raw.length === 4) return String(n);
  if (raw.length === 2) return n <= 40 ? `20${raw.padStart(2, "0")}` : `19${raw}`;
  return "";
}

export type DateRange = { startDate: string; endDate: string; current: boolean; matched: string };

export function findDateRange(text: string): DateRange | null {
  const match = text.match(DATE_RANGE_RE);
  if (!match) return null;
  const current = new RegExp(`^(?:${PRESENT_WORDS})$`, "i").test(match[2].trim());
  return {
    startDate: toMonth(match[1]),
    endDate: current ? "" : toMonth(match[2]),
    current,
    matched: match[0],
  };
}

export function findSingleDate(text: string): string {
  const match = text.match(SINGLE_DATE_RE);
  return match ? toMonth(match[1]) : "";
}

/* ------------------------------------------------------------------ */
/* Contact details                                                     */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()\[\],;"']+|(?:linkedin|github|gitlab|bitbucket|behance|dribbble|medium|stackoverflow|kaggle|leetcode)\.com\/[^\s<>()\[\],;"']+/gi;

/**
 * Phone candidates. Deliberately broad, then validated below - a strict
 * pattern used to clip the last digit off numbers like "+91 98450 22317".
 * The en dash is excluded so date ranges ("2013 – 2017") never match.
 */
const PHONE_RE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{1,4}\)[\s.\-]?)?\d[\d\s.\-]{5,18}\d/g;
const YEAR_RANGE_RE = /^\D*(?:19|20)\d{2}\D+(?:19|20)\d{2}\D*$/;

export function extractContacts(text: string) {
  const emails = Array.from(new Set((text.match(EMAIL_RE) ?? []).map((e) => e.replace(/[.,;:]+$/, ""))));

  const urls = Array.from(
    new Set(
      (text.match(URL_RE) ?? []).map((raw) => {
        let url = raw.replace(/[.,;:]+$/, "");
        if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^www\./i, "www.")}`;
        return url;
      })
    )
  ).filter((u) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(u));

  // Digits inside a URL or an email are not a phone number. A profile slug
  // like "linkedin.com/in/s-895668237" was being read as the candidate's
  // mobile, displacing the real one.
  const withoutLinks = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");

  const phones: string[] = [];
  for (const raw of withoutLinks.match(PHONE_RE) ?? []) {
    const candidate = raw.trim().replace(/[\s.\-]+$/, "").replace(/\s+/g, " ");
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    // Year ranges, single years and GPA-like runs are not phone numbers.
    if (YEAR_RANGE_RE.test(candidate)) continue;
    if (/^(19|20)\d{2}$/.test(digits)) continue;
    phones.push(candidate);
  }

  return { emails, urls, phones: Array.from(new Set(phones)) };
}

export function labelForUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("linkedin")) return "LinkedIn";
  if (u.includes("github")) return "GitHub";
  if (u.includes("twitter.com") || u.includes("//x.com") || u.includes(".x.com")) return "Twitter/X";
  if (u.includes("dribbble")) return "Dribbble";
  if (u.includes("behance")) return "Behance";
  if (u.includes("gitlab") || u.includes("bitbucket") || u.includes("stackoverflow") || u.includes("kaggle") || u.includes("leetcode") || u.includes("medium")) {
    return "Portfolio";
  }
  return "Portfolio";
}

/* ------------------------------------------------------------------ */
/* Name                                                                */
/* ------------------------------------------------------------------ */

const NON_NAME_WORDS = new Set([
  "resume", "cv", "curriculum", "vitae", "profile", "summary", "objective",
  "contact", "portfolio", "engineer", "developer", "manager", "analyst",
  "consultant", "designer", "student", "intern", "senior", "junior", "lead",
]);

/**
 * Tools and technologies that sit on the headline right under the name.
 * Without these, "TOSCA Automation Test Lead" scored as a perfectly good
 * four-word name and the profile came back called "Tosca".
 */
const TOOL_WORDS = /\b(tosca|selenium|cypress|playwright|appium|jira|sap|salesforce|servicenow|workday|oracle|azure|aws|gcp|java|python|dotnet|react|angular|node|devops|qa|sdet|etl|erp|crm|scrum|agile|automation|testing|test|full[\s-]?stack|frontend|backend|cloud|data|business|senior|junior|lead|specialist|professional|certified|resume|curriculum|vitae)\b/i;

/** Tokens from the email local part, e.g. "sowjanya.pqa" -> {sowjanya, pqa}. */
function emailTokens(text: string): Set<string> {
  const email = text.match(EMAIL_RE)?.[0] ?? "";
  const local = email.split("@")[0] ?? "";
  return new Set(
    local
      .split(/[._\-+0-9]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 3)
  );
}

export function guessName(
  text: string,
  fullText = text
): { firstName: string; middleName: string; lastName: string; full: string } {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  const tokens = emailTokens(fullText);

  // A narrow header column often wraps the name: "Priya" / "Raghunathan".
  // Consider each line, each line joined with the one after it, and each
  // column of a multi-column header row - "Srinivasa Ajay Babu   Mobile: +1..."
  // puts the name and the phone side by side, and judging the whole row
  // rejected it for containing digits.
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].replace(/^\s*(?:name|full name)\s*[:：]\s*/i, "");
    lines.push(row);
    for (const column of splitHeaderLine(row)) {
      if (column && column !== row) lines.push(column.replace(/^\s*(?:name|full name)\s*[:：]\s*/i, ""));
    }
    if (row.split(/\s+/).length === 1 && rows[i + 1] && rows[i + 1].split(/\s+/).length <= 2) {
      lines.push(`${row} ${rows[i + 1]}`);
    }
  }

  type Candidate = { words: string[]; score: number; order: number };
  const candidates: Candidate[] = [];

  lines.forEach((line, order) => {
    const candidate = line.replace(/[|•·,]+.*$/, "").trim();
    if (candidate.length < 2 || candidate.length > 60) return;
    if (/@|https?:\/\/|\d/.test(candidate)) return;
    if (headingFor(candidate)) return;

    const words = candidate.split(/\s+/).filter(Boolean);
    // Mononyms are common; five words is the practical upper bound for a name.
    if (words.length < 1 || words.length > 5) return;
    if (!words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*$/.test(w))) return;
    if (words.some((w) => NON_NAME_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return;

    // A headline is not a name.
    if (TITLE_HINTS.test(candidate) || TITLE_PREFIX.test(candidate) || TOOL_WORDS.test(candidate)) return;

    let score = 10 - order;                       // earlier lines win ties
    const matched = words.filter((w) => tokens.has(w.toLowerCase().replace(/[^a-z]/g, ""))).length;
    // Matching the email local part is near-proof this really is the name.
    score += matched * 25;
    if (words.length >= 2) score += 4;
    if (candidate === candidate.toUpperCase() && candidate.length > 3) score += 2;

    candidates.push({ words, score, order });
  });

  if (!candidates.length) return { firstName: "", middleName: "", lastName: "", full: "" };

  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const clean = best.words;
  return {
    firstName: clean[0],
    middleName: clean.length > 2 ? clean.slice(1, -1).join(" ") : "",
    lastName: clean.length > 1 ? clean[clean.length - 1] : "",
    full: clean.join(" "),
  };
}

/* ------------------------------------------------------------------ */
/* Block segmentation                                                  */
/* ------------------------------------------------------------------ */

const BULLET_RE = /^\s*(?:[•▪◦‣∙·*]|[-–—](?=\s)|\d{1,2}[.)]\s)/;

function isBullet(line: string) {
  return BULLET_RE.test(line);
}

/** Abbreviations that end in a full stop without ending a sentence. */
const ABBREV_TAIL = /\b(inc|ltd|llc|corp|co|plc|pvt|gmbh|jr|sr|ph|d|univ|dept|st|ave)\.$/i;

/**
 * A line ending in a full stop is prose, not an entry header - unless the
 * stop belongs to an abbreviation such as "Cognizant Solutions, Inc.".
 * The old eight-word threshold let short bullets ("Building internal tooling
 * in Java.") be read as an employer name.
 */
/** Verbs that open an achievement bullet. A heading never starts this way. */
const ACHIEVEMENT_VERB =
  /^(built|designed|led|developed|implemented|created|managed|improved|reduced|increased|delivered|migrated|automated|deployed|integrated|executed|collaborated|ensured|prototyped|grew|drove|owned|wrote|tested|maintained|supported|achieved|streamlined|optimi[sz]ed|architected|mentored|coordinated|analy[sz]ed|performed|conducted|participated|worked|assisted|handled|resolved|configured|installed|trained|published|presented|spearheaded|launched|scaled|refactored|documented|responsible|involved|used|using|utilized|utilised|generated|provided|enabled|enhanced|established|introduced|monitored|reviewed|validated|verified)\b/i;

/**
 * Is this line the heading of a work-history entry?
 *
 * Crucially this ignores a leading bullet glyph. Plenty of resumes - the one
 * that triggered this fix included - format the employer line as a bullet:
 *
 *     •Optum   Aug 2025 - Present
 *     AI & Machine Learning Engineer
 *     •Generative AI Solutions: ...
 *
 * Treating that first line as description meant the block had no date, so the
 * entire work history was discarded, and the employer and dates showed up
 * inside "What you did" instead.
 */
export function isEntryHeader(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 160) return false;

  const bare = trimmed.replace(BULLET_RE, "").trim();
  if (!bare) return false;

  const range = findDateRange(bare);
  if (!range) return false;

  // Whatever is left once the dates are removed must read like a name, not
  // like a sentence about what someone accomplished.
  const rest = stripDates(bare, range);
  if (!rest) return true; // a bare date line still anchors an entry
  if (rest.length > 80) return false;
  if (ACHIEVEMENT_VERB.test(rest)) return false;
  if (/[.;:]$/.test(rest)) return false;

  const words = rest.split(/\s+/).filter(Boolean).length;
  return words <= 8;
}

function looksLikeSentence(line: string): boolean {
  const trimmed = line.trim();
  if (isEntryHeader(trimmed)) return false;
  if (!/[.!?]$/.test(trimmed)) return false;
  if (ABBREV_TAIL.test(trimmed)) return false;
  return trimmed.split(/\s+/).length >= 5;
}

/**
 * Group section lines into entry blocks.
 *
 * A new block starts at a blank line, or when a second date range appears in a
 * block that already has one. In the second case the header lines that were
 * already collected for the new entry (its title and employer, which are
 * printed above its dates) are carried over, so a job never inherits the
 * previous job's employer.
 */
/**
 * Rejoin a bullet that the page layout wrapped onto a second line.
 *
 * PDFs break a long bullet wherever the column ends:
 *
 *     •Generative AI Solutions: Designed and fine-tuned GPT-4 solutions for
 *     clinical documentation, member support automation.
 *
 * The orphaned tail is not a bullet and is often too short to read as a
 * sentence, so it was classified as a heading - which is how fragments like
 * "transformation workflows." ended up in the Job title field and how stray
 * text appeared at the top of "What you did".
 */
function joinWrappedLines(lines: string[]): string[] {
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { out.push(""); continue; }

    const previous = (out[out.length - 1] ?? "").trim();
    // Nothing ever wraps onto an entry heading or a section heading.
    const canContinue = Boolean(previous) && !isEntryHeader(previous) && !headingFor(previous);

    // A line that names a credential together with a school or a year is its
    // own education entry, not the tail of the line above. Two such lines in a
    // row are two degrees, and joining them lost one.
    const startsEducationEntry =
      looksLikeDegree(line) && (SCHOOL_HINTS.test(line) || /\b(?:19|20)\d{2}\b/.test(line));

    const startsSomethingNew =
      isBullet(line) || isEntryHeader(line) || Boolean(headingFor(line)) || startsEducationEntry;

    // Only join on a real wrap signal:
    //  - the tail starts lowercase or with a connector, or
    //  - the line above ended mid-clause, or
    //  - the line above filled its column and did not end a sentence.
    // Without these tests, "Master's in Computer Science" was glued onto the
    // school line above it and the degree disappeared.
    // A line carrying layout separators ("Acme • Boston, MA • Full-time") is a
    // meta line, never a wrapped sentence - do not let it swallow the bullet
    // beneath it. The leading bullet glyph itself does not count.
    const previousBare = previous.replace(BULLET_RE, "").trim();
    const previousIsMeta = /[•·|‖]|\s{2,}/.test(previousBare);

    const endsOpen = !/[.!?:;]$/.test(previous);
    const continuesPrevious =
      /^[a-z&(),\/\-–—]/.test(line) ||
      /[,;:\-–—]$/.test(previous) ||
      (previous.length >= 50 && endsOpen && !previousIsMeta);

    if (canContinue && !startsSomethingNew && continuesPrevious) {
      out[out.length - 1] = `${previous.replace(/-$/, "")} ${line}`.replace(/\s{2,}/g, " ").trim();
      continue;
    }
    out.push(line);
  }

  return out;
}

function toBlocks(rawLines: string[]): string[][] {
  const lines = joinWrappedLines(rawLines);
  const blocks: string[][] = [];
  let current: string[] = [];
  let hasDate = false;

  const push = (keep: string[] = []) => {
    if (current.some((l) => l.trim())) blocks.push(current.filter(Boolean));
    current = keep;
    hasDate = keep.some((l) => DATE_RANGE_RE.test(l));
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { push(); continue; }

    // A new entry starts at the next heading, whether or not it is bulleted.
    if (hasDate && isEntryHeader(line)) {
      // Pull back the trailing header lines - they belong to this new entry.
      const carried: string[] = [];
      while (
        current.length &&
        !isBullet(current[current.length - 1]) &&
        !DATE_RANGE_RE.test(current[current.length - 1]) &&
        !looksLikeSentence(current[current.length - 1]) &&
        carried.length < 3
      ) {
        carried.unshift(current.pop() as string);
      }

      // Only valid when the previous entry's own body still ends the block.
      // In education the school line sits directly under its dates, with no
      // bullets in between, and carrying it forward stole it from its entry.
      const tail = current[current.length - 1];
      if (carried.length && (!tail || (!isBullet(tail) && !looksLikeSentence(tail)))) {
        current.push(...carried);
        carried.length = 0;
      }

      push(carried);
    }

    current.push(line);
    if (DATE_RANGE_RE.test(line)) hasDate = true;
  }
  push();

  return mergeOrphanBlocks(blocks);
}

/**
 * Double-spaced resumes put a blank line between an entry's heading and its
 * date line, which splits one entry across two blocks:
 *
 *     Marketing Manager - Telefonica      <- block A, no date
 *                                          (blank)
 *     Madrid, Spain - Feb 2020 - Present  <- block B, has the date
 *
 * Block A alone has no date so it was discarded, and block B alone has no
 * employer so it was discarded too - the role vanished. Rejoin them.
 */
function mergeOrphanBlocks(blocks: string[][]): string[][] {
  const out: string[][] = [];

  for (const block of blocks) {
    const previous = out[out.length - 1];
    const hasDate = block.some((l) => DATE_RANGE_RE.test(l));
    const previousHasDate = previous?.some((l) => DATE_RANGE_RE.test(l)) ?? true;

    // A block of nothing but bullets belongs to the entry above it. Templates
    // that put a blank line between every bullet used to strand them in blocks
    // of their own, which is why "What you did" came back empty.
    const isBodyOnly =
      !hasDate &&
      block.length > 0 &&
      block.every((l) => !l.trim() || isBullet(l) || looksLikeSentence(l));

    if (isBodyOnly && previous && previousHasDate) {
      previous.push(...block);
      continue;
    }

    const previousIsHeading =
      previous &&
      previous.length <= 3 &&
      !previousHasDate &&
      !previous.some((l) => isBullet(l) || looksLikeSentence(l));

    if (hasDate && previousIsHeading) previous.push(...block);
    else out.push([...block]);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Experience                                                          */
/* ------------------------------------------------------------------ */

/**
 * Only unambiguous employer signals belong here. "Software", "Systems" and
 * "Solutions" used to be on this list, which made "Staff Software Engineer"
 * outscore "Airbnb" and land in the company field.
 */
const STRONG_COMPANY_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|gmbh|plc|pvt|s\.a|s\.r\.l|b\.v|n\.v|a\.g|oy|ab|kk|pte|llp|lp|co)\b\.?$/i;

const COMPANY_HINTS = /\b(inc|llc|ltd|limited|corp|corporation|gmbh|plc|pvt|private|holdings|partners|associates|bank|university|college|hospital|institute|foundation|agency|networks|ventures|capital|labs|laboratories)\b\.?/i;

const TITLE_HINTS = /\b(engineer|developer|programmer|architect|analyst|scientist|manager|director|lead|head|officer|consultant|designer|specialist|administrator|coordinator|associate|assistant|intern|trainee|executive|president|founder|owner|supervisor|technician|researcher|professor|lecturer|teacher|nurse|accountant|auditor|recruiter|strategist|marketer|writer|editor|producer|attorney|paralegal|therapist|pharmacist|chef|driver|operator|cto|ceo|coo|cfo|vp|svp|evp)\b/i;

/** Seniority words only ever appear in a job title. */
const TITLE_PREFIX = /^(senior|sr\.?|junior|jr\.?|staff|principal|lead|chief|head of|associate|assistant|deputy|global|regional|group)\b/i;

const EMPLOYMENT_TYPES: Array<[RegExp, string]> = [
  [/\bfull[\s-]?time\b/i, "Full-time"],
  [/\bpart[\s-]?time\b/i, "Part-time"],
  [/\b(intern(ship)?|summer intern)\b/i, "Internship"],
  [/\bcontract(or|ual)?\b/i, "Contract"],
  [/\b(freelance|self[\s-]?employed|consultant)\b/i, "Freelance"],
  [/\bco[\s-]?op\b/i, "Co-op"],
];

const LOCATION_TYPES: Array<[RegExp, string]> = [
  [/\bremote(ly)?\b/i, "Remote"],
  [/\bhybrid\b/i, "Hybrid"],
  [/\b(on[\s-]?site|in[\s-]?office)\b/i, "On-site"],
];

const LOCATION_RE = /\b([A-Z][A-Za-zÀ-ÿ.'’-]+(?:[ ][A-Z][A-Za-zÀ-ÿ.'’-]+){0,3}),\s*([A-Z]{2}|[A-Z][A-Za-zÀ-ÿ.'’ -]{2,24})\b/;

/**
 * "City, Region" is exactly the shape of "Cognizant Technology Solutions, Inc"
 * and "Quadrant Technologies, Inc." - which is how employers ended up in the
 * Location field. A match only counts as a place if it carries no corporate or
 * academic signal.
 */
function looksLikeLocation(text: string): boolean {
  const match = text.match(LOCATION_RE);
  if (!match) return false;
  if (STRONG_COMPANY_SUFFIX.test(match[0]) || COMPANY_HINTS.test(match[0])) return false;
  if (SCHOOL_HINTS.test(match[0])) return false;
  if (TITLE_HINTS.test(match[0])) return false;
  // "Solutions, Inc" style tails are never a region.
  if (/\b(inc|llc|ltd|corp|co|gmbh|plc|pvt|technologies|solutions|systems|services|group|labs|software)\b\.?$/i.test(match[0])) return false;
  return true;
}

function locationIn(text: string): string {
  return looksLikeLocation(text) ? (text.match(LOCATION_RE)?.[0] ?? "") : "";
}

/** US state/territory codes - the reliable half of "City, ST". */
const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND " +
   "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP").split(" ")
);

const KNOWN_REGIONS =
  /^(india|usa|u\.?s\.?a?\.?|united states|uk|u\.?k\.?|united kingdom|england|scotland|wales|ireland|canada|australia|new zealand|germany|deutschland|france|spain|italy|netherlands|belgium|switzerland|sweden|norway|denmark|finland|poland|portugal|romania|czechia|austria|singapore|malaysia|philippines|indonesia|thailand|vietnam|japan|china|hong kong|south korea|uae|u\.?a\.?e\.?|dubai|abu dhabi|qatar|saudi arabia|israel|south africa|nigeria|kenya|egypt|brazil|mexico|argentina|chile|colombia|remote|telangana|karnataka|maharashtra|tamil nadu|kerala|andhra pradesh|gujarat|punjab|haryana|west bengal|uttar pradesh|delhi|ncr|ontario|quebec|british columbia|alberta)$/i;

function isRegion(value: string): boolean {
  const v = value.trim().replace(/\.$/, "");
  if (/^[A-Z]{2}$/.test(v) && US_STATES.has(v)) return true;
  return KNOWN_REGIONS.test(v);
}

/**
 * Peel a trailing "City, Region" off a longer string.
 *
 * "ALLY Financials, Detroit, MI" is an employer followed by a place, but the
 * plain City/Region pattern matched "ALLY Financials, Detroit" and swallowed
 * the employer. Splitting only when there are three or more comma-separated
 * segments keeps a bare "San Francisco, CA" intact, and requiring a real
 * state code or country name keeps "Solutions, Inc." out.
 */
export /**
 * The staffing-vendor tail that Indian IT resumes append to the client name:
 * "Bank of America, Charlotte, NC (TCS) Hyderabad-INDIA". Everything from the
 * bracketed vendor onwards describes the supplier, not the employer, and left
 * in place it kept the real location from being found.
 */
const VENDOR_TAIL = /\s*\([^)]{2,40}\)\s*([A-Za-zÀ-ÿ .']{2,30})\s*[-–]\s*([A-Za-zÀ-ÿ]{2,20})\.?\s*$/;

/** "INDIA" -> "India", "usa" -> "USA". */
function tidyRegionName(value: string): string {
  const v = value.trim();
  if (v.length <= 3) return v.toUpperCase();
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

/**
 * "Hyderabad-INDIA" is where the person actually sat. The vendor tail is
 * removed from the employer name, but its city is the only location some
 * entries carry, so keep it as a fallback rather than discarding it.
 */
export function vendorPlace(text: string): string {
  const m = text.match(VENDOR_TAIL);
  if (!m) return "";
  const city = m[1].trim().replace(/[\s,;-]+$/, "");
  const region = tidyRegionName(m[2]);
  return city && region ? `${city}, ${region}` : "";
}

/** "Hyderabad-INDIA" on its own, with no bracketed vendor in front of it. */
export function bareDeliveryCentre(text: string): string {
  const m = text.trim().match(/^([A-Za-zÀ-ÿ .']{2,30})\s*[-–]\s*([A-Za-zÀ-ÿ]{2,20})\.?$/);
  if (!m) return "";
  const region = m[2];
  if (!isRegion(region) && region !== region.toUpperCase()) return "";
  return `${m[1].trim()}, ${tidyRegionName(region)}`;
}

export function trailingLocation(text: string): { head: string; location: string } {
  const cleaned = text.replace(VENDOR_TAIL, "").replace(/[\s,;|·•]+$/, "").trim();
  const parts = cleaned.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return { head: cleaned, location: "" };

  const region = parts[parts.length - 1];
  const city = parts[parts.length - 2];
  if (!isRegion(region)) return { head: cleaned, location: "" };
  if (!/^[A-Z]/.test(city) || city.split(/\s+/).length > 3) return { head: cleaned, location: "" };

  return { head: parts.slice(0, -2).join(", ").trim(), location: `${city}, ${region}` };
}

/** Strip the vendor tail even when there is no place to split off. */
function withoutVendorTail(text: string): string {
  return text.replace(VENDOR_TAIL, "").replace(/[\s,;|·•-]+$/, "").trim();
}

/**
 * Split a date range out of a value that was written inline with something
 * else - "Client: Regions Bank Feb 2026-Till Date" put the whole string in
 * the Company field.
 */
export function peelDates(value: string): { text: string; range: DateRange | null } {
  const raw = String(value ?? "").trim();
  if (!raw) return { text: "", range: null };

  const range = findDateRange(raw);
  let text = range?.matched ? raw.split(range.matched).join(" ") : raw;

  text = text
    .replace(/\b(?:from|since|between)\b\s*$/i, "")
    .replace(new RegExp(`\\b(?:${PRESENT_WORDS})\\b`, "gi"), " ")
    // A lone trailing year, with or without brackets.
    .replace(/[([]?\s*\b(?:19|20)\d{2}\b\s*[)\]]?\s*$/, "")
    .replace(/[\s,\-–—|]+$/, "")
    .replace(/^[\s,\-–—|]+/, "")
    .replace(/[ \t]{2,}/g, "   ")
    .trim();

  return { text, range };
}

/* ------------------------------------------------------------------ */
/* Labelled entries ("Client: X" / "Role: Y" / "Duration: Z")          */
/* ------------------------------------------------------------------ */

/**
 * Consulting and staffing resumes - extremely common in the Indian IT market -
 * write each role as labelled key/value lines rather than a heading. Reading
 * them heuristically produced companies called "Client: Regions Bank" and
 * titles called "Role: TOSCA QA Lead", and when a label was missing the label
 * word itself ("Duration:") became the employer.
 */
const LABELS: Array<[RegExp, "company" | "title" | "dates" | "location" | "type" | "skip"]> = [
  [/^(client|company|employer|organi[sz]ation|organi[sz]ation name|account|firm|customer)\b/i, "company"],
  [/^(role|title|job title|designation|position|profile)\b/i, "title"],
  [/^(duration|period|dates?|timeline|tenure|from\s*[–-]\s*to)\b/i, "dates"],
  [/^(location|work location|place|based in|city)\b/i, "location"],
  [/^(employment type|job type|engagement)\b/i, "type"],
  [/^(responsibilit(y|ies)|description|summary|environment|technolog(y|ies)|tools?|tech stack|project|key contributions?|achievements?)\b/i, "skip"],
];

type Labelled = {
  company: string;
  title: string;
  dates: string;
  location: string;
  type: string;
  /** Unlabelled lines - still eligible to supply a missing employer or date. */
  rest: string[];
  /** Values of narrative labels (Project, Description, Environment). */
  notes: string[];
};

/** Split "Label: value" lines out of a block. `rest` keeps everything else. */
function readLabelled(lines: string[]): Labelled | null {
  const found: Labelled = { company: "", title: "", dates: "", location: "", type: "", rest: [], notes: [] };
  let hits = 0;

  for (const raw of lines) {
    const line = raw.replace(BULLET_RE, "").trim();

    // "Responsibilities:" and a bare "Responsibilities" on its own line mean
    // the same thing. Without the colon-less form the word itself survived as
    // a candidate and was picked as the employer.
    const match =
      line.match(/^([A-Za-z][A-Za-z /&'-]{2,28})\s*[:：]\s*(.*)$/) ??
      (line.length <= 32 ? line.match(/^([A-Za-z][A-Za-z /&'-]{2,28})\s*$/)?.concat("") ?? null : null);
    if (!match) { found.rest.push(raw); continue; }

    const [, label, value = ""] = match;
    const rule = LABELS.find(([re]) => re.test(label.trim()));
    if (!rule) { found.rest.push(raw); continue; }

    hits += 1;
    const kind = rule[1];
    if (kind === "skip") {
      // "Project Name:" / "Description:" carry narrative text. It belongs in
      // the summary, never in the pool the employer is chosen from - a project
      // name was being picked as the company.
      if (value.trim()) found.notes.push(value.trim());
      continue;
    }
    if (!found[kind] && value.trim()) found[kind] = value.trim();
  }

  // One stray "Note:" line is not a labelled resume; two real labels is.
  return hits >= 2 ? found : null;
}

function splitHeaderLine(line: string): string[] {
  return line
    .split(/\s{2,}|\s*[|•·‖]\s*|\s+[–—]\s+|\s+-\s+|\s+@\s+|\s+\bat\b\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * "Junior Developer, Infosys" is one comma-separated piece that holds both the
 * title and the employer. Split it only when exactly one side reads as a job
 * title, so "Cognizant Technology Solutions, Inc." and "San Francisco, CA"
 * stay in one piece.
 */
function splitOnRoleComma(piece: string): string[] {
  const parts = piece.split(/\s*,\s*/);
  if (parts.length !== 2) return [piece];
  if (looksLikeLocation(piece)) return [piece];

  const [left, right] = parts.map((p) => p.trim());
  if (left.length < 2 || right.length < 2 || left.length > 60 || right.length > 60) return [piece];
  if (STRONG_COMPANY_SUFFIX.test(right) || /^(inc|llc|ltd|corp|co|plc|pvt|gmbh)\.?$/i.test(right)) return [piece];

  const leftIsTitle = TITLE_HINTS.test(left) || TITLE_PREFIX.test(left);
  const rightIsTitle = TITLE_HINTS.test(right) || TITLE_PREFIX.test(right);
  return leftIsTitle !== rightIsTitle ? [left, right] : [piece];
}

function stripDates(line: string, range: DateRange | null): string {
  let out = line;
  if (range?.matched) out = out.split(range.matched).join(" ");

  // "(2016 - 2018)" and "(2020)" trail school names constantly - remove the
  // brackets with their contents before the bare-range pass below, otherwise
  // an empty "( )" is left behind.
  out = out.replace(/[([]\s*(?:19|20)\d{2}\s*(?:[-–—]\s*(?:present|current|(?:19|20)\d{2}))?\s*[)\]]/gi, " ");

  // Also remove any date range printed on this line. Education headers put
  // the years inline ("Master of Science, Computer Science 2012 - 2014"),
  // and leaving them in made "2014" look like the institution name.
  for (let guard = 0; guard < 3; guard++) {
    const found = out.match(DATE_RANGE_RE);
    if (!found) break;
    out = out.replace(found[0], " ");
  }

  return out
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/[([]\s*$/, " ")
    .replace(new RegExp(`\\b(?:${PRESENT_WORDS})\\b`, "gi"), " ")
    .replace(/\s*[|•·‖]\s*$/, "")
    .replace(/[\s,\-–—|(]+$/, "")
    .replace(/^[\s,\-–—|)]+/, "")
    .replace(/[ \t]{2,}/g, "   ")
    .trim();
}

function scoreAsCompany(piece: string): number {
  let score = 0;
  if (STRONG_COMPANY_SUFFIX.test(piece)) score += 6;
  if (COMPANY_HINTS.test(piece)) score += 3;
  if (TITLE_HINTS.test(piece)) score -= 4;
  if (TITLE_PREFIX.test(piece)) score -= 5;
  if (/^[A-Z][A-Za-z]*(?:[ &][A-Z][A-Za-z]*)*$/.test(piece)) score += 1;
  if (/\b(at|for)\b/i.test(piece)) score -= 1;
  // A short proper noun with no role words reads as an employer.
  if (piece.split(/\s+/).length <= 2 && !TITLE_HINTS.test(piece)) score += 1;
  return score;
}

/** Decide which candidate is the job title and which is the employer. */
function pickTitleAndCompany(pieces: string[]): { title: string; company: string } {
  if (pieces.length === 1) {
    const only = pieces[0];
    return TITLE_HINTS.test(only) || TITLE_PREFIX.test(only)
      ? { title: only, company: "" }
      : { title: "", company: only };
  }

  const titleLike = pieces.filter((p) => TITLE_HINTS.test(p) || TITLE_PREFIX.test(p));

  // The common, unambiguous case: exactly one candidate reads as a job title,
  // so the other one is the employer regardless of how it is spelled.
  if (titleLike.length === 1) {
    const title = titleLike[0];
    const rest = pieces.filter((p) => p !== title);
    const company = rest.reduce((a, b) => (scoreAsCompany(b) > scoreAsCompany(a) ? b : a));
    return { title, company };
  }

  const ranked = pieces.map((piece, index) => ({ piece, index, score: scoreAsCompany(piece) }));
  const companyPick = ranked.reduce((a, b) => (b.score > a.score ? b : a));
  const rest = ranked.filter((r) => r.index !== companyPick.index);
  const titlePick = rest.find((r) => TITLE_HINTS.test(r.piece)) ?? rest[0];
  return { title: titlePick?.piece ?? "", company: companyPick.piece };
}

type RoleDraft = {
  company: string;
  title: string;
  location: string;
  locationType: string;
  employmentType: string;
  range: DateRange | null;
};

/**
 * Pull whatever the labelled lines state outright. Values are date-peeled,
 * because resumes routinely write the period inline with the employer
 * ("Client: Regions Bank Feb 2026-Till Date") and the raw value used to be
 * copied straight into the Company field.
 */
function draftFromLabels(labelled: Labelled): RoleDraft {
  const company = peelDates(labelled.company);
  const title = peelDates(labelled.title);
  const place = peelDates(labelled.location);

  // A labelled value can still hold two columns: "Client: Acme   Boston, MA".
  const companyColumns = splitHeaderLine(company.text).filter(Boolean);
  const companyHead = companyColumns[0] ?? company.text;
  const columnPlace = companyColumns.slice(1).map((c) => locationIn(c)).find(Boolean) ?? "";

  const companyParts = trailingLocation(companyHead);
  const range =
    (labelled.dates ? findDateRange(labelled.dates) : null) ??
    company.range ??
    title.range ??
    place.range;

  // "Role: Lead Tosca Automation Engineer." - the label's own full stop is not
  // part of the job title.
  const tidy = (v: string) => v.replace(/\s*[.,;:]+\s*$/, "").trim();

  return {
    company: tidy(companyParts.head || companyHead),
    title: tidy(splitHeaderLine(title.text)[0] ?? title.text),
    location: place.text || companyParts.location || columnPlace,
    locationType: LOCATION_TYPES.find(([re]) => re.test(place.text))?.[1] ?? "",
    employmentType: EMPLOYMENT_TYPES.find(([re]) => re.test(labelled.type || labelled.title))?.[1] ?? "",
    range,
  };
}

/** Read company/title/location/dates out of unlabelled header lines. */
function draftFromHeaders(headerLines: string[], draft: RoleDraft): { draft: RoleDraft; usedLines: Set<string> } {
  const usedLines = new Set<string>();

  let range = draft.range;
  let dateLineIndex = -1;
  for (let i = 0; i < headerLines.length; i++) {
    const found = findDateRange(headerLines[i]);
    if (found) {
      if (!range) range = found;
      dateLineIndex = i;
      break;
    }
  }
  if (dateLineIndex === -1 && !range) return { draft, usedLines };

  // The title and employer sit within a line or two of the dates. Reading
  // further pulls in the next entry or the previous entry's tail.
  const anchor = dateLineIndex === -1 ? 0 : dateLineIndex;
  const from = Math.max(0, anchor - 2);
  // When the title already came from a label only the employer is missing, and
  // it sits on the dated line itself. Reading further pulled in the first
  // responsibility bullet and made it the company.
  const to = Math.min(headerLines.length, anchor + (draft.title ? 1 : 3));

  const candidates: string[] = [];
  for (let i = from; i < to; i++) {
    const cleaned = stripDates(headerLines[i], i === dateLineIndex ? range : null);
    if (!cleaned) continue;
    usedLines.add(headerLines[i]);
    for (const piece of splitHeaderLine(cleaned)) {
      if (piece.length >= 2 && piece.length <= 90) candidates.push(...splitOnRoleComma(piece));
    }
  }

  let location = draft.location;
  let locationType = draft.locationType;
  let employmentType = draft.employmentType;

  const kept: string[] = [];
  // The delivery centre from a vendor tail. Used only when the entry carries
  // no client location of its own.
  let fallbackPlace = "";

  for (const rawPiece of candidates) {
    const vendorCity = vendorPlace(rawPiece);
    if (vendorCity && !fallbackPlace) fallbackPlace = vendorCity;

    const raw = withoutVendorTail(rawPiece);
    if (!raw) continue;

    // Columns that hold only the staffing vendor or its delivery centre -
    // "(Logic gate)", "Hyderabad-INDIA" - describe the supplier, not the job.
    if (/^\([^)]{2,40}\)$/.test(raw)) continue;
    // "Hyderabad-INDIA" is a delivery centre; "Full-time" is an employment
    // type that merely looks like one, so the tail must read as a place.
    const centre = TITLE_HINTS.test(raw) ? "" : bareDeliveryCentre(raw);
    if (centre) {
      if (!fallbackPlace) fallbackPlace = centre;
      continue;
    }

    // "ALLY Financials, Detroit, MI" is an employer plus a place in one piece.
    const { head, location: trailing } = trailingLocation(raw);
    if (trailing && head) {
      if (!location) location = trailing;
      if (head.length >= 2) kept.push(head);
      continue;
    }

    const piece = raw;
    const locType = LOCATION_TYPES.find(([re]) => re.test(piece));
    const empType = EMPLOYMENT_TYPES.find(([re]) => re.test(piece));
    const place = locationIn(piece);

    // A piece is only *consumed* as a type when that is all it says.
    // "Python Developer Intern" names an internship but is still the job
    // title - swallowing it whole left the Job title field empty.
    const isTypeOnly = (pattern: RegExp) =>
      piece.replace(pattern, "").replace(/[^A-Za-z0-9]/g, "").length <= 2;

    if (locType) {
      if (!locationType) locationType = locType[1];
      if (isTypeOnly(locType[0])) continue;
    }
    if (empType) {
      if (!employmentType) employmentType = empType[1];
      if (isTypeOnly(empType[0])) continue;
    }
    // `locationIn` rejects "Cognizant Technology Solutions, Inc" and friends,
    // which the raw pattern happily matched as a city/region pair.
    if (!location && place && place.length >= piece.length - 3) { location = place; continue; }
    kept.push(piece);
  }

  let company = draft.company;
  let title = draft.title;

  // No client location on the heading, but the vendor tail named a city.
  if (!location && fallbackPlace) location = fallbackPlace;

  // Everything on the heading was consumed as a place, leaving no employer.
  // "HBC, UK" is really the employer followed by its country, so recover it
  // rather than returning a role with no company at all.
  if (!kept.length && !company && location.includes(",")) {
    const cut = location.lastIndexOf(",");
    const head = location.slice(0, cut).trim();
    const tail = location.slice(cut + 1).trim();
    if (head && tail) {
      kept.push(head);
      location = tail;
    }
  }

  if (kept.length) {
    if (!company && !title) {
      const picked = pickTitleAndCompany(kept);
      company = picked.company;
      title = picked.title;
    } else if (!company) {
      // Title already known, so the best remaining candidate is the employer.
      const pool = kept.filter((p) => p !== title);
      if (pool.length) company = pool.reduce((a, b) => (scoreAsCompany(b) > scoreAsCompany(a) ? b : a));
    } else if (!title) {
      const pool = kept.filter((p) => p !== company);
      const named = pool.find((p) => TITLE_HINTS.test(p) || TITLE_PREFIX.test(p));
      if (named) title = named;
    }
  }

  return {
    draft: { company, title, location, locationType, employmentType, range },
    usedLines,
  };
}

export function parseExperienceBlocks(lines: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const block of toBlocks(lines)) {
    // Labelled layouts state some fields outright; the rest of the block still
    // has to be read heuristically. Treating the two as either/or is what left
    // Company empty and pushed the employer line into "What you did".
    const labelled = readLabelled(block);
    const scanLines = labelled ? labelled.rest : block;

    let draft: RoleDraft = labelled
      ? draftFromLabels(labelled)
      : { company: "", title: "", location: "", locationType: "", employmentType: "", range: null };

    // Prose lines are description even without a bullet glyph - some PDF
    // producers drop the bullet character from the text layer entirely. And
    // the reverse: an employer/date heading is still a heading when the
    // template happens to bullet it, so the bullet is stripped rather than
    // used to classify the line.
    const headerLines = scanLines
      .filter((l) => isEntryHeader(l) || (!isBullet(l) && !looksLikeSentence(l)))
      .map((l) => (isEntryHeader(l) ? l.replace(BULLET_RE, "").trim() : l));
    const bodyLines = scanLines.filter((l) => !isEntryHeader(l) && (isBullet(l) || looksLikeSentence(l)));

    let usedLines = new Set<string>();
    const needsScan = !draft.company || !draft.title || !draft.range;
    if (needsScan && headerLines.length) {
      const scanned = draftFromHeaders(headerLines, draft);
      draft = scanned.draft;
      usedLines = scanned.usedLines;
    }

    // A block with no date is prose, a heading, or a skills blob - not a job.
    // Guessing here is what produced phantom entries.
    if (!draft.range) continue;
    if (!draft.company && !draft.title) continue;

    // Everything the header pass did not consume, in the order the resume
    // printed it. Rebuilding from `scanLines` rather than concatenating the
    // two buckets keeps the bullets in their original sequence.
    const description = [
      ...(labelled?.notes ?? []),
      ...scanLines
        .map((l) => (isEntryHeader(l) ? l.replace(BULLET_RE, "").trim() : l))
        .filter((l) => !isEntryHeader(l) && !usedLines.has(l)),
    ]
      .map((l) => l.replace(BULLET_RE, "").trim())
      .filter((l) => l && !headingFor(l))
      .join("\n")
      .slice(0, 4000);

    out.push({
      company: draft.company.trim(),
      title: draft.title.trim(),
      employmentType: draft.employmentType,
      location: draft.location.trim(),
      locationType: draft.locationType,
      startDate: draft.range.startDate,
      endDate: draft.range.endDate,
      current: draft.range.current,
      description,
    });

    if (out.length >= 25) break;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Education                                                           */
/* ------------------------------------------------------------------ */

const SCHOOL_HINTS = /\b(universit(y|ies|e|é|à|ä|y'?s)?|universidad|universidade|universität|université|universiteit|universita|universitat|college|coll[eè]ge|institute|institut|instituto|school|schule|escuela|escola|academy|academia|académie|polytechnic|politecnico|conservatory|seminary|gymnasium|iit|nit|iiit|bits|vit|srm|amity|kiit|manipal|campus|faculty|hochschule)\b/i;

/**
 * Includes a generic rule for the long tail of abbreviations (B.Des, M.Des,
 * B.Voc, B.Ed, BPT...). Without it, anything outside a hard-coded list was
 * dropped and the institution name landed in the degree field instead.
 */
const DEGREE_HINTS = /\b(b\.?\s?tech|b\.?\s?e\.?|b\.?\s?sc|b\.?\s?a\.?|b\.?\s?com|b\.?\s?b\.?\s?a|bca|bs|ba|bfa|bba|llb|mbbs|bds|barch|b\.?\s?des|b\.?\s?ed|b\.?\s?voc|b\.?\s?pharm|bpt|b\.\s?s\.?|m\.\s?s\.?|m\.?\s?tech|m\.?\s?e\.?|m\.?\s?sc|m\.?\s?a\.?|m\.?\s?com|m\.?\s?des|m\.?\s?ed|mca|mba|ms|ma|mfa|mph|mds|mpt|llm|md|jd|pgdm|ph\.?\s?d|dphil|doctorate|bachelor|master|associate|diploma|certificate|high school|secondary|hsc|ssc|intermediate|matriculation|gcse|a[\s-]levels?|baccalaureate|post[\s-]?graduate|undergraduate|bootcamp|nanodegree|m[aá]ster|maestr[ií]a|licenciatura|licenciad[oa]|laurea|ingenier[ií]a|bachillerato|magister|mestrado|doctorado|grado)\b/i;

/** "B.Des", "M.Sc.", "B.Voc" - a one-letter level plus a short abbreviation. */
const DEGREE_ABBREV_RE = /^(?:[BM]\.?\s?[A-Za-z]{1,5}\.?|[BM]\.?[A-Za-z]\.?[A-Za-z]?\.?)(?:\s*\((?:hons?|honou?rs)\.?\))?$/i;

function looksLikeDegree(piece: string): boolean {
  if (DEGREE_HINTS.test(piece)) return true;
  const head = piece.split(/\s+(?:in|of)\s+/i)[0].trim();
  return head.length <= 12 && DEGREE_ABBREV_RE.test(head);
}

const GPA_RE = /\b(?:c?gpa|grade|marks?|percentage|score|aggregate)\b\s*[:=-]?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?\s*(?:\/\s*[0-9]{1,3}(?:\.[0-9]{1,2})?)?\s*%?)/i;
const BARE_GPA_RE = /\b([0-9]\.[0-9]{1,2}\s*\/\s*(?:4|5|10)(?:\.0)?)\b|\b([0-9]{2,3}(?:\.[0-9]{1,2})?\s*%)/;

const FIELD_RE = /\b(?:in|of|en|em|major(?:ing)? in|specialisation in|specialization in|concentration in)\b[\s:]+([A-Z][A-Za-zÀ-ÿ&,'’\- ]{2,60})/i;

/** Connectors that separate a credential from the institution awarding it. */
const EDU_CONNECTOR = /\s+from\s+|\s+at\s+|\s*[|·•@]\s*|\s+[-–—]\s+|,\s*/gi;

/**
 * Split "Master of Science in Information Technology from Wilmington
 * University, New Castle, DE" into its credential and its institution.
 *
 * This single line is why Degree came out blank and School and Field of Study
 * both showed the whole sentence: the school test ran first, matched
 * "University" anywhere in the string, and claimed the entire line.
 */
function splitDegreeAndSchool(text: string): { degree: string; school: string } | null {
  const line = text.trim();
  if (!line) return null;

  const schoolMatch = line.match(SCHOOL_HINTS);
  const schoolAt = schoolMatch?.index ?? -1;

  // Collect every connector position, then take the last one that still sits
  // before the institution keyword.
  const cuts: Array<{ index: number; length: number }> = [];
  EDU_CONNECTOR.lastIndex = 0;
  for (let m = EDU_CONNECTOR.exec(line); m; m = EDU_CONNECTOR.exec(line)) {
    cuts.push({ index: m.index, length: m[0].length });
  }
  if (!cuts.length) return null;

  // With a recognisable institution keyword, any connector before it works.
  // Without one ("... from JNTU Hyderabad"), only an explicit from/at is
  // trustworthy - a stray comma would cut the line in the wrong place.
  const usable =
    schoolAt >= 0
      ? cuts.filter((c) => c.index < schoolAt)
      : cuts.filter((c) => /\s+(?:from|at)\s+/i.test(line.slice(c.index, c.index + c.length)));
  if (!usable.length) return null;

  const cut = usable[usable.length - 1];
  const left = line.slice(0, cut.index).trim();
  const right = line.slice(cut.index + cut.length).trim();
  if (!left || !right) return null;

  // Only accept the split when the halves really are credential + institution.
  const leftIsDegree = looksLikeDegree(left);
  const rightIsSchool = schoolAt >= 0 && schoolAt >= cut.index + cut.length;
  const viaFrom = /\s+(?:from|at)\s+/i.test(line.slice(cut.index, cut.index + cut.length));
  if (!leftIsDegree) return null;
  if (!rightIsSchool && !viaFrom) return null;

  return { degree: left.replace(/[,;]+$/, ""), school: right.replace(/[,;]+$/, "") };
}

/**
 * Peel a trailing place and a trailing year off an institution name, so
 * "Wilmington University, New Castle, DE" yields the school and the location
 * separately instead of cramming the whole string into School.
 */
function splitSchoolAndPlace(text: string): { school: string; location: string } {
  const parts = text.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { school: text.trim(), location: "" };

  const tail: string[] = [];
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^\(?(19|20)\d{2}\)?$/.test(last)) { parts.pop(); continue; }
    if (SCHOOL_HINTS.test(last) || looksLikeDegree(last)) break;
    if (tail.length >= 2) break;
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’ -]{1,30}$/.test(last)) break;
    tail.unshift(parts.pop() as string);
  }

  return { school: parts.join(", ").trim(), location: tail.join(", ").trim() };
}

/**
 * One entry per line is a very common education layout. `toBlocks` only breaks
 * on blank lines and date *ranges*, so two such lines ending in a bare year
 * stayed in one block and were merged into a single wrong entry.
 */
function splitOneLineEntries(block: string[]): string[][] {
  const complete = block.filter(
    (l) => !isBullet(l) && looksLikeDegree(l) && (SCHOOL_HINTS.test(l) || /\b(19|20)\d{2}\b/.test(l))
  );
  if (complete.length < 2) return [block];

  // Each complete line opens a new entry; anything after it is its detail.
  const groups: string[][] = [];
  for (const line of block) {
    if (complete.includes(line)) groups.push([line]);
    else if (groups.length) groups[groups.length - 1].push(line);
  }
  return groups.length ? groups : [block];
}

const EDU_DETAIL_LINE =
  /^(relevant\s+coursework|coursework|courses?|subjects?|gpa|cgpa|grade|percentage|marks|honou?rs|thesis|dissertation|activities|achievements?)\b/i;

/**
 * Start a new education entry at each institution line.
 *
 * Some resumes list schools with no dates at all:
 *
 *     •University of Southern Mississippi, USA
 *     Master's in Computer Science
 *     •Lakki Reddy Bali Reddy Engineering College
 *     Bachelor's in Engineering
 *
 * With no blank line and no date range there was nothing to split on, so both
 * degrees collapsed into a single entry. The split only fires once the current
 * group already names an institution, which leaves the common
 * "degree line then school line" layout untouched.
 */
function splitOnSchoolLines(block: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentHasSchool = false;

  for (const line of block) {
    const bare = line.replace(BULLET_RE, "").trim();
    const isSchoolLine = Boolean(bare) && SCHOOL_HINTS.test(bare) && !EDU_DETAIL_LINE.test(bare);

    if (isSchoolLine && currentHasSchool && current.length) {
      groups.push(current);
      current = [];
      currentHasSchool = false;
    }

    current.push(line);
    if (isSchoolLine) currentHasSchool = true;
  }
  if (current.length) groups.push(current);

  return groups.length ? groups : [block];
}

export function parseEducationBlocks(lines: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const blocks = toBlocks(lines).flatMap(splitOneLineEntries).flatMap(splitOnSchoolLines);

  for (const block of blocks) {
    const joined = block.join(" ");
    // A block must name either an institution or a credential. Coursework and
    // GPA lines on their own are details, not entries.
    if (!SCHOOL_HINTS.test(joined) && !looksLikeDegree(joined)) continue;

    const range = findDateRange(joined);
    let startDate = range?.startDate ?? "";
    let endDate = range?.endDate ?? "";
    let current = range?.current ?? false;
    if (!range) {
      const single = findSingleDate(joined);
      if (single) endDate = single;
      if (/\b(expected|pursuing|ongoing|present|currently)\b/i.test(joined)) { current = true; endDate = ""; }
    }

    let school = "";
    let degree = "";
    let fieldOfStudy = "";
    let gpa = "";
    let location = "";
    const extras: string[] = [];

    for (const rawLine of block) {
      let line = stripDates(rawLine.replace(BULLET_RE, "").trim(), null);
      if (!line) continue;

      const gpaMatch = line.match(GPA_RE) ?? line.match(BARE_GPA_RE);
      if (gpaMatch) {
        if (!gpa) gpa = String(gpaMatch[1] ?? gpaMatch[2] ?? "").replace(/\s+/g, "").trim();
        // Remove it from the line so the grade never trails the school name.
        line = line.replace(gpaMatch[0], " ").replace(/\s*[,;|·•]\s*$/, "").replace(/\s{2,}/g, " ").trim();
        if (!line) continue;
      }

      // "<credential> from <institution>" on one line, before anything else
      // gets a chance to claim the whole string.
      if (!school && !degree) {
        const split = splitDegreeAndSchool(line);
        if (split) {
          degree = split.degree;
          const parts = splitSchoolAndPlace(split.school);
          school = parts.school;
          if (!location) location = parts.location;
          continue;
        }
      }

      for (const piece of splitHeaderLine(line)) {
        if (!piece || piece.length < 2) continue;

        // A piece can still be "Degree from School" if the line used a
        // separator splitHeaderLine already consumed.
        if (!school && !degree) {
          const split = splitDegreeAndSchool(piece);
          if (split) {
            degree = split.degree;
            const parts = splitSchoolAndPlace(split.school);
            school = parts.school;
            if (!location) location = parts.location;
            continue;
          }
        }

        // Degree first: a credential string frequently contains a school word
        // ("Master of Science ... University"), never the other way round.
        if (!degree && looksLikeDegree(piece)) { degree = piece.replace(/[,;]+$/, "").trim(); continue; }
        if (!school && SCHOOL_HINTS.test(piece)) {
          const parts = splitSchoolAndPlace(piece.replace(/[,;]+$/, "").trim());
          school = parts.school;
          if (!location) location = parts.location;
          continue;
        }
        if (!location) {
          const place = locationIn(piece);
          if (place && place.length >= piece.length - 3) { location = place; continue; }
        }
        extras.push(piece);
      }
    }

    // "B.Tech in Computer Science" - lift the major out of the degree string.
    // Uses the same helper as the normaliser so both paths agree.
    fieldOfStudy = fieldFromDegree(degree) || fieldFromDegree(joined);
    if (!fieldOfStudy) {
      const fieldMatch = (degree || joined).match(FIELD_RE);
      if (fieldMatch) fieldOfStudy = fieldMatch[1].replace(/[,;.]+$/, "").trim();
    }

    if (!school && extras.length) school = extras.shift() ?? "";
    if (!school && !degree) continue;

    out.push({
      school,
      degree,
      fieldOfStudy,
      gpa,
      startDate,
      endDate,
      current,
      location,
      description: extras.join(" ").slice(0, 600),
    });

    if (out.length >= 15) break;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Skills and certifications                                           */
/* ------------------------------------------------------------------ */

const SKILL_CATEGORY_RE = /^[A-Za-z][A-Za-z0-9 &/+#.'-]{1,40}\s*[:：]\s*/;

/**
 * Rejoin lines a narrow column soft-wrapped mid-list.
 *
 * A sidebar reading "Python, Scala, SQL, Apache / Spark, Kafka, ..." is one
 * list, not two - handling it line by line split "Apache Spark" into two
 * separate skills. Lines that start their own bullet or carry their own
 * category label are left alone.
 */
function reflow(lines: string[], mode: "list" | "entries" = "list"): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { out.push(""); continue; }

    // A line carrying column markers is a complete table row, never the tail
    // of the line above. Without this the whole skills table was reflowed into
    // a single line and every skill was lost.
    const hasColumns = /\s{2,}/.test(line);
    const standalone = isBullet(line) || SKILL_CATEGORY_RE.test(line) || Boolean(headingFor(line)) || hasColumns;
    const previous = out[out.length - 1];
    const hasPrevious = Boolean(previous && previous.trim()) && !/\s{2,}/.test(previous ?? "");

    // "list" (skills): a comma-separated run wraps freely, so join unless the
    // previous line ended a sentence.
    // "entries" (certifications): every line is its own item, so only join a
    // line that is visibly unfinished.
    const continues =
      !standalone &&
      hasPrevious &&
      (mode === "list"
        ? !/[.:;!?]$/.test(previous.trim())
        : /[,\-–—:]$/.test(previous.trim()) ||
          /^[a-z(]/.test(line) ||
          // A short trailing fragment that carries the year ("Professional,
          // 2022") completes the line above. Requiring the year keeps a list
          // of separate credentials ("Automation Specialist 1",
          // "Automation Specialist 2") from collapsing into one entry.
          (line.length < 28 &&
            /\b(19|20)\d{2}\b/.test(line) &&
            !/\b(19|20)\d{2}\b/.test(previous) &&
            !/\b(certifi|certificate|licen[cs]e|credential|diploma|award)\w*\b/i.test(line)));

    if (continues) out[out.length - 1] = `${previous.replace(/[-–—]$/, "")} ${line}`.replace(/\s{2,}/g, " ");
    else out.push(line);
  }
  return out.filter((l) => l.trim());
}

export function parseSkills(lines: string[]): string[] {
  const skills: string[] = [];

  for (const raw of reflow(lines)) {
    let line = raw.replace(BULLET_RE, "").trim();
    if (!line) continue;
    // A table's own header row ("Skill | Years of Experience | Last Used")
    // names the section; its column titles are not skills.
    if (headingFor(line)) continue;

    // A skills table row is "<skill>   <years>   <last used>". Only the first
    // column is a skill; the rest are metadata about it.
    const columns = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    const isTableRow =
      columns.length >= 2 && /^[\d.]+\s*(years?|yrs?|months?)?$|^(19|20)\d{2}$/i.test(columns[1]);
    if (isTableRow) line = columns[0];

    // Drop the category label ("Languages: Python, Go") but keep its values.
    line = line.replace(SKILL_CATEGORY_RE, "");
    if (!line) continue;

    // A table row is one skill the resume declared for itself. Splitting it or
    // rejecting it for being wordy threw away most of a skills matrix -
    // "Experience using database query tools and writing SQL" is exactly what
    // this candidate listed under the "Skill" column.
    const tokens = isTableRow ? [line] : line.split(/[,;|•·]+|\s{3,}/);

    for (const token of tokens) {
      const skill = token.replace(/^[-–—\s]+|[-–—\s.]+$/g, "").trim();
      if (skill.length < 2 || skill.length > (isTableRow ? 110 : 60)) continue;
      if (/^\d+$/.test(skill)) continue;
      if (headingFor(skill)) continue;
      // A whole sentence is not a skill - unless the resume tabulated it.
      if (!isTableRow && skill.split(/\s+/).length > 6) continue;
      skills.push(skill);
    }
  }

  return dedupe(skills).slice(0, 120);
}

export function parseCertifications(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of reflow(lines, "entries")) {
    const line = raw.replace(BULLET_RE, "").replace(/^[-–—\s]+/, "").trim();
    if (line.length < 3 || line.length > 200) continue;
    if (headingFor(line)) continue;
    out.push(line);
  }
  return dedupe(out).slice(0, 50);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function fallbackParseResumeText(text: string): Record<string, unknown> {
  const clean = normaliseExtractedText(text);
  if (!clean) {
    return {
      personal: { firstName: "", lastName: "", email: "", phone: "", phoneType: "Mobile", languages: [] },
      summary: "", targetRole: "", experience: [], education: [], skills: [],
      certifications: [], websites: [], workAuth: {}, compensation: {}, eeo: {},
    };
  }

  const sections = splitSections(clean);
  const contacts = extractContacts(clean);
  // The header block supplies the candidates; the whole document supplies the
  // email used to confirm which candidate is really the person's name.
  const name = guessName(sections.find((s) => s.name === "contact")?.lines.join("\n") || clean, clean);

  const experienceLines = sections.filter((s) => s.name === "experience").flatMap((s) => s.lines);
  const educationLines = sections.filter((s) => s.name === "education").flatMap((s) => s.lines);
  const skillLines = sections.filter((s) => s.name === "skills").flatMap((s) => s.lines);
  const certLines = sections.filter((s) => s.name === "certifications").flatMap((s) => s.lines);
  const summaryLines = sections.filter((s) => s.name === "summary").flatMap((s) => s.lines);
  const languageLines = sections.filter((s) => s.name === "languages").flatMap((s) => s.lines);

  const websites = contacts.urls.slice(0, 20).map((url) => ({ label: labelForUrl(url), url }));

  // Prefer a phone found near the contact block over one buried in the body.
  const contactBlock = sections.find((s) => s.name === "contact")?.lines.join("\n") ?? "";
  const contactPhones = extractContacts(contactBlock).phones;

  return {
    personal: {
      firstName: name.firstName,
      middleName: name.middleName,
      lastName: name.lastName,
      email: contacts.emails[0] ?? "",
      phone: contactPhones[0] ?? contacts.phones[0] ?? "",
      phoneType: "Mobile",
      languages: parseSkills(languageLines).slice(0, 12),
    },
    summary: summaryLines.join(" ").replace(/\s+/g, " ").trim().slice(0, 3000),
    targetRole: "",
    experience: parseExperienceBlocks(experienceLines),
    education: parseEducationBlocks(educationLines),
    skills: parseSkills(skillLines),
    certifications: parseCertifications(certLines),
    websites,
    workAuth: {},
    compensation: {},
    eeo: {},
  };
}
