import { requireUser } from "@/lib/auth";
import { ok, fail, handler } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { parseBudgetMs, geminiDiagnostics } from "@/lib/ai";
import { parseResumeDocument } from "@/lib/resume-parse";
import { fallbackParseResumeText } from "@/lib/resume-fallback";
import { normalizeParsedResume } from "@/lib/profile-shape";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel Hobby caps Node functions at 60s. Raise RESUME_PARSE_BUDGET_MS and
// this value together on a plan that allows longer functions.
export const maxDuration = 60;
export const preferredRegion = "iad1";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Health check: which Gemini models can this deployment's key actually use?
 *
 * Open /api/ai/parse-resume while signed in. If `ok` is false the response
 * says exactly which model was refused and why, which beats guessing at the
 * API key when the real problem is that the key's tier cannot reach a model.
 */
export const GET = handler(async (req: Request) => {
  await requireUser(req as any);
  const report = await geminiDiagnostics();
  return ok(report, report.ok ? 200 : 503);
});

/**
 * Accepts the resume file itself (multipart) or pre-extracted text (JSON).
 *
 * Nothing is written to the profile - the UI shows the result for the user to
 * review and accept. `_meta` travels with the payload so the UI can tell the
 * user when a section came from degraded extraction instead of pretending
 * every parse is equally trustworthy.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser(req as any);

  // Resume parsing is the most expensive call in the app — a multi-page PDF sent
  // to Gemini. Without a per-account ceiling one signed-in user can run up an
  // unbounded API bill (and hold serverless functions open) in a loop.
  await rateLimit("parse-resume", String(user._id), { limit: 20, windowSec: 3600 });

  const started = Date.now();
  const deadline = started + parseBudgetMs();
  const contentType = req.headers.get("content-type") ?? "";

  /* ---------- JSON body: the caller already extracted the text ---------- */
  if (contentType.includes("application/json")) {
    const { text } = await req.json().catch(() => ({ text: "" }));
    const resumeText = String(text ?? "");
    if (resumeText.trim().length < 60) {
      return fail("We couldn't read enough text from that file. Try a PDF, DOC, DOCX, RTF or TXT resume.", 400);
    }

    // Route text through the same pipeline by wrapping it as a text upload,
    // so JSON callers get identical accuracy instead of a thinner code path.
    try {
      const parsed = await parseResumeDocument({
        buffer: Buffer.from(resumeText, "utf8"),
        mimeType: "text/plain",
        filename: "resume.txt",
        deadline,
      });
      return ok(withMeta(parsed));
    } catch (err) {
      console.error("[parse-resume:text] falling back to local extraction", err);
      return ok(withMeta({ ...fallbackParseResumeText(resumeText), _meta: { source: "local", aiUsed: false, warnings: ["AI parsing was unavailable, so this came from basic text extraction."] } }));
    }
  }

  /* ---------- Multipart: the file itself ---------- */
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return fail("Choose a resume file to read.", 400);
  if (!file.size) return fail("That file is empty. Choose a valid resume and try again.", 400);
  if (file.size > MAX_BYTES) {
    return fail("That resume is over 10 MB. Please export or compress it to a smaller PDF or DOCX and try again.", 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const parsed = await parseResumeDocument({
      buffer,
      mimeType: file.type || "application/octet-stream",
      filename: file.name,
      deadline,
    });
    return ok(withMeta(parsed));
  } catch (err: any) {
    const message = String(err?.message || "We couldn't parse that resume.");

    // Client-fixable file problems should not become opaque 500s.
    if (/unsupported resume format|password protected|encrypted|couldn't read (this|any)|corrupt/i.test(message)) {
      return fail(message, 422);
    }
    if (/AI features need|authentication failed|API key|invalid api|unauthorized|forbidden/i.test(message)) {
      return fail(message, 503);
    }
    if (/rate limit|temporarily unavailable|timed out|unavailable/i.test(message)) {
      return fail("The AI service is busy right now. Please try the upload again in a moment.", 503);
    }

    console.error("[parse-resume] unexpected parser error", err);
    return fail("We could not parse that resume. Please try the upload again with the original file.", 422);
  }
});

/**
 * `normalizeParsedResume` deliberately returns only profile fields, so carry
 * the parse metadata across separately.
 */
function withMeta(parsed: Record<string, any>) {
  const normalized = normalizeParsedResume(parsed);
  const meta = parsed?._meta ?? {};
  return {
    ...normalized,
    _meta: {
      source: meta.source ?? "ai",
      aiUsed: meta.aiUsed !== false,
      model: meta.model ?? "",
      strategy: meta.strategy ?? "",
      pages: meta.pages ?? 0,
      chars: meta.chars ?? 0,
      textQuality: meta.textQuality ?? null,
      durationMs: meta.durationMs ?? 0,
      warnings: Array.isArray(meta.warnings) ? meta.warnings.slice(0, 8) : [],
      counts: {
        experience: normalized.experience.length,
        education: normalized.education.length,
        skills: normalized.skills.length,
        certifications: normalized.certifications.length,
        websites: normalized.websites.length,
      },
    },
  };
}
