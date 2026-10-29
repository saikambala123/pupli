import { connectDB } from "@/lib/db";
import Application, { STAGES } from "@/models/Application";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

/**
 * The only fields a client may change, with coercion.
 *
 * This used to be `Object.assign(app, body)`, which let a caller write *any*
 * schema path — including `userId`, which moved one of their applications into
 * someone else's tracker, and `events`, which rewrote the stage history.
 */
const EDITABLE: Record<string, (v: unknown) => unknown> = {
  jobTitle: (v) => String(v ?? "").slice(0, 200),
  company: (v) => String(v ?? "").slice(0, 200),
  companyDomain: (v) => String(v ?? "").slice(0, 253),
  location: (v) => String(v ?? "").slice(0, 200),
  workplaceType: (v) => String(v ?? "").slice(0, 60),
  salaryRange: (v) => String(v ?? "").slice(0, 120),
  url: (v) => String(v ?? "").slice(0, 2000),
  ats: (v) => String(v ?? "").slice(0, 60),
  notes: (v) => String(v ?? "").slice(0, 20_000),
  favorite: (v) => Boolean(v),
  tags: (v) =>
    (Array.isArray(v) ? v : []).map((t) => String(t ?? "").slice(0, 60)).filter(Boolean).slice(0, 30),
  appliedAt: (v) => (v ? new Date(String(v)) : undefined),
};

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  await connectDB();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("That request body wasn't valid JSON.", 400);

  const app = await Application.findOne({ _id: params.id, userId: user._id });
  if (!app) return fail("We couldn't find that application.", 404);

  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage)) {
      return fail(`"${body.stage}" isn't a valid stage. Use one of: ${STAGES.join(", ")}.`, 422);
    }
    if (body.stage !== app.stage) {
      app.events.push({
        stage: body.stage,
        at: new Date(),
        note: body.note ? String(body.note).slice(0, 2000) : undefined,
      });
      app.stage = body.stage;
    }
  }

  for (const [key, coerce] of Object.entries(EDITABLE)) {
    if (body[key] === undefined) continue;
    const value = coerce(body[key]);
    if (value === undefined) continue;
    if (key === "appliedAt" && Number.isNaN((value as Date).getTime())) continue;
    (app as any)[key] = value;
  }

  app.lastActivityAt = new Date();
  await app.save();

  return ok({ ...app.toObject(), _id: String(app._id) });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  await connectDB();
  const res = await Application.findOneAndDelete({ _id: params.id, userId: user._id });
  if (!res) return fail("We couldn't find that application.", 404);
  return ok({ deleted: true });
});
