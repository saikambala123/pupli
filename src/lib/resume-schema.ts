/**
 * The single source of truth for resume extraction.
 *
 * Three things live here so they can never drift apart:
 *  1. the controlled vocabularies the ProfileEditor <Select> menus use,
 *  2. the JSON Schema handed to Gemini as `responseSchema`, and
 *  3. the extraction instructions.
 *
 * Why a real schema matters: without one the model is free to rename keys,
 * flatten `experience` into a string, or merge three jobs into one bullet
 * list. Every "wrong work experience / education" report traces back to an
 * unconstrained response being coerced by lenient client-side code.
 */

/* ------------------------------------------------------------------ */
/* Controlled vocabularies - these MUST match ProfileEditor's Selects  */
/* ------------------------------------------------------------------ */

export const DEGREE_OPTIONS = [
  "High School Diploma",
  "Associate's Degree",
  "Bachelor's Degree",
  "Master's Degree",
  "MBA",
  "Doctorate (PhD)",
  "Bootcamp",
  "Other",
] as const;

export const EMPLOYMENT_TYPE_OPTIONS = [
  "Full-time",
  "Part-time",
  "Internship",
  "Contract",
  "Freelance",
  "Co-op",
] as const;

export const LOCATION_TYPE_OPTIONS = ["On-site", "Remote", "Hybrid"] as const;

export const WORK_AUTH_TYPE_OPTIONS = [
  "US Citizen",
  "Permanent Resident (Green Card)",
  "H-1B",
  "F-1 OPT",
  "F-1 CPT",
  "TN",
  "L-1",
  "EAD",
  "Other",
] as const;

export const REMOTE_PREFERENCE_OPTIONS = ["Remote", "Hybrid", "On-site", "No preference"] as const;

export const WEBSITE_LABEL_OPTIONS = [
  "LinkedIn",
  "GitHub",
  "Portfolio",
  "Personal website",
  "Twitter/X",
  "Dribbble",
  "Behance",
  "Other",
] as const;

export const PHONE_TYPE_OPTIONS = ["Mobile", "Home", "Personal", "Work"] as const;

/* ------------------------------------------------------------------ */
/* JSON Schema (OpenAPI 3.0 subset accepted by Gemini responseSchema)  */
/* ------------------------------------------------------------------ */

type JsonSchema = Record<string, any>;

const S = (description: string): JsonSchema => ({ type: "string", description });

const EXPERIENCE_ITEM: JsonSchema = {
  type: "object",
  propertyOrdering: [
    "company", "title", "employmentType", "location", "locationType",
    "startDate", "endDate", "current", "description",
  ],
  properties: {
    company: S("Employer / organisation name, exactly as printed. Never a project, product, client codename or job board."),
    title: S("Job title held at that employer, exactly as printed."),
    employmentType: {
      type: "string",
      description: "Only when the resume states it. One of: Full-time, Part-time, Internship, Contract, Freelance, Co-op. Otherwise empty string.",
    },
    location: S("City, State/Region, Country as printed. Empty string if absent."),
    locationType: {
      type: "string",
      description: "On-site, Remote or Hybrid, only when the resume says so. Otherwise empty string.",
    },
    startDate: S("Start month as YYYY-MM. Use YYYY-01 when only a year is printed. Empty string if genuinely absent."),
    endDate: S("End month as YYYY-MM. MUST be an empty string when the role is current/present/ongoing."),
    current: { type: "boolean", description: "true only when the resume marks the role as current, present or ongoing." },
    description: S("The bullet points / responsibilities for THIS role only, joined with newlines, copied near-verbatim. Never merge bullets from another role."),
  },
  required: ["company", "title", "startDate", "endDate", "current", "description"],
};

const EDUCATION_ITEM: JsonSchema = {
  type: "object",
  propertyOrdering: [
    "school", "degree", "fieldOfStudy", "gpa", "startDate", "endDate", "current", "location", "description",
  ],
  properties: {
    school: S("Institution name only - university, college, school or bootcamp. Never the degree, never the field of study, never a course name."),
    degree: S("The credential exactly as printed (e.g. 'B.Tech', 'Bachelor of Science', 'MSc', 'Diploma'). Do not translate or normalise it."),
    fieldOfStudy: S("Major / specialisation only, e.g. 'Computer Science'. Empty string if not printed."),
    gpa: S("GPA, CGPA or percentage exactly as printed, e.g. '3.8/4.0' or '82%'. Empty string if absent."),
    startDate: S("Start month as YYYY-MM, or empty string."),
    endDate: S("Graduation / end month as YYYY-MM. Empty string when still studying."),
    current: { type: "boolean", description: "true only when the resume marks this education as ongoing/expected." },
    location: S("City / country of the institution, or empty string."),
    description: S("Honours, thesis, relevant coursework or activities printed under this entry. Empty string if none."),
  },
  required: ["school", "degree", "fieldOfStudy", "startDate", "endDate", "current"],
};

const WEBSITE_ITEM: JsonSchema = {
  type: "object",
  propertyOrdering: ["label", "url"],
  properties: {
    label: S("LinkedIn, GitHub, Portfolio, Personal website, Twitter/X, Dribbble, Behance or Other."),
    url: S("The full URL as printed. Add https:// only if the resume omitted the scheme."),
  },
  required: ["label", "url"],
};

const PERSONAL: JsonSchema = {
  type: "object",
  propertyOrdering: [
    "firstName", "middleName", "lastName", "preferredName", "email", "phone",
    "phoneCountryCode", "phoneType", "address", "addressLine2", "city", "state",
    "zip", "country", "nationality", "citizenship", "languages",
  ],
  properties: {
    firstName: S("Given name only."),
    middleName: S("Middle name(s) or initial, empty string if none."),
    lastName: S("Family name only."),
    preferredName: S("Nickname in quotes or parentheses next to the name, else empty string."),
    email: S("Primary email address, copied character for character."),
    phone: S("Phone number as printed, without the country code."),
    phoneCountryCode: S("Leading country dialling code with the plus sign, e.g. '+91'. Empty string if not printed."),
    phoneType: S("Mobile unless the resume says otherwise."),
    address: S("Street address line 1, or empty string."),
    addressLine2: S("Street address line 2, or empty string."),
    city: S("City of residence."),
    state: S("State / province / region."),
    zip: S("Postal code."),
    country: S("Country of residence."),
    nationality: S("Only if explicitly stated."),
    citizenship: S("Only if explicitly stated."),
    languages: { type: "array", description: "Spoken/written languages listed on the resume.", items: { type: "string" } },
  },
  required: ["firstName", "lastName", "email", "phone"],
};

const WORK_AUTH: JsonSchema = {
  type: "object",
  properties: {
    authorizedToWork: S("Yes / No, only if the resume states work authorisation. Else empty string."),
    requireSponsorship: S("Yes / No, only if stated. Else empty string."),
    workAuthType: S("e.g. US Citizen, Permanent Resident (Green Card), H-1B, F-1 OPT. Only if stated."),
    visaStatus: S("Visa status only if stated."),
    willingToRelocate: S("Yes / No, only if stated."),
    remotePreference: S("Remote / Hybrid / On-site / No preference, only if stated."),
    availableStartDate: S("Only if stated."),
    noticePeriod: S("Only if stated."),
    securityClearance: S("Only if stated."),
    driversLicense: S("Only if stated."),
  },
};

const COMPENSATION: JsonSchema = {
  type: "object",
  properties: {
    desiredSalary: S("Only if the resume states a desired/expected salary."),
    currentSalary: S("Only if the resume states a current salary."),
    salaryCurrency: S("ISO currency code for the salary figures, else empty string."),
    salaryPeriod: S("year, month or hour, else empty string."),
  },
};

const EEO: JsonSchema = {
  type: "object",
  properties: {
    gender: S("Only if explicitly self-identified on the resume."),
    race: S("Only if explicitly self-identified."),
    hispanicLatino: S("Only if explicitly self-identified."),
    veteranStatus: S("Only if explicitly stated."),
    disabilityStatus: S("Only if explicitly stated."),
  },
};

/** Complete resume -> profile schema. Used for normal-length resumes. */
export const RESUME_SCHEMA: JsonSchema = {
  type: "object",
  propertyOrdering: [
    "personal", "summary", "targetRole", "experience", "education",
    "skills", "certifications", "websites", "workAuth", "compensation", "eeo",
  ],
  properties: {
    personal: PERSONAL,
    summary: S("The professional summary / objective / profile paragraph, copied near-verbatim. Empty string if the resume has none - never write one yourself."),
    targetRole: S("The role the candidate is targeting, only if the resume names one (headline or objective). Else empty string."),
    experience: {
      type: "array",
      description: "EVERY paid role, internship, contract and freelance engagement, newest first. Do not omit older roles. Do not merge two roles at the same employer into one entry unless the resume itself does.",
      items: EXPERIENCE_ITEM,
    },
    education: {
      type: "array",
      description: "EVERY school, college, university and bootcamp entry, newest first. One entry per credential.",
      items: EDUCATION_ITEM,
    },
    skills: {
      type: "array",
      description: "Individual skills as separate strings. Split comma/pipe/bullet separated lists. Never return a whole line as one skill. Never include category headings like 'Languages:'.",
      items: { type: "string" },
    },
    certifications: {
      type: "array",
      description: "Certifications and licences, one per string, name only (issuer and year may be appended after a comma).",
      items: { type: "string" },
    },
    websites: { type: "array", description: "Every profile/portfolio link on the resume.", items: WEBSITE_ITEM },
    workAuth: WORK_AUTH,
    compensation: COMPENSATION,
    eeo: EEO,
  },
  required: ["personal", "summary", "experience", "education", "skills", "certifications", "websites"],
};

/** Experience-only schema - second concurrent pass for long resumes. */
export const EXPERIENCE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    experience: {
      type: "array",
      description: "EVERY role in the supplied text, newest first.",
      items: EXPERIENCE_ITEM,
    },
  },
  required: ["experience"],
};

/** Everything except experience - first concurrent pass for long resumes. */
export const PROFILE_SCHEMA: JsonSchema = {
  type: "object",
  propertyOrdering: [
    "personal", "summary", "targetRole", "education", "skills",
    "certifications", "websites", "workAuth", "compensation", "eeo",
  ],
  properties: {
    personal: PERSONAL,
    summary: RESUME_SCHEMA.properties.summary,
    targetRole: RESUME_SCHEMA.properties.targetRole,
    education: RESUME_SCHEMA.properties.education,
    skills: RESUME_SCHEMA.properties.skills,
    certifications: RESUME_SCHEMA.properties.certifications,
    websites: RESUME_SCHEMA.properties.websites,
    workAuth: WORK_AUTH,
    compensation: COMPENSATION,
    eeo: EEO,
  },
  required: ["personal", "summary", "education", "skills", "certifications", "websites"],
};

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

export const RESUME_SYSTEM = `You are a precision resume parser for an ATS autofill product. You transcribe, you never author.

ACCURACY RULES
1. Copy values exactly as printed. Never translate, expand, abbreviate, re-title, correct spelling, or "clean up" a name.
2. Never invent an employer, job title, school, degree, date, credential, salary, address or answer. If a value is not printed, return an empty string (or an empty array). A blank field is always better than a plausible guess.
3. Never carry a value from one entry to another. Each role keeps its own dates, location and bullets.

COMPLETENESS RULES
4. Extract EVERY entry, not just recent ones. A 12-page resume with 9 jobs must return 9 experience objects. Work through the document top to bottom before you answer; do not summarise, sample or stop early.
5. Two roles at the same employer are two entries when the resume lists them separately (promotion history).
6. Include internships, contract, freelance, part-time, co-op, apprenticeship and self-employment in "experience".

CLASSIFICATION RULES
7. company = the organisation that paid them. title = what they were called. If a line reads "Senior Engineer, Acme Corp" then title="Senior Engineer" and company="Acme Corp". If it reads "Acme Corp - Senior Engineer" then company="Acme Corp". Use surrounding layout to decide; the employer is the one that repeats across bullet groups.
8. Never put a project name, product name, technology, client codename or university course into "company".
9. Personal projects, publications, awards, volunteering and open-source work are NOT experience. Leave them out unless a real employer is named.
10. school = institution only. Put the credential in "degree" and the major in "fieldOfStudy". "B.Tech in Computer Science, IIT Delhi" -> school="IIT Delhi", degree="B.Tech", fieldOfStudy="Computer Science".

DATE RULES
11. Output YYYY-MM. "Mar 2021"->2021-03. "03/2021"->2021-03. "2021"->2021-01. Seasons: Spring->03, Summer->06, Fall/Autumn->09, Winter->12.
12. "Present", "Current", "Now", "Till date", "Ongoing" or an open range means current=true AND endDate="".
13. Never guess a date that is not printed, and never reuse a nearby entry's date.

FIELD HYGIENE - these are the most common extraction mistakes, do not make them
14. "company" holds ONLY the employer name. Never a date, never a date range, never a location, never a label. "Client: Regions Bank Feb 2026-Till Date" -> company="Regions Bank", startDate="2026-02", current=true.
15. "location" holds ONLY a place - city, state/region, country. Never the employer. "Microsoft   Redmond, WA" -> company="Microsoft", location="Redmond, WA". "ALLY Financials, Detroit, MI" -> company="ALLY Financials", location="Detroit, MI".
15b. Consulting resumes append the staffing vendor: "Bank of America, Charlotte, NC (TCS) Hyderabad-INDIA". The employer is the client ("Bank of America") and the location is the client site ("Charlotte, NC"). Keep the vendor out of both. When the entry names no client site, use the vendor's city as the location ("Archer Daniels Midland Company (TCS)Hyderabad-INDIA" -> location "Hyderabad, India").
15c. Leave "location" empty when the resume prints no place for that role. Never copy a place from a different role.
16. "title" holds ONLY the role name. Never a label, an employer or a date.
17. "description" holds ONLY the bullets and duties. Never repeat the employer line, the location or the date range inside it.
18. Labelled resumes write each role as "Client:", "Role:", "Duration:", "Location:", "Project:", "Environment:", "Responsibilities:". Read the value after each label and DISCARD the label word itself. A label's own text is never a value.
19. Wide gaps between words in the supplied text are column separators from the original layout - the pieces on either side are different fields, not one value.

SECTION RULES
14. Split skill lists on commas, pipes, slashes and bullets into individual skills. Drop the category label ("Languages:", "Tools:").
14b. A skills MATRIX is still a skills list. When the resume tabulates them ("Skill | Years of Experience | Last Used"), take each row's first column as one skill and ignore the years/last-used columns. Do not split such a row, and do not skip a row for being wordy.
14c. Skills can also be listed per role as "Environment:" or "Technologies:" lines. Include those in "skills" as well as leaving them in the role description.
14d. If the resume has no skills section at all, return an empty array - do not invent skills from prose.
15. "summary" is the candidate's own summary/objective/profile paragraph. If the resume has none, return "".
16. Only fill workAuth, compensation and eeo from statements printed on the resume. These are almost always empty - that is the correct answer.

Return only the JSON object described by the schema.`;

export const EXPERIENCE_SYSTEM = `${RESUME_SYSTEM}

For this request return ONLY the "experience" array. Ignore education, skills and contact details entirely.`;

export const PROFILE_SYSTEM = `${RESUME_SYSTEM}

For this request return everything EXCEPT "experience". Do not include an experience key.`;

/**
 * Plain-text shape used as a belt-and-braces hint, and as the whole contract
 * if a deployment's model/key combination rejects responseSchema.
 */
export const RESUME_SHAPE_HINT = `{"personal":{"firstName":"","middleName":"","lastName":"","preferredName":"","email":"","phone":"","phoneCountryCode":"","phoneType":"Mobile","address":"","addressLine2":"","city":"","state":"","zip":"","country":"","nationality":"","citizenship":"","languages":[]},
 "summary":"","targetRole":"",
 "experience":[{"company":"","title":"","employmentType":"","location":"","locationType":"","startDate":"YYYY-MM","endDate":"YYYY-MM","current":false,"description":""}],
 "education":[{"school":"","degree":"","fieldOfStudy":"","gpa":"","startDate":"YYYY-MM","endDate":"YYYY-MM","current":false,"location":"","description":""}],
 "skills":[],"certifications":[],
 "websites":[{"label":"LinkedIn","url":""}],
 "workAuth":{"authorizedToWork":"","requireSponsorship":"","workAuthType":"","visaStatus":"","willingToRelocate":"","remotePreference":"","availableStartDate":"","noticePeriod":"","securityClearance":"","driversLicense":""},
 "compensation":{"desiredSalary":"","currentSalary":"","salaryCurrency":"","salaryPeriod":""},
 "eeo":{"gender":"","race":"","hispanicLatino":"","veteranStatus":"","disabilityStatus":""}}`;
