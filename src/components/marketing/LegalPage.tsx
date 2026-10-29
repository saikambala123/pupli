import type { ReactNode } from "react";

/**
 * Shared shell and shared details for /privacy and /terms.
 *
 * FILL THESE IN before you launch. They are deliberately obvious placeholders
 * rather than invented values, so a real one is never mistaken for a real one.
 */
export const COMPANY = process.env.NEXT_PUBLIC_COMPANY_NAME || "[YOUR LEGAL ENTITY NAME]";
export const JURISDICTION = process.env.NEXT_PUBLIC_JURISDICTION || "[YOUR COUNTRY / STATE]";
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@example.com";
export const LAST_UPDATED = "28 August 2026";

export default function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  const unset = COMPANY.startsWith("[") || SUPPORT_EMAIL === "support@example.com";

  return (
    <main className="container-x max-w-[720px] py-16">
      <p className="eyebrow">Legal</p>
      <h1 className="mt-3 font-display text-[36px] font-extrabold tracking-[-.02em]">{title}</h1>
      <p className="mt-2 font-mono text-[12px] text-ink-faint">Last updated {updated}</p>

      {unset && (
        <div
          role="note"
          className="mt-8 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13.5px] leading-relaxed text-ink-soft"
        >
          <b className="text-ink">Not ready to publish yet.</b> Set{" "}
          <code className="font-mono text-[12.5px]">NEXT_PUBLIC_COMPANY_NAME</code>,{" "}
          <code className="font-mono text-[12.5px]">NEXT_PUBLIC_JURISDICTION</code> and{" "}
          <code className="font-mono text-[12.5px]">NEXT_PUBLIC_SUPPORT_EMAIL</code>, and have a
          lawyer review this text. This notice disappears once they&rsquo;re set. The content below
          accurately describes what the software does with data, but it is not legal advice.
        </div>
      )}

      <div className="legal mt-10">{children}</div>
    </main>
  );
}
