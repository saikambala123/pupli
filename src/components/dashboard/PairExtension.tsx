"use client";

import { useEffect, useState } from "react";
import { Puzzle, Loader2, RefreshCw, Copy, Check, CheckCircle2 } from "lucide-react";

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(iso: string | null | undefined) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * Generates a short-lived code the user types into the extension popup once.
 * The extension trades it for a long-lived bearer token via POST /api/extension/pair.
 *
 * Once a browser is connected the card shrinks to one line saying so. The full
 * pairing instructions, on every visit, for something already done, were most
 * of what made the right-hand column feel heavy; pairing another browser is
 * still one click away.
 */
export default function PairExtension({
  connected = false,
  lastSeenAt = null,
}: { connected?: boolean; lastSeenAt?: string | null } = {}) {
  const [pairAnother, setPairAnother] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/extension/pair");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't generate a code.");
      setCode(json.data.code);
      setSecondsLeft(json.data.expiresInSeconds);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  const expired = Boolean(code) && secondsLeft <= 0;
  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;

  if (connected && !pairAnother && !code) {
    const seen = ago(lastSeenAt);
    return (
      <section className="card min-w-0 p-5">
        <div className="flex min-w-0 items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold">Extension connected</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Your profile and saved answers sync to it automatically{seen ? ` — last synced ${seen}` : ""}.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPairAnother(true)}
          className="btn-ghost btn-sm mt-4 w-full"
        >
          <Puzzle className="h-3.5 w-3.5" />
          Pair another browser
        </button>
      </section>
    );
  }

  return (
    <section className="card min-w-0 overflow-hidden">
      <div className="flex min-w-0 items-center gap-2.5 border-b border-line px-5 py-3.5">
        <Puzzle className="h-4 w-4 shrink-0 text-brand-500" />
        <h2 className="truncate text-[15px] font-bold">{connected ? "Pair another browser" : "Connect the extension"}</h2>
      </div>

      <div className="p-5">
        {!code ? (
          <>
            <p className="text-[13.5px] leading-relaxed text-ink-soft">
              Generate a code, then enter it in the Appli-Fill popup in your browser. Your profile and saved
              answers sync straight away.
            </p>
            <button onClick={generate} className="btn-primary btn-sm mt-4 w-full" disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Generate pairing code
            </button>
          </>
        ) : (
          <>
            <div
              className={`flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed py-4 transition ${
                expired ? "border-line bg-canvas" : "border-brand-200 bg-brand-50"
              }`}
            >
              {code.split("").map((ch, i) => (
                <span
                  key={i}
                  className={`font-mono text-[26px] font-semibold tracking-wider ${
                    expired ? "text-ink-faint line-through" : "text-brand-600"
                  }`}
                >
                  {ch}
                </span>
              ))}
            </div>

            <p className="mt-3 text-center font-mono text-[11px] text-ink-faint">
              {expired ? "Code expired" : `Expires in ${mmss}`}
            </p>

            <div className="mt-4 flex gap-2">
              <button
                onClick={async () => {
                  /**
                   * Only claim "Copied" if it actually copied. `navigator.clipboard`
                   * is undefined on any non-secure origin (a dev box reached by IP,
                   * plain http on a LAN) and the optional chaining swallowed that —
                   * the button went green while the clipboard still held whatever
                   * was there before, which the user then pasted into the pairing
                   * field and got "invalid code".
                   */
                  try {
                    await navigator.clipboard.writeText(code);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  } catch {
                    setCopyFailed(true);
                    setTimeout(() => setCopyFailed(false), 3000);
                  }
                }}
                className="btn-ghost btn-sm flex-1"
                disabled={expired}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-teal-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : copyFailed ? "Copy it manually" : "Copy"}
              </button>
              <button onClick={generate} className="btn-ghost btn-sm flex-1" disabled={busy}>
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                New code
              </button>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-[12.5px] text-danger-500">{error}</p>}

        {connected && (
          <button
            type="button"
            onClick={() => { setPairAnother(false); setCode(null); setSecondsLeft(0); setError(""); }}
            className="mt-3 w-full text-center text-[12.5px] font-medium text-ink-soft hover:text-ink hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
