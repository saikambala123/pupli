"use client";

import "./globals.css";
import ErrorPanel from "@/components/ui/ErrorPanel";

/** The last line of defence: the root layout itself failed. It must bring its own <html>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas">
        <ErrorPanel error={error} reset={reset} />
      </body>
    </html>
  );
}
