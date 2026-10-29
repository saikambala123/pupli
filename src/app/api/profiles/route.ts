import { connectDB } from "@/lib/db";
import Profile from "@/models/Profile";
import User from "@/models/User";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler } from "@/lib/api";
import { isPremium } from "@/lib/plan";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  await connectDB();
  const profiles = await Profile.find({ userId: user._id })
    .select("-documents.dataUrl")
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();
  return ok(profiles.map((p) => ({ ...p, _id: String(p._id), userId: String(p.userId) })));
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const count = await Profile.countDocuments({ userId: user._id });
  if (count >= 1 && !isPremium(user)) {
    return fail("Multiple profiles are a Premium feature. Start a free trial to add another.", 402);
  }
  if (count >= 8) return fail("You've reached the limit of 8 profiles.", 400);

  const body = await req.json().catch(() => ({}));

  /**
   * Sections a caller may seed a new profile with.
   *
   * This route previously read only `label`, `targetRole` and `personal` — so
   * the dashboard's "Duplicate this profile" button, which posts the whole
   * profile, produced a copy containing nothing but the contact details. Work
   * history, education, skills, links, work eligibility, compensation, EEO and
   * the summary were all silently dropped, with no error shown.
   *
   * `documents` stays excluded on purpose: base64 file data is not copied.
   */
  const SEEDABLE = [
    "summary", "websites", "education", "experience",
    "skills", "certifications", "workAuth", "compensation", "eeo", "color",
  ] as const;

  const seed: Record<string, unknown> = {};
  for (const key of SEEDABLE) if (body[key] !== undefined) seed[key] = body[key];

  const profile = await Profile.create({
    ...seed,
    userId: user._id,
    label: body.label || `Profile ${count + 1}`,
    targetRole: body.targetRole || "",
    isDefault: count === 0,
    personal: { email: user.email, ...(body.personal || {}) },
    documents: [],
  });

  if (count === 0) await User.findByIdAndUpdate(user._id, { activeProfileId: profile._id });
  return ok({ ...profile.toObject(), _id: String(profile._id) }, 201);
});
