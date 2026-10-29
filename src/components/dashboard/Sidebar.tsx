"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard, User, Briefcase, MessageSquareQuote, Settings, Sparkles,
  LogOut, Menu, X, ChevronRight, Loader2,
} from "lucide-react";
import Logo from "@/components/ui/Logo";
import { initials } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/profile", label: "Profile", icon: User },
  { href: "/dashboard/applications", label: "Applications", icon: Briefcase },
  { href: "/dashboard/responses", label: "Saved answers", icon: MessageSquareQuote },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

type Account = { name: string; email: string; premium: boolean; trialDaysLeft: number };

export default function Sidebar({ account }: { account: Account }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Signing out asks first: the icon sits right beside the account name, and
  // one stray click used to end the session with no way back but signing in.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/");
    router.refresh();
  }

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-4">
      <Link href="/" className="mb-8 px-1 pt-1" aria-label="Appli-Fill home">
        <Logo dark />
      </Link>

      <p className="af-sidebar-label">Your workspace</p>
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            data-active={active}
            className="af-nav-item group relative"
          >
            {active && (
              <span
                aria-hidden
                className="absolute -left-1.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand-400"
              />
            )}
            <item.icon
              className={`h-[17px] w-[17px] transition-colors ${
                active ? "text-brand-400" : "text-slate-400 group-hover:text-slate-100"
              }`}
            />
            <span className="flex-1">{item.label}</span>
            {active && <ChevronRight className="h-3.5 w-3.5 text-white/30" />}
          </Link>
        );
      })}

      <Link
        href="/dashboard/premium"
        onClick={() => setOpen(false)}
        className={`group relative mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-all ${
          pathname === "/dashboard/premium"
            ? "bg-white/[.10] text-white"
            : "text-amber-300/90 hover:bg-white/[.04] hover:text-amber-200"
        }`}
      >
        <Sparkles className="h-[17px] w-[17px] text-amber-300" />
        <span className="flex-1">Premium</span>
        {!account.premium && (
          <span className="rounded-full bg-amber-300/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-300">
            Trial
          </span>
        )}
      </Link>

      <div className="flex-1" />

      {account.premium && account.trialDaysLeft > 0 && (
        <div className="mb-3 rounded-xl border border-white/[.08] bg-white/[.03] p-3">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold text-white">Trial active</p>
            <span className="font-mono text-[10px] text-amber-300/80">{account.trialDaysLeft}d left</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[.08]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-300 to-teal-300 transition-all"
              style={{ width: `${Math.min(100, (account.trialDaysLeft / 3) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 rounded-xl border border-white/[.08] bg-white/[.03] p-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 font-display text-[12px] font-bold text-white shadow-[0_4px_10px_-3px_rgba(201,77,11,.6)]">
          {initials(account.name || account.email)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-white">{account.name || "Your account"}</p>
          <p className="truncate font-mono text-[11px] text-slate-400">{account.email}</p>
        </div>
        <button
          onClick={() => { setOpen(false); setConfirmSignOut(true); }}
          aria-label="Sign out"
          aria-haspopup="dialog"
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/[.08] hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-white/90 px-5 py-3 backdrop-blur-md lg:hidden">
        <Logo />
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-lg border border-line p-2 transition hover:bg-canvas"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[280px] af-sidebar shadow-2xl">
            <button
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            {nav}
          </aside>
        </div>
      )}

      <aside className="sticky top-0 hidden h-screen af-sidebar lg:block">
        {nav}
      </aside>

      {confirmSignOut && (
        <SignOutDialog
          busy={signingOut}
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={signOut}
        />
      )}
    </>
  );
}

/** "Are you sure you want to log out?" — Escape or a click outside keeps you in. */
function SignOutDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The safe choice has the focus, so Enter by reflex does not sign out.
    stay.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => !busy && onCancel()} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sign-out-title"
        aria-describedby="sign-out-body"
        className="relative w-full max-w-[400px] animate-pop rounded-2xl bg-white p-6 shadow-lift"
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-danger-500/10 text-danger-500">
          <LogOut className="h-5 w-5" />
        </span>
        <h2 id="sign-out-title" className="mt-4 font-display text-[19px] font-extrabold">
          Are you sure you want to log out?
        </h2>
        <p id="sign-out-body" className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          You'll need to sign in again to use your dashboard. The browser extension stays connected.
        </p>
        <div className="mt-6 flex gap-2">
          <button ref={stay} onClick={onCancel} className="btn-ghost flex-1" disabled={busy}>
            Cancel
          </button>
          <button onClick={onConfirm} className="btn flex-1 bg-danger-500 text-white hover:bg-danger-600" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
