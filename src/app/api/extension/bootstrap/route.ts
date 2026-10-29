import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Profile from "@/models/Profile";
import SavedResponse from "@/models/SavedResponse";
import User, { effectiveSettings } from "@/models/User";
import { requireUser } from "@/lib/auth";
import { ok, handler, cors } from "@/lib/api";
import { isPremium } from "@/lib/plan";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

/** How often "the extension synced" is written back — not on every request. */
const SEEN_WRITE_EVERY_MS = 5 * 60 * 1000;

/**
 * One payload the content script can cache: profiles, settings and every saved
 * answer. Called on install, on login, and whenever the dashboard pushes a change.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const [profiles, responses] = await Promise.all([
    Profile.find({ userId: user._id }).sort({ isDefault: -1 }).lean(),
    // `lastDomain` and `lastCompany` let the extension recognise the employer a
    // saved answer was given to, so "Have you worked for Leidos?" can answer
    // "…for GDIT?".
    SavedResponse.find({ userId: user._id })
      .select("question normalizedKey aliases category answer inputType options lastDomain lastCompany")
      .lean(),
  ]);

  // The Overview shows "Extension connected" once a browser has synced. Only
  // the extension calls with a bearer token; the dashboard uses its cookie.
  const fromExtension = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
  const seen = (user as any).extensionSeenAt ? new Date((user as any).extensionSeenAt).getTime() : 0;
  if (fromExtension && Date.now() - seen > SEEN_WRITE_EVERY_MS) {
    User.updateOne({ _id: user._id }, { $set: { extensionSeenAt: new Date() } }).catch(() => {});
  }

  return ok({
    user: {
      id: String(user._id),
      name: (user as any).name,
      email: (user as any).email,
      premium: isPremium(user),
    },
    settings: effectiveSettings((user as any).settings),
    activeProfileId: String((user as any).activeProfileId ?? profiles[0]?._id ?? ""),
    profiles: profiles.map((p) => ({ ...p, _id: String(p._id), userId: undefined })),
    responses: responses.map((r) => ({ ...r, _id: String(r._id) })),
    syncedAt: new Date().toISOString(),
  });
});
