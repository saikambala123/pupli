"use client";

/**
 * 12-week contribution-style grid of applications per day, with the numbers
 * that matter beside it.
 *
 * The grid alone filled a quarter of its card and left the rest empty. The
 * summary — this week, best day, active days, current streak — uses that space
 * for something worth reading, and wraps under the grid on narrow screens.
 */
export default function ActivityGrid({
  data,
  goal = 10,
}: {
  data: { date: string; count: number }[];
  goal?: number;
}) {
  const weeks: { date: string; count: number }[][] = [];
  for (let i = 0; i < data.length; i += 7) weeks.push(data.slice(i, i + 7));

  const tone = (n: number) => {
    if (n === 0) return "bg-canvas border-line";
    if (n < goal * 0.34) return "bg-brand-100 border-brand-100";
    if (n < goal * 0.67) return "bg-brand-300 border-brand-300";
    if (n < goal) return "bg-brand-400 border-brand-400";
    return "bg-brand-500 border-brand-500";
  };

  const total = data.reduce((s, d) => s + d.count, 0);
  const lastWeek = data.slice(-7).reduce((s, d) => s + d.count, 0);
  const best = data.reduce<{ date: string; count: number } | null>(
    (b, d) => (d.count > (b?.count ?? 0) ? d : b),
    null
  );
  const activeDays = data.filter((d) => d.count > 0).length;
  let streak = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].count > 0) streak++;
    else if (i === data.length - 1) continue;   // today not started yet
    else break;
  }
  // Formatted by hand: a locale-formatted date differs between the server
  // render and the browser, and React reports that as a hydration mismatch.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const bestLabel = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(best?.date ?? "");
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
  })();

  const facts = [
    { label: "Last 7 days", value: String(lastWeek) },
    { label: "Best day", value: best ? `${best.count}` : "—", hint: bestLabel },
    { label: "Active days", value: `${activeDays}`, hint: `of ${data.length}` },
    { label: "Streak", value: `${streak}`, hint: streak === 1 ? "day" : "days" },
  ];

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-10 gap-y-5">
      <div className="min-w-0">
        <div className="flex max-w-full gap-[3px] overflow-x-auto pb-1 scroll-thin" role="img"
             aria-label={`${total} application${total === 1 ? "" : "s"} in the last ${Math.round(data.length / 7)} weeks`}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((day) => (
                <div
                  key={day.date}
                  title={`${day.count} application${day.count === 1 ? "" : "s"} on ${day.date}`}
                  className={`h-[14px] w-[14px] rounded-[3px] border ${tone(day.count)}`}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-[10px] text-ink-faint">less</span>
          {["bg-canvas border-line", "bg-brand-100 border-brand-100", "bg-brand-300 border-brand-300", "bg-brand-400 border-brand-400", "bg-brand-500 border-brand-500"].map((c) => (
            <span key={c} className={`h-[11px] w-[11px] rounded-[3px] border ${c}`} />
          ))}
          <span className="font-mono text-[10px] text-ink-faint">more</span>
        </div>
      </div>

      <dl className="grid min-w-0 flex-1 basis-[220px] grid-cols-2 gap-x-6 gap-y-4">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="truncate text-[12px] font-medium text-ink-soft">{f.label}</dt>
            <dd className="mt-1 flex items-baseline gap-1.5">
              <span className="font-display text-[22px] font-extrabold leading-none tracking-tight">{f.value}</span>
              {f.hint && <span className="truncate font-mono text-[11px] text-ink-faint">{f.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
