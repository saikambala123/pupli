"use client";

import ErrorPanel from "@/components/ui/ErrorPanel";

/**
 * Any page, or the dashboard frame itself, that failed to load. (A failure in
 * the dashboard's layout is caught here, one level up, not by the dashboard's
 * own error screen.)
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="min-h-screen bg-canvas">
      <ErrorPanel error={error} reset={reset} />
    </main>
  );
}
