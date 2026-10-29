import { connectDB } from "@/lib/db";
import SavedResponse, { normalizeQuestion } from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

/**
 * Writable fields only. `$set: body` accepted anything the caller sent — most
 * importantly `userId`, which reassigned the answer to another account.
 */
const EDITABLE: Record<string, (v: unknown) => unknown> = {
  question: (v) => String(v ?? "").slice(0, 2000),
  answer: (v) => String(v ?? "").slice(0, 20_000),
  inputType: (v) => String(v ?? "text").slice(0, 40),
  category: (v) => String(v ?? "general").slice(0, 80),
  ats: (v) => String(v ?? "").slice(0, 60),
  lastDomain: (v) => String(v ?? "").slice(0, 253),
  pinned: (v) => Boolean(v),
  options: (v) =>
    (Array.isArray(v) ? v : []).map((o) => String(o ?? "").slice(0, 500)).slice(0, 50),
};

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  await connectDB();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("That request body wasn't valid JSON.", 400);

  const update: Record<string, unknown> = {};
  for (const [key, coerce] of Object.entries(EDITABLE)) {
    if (body[key] === undefined) continue;
    update[key] = coerce(body[key]);
  }
  if (typeof update.question === "string" && update.question.trim()) {
    update.normalizedKey = normalizeQuestion(update.question);
  }
  if (!Object.keys(update).length) return fail("There was nothing to update.", 400);

  const doc = await SavedResponse.findOneAndUpdate(
    { _id: params.id, userId: user._id },
    { $set: update },
    { new: true }
  );
  if (!doc) return fail("We couldn't find that saved answer.", 404);
  return ok({ ...doc.toObject(), _id: String(doc._id) });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  await connectDB();
  const res = await SavedResponse.findOneAndDelete({ _id: params.id, userId: user._id });
  if (!res) return fail("We couldn't find that saved answer.", 404);
  return ok({ deleted: true });
});
