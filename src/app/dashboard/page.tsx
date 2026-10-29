import { withDbRetry } from "@/lib/db";
import { requirePageUser } from "@/lib/auth";
import Application from "@/models/Application";
import Profile from "@/models/Profile";
import SavedResponse from "@/models/SavedResponse";
import OverviewView from "@/components/dashboard/OverviewView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const user = await requirePageUser();
  const [apps, profile, responseCount] = await withDbRetry(() =>
    Promise.all([
      Application.find({ userId: user._id })
        .sort({ appliedAt: -1 })
        .select("jobTitle company location ats stage appliedAt autofill.fieldsFilled")
        .lean(),
      Profile.findOne({ userId: user._id, isDefault: true }).select("completeness").lean(),
      SavedResponse.countDocuments({ userId: user._id }),
    ])
  );

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = apps.filter((a) => new Date(a.appliedAt as Date) >= startOfDay).length;
  const fieldsFilled = apps.reduce((s, a: any) => s + (a.autofill?.fieldsFilled ?? 0), 0);

  // A browser counts as connected once it has paired, or has synced since.
  const u = user as any;
  const seen: Date | undefined = u.extensionSeenAt ?? u.extensionPairedAt;

  return (
    <OverviewView
      name={u.name?.split(" ")[0] || "there"}
      goal={u.settings?.dailyGoal ?? 10}
      serverToday={today}
      apps={apps.map((a: any) => ({
        id: String(a._id),
        jobTitle: a.jobTitle,
        company: a.company,
        location: a.location,
        ats: a.ats,
        stage: a.stage,
        appliedAt: new Date(a.appliedAt as Date).toISOString(),
      }))}
      completeness={(profile as any)?.completeness ?? 0}
      responseCount={responseCount}
      fieldsFilled={fieldsFilled}
      extension={{ connected: Boolean(seen), lastSeenAt: seen ? new Date(seen).toISOString() : null }}
    />
  );
}
