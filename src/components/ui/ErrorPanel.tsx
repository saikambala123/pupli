"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import Logo from "@/components/ui/Logo";
import { useRouter } from "next/navigation";
import { RotateCw, LogIn } from "lucide-react";

/**
 * When the page last retried itself. Module-level, so a page that keeps
 * failing is retried automatically once — never in a loop.
 */
let lastAutoRetry = 0;
const AUTO_RETRY_GAP_MS = 20_000;

/**
 * What a visitor sees when a page fails to render on the server.
 *
 * Without this, any failure while loading a dashboard page — most often a
 * database connection that went stale while the server sat idle — showed the
 * framework's bare "Application error: a server-side exception has occurred"
 * with no way forward but refreshing again. The page now retries itself once,
 * and offers Try again and Sign in if that doesn't help.
 */
export default function ErrorPanel({
  error,
  reset,
  compact = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const retry = () =>
    startTransition(() => {
      // Server components only render again after a refresh; `reset` then
      // clears this boundary so the fresh result can show.
      router.refresh();
      reset();
    });

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[applifill] page failed to load", error?.digest ?? "", error);
    if (Date.now() - lastAutoRetry > AUTO_RETRY_GAP_MS) {
      lastAutoRetry = Date.now();
      const timer = setTimeout(retry, 700);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <div className={compact ? "py-10" : "flex min-h-[70vh] items-center justify-center px-4 py-16"}>
      <div className="card mx-auto w-full max-w-md p-7 text-center">
        <div className="mb-6 flex justify-center"><Logo /></div>
        <p className="eyebrow">Something went wrong</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">This page didn’t load</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Our server had trouble loading it — usually a brief connection hiccup. Your data is safe.
          {pending ? " Trying again…" : " Try again, and if it keeps happening, sign in again."}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button type="button" onClick={retry} className="btn-primary" disabled={pending}>
            <RotateCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} aria-hidden />
            {pending ? "Retrying…" : "Try again"}
          </button>
          <Link href="/auth" className="btn-ghost">
            <LogIn className="h-4 w-4" aria-hidden />
            Sign in again
          </Link>
        </div>
        {error?.digest ? (
          <p className="mt-5 font-mono text-[11px] text-ink-faint">Reference: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
