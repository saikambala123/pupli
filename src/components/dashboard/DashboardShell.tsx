import DashboardTopbar from "@/components/dashboard/DashboardTopbar";
import Sidebar from "@/components/dashboard/Sidebar";

type Account = { name: string; email: string; premium: boolean; trialDaysLeft: number };

/**
 * The frame every dashboard page sits in: the sidebar, and a content column
 * that can never be pushed wider than the window.
 *
 * `min-w-0` on the column is what lets anything inside it shrink. Without it
 * the column takes the widest thing on the page as its minimum width — one
 * long company name in "Recent applications" was enough — and the right-hand
 * cards ("Connect the extension", "Profile strength") were pushed past the
 * edge of the window behind a horizontal scrollbar.
 */
export default function DashboardShell({ account, children }: { account: Account; children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)]">
      <Sidebar account={account} />
      <div className="min-w-0 bg-canvas">
        <DashboardTopbar />
        <main id="main-content" className="af-dashboard-content">{children}</main>
      </div>
    </div>
  );
}
