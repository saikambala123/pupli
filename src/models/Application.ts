import mongoose, { Schema, model, models } from "mongoose";

export const STAGES = [
  "saved",
  "applied",
  "screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
] as const;

const ApplicationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    profileId: { type: Schema.Types.ObjectId, ref: "Profile" },

    jobTitle: { type: String, required: true },
    company: String,
    companyDomain: String,
    location: String,
    workplaceType: String,
    salaryRange: String,
    url: String,
    ats: String,                  // greenhouse | lever | workday | ashby | ...
    source: { type: String, enum: ["extension", "manual", "import"], default: "extension" },

    stage: { type: String, enum: STAGES, default: "applied", index: true },
    appliedAt: { type: Date, default: Date.now, index: true },
    lastActivityAt: { type: Date, default: Date.now },

    autofill: {
      fieldsDetected: Number,
      fieldsFilled: Number,
      durationMs: Number,
      matchScore: Number,         // Premium: how well the profile fit the posting
    },

    notes: String,
    favorite: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    events: {
      type: [
        new Schema(
          { stage: String, at: { type: Date, default: Date.now }, note: String },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

/**
 * One row per job URL per user — stops the extension double-logging on re-submit.
 *
 * This must be a PARTIAL index, not a sparse one. A compound sparse index still
 * indexes a document when *any* of its keys is present, and `userId` always is,
 * so every URL-less application was indexed as `(userId, null)` — which made the
 * unique constraint reject a user's second manually-added application whenever
 * they left the link blank. A partial index skips those documents entirely.
 */
ApplicationSchema.index(
  { userId: 1, url: 1 },
  { unique: true, partialFilterExpression: { url: { $type: "string" } } }
);
ApplicationSchema.index({ userId: 1, appliedAt: -1 });

export type ApplicationDoc = mongoose.InferSchemaType<typeof ApplicationSchema> & { _id: string };
export default models.Application || model("Application", ApplicationSchema);
