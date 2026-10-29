"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { apiPatch } from "@/lib/client-api";

type Settings = Record<string, any>;

function Toggle({
  label, description, checked, onChange, disabled = false,
}: {
  label: string; description: React.ReactNode; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={`flex items-start justify-between gap-6 py-4 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-semibold">{label}</span>
        <span className="mt-0.5 block text-[13.5px] leading-relaxed text-ink-soft">{description}</span>
      </span>
      <span className="relative mt-1 shrink-0">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="block h-6 w-11 rounded-full bg-line transition peer-checked:bg-brand-500 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-500/20" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** A titled card of related switches. */
function Group({
  title, note, children,
}: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="card px-5 pb-1 pt-5 sm:px-6">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {note && <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-soft">{note}</p>}
      <div className="mt-2 divide-y divide-line">{children}</div>
    </section>
  );
}

export default function SettingsPanel({
  initial, email, premium = false,
}: { initial: Settings; email: string; premium?: boolean }) {
  const [s, setS] = useState<Settings>({
    autofillOnLoad: false, autoPilot: false, showOverlay: false, trackAutomatically: true,
    reuseSavedResponses: true, aiAnswers: true, fillDelayMs: 0, dailyGoal: 10,
    // These three drive real behaviour in the content script but were only
    // reachable from the extension popup, so the dashboard and the popup
    // disagreed about the account's settings.
    overwriteExisting: false, autoAttachResume: false, eeoFallbackDecline: false,
    excludedDomains: [], ...initial,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /**
   * Toggles save at once; sliders and number inputs are debounced, because
   * dragging the delay slider previously fired one request per pixel moved.
   */
  async function save(next: Settings, debounceMs = 0) {
    setS(next);
    if (timer.current) clearTimeout(timer.current);

    const run = async () => {
      setSaving(true);
      try {
        // A 502 returns HTML, and `(await res.json()).error` then threw a
        // SyntaxError whose message ("Unexpected token '<'…") was shown to the
        // user verbatim. apiPatch always yields a sentence worth reading.
        const res = await apiPatch("/api/settings", next);
        if (!res.ok) throw new Error(res.error);
        setError("");
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      } catch (e: any) {
        setError(e.message || "Couldn't save that setting.");
      } finally {
        setSaving(false);
      }
    };

    if (debounceMs) timer.current = setTimeout(run, debounceMs);
    else await run();
  }

  const set = (k: string) => (v: any) => save({ ...s, [k]: v });
  const setSlow = (k: string) => (v: any) => save({ ...s, [k]: v }, 500);

  return (
    <div className="space-y-6">
      {/*
        The save indicator sat on the header's baseline next to the account
        email, so it appeared and vanished a long way from the switch that
        caused it and pushed the description's line wrap around as it changed.
        It is a status, so it reads as one: fixed width, beside the title.
      */}
      <header>
        <p className="eyebrow">Settings</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-[30px] font-extrabold tracking-[-.02em]">Autofill behaviour</h1>
          <span aria-live="polite" className="text-[12.5px] text-ink-faint">
            {saving ? (
              <><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> saving…</>
            ) : saved ? (
              <><Check className="inline h-3.5 w-3.5 text-teal-600" /> saved</>
            ) : null}
          </span>
        </div>
        <p className="mt-1.5 max-w-[62ch] text-[15px] text-ink-soft">
          Changes reach the extension within a minute, or straight away if you hit
          Sync now in the popup. Signed in as {email}.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-xl border border-danger-500/25 bg-danger-500/5 px-4 py-3 text-[13px] text-danger-600">
          {error}
        </p>
      )}

      {/*
        Grouped rather than listed.

        Nine switches in one column read as nine unrelated obligations, and the
        two that do nothing — a retired setting and an unbuilt one — were the
        first two rows on the page. They are now at the bottom, under a heading
        that says why they are there, and the seven live ones are split by the
        question they answer: what gets filled, what happens afterwards, and
        what is written for you.
      */}
      <Group
        title="Where answers come from"
        note="Appli-Fill always fills from your profile first. These decide what happens to the questions it cannot answer that way."
      >
        <Toggle
          label="Reuse saved answers"
          description="Match custom questions against answers you've already written, even when the wording differs."
          checked={s.reuseSavedResponses}
          onChange={set("reuseSavedResponses")}
        />
        <Toggle
          label="Answer remaining questions with AI"
          description={
            premium
              ? "When no saved answer matches, Appli-Fill writes one from your profile — including dropdowns and multiple choice. Drafts are outlined so you review them before submitting."
              : "Premium. Appli-Fill writes the questions your profile can't answer, dropdowns included."
          }
          checked={premium && s.aiAnswers}
          disabled={!premium}
          onChange={set("aiAnswers")}
        />
        <Toggle
          label={"Answer EEO questions with “decline to self-identify”"}
          description="For voluntary demographic questions you haven't answered in your profile. Off by default, so those questions are simply left blank."
          checked={s.eeoFallbackDecline}
          onChange={set("eeoFallbackDecline")}
        />
      </Group>

      <Group
        title="What Appli-Fill is allowed to change"
        note="Off by default: a value already on screen is usually the one you want. Résumé uploads are always left for you."
      >
        <Toggle
          label="Replace answers already in the form"
          description="Overwrite values a page pre-filled, or that you already typed."
          checked={s.overwriteExisting}
          onChange={set("overwriteExisting")}
        />
      </Group>

      <Group title="On the page">
        <Toggle
          label="Show the status pill"
          description="A small indicator on the page showing how many fields were filled and what it skipped."
          checked={s.showOverlay}
          onChange={set("showOverlay")}
        />
        <Toggle
          label="Track applications automatically"
          description="Log the role, company and link to your tracker when you submit."
          checked={s.trackAutomatically}
          onChange={set("trackAutomatically")}
        />
      </Group>

      <section className="card p-5 sm:p-6">
        <h2 className="text-[15px] font-bold">Pace</h2>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <div>
            <label className="label">Daily application goal</label>
            <input
              type="number"
              min={1}
              max={100}
              className="input"
              value={s.dailyGoal ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                // Let the box be empty while it's being retyped. `Number("")` is
                // 0, which snapped the field back to 0 the instant it was
                // cleared — and the server then coerced 0 to 10, so the panel
                // showed a goal the account did not actually have.
                if (raw === "") return setS((prev) => ({ ...prev, dailyGoal: "" }));
                const n = Number(raw);
                if (Number.isFinite(n)) setSlow("dailyGoal")(Math.min(100, Math.max(1, n)));
              }}
              onBlur={() => { if (!s.dailyGoal) setSlow("dailyGoal")(10); }}
            />
            <p className="mt-1 font-mono text-[10.5px] text-ink-faint">Drives the goal line on your overview</p>
          </div>
          <div>
            {/*
              This used to range to 600ms and default to 120ms, spent after every
              field — dropdowns included — which made a long Workday page take
              many seconds longer than it needed to. Dropdowns now wait for the
              page on their own; the pause applies to typed boxes only.
            */}
            <label className="label">Pause after each typed box</label>
            <input
              type="range"
              min={0}
              max={30}
              step={5}
              className="w-full accent-brand-500"
              value={Math.min(30, Number(s.fillDelayMs) || 0)}
              onChange={(e) => setSlow("fillDelayMs")(Number(e.target.value))}
            />
            <p className="mt-1 font-mono text-[10.5px] text-ink-faint">
              {Math.min(30, Number(s.fillDelayMs) || 0)}ms — dropdowns wait for the page on their own
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-[15px] font-bold">Skip these sites</h2>
        <p className="mt-1 text-[13.5px] text-ink-soft">
          One domain per line. Appli-Fill won&apos;t touch forms on these — an internal HR
          system, or anywhere you would rather fill in by hand.
        </p>
        <textarea
          className="input mt-4 resize-y font-mono text-[13px]"
          rows={4}
          placeholder={"internal.mycompany.com\nexample.org"}
          value={(s.excludedDomains ?? []).join("\n")}
          onChange={(e) => setS({ ...s, excludedDomains: e.target.value.split("\n") })}
          onBlur={(e) =>
            save({ ...s, excludedDomains: e.target.value.split("\n").map((d) => d.trim()).filter(Boolean) })
          }
        />
      </section>

      {/*
        Switches that do nothing, kept visible so anyone who had one on can
        see what became of it — but at the bottom, not at the top of the page.
        Résumé auto-attach joined them: every upload is left for the applicant.

        Fill-on-load is retired: one pass per page load is also one pass per
        *re*load, and a Workday application reloads itself constantly, so each
        reload restarted a fill over answers the applicant had already
        corrected. Auto Pilot was never built: the content script has no
        submit-and-advance path, so the switch saved a value nothing read.
      */}
      <details className="card px-5 py-4 sm:px-6">
        <summary className="cursor-pointer select-none text-[14px] font-semibold text-ink-soft hover:text-ink">
          Settings that no longer apply
        </summary>
        <div className="mt-1 divide-y divide-line">
          <Toggle
            label="Fill as soon as a form loads"
            description="Retired. Filling now happens only when you click Fill, so refreshing a job tab never overwrites answers you have already corrected."
            checked={false}
            disabled
            onChange={() => {}}
          />
          <Toggle
            label="Auto Pilot"
            description="Not available. Appli-Fill always stops before the submit button so you can review the application."
            checked={false}
            disabled
            onChange={() => {}}
          />
          <Toggle
            label="Attach my resume automatically"
            description="Retired. Appli-Fill leaves every résumé and file upload empty, so you choose which document each employer receives."
            checked={false}
            disabled
            onChange={() => {}}
          />
        </div>
      </details>
    </div>
  );
}
