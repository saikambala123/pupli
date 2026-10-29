import Link from "next/link";
import PairExtension from "@/components/dashboard/PairExtension";
import ActivityGrid from "@/components/dashboard/ActivityGrid";
import TodaySummary from "@/components/dashboard/TodaySummary";
import { buildActivity, relativeDate } from "@/lib/utils";
import { ArrowUpRight, Briefcase, Target, MessageSquareQuote, Clock, Check } from "lucide-react";

const STAGE_TONE: Record<string, string> = {
  saved: "bg-canvas text-ink-soft",
  applied: "bg-brand-50 text-brand-600",
  screen: "bg-amber-500/15 text-amber-600",
  interview: "bg-teal-500/10 text-teal-600",
  offer: "bg-teal-500/20 text-teal-600",
  rejected: "bg-danger-500/10 text-danger-500",
  ghosted: "bg-canvas text-ink-faint",
};

export type OverviewApp = {
  id: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  ats?: string;
  stage?: string;
  appliedAt: string;
};

export type OverviewProps = {
  name: string;
  goal: number;
  /** Applications filed today by the server's clock; corrected in the browser. */
  serverToday: number;
  apps: OverviewApp[];
  completeness: number;
  responseCount: number;
  fieldsFilled: number;
  extension: { connected: boolean; lastSeenAt: string | null };
};

/**
 * The Overview, as a plain view of the numbers the page fetched.
 *
 * Layout rules that keep every card inside the window at every width:
 *   - every grid track is `minmax(0, …)`, so a long company or job title can
 *     only ever truncate — it can never widen its column and push the right
 *     rail ("Connect the extension", "Profile strength") off-screen;
 *   - two columns only from 1180px up, with a fixed-width rail. Between the
 *     phone layout and a wide screen the rail cards sit under the main column,
 *     side by side, instead of being squeezed into a sliver beside it.
 */
export default function OverviewView({
  name, goal, serverToday, apps, completeness, responseCount, fieldsFilled, extension,
}: OverviewProps) {
  const byStage = apps.reduce<Record<string, number>>((acc, a) => {
    const stage = a.stage || "applied";
    acc[stage] = (acc[stage] ?? 0) + 1;
    return acc;
  }, {});
  const interviews = (byStage.screen ?? 0) + (byStage.interview ?? 0) + (byStage.offer ?? 0);
  const minutesSaved = Math.round((fieldsFilled * 7) / 60);

  const stats = [
    { label: "Applications sent", value: apps.length, icon: Briefcase, sub: `${serverToday} today` },
    {
      label: "Reply rate",
      value: apps.length ? `${Math.round((interviews / apps.length) * 100)}%` : "—",
      icon: Target,
      sub: `${interviews} moved forward`,
    },
    { label: "Saved answers", value: responseCount, icon: MessageSquareQuote, sub: "reused automatically" },
    {
      label: "Time saved",
      value: minutesSaved >= 60 ? `${(minutesSaved / 60).toFixed(1)}h` : `${minutesSaved}m`,
      icon: Clock,
      sub: `${fieldsFilled} fields filled`,
    },
  ];

  const appliedAt = apps.map((a) => a.appliedAt);

  return (
    <div className="min-w-0 space-y-6 sm:space-y-8">
      <header className="af-overview-header flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="eyebrow">Overview</p>
          {/* Greeting and the "today" count are timezone-sensitive, so they are
              computed in the browser rather than in the server's UTC clock. */}
          <TodaySummary name={name} goal={goal} serverToday={serverToday} appliedAt={appliedAt} />
        </div>
        <Link href="/dashboard/applications" className="btn-ghost btn-sm shrink-0">
          Open tracker
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </header>

      {/* Stat row. Hidden until there is something to count: on day one it read
          "0 sent · — reply rate · 0 saved answers · 0m saved", which is four
          cards of nothing where the setup steps belong. */}
      {apps.length > 0 && (
        <section className="grid grid-cols-2 gap-3 min-[1180px]:grid-cols-4" aria-label="Your numbers">
          {stats.map((s) => (
            <div key={s.label} className="card af-stat min-w-0 p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[13px] font-medium text-ink-soft">{s.label}</p>
                <s.icon className="h-4 w-4 shrink-0 text-brand-400" />
              </div>
              <p className="mt-3 truncate font-display text-[30px] font-extrabold leading-none tracking-tight sm:text-[36px]">{s.value}</p>
              <p className="mt-2 truncate font-mono text-[11px] text-ink-faint">{s.sub}</p>
            </div>
          ))}
        </section>
      )}

      {apps.length === 0 ? (
        <FirstRun completeness={completeness} responseCount={responseCount} extension={extension} />
      ) : (
        <div className="grid grid-cols-1 gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <div className="min-w-0 space-y-6">
            {/* Activity */}
            <section className="card min-w-0 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[15px] font-bold">Last 12 weeks</h2>
                <span className="font-mono text-[11px] text-ink-faint">daily goal: {goal}</span>
              </div>
              <ActivityGrid data={buildActivity(appliedAt)} goal={goal} />
            </section>

            {/* Recent */}
            <section className="card min-w-0 overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                <h2 className="text-[15px] font-bold">Recent applications</h2>
                <Link href="/dashboard/applications" className="shrink-0 font-mono text-[11px] text-brand-600 hover:underline">
                  View all
                </Link>
              </div>
              <ul className="divide-y divide-line">
                {apps.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex min-w-0 items-center gap-3 px-4 py-3.5 sm:px-5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-canvas font-display text-[13px] font-bold text-ink-soft">
                      {(a.company || a.jobTitle || "?")[0]?.toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium" title={a.jobTitle}>{a.jobTitle || "Untitled role"}</p>
                      <p className="truncate font-mono text-[11px] text-ink-faint" title={[a.company, a.location].filter(Boolean).join(" · ")}>
                        {[a.company, a.location].filter(Boolean).join(" · ") || a.ats || "—"}
                      </p>
                    </div>
                    <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint sm:block">
                      {relativeDate(a.appliedAt)}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${
                        STAGE_TONE[a.stage || "applied"] ?? STAGE_TONE.applied
                      }`}
                    >
                      {a.stage || "applied"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* The rail: beside the main column on wide screens, under it (two up)
              everywhere else. */}
          <aside className="grid min-w-0 grid-cols-1 content-start gap-6 md:grid-cols-2 min-[1180px]:grid-cols-1" aria-label="Setup and progress">
            <PairExtension connected={extension.connected} lastSeenAt={extension.lastSeenAt} />

            {/* Profile strength */}
            <section className="card min-w-0 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-bold">Profile strength</h2>
                <span className="shrink-0 font-mono text-[13px] font-semibold text-brand-600">{completeness}%</span>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-canvas"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={completeness}
                aria-label="Profile completeness"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-teal-500 transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, completeness))}%` }}
                />
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
                {completeness >= 90
                  ? "Your profile covers everything a typical application asks for."
                  : "Fields you leave blank are fields you'll type by hand. Fill the gaps once."}
              </p>
              <Link href="/dashboard/profile" className="btn-ghost btn-sm mt-4 w-full">
                {completeness >= 90 ? "Review profile" : "Complete profile"}
              </Link>
            </section>

            {/* Pipeline */}
            <section className="card min-w-0 p-5 md:col-span-2 min-[1180px]:col-span-1">
              <h2 className="text-[15px] font-bold">Pipeline</h2>
              <ul className="mt-4 space-y-2.5">
                {["applied", "screen", "interview", "offer", "rejected"].map((stage) => {
                  const count = byStage[stage] ?? 0;
                  const pct = apps.length ? (count / apps.length) * 100 : 0;
                  return (
                    <li key={stage} className="flex min-w-0 items-center gap-3">
                      <span className="w-[70px] shrink-0 text-[13px] capitalize text-ink-soft">{stage}</span>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
                        <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-7 shrink-0 text-right font-mono text-[12px] text-ink-soft">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * The overview before there is anything to show on it.
 *
 * Three steps, in the order they have to happen, each one marked done as soon
 * as it is. The pairing card stays until the extension has connected — it is
 * the step that cannot be completed anywhere else.
 */
function FirstRun({
  completeness, responseCount, extension,
}: { completeness: number; responseCount: number; extension: OverviewProps["extension"] }) {
  const steps = [
    {
      done: completeness >= 40,
      title: "Fill in your profile",
      body: "Name, contact details, work history and eligibility. This is what gets typed into every form.",
      href: "/dashboard/profile",
      cta: completeness > 0 ? `Continue — ${completeness}% done` : "Start your profile",
    },
    {
      done: extension.connected,
      title: "Connect the extension",
      body: extension.connected
        ? "Your browser is connected. Your profile and saved answers sync to it automatically."
        : "Generate a pairing code and enter it in the Appli-Fill popup in your browser.",
    },
    {
      done: responseCount > 0,
      title: "Apply to something",
      body: "Open a job posting, click Fill, and the application, the answers you gave and your progress all land here.",
      href: "/dashboard/applications",
      cta: "Open the tracker",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <section className="card min-w-0 p-5 sm:p-6">
        <h2 className="text-[15px] font-bold">Get set up</h2>
        <p className="mt-1 text-[13.5px] text-ink-soft">Three things, once. Then every application is one click.</p>

        <ol className="mt-6 space-y-5">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                  step.done ? "bg-teal-500/15 text-teal-600" : "bg-brand-50 text-brand-600"
                }`}
              >
                {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[14.5px] font-semibold">{step.title}</p>
                <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-ink-soft">{step.body}</p>
                {step.href && (
                  <Link href={step.href} className="btn-ghost btn-sm mt-3">
                    {step.cta}
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <aside className="min-w-0" aria-label="Connect the extension">
        <PairExtension connected={extension.connected} lastSeenAt={extension.lastSeenAt} />
      </aside>
    </div>
  );
}
