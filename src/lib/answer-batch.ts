/**
 * Answering a page of application questions in one model call.
 *
 * Everything here is pure — no database, no network — so the route stays a
 * thin shell around it and the rules can be tested on their own.
 */

/**
 * Questions the model is never asked, whatever the caller says.
 *
 * Two groups: anything inside a voluntary self-identification block, and the
 * factual identity fields that always have a profile value. Kept broad on
 * purpose — a refusal here costs a blank field the applicant can fill in, while
 * a wrong answer is a false declaration they may not notice.
 */
export const IDENTITY_QUESTION_RE =
  /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number|voluntary\s+disclosure|equal\s+employment\s+opportunity|\bveteran\b|\bdisabilit(y|ies)\b|\bethnicity\b|\brace\b|\bgender\b|\bemployee\s*(id|number)\b|\bdate\s*of\s*birth\b|\bsocial\s*security\b|\bssn\b)/i;

/**
 * Declarations only the applicant can make: their record, their health, their
 * beliefs. Mirrors the extension's list, so an older extension that still
 * sends one of these gets a blank back rather than a draft.
 */
export const SENSITIVE_QUESTION_RE =
  /\b(convict\w*|felon\w*|misdemeanou?r\w*|criminal|arrest\w*|plead(ed)?\s+(guilty|no\s+contest)|probation|parole|offen[cs]es?|sex\s+offender|court[-\s]martial\w*|dishonou?rabl\w*|terminated|fired|dismissed|discharged\s+from|asked\s+to\s+resign|disciplin\w*|debarred|suspended\s+from|bankrupt\w*|restraining\s+order|medical\s+condition|pregnan\w*|religio\w*|marital|sexual\s+orientation|date\s+of\s+birth|social\s+security|ssn|national\s+origin|genetic)\b/i;

/** Saved "answers" that are credentials, never context for a model. */
const SECRET_QUESTION_RE = /\b(pass\s*word|passcode|pin\s*(code|number)?|security\s+(question|answer)|one[-\s]?time\s+code|otp|ssn|social\s+security)\b/i;

export type BatchQuestion = {
  id: string;
  question: string;
  options: string[];
  fieldType: string;
  multiple: boolean;
  maxWords: number;
  required: boolean;
};

export type MemoryRow = { question?: string; answer?: string; pinned?: boolean; useCount?: number };

const MAX_QUESTIONS = 40;

/** The request's questions, bounded and cleaned; anything malformed is dropped. */
export function sanitizeQuestions(raw: unknown): BatchQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: BatchQuestion[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const question = String(q.question ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (question.length < 3) continue;
    let id = String(q.id ?? "").trim().slice(0, 24);
    if (!id || ids.has(id)) id = `q${out.length + 1}`;
    ids.add(id);
    const options = Array.isArray(q.options)
      ? Array.from(new Set(q.options.map((o) => String(o ?? "").replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean))).slice(0, 60)
      : [];
    const fieldType = String(q.fieldType ?? "text").slice(0, 20);
    const maxWords = Math.min(250, Math.max(5, Number(q.maxWords) || (fieldType === "textarea" ? 130 : 40)));
    out.push({
      id,
      question,
      options,
      fieldType,
      multiple: Boolean(q.multiple) && options.length > 1,
      maxWords,
      required: Boolean(q.required),
    });
  }
  return out;
}

/** Is this a question the model may answer at all? */
export function askable(question: string): boolean {
  return !IDENTITY_QUESTION_RE.test(question) && !SENSITIVE_QUESTION_RE.test(question);
}

const STOP = new Set([
  "the", "and", "for", "you", "your", "are", "have", "has", "had", "been", "any", "this", "that", "with",
  "will", "would", "can", "could", "our", "its", "from", "who", "what", "which", "when", "how", "please",
  "does", "did", "was", "were", "not", "now", "all", "per",
]);

function tokens(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, ""))
      .filter((w) => w.length > 1)
  );
}

/**
 * The saved answers worth showing the model for these questions.
 *
 * Every earlier answer is a candidate, ranked by how much it shares with any
 * question on the page; credentials are never included. With few saved
 * answers, all of them go — the model is better at spotting "the same question
 * worded differently" than a word count is.
 */
export function rankMemory(rows: MemoryRow[], questions: string[], limit = 40): Array<{ question: string; answer: string }> {
  const usable = (rows ?? []).filter(
    (r) => r?.question && r?.answer && String(r.answer).trim() &&
      !SECRET_QUESTION_RE.test(String(r.question)) && !IDENTITY_QUESTION_RE.test(String(r.question))
  );
  const asked = questions.map(tokens);
  const scored = usable.map((r, index) => {
    const t = tokens(String(r.question));
    let best = 0;
    for (const q of asked) {
      if (!q.size || !t.size) continue;
      let shared = 0;
      t.forEach((w) => { if (q.has(w)) shared++; });
      best = Math.max(best, shared / Math.sqrt(q.size * t.size));
    }
    return { r, index, score: best + (r.pinned ? 0.05 : 0) };
  });
  const picked = usable.length <= limit
    ? scored
    : scored.filter((x) => x.score >= 0.15).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit);
  return picked
    .sort((a, b) => a.index - b.index)
    .map(({ r }) => ({ question: String(r.question).slice(0, 220), answer: String(r.answer).slice(0, 320) }));
}

export const BATCH_SYSTEM = [
  "You complete the open questions on a job application for one applicant. You are given their profile, answers they gave on earlier applications, the job, and a numbered list of questions. Answer each question the way this applicant would: accurately, and consistently with everything else they have said.",
  "",
  "How to answer:",
  "1. Facts about the applicant — employers, job titles, dates, schools, degrees, certifications, skills, years of experience, security clearance, citizenship or immigration status, salary, military or government service, and whether they have worked for a particular company — come only from the profile and the earlier answers. You may work a fact out from what is there (count years from the dates listed; answer \"Have you worked for X?\" from the list of employers; \"Do you have experience with Kubernetes?\" from the skills and job descriptions), but never invent one.",
  "2. The earlier answers are the applicant's own. When a question asks the same thing as an earlier one — in different words, or naming a different company — give the same answer.",
  "3. Questions about willingness or ability to meet an ordinary requirement of the job — travel, on-site or hybrid work, shift or weekend work, overtime, commuting, relocation, background checks, drug screening, performing the essential functions of the role — are answered \"Yes\" unless the profile or an earlier answer says otherwise.",
  "4. Otherwise, when the profile and the earlier answers do not settle a question, leave its answer empty (\"\"). This includes relatives or friends at the company, agreements with former employers, criminal history, health or disability, and anything you would have to guess. Consents, certifications and signatures (\"I certify…\", \"I agree to the terms…\") are the applicant's to give: leave them empty too.",
  "5. A choice question is answered with exactly one of its listed options, copied character for character. A multi-select question is answered with an array of listed options (it may be empty). Free text is first person, plain prose, specific to this job and this applicant, within the word limit, with no greeting, sign-off or markdown.",
  "",
  "Return one JSON object: {\"answers\":[{\"id\":\"q1\",\"answer\":\"...\"}]} with one entry for every question id.",
].join("\n");

function describe(q: BatchQuestion): string {
  const categories = q.options.some((o) => /\(category/i.test(o));
  let kind: string;
  if (q.multiple) kind = "multi-select";
  else if (q.options.length && categories) kind = "single choice from a menu with sub-menus: entries marked (category…) are headings — answer with the specific value you expect inside the right one, never the heading";
  else if (q.options.length) kind = "single choice";
  else if (q.fieldType === "textarea") kind = `free text, at most ${q.maxWords} words`;
  else kind = `short answer, at most ${Math.min(q.maxWords, 40)} words`;
  const lines = [`${q.id} [${kind}]${q.required ? " (required)" : ""} ${q.question}`];
  if (q.options.length) lines.push(`   Options: ${q.options.map((o) => JSON.stringify(o)).join(" | ")}`);
  return lines.join("\n");
}

export function batchPrompt(input: {
  profileContext: string;
  memory: Array<{ question: string; answer: string }>;
  questions: BatchQuestion[];
  jobTitle?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  jobDescription?: string | null;
  today: string;
}): string {
  const memory = input.memory.length
    ? input.memory.map((m) => `- Q: ${m.question}\n  A: ${m.answer}`).join("\n")
    : "(none yet)";
  const where = [input.company, input.companyDomain].filter(Boolean).join(", ");
  return [
    `Today's date: ${input.today}`,
    "",
    "Applicant profile:",
    input.profileContext,
    "",
    "Answers this applicant gave on earlier applications:",
    memory,
    "",
    `The job: ${input.jobTitle || "?"}${where ? ` at ${where}` : ""}`,
    input.jobDescription ? `Job description (excerpt):\n${String(input.jobDescription).slice(0, 3000)}` : "",
    "",
    "Questions:",
    input.questions.map(describe).join("\n"),
  ].filter((line) => line !== null).join("\n");
}

/** Enough output room for every answer, and no more — a smaller budget answers faster. */
export function tokenBudget(questions: BatchQuestion[]): number {
  let total = 200;
  for (const q of questions) {
    if (q.multiple) total += 60;
    else if (q.options.length) total += 30;
    else total += Math.ceil(Math.min(q.maxWords, 250) * 1.7) + 20;
  }
  return Math.min(6000, Math.max(512, total));
}

/**
 * The option this reply names, or null.
 *
 * Exact first, then case/punctuation-insensitive, then an option quoted inside
 * a longer sentence. Never a "closest" guess: an unrecognised reply returns
 * null so the field is left blank rather than filled with the wrong choice.
 */
export function snapToOption(reply: unknown, options: string[]): string | null {
  const text = String(reply ?? "").trim();
  if (!text) return null;
  if (options.includes(text)) return text;

  // Apostrophes are dropped rather than turned into a space: "I don't wish to
  // answer" and "I dont wish to answer" are the same choice, and EEO menus are
  // full of them.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[‘’']/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

  const wanted = norm(text);
  if (!wanted) return null;

  const exact = options.find((o) => norm(o) === wanted);
  if (exact) return exact;

  // The model wrapped the choice in a sentence. Only unambiguous hits count:
  // if two options are named, we cannot tell which was meant.
  //
  // Whole words only. A bare substring test read "I do not know" and "Not
  // applicable" as naming the option "No" — a confident answer to a Yes/No
  // question the model had explicitly declined to answer.
  const padded = ` ${wanted} `;
  const contained = options.filter((o) => {
    const key = norm(o);
    return key.length >= 2 && padded.includes(` ${key} `);
  });
  if (contained.length === 1) {
    const only = norm(contained[0]);
    // "No" inside "no, I do not know" is still a refusal to choose.
    if ((only === "no" || only === "yes") && /\b(not sure|unsure|do not know|dont know|cannot say|can t say|not applicable|n a)\b/.test(wanted)) {
      return null;
    }
    return contained[0];
  }

  return null;
}

/** Words a model uses for "I have no answer", which must never reach a form. */
const NON_ANSWER_RE =
  /^(n\/?a|none|null|unknown|not\s+(specified|provided|applicable|available|sure|known)|no\s+(answer|information|data)|unsure|tbd|-+|—|\?+)\.?$/i;

/**
 * One reply, made safe for the question it answers: an option the question
 * actually offers, a list of them, or a sentence within its word limit — or ""
 * when the reply is none of those.
 */
export function normalizeBatchAnswer(q: BatchQuestion, raw: unknown): string | string[] {
  if (raw == null) return q.multiple ? [] : "";
  const categories = q.options.some((o) => /\(category/i.test(o));

  if (q.multiple) {
    const list = Array.isArray(raw) ? raw : String(raw).split(/\s*[,;|]\s*/);
    const snapped = list.map((x) => snapToOption(x, q.options)).filter((x): x is string => Boolean(x));
    return Array.from(new Set(snapped)).slice(0, 20);
  }

  let text = String(Array.isArray(raw) ? raw[0] ?? "" : raw).trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!text || NON_ANSWER_RE.test(text)) return "";

  if (q.options.length) {
    if (categories) return text.replace(/\s*\(category[^)]*\)\s*/i, "").trim();
    return snapToOption(text, q.options) ?? "";
  }

  // Free text: plain prose, cut at the word limit.
  text = text.replace(/\*\*|__|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  const words = text.split(" ");
  const limit = Math.ceil(q.maxWords * 1.15);
  if (words.length > limit) {
    const cut = words.slice(0, limit).join(" ");
    const sentence = cut.lastIndexOf(". ");
    text = sentence > cut.length * 0.6 ? cut.slice(0, sentence + 1) : cut;
  }
  return text;
}
