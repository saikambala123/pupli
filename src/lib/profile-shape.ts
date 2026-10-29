/**
 * Coercion and normalisation for profile sections.
 *
 * Two callers need this:
 *  - the resume parser, because a model asked for `skills: string[]` will
 *    sometimes hand back `[{name:"React"}]` or `"React, Node"`;
 *  - the PATCH route, because the browser can send anything.
 *
 * It also enforces the controlled vocabularies the ProfileEditor's <Select>
 * menus use. That matters more than it sounds: a <select> silently renders
 * blank when its value is not one of its options, so a perfectly correct
 * "B.Tech" or "Bachelor of Engineering" from the resume used to display as an
 * empty Degree field. Users reported that as "the education data is wrong".
 */

import {
  DEGREE_OPTIONS,
  EMPLOYMENT_TYPE_OPTIONS,
  LOCATION_TYPE_OPTIONS,
  WORK_AUTH_TYPE_OPTIONS,
  REMOTE_PREFERENCE_OPTIONS,
  WEBSITE_LABEL_OPTIONS,
  PHONE_TYPE_OPTIONS,
} from "./resume-schema";

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
};

const bool = (v: unknown): boolean =>
  v === true || v === 1 || (typeof v === "string" && /^(true|yes|y|1|current|present)$/i.test(v.trim()));

/** Match a free-text value against a fixed option list, case/punctuation insensitive. */
function pickOption<T extends readonly string[]>(value: unknown, options: T): string {
  const raw = str(value);
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return "";
  const exact = options.find((o) => o.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
  if (exact) return exact;
  const partial = options.find((o) => {
    const ok = o.toLowerCase().replace(/[^a-z0-9]/g, "");
    return ok.includes(key) || key.includes(ok);
  });
  return partial ?? "";
}

/* ------------------------------------------------------------------ */
/* Degrees                                                             */
/* ------------------------------------------------------------------ */

/** Priority order matters: "MBA" must be tested before "BA". */
const DEGREE_RULES: Array<[RegExp, (typeof DEGREE_OPTIONS)[number]]> = [
  [/\b(ph\.?\s?d|d\.?\s?phil|doctor(ate|ado)?( of philosophy)?|d\.?\s?sc|ed\.?\s?d|psy\.?\s?d|dba|dottorato)\b/i, "Doctorate (PhD)"],
  [/\b(m\.?\s?b\.?\s?a|master of business administration|pgdm|pgpm|e\.?mba|executive mba)\b/i, "MBA"],
  [
    /\b(m\.?\s?tech|m\.?\s?e\.?|m\.?\s?sc?|m\.?\s?s\.?|m\.?\s?a\.?|m\.?\s?com|m\.?\s?c\.?\s?a|m\.?\s?f\.?\s?a|m\.?\s?p\.?\s?h|m\.?\s?eng|m\.?\s?phil|m\.?\s?res|ll\.?\s?m|master'?s?|m[aá]ster|maestr[ií]a|magister|mestrado|postgraduate|post[\s-]graduate|pg diploma)\b/i,
    "Master's Degree",
  ],
  [
    /\b(b\.?\s?tech|b\.?\s?e\.?|b\.?\s?sc?|b\.?\s?s\.?|b\.?\s?a\.?|b\.?\s?com|b\.?\s?c\.?\s?a|b\.?\s?b\.?\s?a|b\.?\s?f\.?\s?a|b\.?\s?eng|b\.?\s?arch|b\.?\s?pharm|ll\.?\s?b|mbbs|bachelor'?s?|licenciatura|licenciad[oa]|licence|laurea|ingenier[ií]a|ingenieur|dipl[oô]m[ea]?[\s-]?ing|grado|undergraduate)\b/i,
    "Bachelor's Degree",
  ],
  [/\b(associate'?s?|a\.?\s?a\.?\s?s|a\.?\s?a\b|a\.?\s?s\b|foundation degree)\b/i, "Associate's Degree"],
  [
    /\b(high school|secondary school|senior secondary|higher secondary|h\.?\s?s\.?\s?c|s\.?\s?s\.?\s?c|matriculation|matric|intermediate|10\+2|12th|10th|gcse|a[\s-]?levels?|baccalaur(e|é)ate|bachillerato|abitur|maturit[àa])\b/i,
    "High School Diploma",
  ],
  [/\b(boot\s?camp|nano\s?degree|immersive|certificate program)\b/i, "Bootcamp"],
];

/**
 * The long tail of abbreviations - B.Des, B.Voc, M.Des, B.Ed, BPT, MDS.
 * A leading B or M plus a short abbreviation reliably means bachelor's or
 * master's, which beats dumping everything unrecognised into "Other".
 */
const ABBREV_LEVEL_RE = /^([BM])\.?\s?[A-Za-z]{1,5}\.?$/;

/** Real-world degree text -> one of the eight values the UI offers. */
export function normalizeDegree(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";

  const exact = pickOption(raw, DEGREE_OPTIONS);
  if (exact) return exact;

  for (const [pattern, normalized] of DEGREE_RULES) {
    if (pattern.test(raw)) return normalized;
  }

  const head = raw.split(/\s+(?:in|of)\s+|[,\-–—]/)[0].trim();
  const abbrev = head.match(ABBREV_LEVEL_RE);
  if (abbrev) return abbrev[1].toUpperCase() === "B" ? "Bachelor's Degree" : "Master's Degree";

  return "Other";
}

/** Words that name the award, not the subject: "Bachelor of Science". */
const GENERIC_DISCIPLINES = /^(science|sciences|arts?|engineering|technology|commerce|business administration|business|laws?|philosophy|education|studies|design|applied science)$/i;

function tidyField(value: string): string {
  let field = value.replace(/[,;.]+$/, "").trim();
  // "Science, Computer Science" and "Science in Computer Science" both name
  // the award first and the subject second - keep the subject.
  const tail = field.match(/^([A-Za-zÀ-ÿ ]{3,30})\s*(?:,|\bin\b)\s+(.+)$/i);
  if (tail && GENERIC_DISCIPLINES.test(tail[1].trim())) field = tail[2].trim();
  return field.replace(/[,;.]+$/, "").trim();
}

/** "B.Tech in Computer Science" -> "Computer Science". */
export function fieldFromDegree(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";

  // Prefer the last "in ..." - it is closest to the actual subject.
  const inMatch = raw.match(/\b(?:in|en|em)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ&,'’\-\s]{2,70})$/i);
  if (inMatch) {
    const field = tidyField(inMatch[1]);
    if (field && !GENERIC_DISCIPLINES.test(field)) return field;
  }

  const ofMatch = raw.match(/\bof\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ&,'’\-\s]{2,70})$/i);
  if (ofMatch) {
    const field = tidyField(ofMatch[1]);
    if (field && !GENERIC_DISCIPLINES.test(field)) return field;
  }

  // "B.Sc, Computer Science" / "M.Tech - Data Science"
  const sepMatch = raw.match(/^[^,\-–—]{2,30}[,\-–—]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ&'’\-\s]{2,70})$/);
  if (sepMatch) {
    const field = tidyField(sepMatch[1]);
    if (field && !GENERIC_DISCIPLINES.test(field) && !DEGREE_RULES.some(([p]) => p.test(field))) return field;
  }

  const parenMatch = raw.match(/\(([^)]{3,60})\)/);
  if (parenMatch) {
    const field = tidyField(parenMatch[1]);
    if (field && !GENERIC_DISCIPLINES.test(field) && !/hons?|honou?rs/i.test(field) && !DEGREE_RULES.some(([p]) => p.test(field))) {
      return field;
    }
  }

  // "B.E. Computer Engineering", "MSc Data Science" - no connector word at
  // all, just the credential followed by the subject.
  for (const [pattern] of DEGREE_RULES) {
    const m = raw.match(pattern);
    if (!m || m.index === undefined) continue;
    const after = raw
      .slice(m.index + m[0].length)
      .replace(/^[\s.,:;\-–—]+/, "")
      .replace(/^(?:of|in|en|em)\s+/i, "")
      .replace(/^\((.*)\)$/, "$1")
      .trim();
    // A subject is short and self-contained. Anything longer, or carrying a
    // bullet or a label colon, is the rest of the document rather than a
    // major - that is how a whole "Relevant Coursework:" line ended up in
    // Field of study.
    if (after.length < 3 || after.length > 60) continue;
    if (/[•·|:;]/.test(after)) continue;
    // "(Hons)", "with Distinction" and friends grade the award, not the subject.
    if (/^(hons?|honou?rs|distinction|first class|with\b.*)$/i.test(after)) continue;
    // Nor is the leftover half of a credential name a subject:
    // "Higher Secondary Certificate" must not yield a field of "Certificate".
    if (/^(certificates?|certifications?|diplomas?|degrees?|programmes?|programs?|courses?|school|education)$/i.test(after)) continue;
    const field = tidyField(after);
    if (field && !GENERIC_DISCIPLINES.test(field) && !DEGREE_RULES.some(([p]) => p.test(field))) {
      return field;
    }
  }

  return "";
}

/* ------------------------------------------------------------------ */
/* Arrays                                                              */
/* ------------------------------------------------------------------ */

/** Anything -> string[]. Handles arrays of objects and separated strings. */
export function toStringArray(v: unknown): string[] {
  if (!v) return [];
  const raw: string[] = [];

  if (typeof v === "string") {
    raw.push(...v.split(/[,;\n|•]/));
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string") {
        // An array element is one item. Splitting it on commas used to turn
        // "Certified Kubernetes Administrator (CKA), 2021" into two entries.
        raw.push(item);
      } else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        raw.push(str(o.name ?? o.skill ?? o.value ?? o.label ?? o.title ?? o.certification));
      } else {
        raw.push(str(item));
      }
    }
  } else if (typeof v === "object") {
    // {"Languages": ["Python"], "Tools": ["Git"]} -> flatten the values.
    for (const value of Object.values(v as Record<string, unknown>)) {
      raw.push(...toStringArray(value));
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = item.replace(/^[-–—•*\s]+/, "").replace(/\s+/g, " ").trim();
    if (value.length < 2 || value.length > 120) continue;
    const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 120);
}

/** Anything -> [{label,url}]. Bare URL strings become labelled entries. */
export function toWebsites(v: unknown) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const seen = new Set<string>();
  const out: Array<{ label: string; url: string }> = [];

  for (const item of list) {
    let url = "";
    let label = "";
    if (typeof item === "string") {
      url = item.trim();
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      url = str(o.url ?? o.link ?? o.href ?? o.value);
      label = str(o.label ?? o.name ?? o.type ?? o.platform);
    }
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      if (/^(mailto:|tel:)/i.test(url)) continue;
      url = `https://${url.replace(/^\/+/, "")}`;
    }
    url = url.replace(/[.,;:)\]]+$/, "");
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: pickOption(label, WEBSITE_LABEL_OPTIONS) || labelForUrl(url), url });
  }
  return out.slice(0, 20);
}

function labelForUrl(url: string) {
  const u = url.toLowerCase();
  if (u.includes("linkedin")) return "LinkedIn";
  if (u.includes("github")) return "GitHub";
  if (u.includes("twitter.com") || u.includes("//x.com")) return "Twitter/X";
  if (u.includes("dribbble")) return "Dribbble";
  if (u.includes("behance")) return "Behance";
  return "Portfolio";
}

const asArray = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12,
};

const PRESENT_RE = /^(present|current(ly)?|now|ongoing|to date|till date|till now|date|n\/?a|--?)$/i;

/**
 * "March 2021", "2021", "03/2021", "Mar '21" -> "2021-03".
 * Returns "" for present/ongoing so `current` is the single source of truth.
 */
export function normalizeMonth(v: unknown): string {
  const s = str(v);
  if (!s || PRESENT_RE.test(s)) return "";
  const validYearMonth = (year: number, month: number) =>
    year >= 1900 && year <= 2100 && month >= 1 && month <= 12;

  const isoMonth = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (isoMonth) {
    const year = Number(isoMonth[1]);
    const month = Number(isoMonth[2]);
    return validYearMonth(year, month) ? `${isoMonth[1]}-${String(month).padStart(2, "0")}` : "";
  }
  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return year >= 1900 && year <= 2100 ? `${s}-01` : "";
  }

  const named = s.toLowerCase().match(/\b([a-z]{3,9})\.?\s*,?\s*'?(\d{2,4})\b/);
  if (named) {
    const month = MONTHS[named[1]] ?? MONTHS[named[1].slice(0, 3)];
    if (month) {
      const year = named[2].length === 4 ? named[2] : Number(named[2]) <= 40 ? `20${named[2]}` : `19${named[2]}`;
      return validYearMonth(Number(year), month) ? `${year}-${String(month).padStart(2, "0")}` : "";
    }
  }

  // 03/2021 or 3-2021
  const monthYear = s.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (monthYear && validYearMonth(Number(monthYear[2]), Number(monthYear[1]))) {
    return `${monthYear[2]}-${monthYear[1].padStart(2, "0")}`;
  }

  // 2021/03
  const yearMonth = s.match(/^(\d{4})[\/\-.](\d{1,2})$/);
  if (yearMonth && validYearMonth(Number(yearMonth[1]), Number(yearMonth[2]))) {
    return `${yearMonth[1]}-${yearMonth[2].padStart(2, "0")}`;
  }

  // 15/03/2021 or 03/15/2021 - take whichever position is a valid month.
  const full = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (full) {
    const a = Number(full[1]);
    const b = Number(full[2]);
    let month = null;
    if (a > 12 && b >= 1 && b <= 12) month = b;
    else if (a >= 1 && a <= 12) month = a;
    if (month !== null && validYearMonth(Number(full[3]), month)) {
      return `${full[3]}-${String(month).padStart(2, "0")}`;
    }
    return "";
  }

  const year = s.match(/\b((?:19|20)\d{2})\b/);
  return year ? `${year[1]}-01` : "";
}

/** True when the raw end-date text says the entry is ongoing. */
function looksCurrent(o: Record<string, unknown>): boolean {
  const end = str(o.endDate ?? o.end ?? o.to ?? o.graduationDate);
  if (end && PRESENT_RE.test(end)) return true;
  if (/\b(present|current|ongoing|till date|to date|expected)\b/i.test(end)) return true;
  return bool(o.current ?? o.isCurrent ?? o.isPresent);
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function descriptionOf(o: Record<string, unknown>): string {
  const value = o.description ?? o.summary ?? o.details ?? o.responsibilities ?? o.achievements ?? o.highlights;
  if (Array.isArray(value)) {
    return value.map((v) => str(typeof v === "object" ? (v as any)?.text ?? (v as any)?.description : v)).filter(Boolean).join("\n").slice(0, 5000);
  }
  return str(value).slice(0, 5000);
}

export function toExperience(v: unknown) {
  return asArray(v)
    .map((item) => {
      if (typeof item === "string") {
        return {
          company: "", title: item.trim(), employmentType: "", location: "",
          locationType: "", startDate: "", endDate: "", current: false, description: "",
        };
      }
      const o = (item ?? {}) as Record<string, unknown>;
      const current = looksCurrent(o);
      const startDate = normalizeMonth(o.startDate ?? o.start ?? o.from ?? o.startYear);
      let endDate = current ? "" : normalizeMonth(o.endDate ?? o.end ?? o.to ?? o.endYear);
      if (startDate && endDate && endDate < startDate) endDate = "";

      return {
        company: str(o.company ?? o.employer ?? o.organization ?? o.organisation ?? o.companyName),
        title: str(o.title ?? o.role ?? o.position ?? o.jobTitle ?? o.designation),
        employmentType: pickOption(o.employmentType ?? o.type ?? o.employment_status ?? o.employmentStatus, EMPLOYMENT_TYPE_OPTIONS),
        location: str(o.location ?? o.city),
        locationType: pickOption(o.locationType ?? o.workArrangement ?? o.workMode ?? o.remote, LOCATION_TYPE_OPTIONS),
        startDate,
        endDate,
        current,
        description: descriptionOf(o),
      };
    })
    /**
     * Keep any row the user has actually put something into.
     *
     * This used to require a company or a title, which quietly deleted a row on
     * save whenever someone typed the dates and the "What you did" description
     * first — the whole entry, and the paragraph they had just written,
     * disappeared from the screen when the server echo replaced local state.
     */
    .filter((e) => e.company || e.title || e.description || e.startDate || e.endDate || e.location)
    // Resume parsers and OCR frequently emit the same role twice. Treat an
    // exact duplicate as one profile row so the extension cannot create two
    // Workday entries containing identical employer/title/date data.
    .filter((e, i, all) => {
      const key = [e.company, e.title, e.location, e.startDate, e.endDate, e.current, e.description]
        .map((v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|");
      return all.findIndex((x) => [x.company, x.title, x.location, x.startDate, x.endDate, x.current, x.description]
        .map((v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|") === key) === i;
    })
    .slice(0, 25);
}

export function toEducation(v: unknown) {
  return asArray(v)
    .map((item) => {
      if (typeof item === "string") {
        return {
          school: item.trim(), degree: "", fieldOfStudy: "", gpa: "",
          startDate: "", endDate: "", current: false, location: "", description: "",
        };
      }
      const o = (item ?? {}) as Record<string, unknown>;
      const rawDegree = str(o.degree ?? o.qualification ?? o.credential ?? o.program);
      const current = looksCurrent(o);
      const startDate = normalizeMonth(o.startDate ?? o.start ?? o.from);
      let endDate = current ? "" : normalizeMonth(o.endDate ?? o.end ?? o.to ?? o.graduationDate ?? o.completionDate);
      if (startDate && endDate && endDate < startDate) endDate = "";

      const explicitField = str(o.fieldOfStudy ?? o.major ?? o.field ?? o.subject ?? o.specialization ?? o.specialisation ?? o.branch);
      const normalizedDegree = normalizeDegree(rawDegree);
      const field = explicitField || fieldFromDegree(rawDegree);

      // The verbatim credential is worth keeping when it says more than the
      // eight-option menu can ("B.Tech" vs "Bachelor's Degree").
      const notes = [str(o.description ?? o.notes ?? o.honors ?? o.honours)];
      if (rawDegree && normalizedDegree === "Other" && !field) notes.unshift(rawDegree);

      return {
        school: str(o.school ?? o.institution ?? o.university ?? o.college ?? o.institute ?? o.schoolName),
        degree: normalizedDegree,
        fieldOfStudy: field,
        gpa: str(o.gpa ?? o.grade ?? o.cgpa ?? o.percentage ?? o.marks),
        startDate,
        endDate,
        current,
        location: str(o.location ?? o.city),
        description: notes.filter(Boolean).join(" — ").slice(0, 2000),
      };
    })
    // Same reasoning as toExperience: don't discard a part-filled entry.
    .filter((e) => e.school || e.degree || e.fieldOfStudy || e.startDate || e.endDate || e.gpa)
    .filter((e, i, all) => {
      const key = [e.school, e.degree, e.fieldOfStudy, e.startDate, e.endDate, e.gpa]
        .map((v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|");
      return all.findIndex((x) => [x.school, x.degree, x.fieldOfStudy, x.startDate, x.endDate, x.gpa]
        .map((v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|") === key) === i;
    })
    .slice(0, 15);
}

/* ------------------------------------------------------------------ */
/* Phone                                                               */
/* ------------------------------------------------------------------ */

function splitPhone(rawPhone: string, rawCode: string, country = "") {
  let phone = rawPhone.replace(/\s+/g, " ").trim();
  let code = rawCode.trim();

  if (!code) {
    // A delimiter identifies the code; greedily taking three digits from a
    // compact +1516... number used to discard the first two national digits.
    const match = phone.match(/^\+([1-9]\d{0,2})[\s.\-]+(.*)$/);
    if (match && match[2].replace(/\D/g, "").length >= 7) {
      code = `+${match[1]}`;
      phone = match[2].trim();
    } else if (/^\+\d+$/.test(phone)) {
      const known: Record<string, string> = {
        "united states": "1", "united states of america": "1", us: "1", usa: "1", canada: "1",
        india: "91", "united kingdom": "44", uk: "44", australia: "61", germany: "49", france: "33",
      };
      const prefix = /^[+]1/.test(phone) ? "1" : /^[+]7/.test(phone) ? "7" : known[country.trim().toLowerCase()];
      if (prefix && phone.startsWith(`+${prefix}`) && phone.length - prefix.length - 1 >= 7) {
        code = `+${prefix}`;
        phone = phone.slice(prefix.length + 1);
      }
    }
  } else if (!code.startsWith("+") && /^\d{1,3}$/.test(code)) {
    code = `+${code}`;
  }

  return { phone: phone.replace(/^[-.\s]+/, ""), phoneCountryCode: code };
}

/* ------------------------------------------------------------------ */
/* Top level                                                           */
/* ------------------------------------------------------------------ */

/** Everything the resume parser may return, coerced to schema shape. */
export function normalizeParsedResume(raw: any) {
  const p = (raw?.personal ?? raw?.contact ?? raw?.basics ?? {}) as Record<string, unknown>;

  const fullName = str(p.name ?? p.fullName);
  const nameParts = fullName ? fullName.split(/\s+/).filter(Boolean) : [];
  const firstName = str(p.firstName ?? p.first_name ?? p.givenName) || nameParts[0] || "";
  const lastName =
    str(p.lastName ?? p.last_name ?? p.familyName ?? p.surname) ||
    (nameParts.length > 1 ? nameParts[nameParts.length - 1] : "");
  const middleName =
    str(p.middleName ?? p.middle_name) || (nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : "");

  const { phone, phoneCountryCode } = splitPhone(
    str(p.phone ?? p.phoneNumber ?? p.mobile ?? p.telephone),
    str(p.phoneCountryCode ?? p.countryPhoneCode ?? p.dialCode),
    str(p.country)
  );

  return {
    personal: {
      firstName,
      middleName,
      lastName,
      preferredName: str(p.preferredName ?? p.preferred_name ?? p.nickname),
      aliases: str(p.aliases),
      preferredLanguage: str(p.preferredLanguage),
      email: str(p.email ?? p.emailAddress).toLowerCase(),
      phone,
      phoneCountryCode,
      phoneType: pickOption(p.phoneType, PHONE_TYPE_OPTIONS) || "Mobile",
      dateOfBirth: str(p.dateOfBirth ?? p.dob),
      address: str(p.address ?? p.addressLine1 ?? p.street),
      addressLine2: str(p.addressLine2 ?? p.address2),
      namePrefix: str(p.namePrefix ?? p.title ?? p.salutation),
      nameSuffix: str(p.nameSuffix ?? p.suffix),
      secondLastName: str(p.secondLastName ?? p.secondSurname),
      city: str(p.city ?? p.town ?? p.locality),
      state: str(p.state ?? p.region ?? p.province),
      county: str(p.county ?? p.administrativeArea2 ?? p.district),
      zip: str(p.zip ?? p.postalCode ?? p.postcode ?? p.pincode),
      country: str(p.country),
      nationality: str(p.nationality),
      citizenship: str(p.citizenship),
      languages: toStringArray(p.languages),
    },
    summary: str(raw?.summary ?? raw?.profile ?? raw?.objective).slice(0, 5000),
    targetRole: str(raw?.targetRole ?? raw?.target_role ?? raw?.headline ?? raw?.desiredRole),
    skills: toStringArray(raw?.skills ?? raw?.technicalSkills ?? raw?.coreCompetencies),
    certifications: toStringArray(raw?.certifications ?? raw?.licenses ?? raw?.licences ?? raw?.certificates),
    experience: toExperience(raw?.experience ?? raw?.workExperience ?? raw?.work_history ?? raw?.employment),
    education: toEducation(raw?.education ?? raw?.academicHistory ?? raw?.academics),
    websites: toWebsites(raw?.websites ?? raw?.links ?? raw?.profiles ?? raw?.socialLinks),
    workAuth: {
      authorizedToWork: str(raw?.workAuth?.authorizedToWork),
      requireSponsorship: str(raw?.workAuth?.requireSponsorship),
      workAuthType: pickOption(raw?.workAuth?.workAuthType, WORK_AUTH_TYPE_OPTIONS),
      visaStatus: str(raw?.workAuth?.visaStatus),
      willingToRelocate: str(raw?.workAuth?.willingToRelocate),
      availableStartDate: str(raw?.workAuth?.availableStartDate),
      noticePeriod: str(raw?.workAuth?.noticePeriod),
      over18: str(raw?.workAuth?.over18),
      previouslyEmployedHere: str(raw?.workAuth?.previouslyEmployedHere),
      relativesEmployedHere: str(raw?.workAuth?.relativesEmployedHere),
      referredBy: str(raw?.workAuth?.referredBy),
      referrerFirstName: str(raw?.workAuth?.referrerFirstName),
      referrerLastName: str(raw?.workAuth?.referrerLastName),
      referrerEmployeeId: str(raw?.workAuth?.referrerEmployeeId),
      howDidYouHear: str(raw?.workAuth?.howDidYouHear),
      securityClearance: str(raw?.workAuth?.securityClearance),
      highSchoolDiplomaOrGED: str(raw?.workAuth?.highSchoolDiplomaOrGED),
      profileVisibility: str(raw?.workAuth?.profileVisibility),
      jobNotifications: str(raw?.workAuth?.jobNotifications),
      textMessageConsent: str(raw?.workAuth?.textMessageConsent),
      signedNonCompete: str(raw?.workAuth?.signedNonCompete),
      employmentTermination: str(raw?.workAuth?.employmentTermination),
      workplaceMisconduct: str(raw?.workAuth?.workplaceMisconduct),
      driversLicense: str(raw?.workAuth?.driversLicense),
      willingToDrugTest: str(raw?.workAuth?.willingToDrugTest),
      willingToBackgroundCheck: str(raw?.workAuth?.willingToBackgroundCheck),
      remotePreference: pickOption(raw?.workAuth?.remotePreference, REMOTE_PREFERENCE_OPTIONS),
    },
    compensation: {
      desiredSalary: str(raw?.compensation?.desiredSalary),
      currentSalary: str(raw?.compensation?.currentSalary),
      salaryCurrency: str(raw?.compensation?.salaryCurrency) || "USD",
      salaryPeriod: str(raw?.compensation?.salaryPeriod) || "year",
    },
    eeo: {
      gender: str(raw?.eeo?.gender),
      genderIdentity: str(raw?.eeo?.genderIdentity),
      ethnicity: str(raw?.eeo?.ethnicity),
      sexualOrientation: str(raw?.eeo?.sexualOrientation),
      transgender: str(raw?.eeo?.transgender),
      disabilitySignatureName: str(raw?.eeo?.disabilitySignatureName),
      disabilitySignatureDate: str(raw?.eeo?.disabilitySignatureDate),
      race: str(raw?.eeo?.race),
      hispanicLatino: str(raw?.eeo?.hispanicLatino),
      veteranStatus: str(raw?.eeo?.veteranStatus),
      disabilityStatus: str(raw?.eeo?.disabilityStatus),
      declineToSelfIdentify: bool(raw?.eeo?.declineToSelfIdentify),
    },
  };
}
