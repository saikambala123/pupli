"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronRight } from "lucide-react";
const TITLES: Record<string,string> = { "/dashboard":"Overview", "/dashboard/profile":"My profile", "/dashboard/applications":"Applications", "/dashboard/responses":"Saved answers", "/dashboard/settings":"Settings", "/dashboard/premium":"Premium" };
export default function DashboardTopbar() {
  const pathname=usePathname();
  return <header className="af-dashboard-topbar">
    <nav className="flex min-w-0 items-center gap-2 text-sm" aria-label="Breadcrumb"><Link href="/dashboard" className="hidden text-ink-faint hover:text-ink sm:inline">Workspace</Link><ChevronRight size={14} className="hidden text-ink-faint sm:block"/><span className="truncate font-semibold" aria-current="page">{TITLES[pathname]||"Workspace"}</span></nav>
    <div className="flex shrink-0 items-center gap-4"><Link href="/docs" className="flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-brand-600"><BookOpen size={16}/><span>Help & guides</span></Link><Link href="/dashboard/profile" className="btn-ghost btn-sm hidden sm:inline-flex">Edit profile</Link></div>
  </header>;
}
