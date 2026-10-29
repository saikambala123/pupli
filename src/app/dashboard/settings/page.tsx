import { requirePageUser } from "@/lib/auth";
import SettingsPanel from "@/components/dashboard/SettingsPanel";
import { isPremium } from "@/lib/plan";
import { effectiveSettings } from "@/models/User";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const settings = JSON.parse(JSON.stringify(effectiveSettings((user as any).settings)));
  return <SettingsPanel initial={settings} email={(user as any).email} premium={isPremium(user)} />;
}
