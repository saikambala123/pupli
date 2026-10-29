"use client";

import { useEffect, useState } from "react";
import { localDateKey } from "@/lib/utils";

/**
 * The greeting and the "today" count, computed in the *viewer's* timezone.
 *
 * Both were previously derived on the server, which on Vercel means UTC. For a
 * user in IST (UTC+5:30) that produced two visible errors: an application filed
 * at 1am local was counted against yesterday, and at 11pm local the dashboard
 * said "Good afternoon".
 *
 * The server-rendered pass uses the count it was given so the page is never
 * blank or wrong-by-default; the effect corrects both values once the real
 * timezone is known. Rendering the neutral form first also avoids a hydration
 * mismatch, which is what a bare `new Date()` in render would cause.
 */
export default function TodaySummary({
  name,
  goal,
  appliedAt,
  serverToday,
}: {
  name: string;
  goal: number;
  /** Every application's appliedAt, as ISO strings. */
  appliedAt: string[];
  serverToday: number;
}) {
  const [today, setToday] = useState(serverToday);
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    const key = localDateKey(new Date());
    setToday(appliedAt.filter((d) => localDateKey(d) === key).length);

    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, [appliedAt]);

  const remaining = Math.max(0, goal - today);

  return (
    <div>
      <h1 className="font-display text-[30px] font-extrabold tracking-[-.02em]">
        {greeting ?? "Welcome back"}, {name}.
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-soft">
        {today >= goal
          ? `You hit your goal of ${goal} today. Anything past this is a bonus.`
          : `${remaining} more application${remaining === 1 ? "" : "s"} to reach today's goal.`}
      </p>
    </div>
  );
}
