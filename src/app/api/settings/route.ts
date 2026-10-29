import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import User, { SETTINGS_FIELDS, effectiveSettings } from "@/models/User";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

/**
 * Both the dashboard (its cookie) and the extension popup (its bearer token)
 * change settings here. The request used to be ignored when resolving the
 * user, so every switch flipped in the popup was refused as signed out — and
 * the next sync quietly switched it back, which is how "Draft answers to new
 * questions" could be turned on and never take effect.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  return ok(effectiveSettings((user as any).settings));
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Send an object of settings to change.", 400);
  }

  /**
   * Whitelisted and coerced. The old version interpolated every key the caller
   * sent straight into a `settings.<key>` update path, so a client could write
   * arbitrary field names — and arbitrarily large values — into the user
   * document with no validation and no size ceiling.
   */
  const update: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const coerce = SETTINGS_FIELDS[key];
    if (!coerce) { rejected.push(key); continue; }
    update[`settings.${key}`] = coerce(value);
  }
  // The applicant's own choice about AI answers is what makes a stored value
  // count — see `effectiveSettings`.
  if ("settings.aiAnswers" in update) update["settings.aiAnswersSetAt"] = new Date();

  if (!Object.keys(update).length) {
    return fail(
      rejected.length
        ? `None of those are settings we recognise: ${rejected.slice(0, 5).join(", ")}.`
        : "There was nothing to update.",
      400
    );
  }

  const updated = await User.findByIdAndUpdate(user._id, { $set: update }, { new: true }).select("settings");

  return ok({ ...effectiveSettings(updated?.settings), ignored: rejected });
});
