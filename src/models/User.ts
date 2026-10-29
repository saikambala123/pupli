import mongoose, { Schema, model, models } from "mongoose";

const SettingsSchema = new Schema(
  {
    autofillOnLoad: { type: Boolean, default: false },     // fill as soon as a form is detected
    autoPilot: { type: Boolean, default: false },          // fill + advance + submit
    showOverlay: { type: Boolean, default: false },         // the status pill on the page
    trackAutomatically: { type: Boolean, default: true },  // log applications on submit
    reuseSavedResponses: { type: Boolean, default: true },
    aiAnswers: { type: Boolean, default: true },           // Premium: answer what the profile and saved answers can't
    // When the applicant last set `aiAnswers` themselves. Until they do, the
    // effective value is on — see `effectiveSettings`. Server-owned.
    aiAnswersSetAt: Date,

    // These three are written by the extension popup and read by the content
    // script. They were previously undeclared, which meant any server-side read
    // through a hydrated (non-lean) document saw `undefined` even though the
    // value was in the database. Declaring them keeps both paths in agreement.
    overwriteExisting: { type: Boolean, default: false },  // replace answers already in the form
    autoAttachResume: { type: Boolean, default: false },   // retired: uploads are always left to the applicant
    eeoFallbackDecline: { type: Boolean, default: false }, // answer EEO questions with "decline to self-identify"

    fillDelayMs: { type: Number, default: 0 },             // pause after typed boxes only; the extension caps it at 30ms
    dailyGoal: { type: Number, default: 10 },
    excludedDomains: { type: [String], default: [] },
    theme: { type: String, enum: ["light", "dark", "system"], default: "system" },
  },
  { _id: false }
);

/**
 * The settings as the extension and dashboard should act on them.
 *
 * "Answer remaining questions with AI" used to default to off, and the default
 * was written into every account at creation — so an applicant with Premium
 * saw their application questions left blank until they found the switch. It
 * now defaults to on; a stored `false` counts only if the applicant chose it
 * themselves (`aiAnswersSetAt`), which every change through the settings API
 * records.
 */
export function effectiveSettings(raw: any): Record<string, unknown> {
  const settings = raw?.toObject?.() ?? raw ?? {};
  const out: Record<string, unknown> = { ...settings };
  out.aiAnswers = settings.aiAnswersSetAt ? settings.aiAnswers !== false : true;
  delete out.aiAnswersSetAt;
  return out;
}

/** Every settings key a client is allowed to write, with its coercion. */
export const SETTINGS_FIELDS: Record<string, (v: unknown) => unknown> = {
  autofillOnLoad: Boolean,
  autoPilot: Boolean,
  showOverlay: Boolean,
  trackAutomatically: Boolean,
  reuseSavedResponses: Boolean,
  aiAnswers: Boolean,
  overwriteExisting: Boolean,
  autoAttachResume: Boolean,
  eeoFallbackDecline: Boolean,
  fillDelayMs: (v) => Math.min(5000, Math.max(0, Number(v) || 0)),
  dailyGoal: (v) => Math.min(500, Math.max(1, Number(v) || 10)),
  excludedDomains: (v) =>
    (Array.isArray(v) ? v : [])
      .map((d) => String(d ?? "").trim().toLowerCase().slice(0, 253))
      .filter(Boolean)
      .slice(0, 200),
  theme: (v) => (["light", "dark", "system"].includes(String(v)) ? String(v) : "system"),
};

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String },
    name: { type: String, trim: true },
    avatarUrl: String,
    provider: { type: String, enum: ["credentials", "google", "linkedin"], default: "credentials" },
    providerId: String,

    plan: { type: String, enum: ["free", "premium"], default: "free" },
    trialEndsAt: Date,
    premiumUntil: Date,
    stripeCustomerId: String,
    stripeSubscriptionId: String,

    activeProfileId: { type: Schema.Types.ObjectId, ref: "Profile" },

    // 6-character code shown in the dashboard to pair the browser extension.
    // Unique (sparse, so the many users without a live code don't collide) —
    // two users holding the same code at once would let the extension redeem
    // it against whichever document Mongo happened to return first.
    pairingCode: { type: String, index: true, unique: true, sparse: true },
    pairingCodeExpires: Date,

    /**
     * Bumped to retire every token issued before now. Password reset and
     * "sign out everywhere" both increment it; `getCurrentUser` refuses any
     * token carrying an older value.
     */
    sessionVersion: { type: Number, default: 0 },

    // Password reset + email confirmation. Only hashes are stored.
    emailVerified: { type: Boolean, default: false },
    verifyTokenHash: { type: String, index: true },
    verifyTokenExpires: Date,
    resetTokenHash: { type: String, index: true },
    resetTokenExpires: Date,

    settings: { type: SettingsSchema, default: () => ({}) },
    onboardedAt: Date,
    lastSeenAt: Date,

    // When a browser extension first paired, and when one last synced. The
    // Overview uses these to show "Extension connected" instead of repeating
    // the pairing instructions to someone who has already paired.
    extensionPairedAt: Date,
    extensionSeenAt: Date,
  },
  { timestamps: true }
);

UserSchema.methods.isPremium = function () {
  const now = Date.now();
  const trial = this.trialEndsAt && new Date(this.trialEndsAt).getTime() > now;
  const paid = this.premiumUntil && new Date(this.premiumUntil).getTime() > now;
  return this.plan === "premium" || Boolean(trial || paid);
};

export type UserDoc = mongoose.InferSchemaType<typeof UserSchema> & { _id: string };
export default models.User || model("User", UserSchema);
