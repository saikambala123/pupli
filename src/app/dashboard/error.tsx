"use client";

import ErrorPanel from "@/components/ui/ErrorPanel";

/** A dashboard page that failed to load, shown inside the dashboard frame. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPanel error={error} reset={reset} compact />;
}
