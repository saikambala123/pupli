import Link from "next/link";
import Logo from "@/components/ui/Logo";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/#how", label: "Autofill" },
      { href: "/#tracker", label: "Application tracker" },
      { href: "/#responses", label: "Saved answers" },
      { href: "/#premium", label: "Premium" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/docs#install", label: "Install guide" },
      { href: "/jobs", label: "Job board" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="af-footer">
      <div className="container-x grid gap-10 py-16 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo dark />
          <p className="mt-4 max-w-[280px] text-[14px] leading-[1.55] text-slate-300">
            One click fills the form. Every application lands in your tracker on its own.
          </p>
          <div className="mt-5 flex gap-2">
            <span className="chip border-white/10 bg-white/[.04] text-slate-300">Chrome</span>
            <span className="chip border-white/10 bg-white/[.04] text-slate-300">Edge</span>
            <span className="chip border-white/10 bg-white/[.04] text-slate-300">Firefox</span>
          </div>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h4 className="eyebrow mb-3 text-slate-400">{col.title}</h4>
            <ul className="space-y-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-[14px] text-slate-300 transition hover:text-brand-600"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="container-x flex flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[12px] text-slate-400">
            © {new Date().getFullYear()} Appli-Fill. Your next chapter starts here.
          </p>
          <p className="font-mono text-[12px] text-slate-400">
            Made for the long job search.
          </p>
        </div>
      </div>
    </footer>
  );
}
