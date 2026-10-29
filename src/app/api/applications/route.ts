import { connectDB } from "@/lib/db";
import Application from "@/models/Application";
import { requireUser } from "@/lib/auth";
import { ok, handler } from "@/lib/api";
import { escapeRegex } from "@/lib/utils";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const { searchParams } = new URL(req.url);
  const stage = searchParams.get("stage");
  const q = searchParams.get("q");
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 500);

  const filter: Record<string, unknown> = { userId: user._id };
  if (stage && stage !== "all") filter.stage = stage;
  if (q) {
    const safe = escapeRegex(q);
    filter.$or = [
      { jobTitle: { $regex: safe, $options: "i" } },
      { company: { $regex: safe, $options: "i" } },
      { location: { $regex: safe, $options: "i" } },
    ];
  }

  const rows = await Application.find(filter).sort({ appliedAt: -1 }).limit(limit).lean();
  return ok(rows.map((r) => ({ ...r, _id: String(r._id), userId: String(r.userId) })));
});

const Body = z.object({
  jobTitle: z.string().min(1, "Add the job title"),
  company: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  ats: z.string().optional(),
  stage: z.string().optional(),
  salaryRange: z.string().optional(),
  notes: z.string().optional(),
  appliedAt: z.string().optional(),
  source: z.enum(["extension", "manual", "import"]).optional(),
  autofill: z.record(z.any()).optional(),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  await connectDB();
  const body = Body.parse(await req.json());

  const fields = {
    ...body,
    userId: user._id,
    appliedAt: body.appliedAt ? new Date(body.appliedAt) : new Date(),
    lastActivityAt: new Date(),
  };

  /**
   * Only de-duplicate when there is a URL to de-duplicate on.
   *
   * Mongoose strips `undefined` values out of a query, so the old filter
   * `{ userId, url: body.url || undefined }` collapsed to `{ userId }` for any
   * application saved without a link — and with `upsert: true` that matched an
   * arbitrary existing row and overwrote it. Adding one URL-less application
   * destroyed an unrelated one already in the tracker.
   */
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : null;

  if (!url) {
    const created = await Application.create({
      ...fields,
      url: undefined,
      events: [{ stage: body.stage || "applied", at: new Date() }],
    });
    return ok({ ...created.toObject(), _id: String(created._id) }, 201);
  }

  const doc = await Application.findOneAndUpdate(
    { userId: user._id, url },
    {
      $set: { ...fields, url },
      $setOnInsert: { events: [{ stage: body.stage || "applied", at: new Date() }] },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return ok({ ...doc.toObject(), _id: String(doc._id) }, 201);
});
