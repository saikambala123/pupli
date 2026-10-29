import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { isPremium, trialDaysLeft } from "@/lib/plan";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/auth");

  const account = {
    name: (user as any).name ?? "",
    email: (user as any).email as string,
    premium: isPremium(user),
    trialDaysLeft: trialDaysLeft(user),
  };

  return <DashboardShell account={account}>{children}</DashboardShell>;
}
