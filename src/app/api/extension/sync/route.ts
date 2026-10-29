import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Application from "@/models/Application";
import SavedResponse, { normalizeQuestion } from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

/**
 * Text that is an answer, not a question.
 *
 * The extension resolves a choice group's question from its legend or heading,
 * but a form can always render markup neither of us anticipated, and the cost
 * of guessing wrong is permanent: a record saved under "Prefer not to say" is
 * matched against every later form and can never be matched by the question it
 * really answers. Nothing matching this is stored, whatever the client sends.
 */
const ANSWER_LIKE =
  /^(?:yes|no|y|n|true|false|maybe|other|none|n\/?a|not applicable|unsure|male|female|man|woman|non[-\s]?binary|transgender|prefer not to (?:say|answer|disclose|respond|specify)|i (?:do not|don't|dont) (?:wish|want|choose) to (?:answer|say|disclose|self[-\s]?identify|specify)|(?:i )?(?:decline|choose not|do not wish|don't wish) to (?:self[-\s]?identify|answer|disclose|specify|state)|declined? to self[-\s]?identify|do not wish to disclose|select(?:\s*an?\s*option|\s*one)?|please select|choose(?:\s*an?\s*option|\s*one)?)\s*[.?!*]?$/i;

/** Is this string usable as the question half of a saved answer? */
function isRealQuestion(q: string) {
  const text = q.trim();
  if (text.length < 5 || text.length > 300) return false;
  if (ANSWER_LIKE.test(text)) return false;
  // A question has words. A bare code, id or number is a capture artefact.
  if (!/[a-z]{3}/i.test(text)) return false;
  return true;
}

function categorizeQuestion(q: string) {
  const s = q.toLowerCase();
  if (/sponsor|visa|authorized|work permit|immigration/.test(s)) return "work-authorization";
  if (/salary|compensation|pay|rate|bonus/.test(s)) return "compensation";
  if (/education|degree|school|university|college|gpa|major/.test(s)) return "education";
  if (/experience|employer|company|job title|role|responsibil/.test(s)) return "experience";
  if (/linkedin|github|portfolio|website|url/.test(s)) return "links";
  if (/location|city|state|address|country|phone|email/.test(s)) return "contact";
  if (/gender|race|ethnicity|veteran|disability|hispanic|sexual orientation|transgender/.test(s)) return "eeo";
  if (/relocat|remote|hybrid|onsite|start date|notice period|availability/.test(s)) return "availability";
  return "general";
}

/**
 * The extension posts here after a successful autofill/submit:
 *   { application: {...}, responses: [{question, answer, inputType}] }
 * Both halves are optional so a page can report responses without an application.
 */
/**
 * The extension's sync payload.
 *
 * This is the highest-volume untrusted input the portal takes, and it had no
 * schema and no size limit. Two consequences worth closing:
 *
 *   - strings were written to the database at whatever length arrived, so one
 *     malformed capture could store a megabyte against a job title;
 *   - `responses` was walked with an awaited database call per item, so a
 *     thousand-item array became a thousand sequential round trips and a
 *     request that ties up a connection for minutes.
 *
 * Fields are capped at lengths comfortably above anything a real form produces,
 * and the array is capped at 200 — an application with more answers than that is
 * a bug, not a candidate.
 */
const str = (max: number) => z.string().trim().max(max);

const SyncBody = z.object({
  application: z
    .object({
      jobTitle: str(300),
      company: str(300).optional(),
      companyDomain: str(300).optional(),
      location: str(300).optional(),
      ats: str(60).optional(),
      url: str(2000).optional(),
      profileId: str(64).optional(),
      appliedAt: z.union([z.string(), z.number()]).optional(),
      autofill: z.record(z.unknown()).optional(),
    })
    .partial({ jobTitle: true })
    .optional(),
  responses: z
    .array(
      z.object({
        question: str(2000),
        answer: str(10000).optional(),
        inputType: str(40).optional(),
        options: z.array(str(500)).max(100).optional(),
        ats: str(60).optional(),
        domain: str(300).optional(),
        company: str(120).optional(),
      })
    )
    .max(200)
    .optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const parsed = SyncBody.safeParse(await req.json());
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "That sync payload was not readable.", 400);
  }
  const body = parsed.data;

  let application = null;
  if (body.application?.jobTitle) {
    const a = body.application;

    // `url` is the de-duplication key. Mongoose drops `undefined` from a query,
    // so an upsert filtered on a missing URL collapsed to `{ userId }` and
    // overwrote whichever application Mongo matched first. Insert instead.
    const url = typeof a.url === "string" && a.url.trim() ? a.url.trim() : null;

    const set = {
      userId: user._id,
      jobTitle: a.jobTitle,
      company: a.company,
      companyDomain: a.companyDomain,
      location: a.location,
      ats: a.ats,
      source: "extension" as const,
      profileId: a.profileId || undefined,
      lastActivityAt: new Date(),
      autofill: a.autofill ?? {},
    };
    const onInsert = {
      stage: "applied",
      appliedAt: a.appliedAt ? new Date(a.appliedAt) : new Date(),
      events: [{ stage: "applied", at: new Date() }],
    };

    application = url
      ? await Application.findOneAndUpdate(
          { userId: user._id, url },
          { $set: { ...set, url }, $setOnInsert: onInsert },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        )
      : await Application.create({ ...set, ...onInsert });
  }

  let savedCount = 0;
  const savedKeys: string[] = [];
  const rejectedKeys: string[] = [];
  if (Array.isArray(body.responses) && body.responses.length) {
    // Validate/filter once, then persist in one MongoDB bulk operation. The
    // previous implementation performed a find + save/create for every answer,
    // turning a large application into hundreds of sequential round trips and
    // making sync noticeably slow on serverless cold starts.
    const clean = body.responses
      .map((r) => {
        const question = String(r?.question || "").trim();
        const answer = String(r?.answer ?? "").trim();
        const normalizedKey = normalizeQuestion(question);
        if (!question || !answer || !normalizedKey) {
          if (question) rejectedKeys.push(normalizedKey || question.slice(0, 180));
          return null;
        }
        if (!isRealQuestion(question)) {
          rejectedKeys.push(normalizedKey);
          return null;
        }
        return {
          question, answer, normalizedKey,
          inputType: r.inputType || "text",
          options: Array.isArray(r.options) ? r.options.slice(0, 50) : [],
          ats: r.ats,
          lastDomain: r.domain,
          lastCompany: r.company,
          category: categorizeQuestion(question),
        };
      })
      .filter(Boolean) as Array<{
        question: string; answer: string; normalizedKey: string; inputType: string;
        options: string[]; ats?: string; lastDomain?: string; lastCompany?: string; category: string;
      }>;

    if (clean.length) {
      // A single form can report the same question more than once (for example
      // a change event followed by the final submit sweep). Keep the latest
      // answer per key before building upserts so two operations in the same
      // bulk request can never race on the unique index.
      const latestByKey = new Map(clean.map((r) => [r.normalizedKey, r]));
      const deduped = Array.from(latestByKey.values());
      const ops = deduped.map((r) => ({
        updateOne: {
          filter: { userId: user._id, normalizedKey: r.normalizedKey },
          update: {
            $set: {
              question: r.question,
              answer: r.answer,
              inputType: r.inputType,
              options: r.options,
              ...(r.ats ? { ats: r.ats } : {}),
              ...(r.lastDomain ? { lastDomain: r.lastDomain } : {}),
              ...(r.lastCompany ? { lastCompany: r.lastCompany } : {}),
              lastUsedAt: new Date(),
              category: r.category,
            },
            $setOnInsert: {
              userId: user._id,
              normalizedKey: r.normalizedKey,
              source: "user",
            },
            $addToSet: { aliases: r.question },
            // useCount lives only here now. MongoDB rejects an update that
            // touches the same field in both $setOnInsert and $inc — every
            // upsert in this batch threw "conflicting update operators",
            // which failed the whole bulkWrite and is why Sync reported
            // failure on every attempt, and why nothing ever reached Saved
            // Answers to be reused on the next application. $inc alone
            // still seeds the field correctly: 1 on insert, +1 on update.
            $inc: { useCount: 1 },
          },
          upsert: true,
        },
      }));

      const result = await SavedResponse.bulkWrite(ops, { ordered: false });
      // What the database actually wrote. Reporting the length of the batch we
      // handed it made a partial — or entirely failed — write look like a clean
      // sync in the extension, which is why "synced" and "still missing from
      // Saved Answers" could both be true at once.
      // Matched rather than modified: re-saving an answer that is already
      // correct changes no field, and counting only modifications would report
      // that perfectly successful write as nothing stored.
      savedCount = (result.upsertedCount ?? 0) + (result.matchedCount ?? 0);
      savedKeys.push(...deduped.map((r) => r.normalizedKey));
    }
  }

  return ok({
    applicationId: application ? String(application._id) : null,
    responsesSaved: savedCount,
    savedKeys,
    rejectedKeys,
    syncedAt: new Date().toISOString(),
  });
});
