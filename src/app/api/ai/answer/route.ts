import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Profile from "@/models/Profile";
import SavedResponse, { normalizeQuestion } from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { isPremium } from "@/lib/plan";
import { textAIEnabled, askAI, askAIJSON, profileToContext, AI_SETUP_HINT } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import {
  IDENTITY_QUESTION_RE, askable, sanitizeQuestions, rankMemory, batchPrompt, tokenBudget,
  normalizeBatchAnswer, snapToOption, BATCH_SYSTEM,
} from "@/lib/answer-batch";

export const dynamic = "force-dynamic";
// One call answers a whole page; the model is given 20 seconds of it.
export const maxDuration = 30;
export const OPTIONS = () => cors();

/** How long the model may take over a page of questions before we answer without it. */
const BATCH_BUDGET_MS = 20_000;

/**
 * Premium — writes answers to application questions using the candidate's own
 * profile and earlier answers as the only source of facts.
 *
 * Two shapes: `{ questions: [...] }` answers a whole page in one model call,
 * which is what the extension sends; `{ question }` answers one, for older
 * extensions.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  if (!isPremium(user)) return fail("Generated answers are a Premium feature.", 402);
  if (!textAIEnabled()) return fail(AI_SETUP_HINT, 503);

  // A long form can ask for many drafts, but a runaway content script shouldn't
  // be able to bill an unbounded number of Gemini calls to this deployment.
  // A page of questions counts once.
  await rateLimit("ai-answer", String(user._id), { limit: 120, windowSec: 3600 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("Send the question to answer.", 400);
  if (Array.isArray((body as any).questions)) return answerPage(user, body as Record<string, unknown>);

  const { question, jobTitle, company, jobDescription, profileId, maxWords = 120, options, fieldType = "text", multiple = false } = body as any;
  if (!question) return fail("We need the question text.", 400);

  /**
   * Voluntary self-identification and identity questions are refused here, not
   * just in the extension.
   *
   * The extension is the only caller today, but it is the caller that got this
   * wrong: a CC-305 "Name" box reached this route with the disability question
   * in its surrounding context and came back "Yes", and an "Employee ID" box
   * came back with the applicant's name. Both are declarations on a federal
   * form. Every one of these questions has a deterministic answer in the
   * profile or no answer at all, so a generated one is never the right output
   * and the refusal belongs on both sides of the wire.
   */
  if (IDENTITY_QUESTION_RE.test(String(question))) {
    return ok({ answer: "", skipped: "identity" });
  }
  // Criminal record, dismissals, health and the like: the applicant's to state.
  if (!askable(String(question))) {
    return ok({ answer: "", skipped: "sensitive" });
  }

  await connectDB();
  const profile = await profileFor(user._id, profileId);
  if (!profile) return fail("Create a profile first.", 400);

  const baseSystem =
    "You help a job applicant answer application questions. Use only facts present in their profile or in the answers they have given before — never invent employers, dates, numbers, credentials, immigration status, demographic information, or preferences. For sensitive questions, use an explicit profile value or choose the neutral decline option when one exists. Never guess.";

  // What this person has already answered elsewhere is the best source after
  // the profile itself: it is their own wording, already approved by them.
  // Wording differs between portals, so the model gets the shortlist and
  // decides, rather than relying on an exact key match.
  const memory = await loadRelatedAnswers(user._id, String(question));
  const memoryBlock = memory.length
    ? `\n\nAnswers this applicant has given before (reuse when the question means the same thing):\n${memory
        .map((m) => `- Q: ${m.question}\n  A: ${m.answer}`)
        .join("\n")}`
    : "";

  const context = `Applicant profile:\n${profileToContext(profile)}${memoryBlock}\n\nRole: ${jobTitle ?? "?"} at ${company ?? "?"}\n${
    jobDescription ? `Job description:\n${String(jobDescription).slice(0, 4000)}\n` : ""
  }\nApplication question: "${question}"`;

  // Checkbox groups can have several correct choices. Force JSON array output
  // so the extension can select multiple real DOM checkboxes instead of trying
  // to interpret a sentence such as "Python and Java".
  if (fieldType === "checkbox" && multiple && options?.length) {
    const result = await askAIJSON<{ answers?: string[] }>(
      `${baseSystem}\nFor a checkbox/multi-select question, return only choices that are supported by the profile. Return an empty array if none are supported.`,
      `${context}\n\nAvailable choices (use these exact strings only): ${options.join(" | ")}\nReturn JSON exactly as: {"answers":["choice 1","choice 2"]}`,
      500
    );
    // Snap each reply to the option it names. Requiring a byte-identical string
    // threw away answers that differed only in case, surrounding spaces or a
    // trailing asterisk the portal prints on required choices — so a correct
    // multi-select came back empty and the group was left for the applicant.
    const answers = Array.isArray(result?.answers)
      ? (result.answers.map((x) => snapToOption(x, options)).filter(Boolean) as string[]).slice(0, 20)
      : [];
    return ok({ answer: Array.from(new Set(answers)) });
  }

  // A menu entry marked "(category, has sub-options)" is a heading, not an
  // answer. "How Did You Hear About Us?" on Workday shows "Job Board" and
  // "Social Media" at the top level and hides LinkedIn one level down, so the
  // model must be free to name a value that is not in the visible list.
  const hasCategories = Array.isArray(options) && options.some((o: string) => /\(category/i.test(o));

  const optionLine = options?.length
    ? hasCategories
      ? `\n\nThis is a single-choice menu with sub-menus. Entries marked "(category, has sub-options)" are headings — never answer with one. Reply with the single most accurate value for this applicant: either a plain entry from the list below, verbatim, or the specific value you expect to find inside the right category (for example answer "LinkedIn" rather than "Social Media"). Reply with the value only.\nMenu: ${options.join(" | ")}`
      : `\n\nThis is a single-choice field. Reply with exactly one option from this list, verbatim: ${options.join(" | ")}`
    : `\n\nWrite at most ${maxWords} words. Plain prose, first person, no greeting, no sign-off, no markdown.`;

  const raw = await askAI(baseSystem, `${context}${optionLine}`, 600);
  let answer = String(raw).replace(/\s*\(category[^)]*\)\s*/i, "").trim();

  /**
   * A single-choice menu only accepts one of its own entries.
   *
   * The extension refuses anything that is not on the menu — correctly, since a
   * fuzzy match here is how a question gets confidently answered with something
   * the applicant would never have picked. But a reply that differs from an
   * option only by case, quotes, or a wrapping sentence ("I would say Yes.")
   * was being thrown away too, and the field was reported as needing the
   * applicant when the model had in fact answered it. Snapping to the exact
   * option text keeps the strictness and recovers those.
   *
   * Menus with sub-menus are left alone: there the model is deliberately free
   * to name a value that is one level down and not in the list it was shown.
   */
  if (!hasCategories && Array.isArray(options) && options.length) {
    answer = snapToOption(answer, options) ?? "";
  }

  return ok({ answer });
});

/**
 * The saved answers most likely to be relevant to this question: an exact
 * normalized-key hit first, then anything sharing a meaningful word with it.
 */
async function loadRelatedAnswers(userId: unknown, question: string) {
  try {
    const key = normalizeQuestion(question);
    /**
     * The words go into a regular expression, so they are escaped first.
     *
     * `question` is whatever the page said; a question containing `(`, `*` or
     * `[` produced an invalid expression and the whole lookup threw, which the
     * catch below turned into "this applicant has never answered anything".
     * The memory silently stopped working on exactly the portals whose question
     * text carries punctuation — and a crafted question could otherwise hand
     * MongoDB an expression expensive enough to tie up the connection.
     */
    const words = key
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    const rows = await SavedResponse.find({
      userId,
      answer: { $nin: ["", null] },
      ...(words.length ? { $or: [{ normalizedKey: key }, { normalizedKey: { $regex: words.join("|") } }] } : { normalizedKey: key }),
    })
      .select("question answer normalizedKey pinned useCount")
      .sort({ pinned: -1, useCount: -1, updatedAt: -1 })
      .limit(12)
      .lean();

    return (rows as Array<{ question?: string; answer?: string }>)
      .filter((r) => r?.question && r?.answer)
      .map((r) => ({ question: String(r.question).slice(0, 160), answer: String(r.answer).slice(0, 400) }));
  } catch {
    // Memory is an enhancement; never let it break answering.
    return [];
  }
}

/** The applicant's profile for this request: the one asked for, else their default. */
async function profileFor(userId: unknown, profileId: unknown) {
  const id = typeof profileId === "string" && /^[a-f0-9]{24}$/i.test(profileId) ? profileId : null;
  return (
    (id && (await Profile.findOne({ _id: id, userId }).lean())) ||
    (await Profile.findOne({ userId, isDefault: true }).lean()) ||
    (await Profile.findOne({ userId }).lean())
  );
}

/**
 * A whole page of questions in one model call.
 *
 * The model sees the profile, every saved answer that bears on the page, the
 * job, and the questions together — so an answer is consistent with the rest
 * of the page, and a question the applicant has answered before for another
 * company is recognised. Identity, self-identification and record questions
 * are never put to it; they come back blank.
 */
async function answerPage(user: any, body: Record<string, unknown>) {
  const started = Date.now();
  const questions = sanitizeQuestions(body.questions);
  const answers = new Map<string, string | string[]>();
  const toAsk = questions.filter((q) => askable(q.question));
  const reply = () =>
    ok({ answers: questions.map((q) => ({ id: q.id, answer: answers.get(q.id) ?? (q.multiple ? [] : "") })) });
  if (!toAsk.length) return reply();

  await connectDB();
  const profile = await profileFor(user._id, body.profileId);
  if (!profile) return fail("Create a profile first.", 400);

  let memoryRows: any[] = [];
  try {
    memoryRows = await SavedResponse.find({ userId: user._id, answer: { $nin: ["", null] } })
      .select("question answer pinned useCount")
      .sort({ pinned: -1, useCount: -1, updatedAt: -1 })
      .limit(300)
      .lean();
  } catch {
    // Memory is an enhancement; never let it stop the page being answered.
  }
  const memory = rankMemory(memoryRows, toAsk.map((q) => q.question));

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const prompt = batchPrompt({
    profileContext: profileToContext(profile),
    memory,
    questions: toAsk,
    jobTitle: typeof body.jobTitle === "string" ? body.jobTitle.slice(0, 180) : null,
    company: typeof body.company === "string" ? body.company.slice(0, 120) : null,
    companyDomain: typeof body.companyDomain === "string" ? body.companyDomain.slice(0, 120) : null,
    jobDescription: typeof body.jobDescription === "string" ? body.jobDescription.slice(0, 3000) : null,
    today,
  });

  let result: { answers?: Array<{ id?: unknown; answer?: unknown }> } | null = null;
  try {
    result = await askAIJSON<{ answers?: Array<{ id?: unknown; answer?: unknown }> }>(
      BATCH_SYSTEM,
      prompt,
      tokenBudget(toAsk),
      { deadline: started + BATCH_BUDGET_MS, timeoutMs: BATCH_BUDGET_MS, retries: 1 }
    );
  } catch (err: any) {
    console.warn("[ai/answer] page of questions failed:", String(err?.message ?? err).slice(0, 300));
    return fail("The answer service didn't respond in time. Press Fill again to retry.", 502);
  }

  const byId = new Map(toAsk.map((q) => [q.id, q]));
  const replies = Array.isArray(result?.answers) ? result!.answers : [];
  replies.forEach((item, index) => {
    // Matched by id; a reply without one is matched by position.
    const q = byId.get(String(item?.id ?? "")) ?? (item?.id == null ? toAsk[index] : undefined);
    if (!q || answers.has(q.id)) return;
    answers.set(q.id, normalizeBatchAnswer(q, item?.answer));
  });
  return reply();
}
