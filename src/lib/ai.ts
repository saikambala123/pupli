/**
 * Gemini client.
 *
 * This file was the direct cause of the "resume parsed but the data is wrong"
 * reports. Four bugs, all in the request we sent:
 *
 *  1. THINKING TOKENS ATE THE OUTPUT BUDGET. Gemini 2.5+ counts internal
 *     reasoning tokens against `maxOutputTokens`. With `maxOutputTokens: 3500`
 *     and thinking enabled, a real resume returned `finishReason: "MAX_TOKENS"`
 *     with an empty or half-written JSON body. The caller then silently swapped
 *     in a crude regex parse, which is what the user saw as "wrong data".
 *  2. THE OUTPUT BUDGET WAS TOO SMALL ANYWAY. A six-job resume needs far more
 *     than 3500 tokens of JSON.
 *  3. 18s TIMEOUT, ZERO RETRIES, NO MODEL FALLBACK - while the route itself was
 *     allowed 55s. Long resumes were aborted with most of the budget unspent.
 *  4. NO RESPONSE SCHEMA. The model was free to rename keys or merge entries.
 *
 * It also hard-coded `gemini-2.5-flash-lite`, the weakest tier, and the 2.5
 * family retires on 2026-10-16. Model selection is now discovered at runtime
 * with a static preference ladder as backup.
 *
 * Gemini 3.x changed the request contract (thinkingLevel instead of
 * thinkingBudget, responseFormat instead of responseSchema, sampling params
 * deprecated), so the client negotiates the dialect per model and caches
 * whichever shape the deployment actually accepts.
 */

import {
  extractResumeText as extractResumeTextImpl,
  type ResumeFileKind,
} from "./resume-text";
import { fallbackParseResumeText as fallbackParseResumeTextImpl } from "./resume-fallback";

export type { ResumeFileKind };
export { detectResumeFileKind } from "./resume-text";

/** Overridable so the parsing tests can point at a local stub server. */
const GEMINI_API_ROOT =
  process.env.GEMINI_API_ROOT_OVERRIDE || "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Preference ladder, best first. Runtime discovery filters this against what
 * the key can actually reach, so a retired model simply drops out instead of
 * breaking resume parsing in production.
 */
const MODEL_LADDER = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
];

/** Used only when discovery fails and no override is set. */
const DEFAULT_MODEL = "gemini-2.5-flash";

const MODEL_DISCOVERY_TTL_MS = 30 * 60 * 1000;

type Message = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  timeoutMs?: number;
  json?: boolean;
  /** OpenAPI-subset schema. Implies json. */
  schema?: Record<string, any>;
  /** Try the next model in the ladder when one fails. */
  fallbackModels?: boolean;
  /** Absolute ms timestamp this call must finish by. Beats timeoutMs. */
  deadline?: number;
  /** "minimal" | "low" for extraction work; omit to leave the model default. */
  thinking?: "off" | "low" | "medium";
  models?: string[];
};

export type GenerateResult = {
  text: string;
  truncated: boolean;
  model: string;
  finishReason: string;
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function cleanSecret(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^\s*['"]/, "")
    .replace(/['"]\s*$/, "");
}

function getGeminiApiKey(): string {
  return cleanSecret(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  );
}

function getGroqApiKey(): string {
  return cleanSecret(process.env.GROQ_API_KEY || process.env.GROQ_API_TOKEN);
}

export function textAIEnabled() {
  return Boolean(getGeminiApiKey() || getGroqApiKey());
}

/** Explicit override. Empty means "let the client pick the best available". */
function getConfiguredModel(): string {
  return cleanSecret(process.env.GEMINI_MODEL);
}

export function aiEnabled() {
  return Boolean(getGeminiApiKey());
}

export const AI_SETUP_HINT =
  "AI features need GEMINI_API_KEY or GOOGLE_API_KEY (Gemini). Text-answer fallback can also use GROQ_API_KEY. Add the variable in Vercel and redeploy.";

/** Wall-clock budget for one resume parse, kept under the platform limit. */
export function parseBudgetMs(): number {
  const configured = Number(process.env.RESUME_PARSE_BUDGET_MS);
  if (Number.isFinite(configured) && configured >= 5000) return Math.min(configured, 280_000);
  return 48_000; // Vercel Hobby functions cap at 60s.
}

/**
 * A 403 from Gemini means one of two very different things, and conflating
 * them is what made every parse report "Gemini authentication failed. Set
 * GOOGLE_API_KEY to a current key" even though the key was perfectly good:
 *
 *   "key"   - the credential itself is rejected (expired, malformed, wrong
 *             project, API not enabled). Nothing will work; stop now.
 *   "model" - the key is fine but THIS model is not available to this
 *             tier/project. Newer models are commonly listed by ListModels
 *             and still refused on the free tier. Skip the model, keep going.
 *
 * Everything below the classifier depends on this distinction.
 */
type DenialKind = "key" | "model";

function classifyDenial(detail: string): DenialKind {
  const d = String(detail || "").replace(/\s+/g, " ").trim();

  // Unambiguous credential problems.
  if (/API_KEY_INVALID|API key not valid|invalid api key|API key expired|API_KEY_EXPIRED|api key is invalid|missing api key|API key not found|UNAUTHENTICATED|credential/i.test(d)) {
    return "key";
  }
  // The Generative Language API itself is switched off for the project.
  if (/SERVICE_DISABLED|has not been used in project|is disabled|enable the API|accessNotConfigured/i.test(d)) {
    return "key";
  }
  // Model-scoped refusals: the key works, this model does not.
  if (/model|tier|billing|quota|not supported|does not have access|not available|permission to access|allowlist|allow list|preview|region/i.test(d)) {
    return "model";
  }
  // Bare PERMISSION_DENIED with no other signal: assume it is the model, so
  // one restricted model can never disable resume parsing entirely.
  if (/PERMISSION_DENIED|forbidden/i.test(d)) return "model";

  return "key";
}

function geminiAuthError(detail: string): Error {
  const d = String(detail || "").replace(/\s+/g, " ").trim();
  if (/SERVICE_DISABLED|has not been used in project|enable the API|accessNotConfigured/i.test(d)) {
    return new Error(
      "The Generative Language API is not enabled for this Google project. Enable it in Google AI Studio (or Google Cloud console) for the project that owns GOOGLE_API_KEY, then retry."
    );
  }
  return new Error(
    "Gemini rejected the API key. Set GOOGLE_API_KEY to a current Google AI Studio Gemini API key, with no quotes or spaces around it, then redeploy."
  );
}

/**
 * Models this key was refused for. Cached for the life of the lambda so one
 * restricted model is not re-probed on every upload.
 */
const deniedModels = new Map<string, number>();
const DENIED_TTL_MS = 15 * 60 * 1000;

function isDenied(model: string): boolean {
  const at = deniedModels.get(model);
  if (!at) return false;
  if (Date.now() - at > DENIED_TTL_MS) { deniedModels.delete(model); return false; }
  return true;
}

/** The model that last produced a usable answer - tried first next time. */
let lastGoodModel = "";

/* ------------------------------------------------------------------ */
/* Request dialects                                                    */
/* ------------------------------------------------------------------ */

/**
 * `v3`     - Gemini 3.x: thinkingLevel, responseFormat, no sampling params.
 * `legacy` - Gemini 2.x/1.x: thinkingBudget, responseMimeType/responseSchema.
 */
type Dialect = "v3" | "legacy";

/** How much of the request the model/deployment actually accepted. */
type Capability = "schema" | "json" | "text";

type ModelProfile = { dialect: Dialect; capability: Capability };

const modelProfiles = new Map<string, ModelProfile>();

function isV3(model: string) {
  return /^gemini-(?:[3-9]|\d{2,})[.\-]/.test(model) || /^gemini-(?:[3-9]|\d{2,})-/.test(model);
}

function profileFor(model: string): ModelProfile {
  const cached = modelProfiles.get(model);
  if (cached) return cached;
  const fresh: ModelProfile = { dialect: isV3(model) ? "v3" : "legacy", capability: "schema" };
  modelProfiles.set(model, fresh);
  return fresh;
}

function buildGenerationConfig(
  profile: ModelProfile,
  opts: { maxTokens: number; temperature: number; json: boolean; schema?: Record<string, any>; thinking?: ChatOptions["thinking"] }
): Record<string, any> {
  const cfg: Record<string, any> = { maxOutputTokens: opts.maxTokens };

  if (profile.dialect === "v3") {
    // Gemini 3.x deprecates temperature/top_p/top_k; sending them is at best
    // ignored and at worst degrades output. Thinking is a string enum here.
    if (opts.thinking === "off") cfg.thinkingConfig = { thinkingLevel: "minimal" };
    else if (opts.thinking) cfg.thinkingConfig = { thinkingLevel: opts.thinking };

    if (profile.capability === "schema" && opts.schema) {
      cfg.responseFormat = { text: { mimeType: "application/json", schema: opts.schema } };
    } else if (profile.capability !== "text" && (opts.json || opts.schema)) {
      cfg.responseFormat = { text: { mimeType: "application/json" } };
    }
    return cfg;
  }

  cfg.temperature = opts.temperature;
  // Thinking tokens are billed against maxOutputTokens on 2.5. For extraction
  // we want every token spent on the answer.
  if (opts.thinking === "off") cfg.thinkingConfig = { thinkingBudget: 0 };
  else if (opts.thinking === "low") cfg.thinkingConfig = { thinkingBudget: 512 };

  if (profile.capability === "schema" && opts.schema) {
    cfg.responseMimeType = "application/json";
    cfg.responseSchema = opts.schema;
  } else if (profile.capability !== "text" && (opts.json || opts.schema)) {
    cfg.responseMimeType = "application/json";
  }
  return cfg;
}

/** Decide whether a 400 is a dialect problem we can recover from. */
function degrade(profile: ModelProfile, detail: string): ModelProfile | null {
  const d = detail.toLowerCase();
  const mentionsV3Field = /responseformat|thinkinglevel|response_format|thinking_level/.test(d);
  const mentionsLegacyField = /responsemimetype|responseschema|thinkingbudget|response_mime_type|response_schema|thinking_budget/.test(d);
  const unknownField = /unknown name|invalid json payload|cannot find field|unexpected field|not supported|invalid argument/.test(d);

  // Wrong dialect for this model: flip it and keep full capability.
  if (unknownField && profile.dialect === "v3" && mentionsV3Field) {
    return { dialect: "legacy", capability: profile.capability };
  }
  if (unknownField && profile.dialect === "legacy" && mentionsLegacyField) {
    return { dialect: "v3", capability: profile.capability };
  }
  // Right dialect, unsupported feature: drop one rung.
  if (profile.capability === "schema") return { dialect: profile.dialect, capability: "json" };
  if (profile.capability === "json") return { dialect: profile.dialect, capability: "text" };
  return null;
}

/* ------------------------------------------------------------------ */
/* Model discovery                                                     */
/* ------------------------------------------------------------------ */

let discovered: { at: number; models: string[] } | null = null;
let discovering: Promise<string[]> | null = null;

async function listAvailableModels(signalTimeoutMs = 4000): Promise<string[]> {
  const key = getGeminiApiKey();
  if (!key) return [];
  if (discovered && Date.now() - discovered.at < MODEL_DISCOVERY_TTL_MS) return discovered.models;
  if (discovering) return discovering;

  discovering = (async () => {
    try {
      const res = await fetchWithTimeout(
        `${GEMINI_API_ROOT}?pageSize=200`,
        { method: "GET", headers: { "x-goog-api-key": key } },
        signalTimeoutMs
      );
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as any;
      const names: string[] = (data?.models ?? [])
        .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m?.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      discovered = { at: Date.now(), models: names };
      return names;
    } catch {
      return [];
    } finally {
      discovering = null;
    }
  })();

  return discovering;
}

/**
 * Ordered list of models to try. An explicit GEMINI_MODEL always goes first;
 * the ladder follows so a retired or unavailable model can never be fatal.
 */
export async function resolveModels(): Promise<string[]> {
  const override = getConfiguredModel();
  const available = await listAvailableModels();

  const ladder = available.length ? MODEL_LADDER.filter((m) => available.includes(m)) : [];

  // Anything else the key can see that looks like a general-purpose flash
  // model. This is the safety net for a lineup released after this code.
  const extras = available.filter(
    (m) =>
      !MODEL_LADDER.includes(m) &&
      /^gemini-[\d.]+-flash(-lite)?$/.test(m) &&
      !/image|tts|live|audio|vision|embedding|robotics|thinking|exp|preview/i.test(m)
  );

  const ordered = [...(ladder.length ? ladder : MODEL_LADDER), ...extras];
  const list = override ? [override, ...ordered.filter((m) => m !== override)] : ordered;

  // Six candidates: deep enough that a couple of tier-restricted models cannot
  // exhaust the list, shallow enough to stay inside the time budget.
  return list.length ? list.slice(0, 6) : [DEFAULT_MODEL];
}

/**
 * Which models this deployment's key can actually use. Powers the
 * `GET /api/ai/parse-resume` health check, so a misconfigured key can be
 * diagnosed from the browser instead of from Vercel logs.
 */
export async function geminiDiagnostics(): Promise<Record<string, unknown>> {
  if (!aiEnabled()) {
    return { ok: false, keyConfigured: false, hint: AI_SETUP_HINT };
  }

  const configured = getConfiguredModel();
  const candidates = await resolveModels();
  const probes: Array<Record<string, unknown>> = [];
  let working = "";

  for (const model of candidates.slice(0, 4)) {
    try {
      const { text, model: used } = await geminiGenerate(
        [{ role: "user", parts: [{ text: 'Reply with exactly: {"ok":true}' }] }],
        { models: [model], maxTokens: 256, timeoutMs: 12000, retries: 0, json: true, thinking: "off" }
      );
      probes.push({ model, ok: true, sample: text.slice(0, 40) });
      if (!working) working = used || model;
    } catch (err: any) {
      probes.push({ model, ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  return {
    ok: Boolean(working),
    keyConfigured: true,
    configuredModel: configured || "(not set - using automatic selection)",
    workingModel: working || null,
    candidates,
    probes,
    hint: working
      ? undefined
      : "No candidate model accepted this key. Set GEMINI_MODEL to a model your key can use (gemini-2.5-flash works on the free tier), or enable billing.",
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Gemini timed out. Please retry once.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function backoff(attempt: number, explicitMs?: number) {
  return new Promise((resolve) => setTimeout(resolve, explicitMs ?? Math.min(2000, 400 * 2 ** attempt)));
}

function remainingMs(opts: ChatOptions, fallback: number): number {
  if (!opts.deadline) return fallback;
  return Math.max(0, Math.min(fallback, opts.deadline - Date.now()));
}

/**
 * One generateContent call, with dialect negotiation, model fallback and
 * truncation reporting.
 */
export async function geminiGenerate(contents: unknown[], opts: ChatOptions = {}): Promise<GenerateResult> {
  const {
    maxTokens = 8192,
    temperature = 0.1,
    retries = 1,
    timeoutMs = 45000,
    json = false,
    schema,
    fallbackModels = true,
    thinking,
  } = opts;

  const key = getGeminiApiKey();
  if (!key) throw new Error(AI_SETUP_HINT);

  const models = opts.models?.length
    ? opts.models
    : fallbackModels
      ? await resolveModels()
      : [(await resolveModels())[0]];

  let lastError = "Gemini request failed.";
  let keyDenial = "";
  let skipped = 0;    // models already known to be off limits for this key
  let deniedNow = 0;  // models that refused us during this call
  let tried = 0;      // models we actually sent a request to

  // A model that worked a moment ago is the best first guess.
  const ordered = lastGoodModel && models.includes(lastGoodModel)
    ? [lastGoodModel, ...models.filter((m) => m !== lastGoodModel)]
    : models;

  for (const model of ordered) {
    if (isDenied(model)) { skipped += 1; continue; }
    tried += 1;

    // Each model gets its own dialect/capability negotiation ladder.
    let tokenBudget = maxTokens;
    let boosted = false;

    for (let shape = 0; shape < 5; shape++) {
      const profile = profileFor(model);
      const budget = remainingMs(opts, timeoutMs);
      if (budget < 1500) {
        lastError = "Ran out of time before Gemini could answer.";
        break;
      }

      const body = {
        contents,
        generationConfig: buildGenerationConfig(profile, { maxTokens: tokenBudget, temperature, json, schema, thinking }),
      };

      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": key,
              "x-goog-api-client": "applifill-resume/2.0",
            },
            body: JSON.stringify(body),
          },
          budget
        );
      } catch (err: any) {
        lastError = String(err?.message || "Couldn't reach Gemini.");
        break; // network/timeout: try the next model, not a different shape
      }

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as any;
        const candidate = data?.candidates?.[0];
        const finishReason = String(candidate?.finishReason ?? "");
        const text = String(
          (candidate?.content?.parts ?? [])
            .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        ).trim();

        if (text) {
          lastGoodModel = model;
          return { text, truncated: finishReason === "MAX_TOKENS", model, finishReason };
        }

        if (finishReason === "MAX_TOKENS") {
          // The model spent the whole budget without emitting any text - the
          // classic reasoning-tokens-ate-the-budget failure. Thinking is
          // already off, so give it more room once before moving on.
          if (!boosted && tokenBudget < 60_000 && remainingMs(opts, timeoutMs) > 6000) {
            boosted = true;
            tokenBudget = Math.min(60_000, Math.max(tokenBudget * 2, 16_384));
            continue;
          }
          lastError = "Gemini ran out of output budget before returning an answer.";
          break;
        }
        if (/SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(finishReason)) {
          lastError = `Gemini declined to answer (${finishReason}).`;
          break;
        }
        lastError = "Gemini returned an empty response.";
        break;
      }

      const detail = await res.text().catch(() => "");

      if (res.status === 401 || res.status === 403) {
        if (classifyDenial(detail) === "key") {
          // The credential itself is bad - no other model will fare better.
          throw geminiAuthError(detail);
        }
        // Only this model is off limits. Remember that and try the next one.
        deniedModels.set(model, Date.now());
        deniedNow += 1;
        keyDenial = detail.slice(0, 200);
        lastError = `Your Gemini key is not allowed to use "${model}".`;
        console.warn(`[gemini] model "${model}" refused (403); trying the next model.`, keyDenial);
        break;
      }

      if (res.status === 404) {
        lastError = `Gemini model "${model}" is unavailable.`;
        discovered = null; // force rediscovery; the ladder may be stale
        break;
      }

      if (res.status === 400) {
        const next = degrade(profile, detail);
        if (next) {
          modelProfiles.set(model, next);
          continue; // same model, simpler request
        }
        lastError = `Gemini rejected the request (400). ${detail.slice(0, 240)}`;
        break;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        lastError = res.status === 429 ? "Gemini is rate limiting requests." : "Gemini is temporarily unavailable.";
        let recovered = false;
        for (let attempt = 0; attempt < retries; attempt++) {
          if (remainingMs(opts, timeoutMs) < 4000) break;
          await backoff(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : undefined);
          recovered = true;
          break;
        }
        if (recovered) continue;
        break;
      }

      lastError = `Gemini request failed (${res.status}). ${detail.slice(0, 240)}`;
      break;
    }
  }

  // Every candidate model refused this key. That is a plan/tier problem, not a
  // bad key, and the message has to say so or people rotate a working key.
  const everyModelRefused = (tried > 0 && deniedNow === tried) || (tried === 0 && skipped > 0);
  if (everyModelRefused) {
    deniedModels.clear(); // do not poison the next request
    throw new Error(
      `Your Gemini API key is valid but is not allowed to use any of the models tried (${ordered.join(", ")}). ` +
      `Set GEMINI_MODEL to a model your key can access - "gemini-2.5-flash" works on the free tier - or enable billing for the newer models.` +
      (keyDenial ? ` Google said: ${keyDenial}` : "")
    );
  }

  throw new Error(lastError);
}

function messagesToContents(messages: Message[]) {
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (!nonSystem.length) return [{ role: "user", parts: [{ text: systemText }] }];
  return nonSystem.map((m, index) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: index === 0 && systemText ? `${systemText}\n\n${m.content}` : m.content }],
  }));
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Salvages a JSON document that was cut off mid-write.
 *
 * A truncated response used to throw, which discarded a perfectly good parse
 * of the first eight jobs because the ninth was incomplete. Closing the open
 * containers keeps everything the model did manage to emit.
 */
export function repairTruncatedJson(input: string): string | null {
  const start = input.indexOf("{");
  if (start === -1) return null;
  const s = input.slice(start);

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // index just after the last completed top-level-ish value

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch === "{" ? "}" : "]"); continue; }
    if (ch === "}" || ch === "]") { stack.pop(); lastSafe = i + 1; continue; }
    if (ch === "," && stack.length) lastSafe = i; // safe cut point between elements
  }

  if (!stack.length) {
    try { JSON.parse(s); return s; } catch { /* keep repairing */ }
  }

  // Cut back to the last point where a value was complete, then close up.
  let body = lastSafe > 0 ? s.slice(0, lastSafe) : s;
  body = body.replace(/,\s*$/, "");

  // Recompute the open containers for the trimmed body.
  const closers: string[] = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  if (inString) body += '"';
  body = body.replace(/,\s*$/, "");
  while (closers.length) body += closers.pop();

  try {
    JSON.parse(body);
    return body;
  } catch {
    return null;
  }
}

export function parseJson<T>(raw: string): T {
  const cleaned = String(raw ?? "")
    .replace(/^﻿/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch { /* try harder */ }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch { /* try harder */ }
  }

  const repaired = repairTruncatedJson(cleaned);
  if (repaired) return JSON.parse(repaired) as T;

  throw new Error("The AI response wasn't valid JSON. Please retry the resume parse.");
}

/* ------------------------------------------------------------------ */
/* Groq text fallback                                                  */
/* ------------------------------------------------------------------ */

async function groqGenerateText(system: string, user: string, maxTokens: number, json = false, timeoutMs = 20000) {
  const key = getGroqApiKey();
  if (!key) throw new Error("GROQ_API_KEY is not configured.");

  const model = cleanSecret(process.env.GROQ_MODEL) || "llama-3.3-70b-versatile";
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.15,
    max_tokens: Math.min(Math.max(64, maxTokens), 32768),
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Groq request failed (${res.status}). ${raw.slice(0, 240)}`);
  }
  const data = JSON.parse(raw);
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("Groq returned an empty response.");
  return text;
}

/* ------------------------------------------------------------------ */
/* Public call helpers                                                 */
/* ------------------------------------------------------------------ */

export async function askAI(system: string, user: string, maxTokens = 1024) {
  try {
    const { text } = await geminiGenerate(
      messagesToContents([
        { role: "system", content: system },
        { role: "user", content: user },
      ]),
      { maxTokens, temperature: 0.4, retries: 1, timeoutMs: 25000, thinking: "off" }
    );
    return text.trim();
  } catch (geminiError) {
    // Text-only AI can keep working when Gemini is temporarily unavailable or
    // its model tier is restricted. Groq is never used for resume image/PDF
    // parsing; it is only a server-side fallback for answer generation/scoring.
    if (!getGroqApiKey()) throw geminiError;
    console.warn("[ai] Gemini text generation failed; using Groq fallback", geminiError);
    return groqGenerateText(system, user, maxTokens, false);
  }
}

/**
 * One JSON object from the model.
 *
 * `opts.deadline` bounds the whole call — every model on the ladder and the
 * Groq fallback share it — so a caller with a person waiting (the extension
 * filling a form) gets an answer or an error in time, never a hang.
 */
export async function askAIJSON<T>(system: string, user: string, maxTokens = 4096, opts: ChatOptions = {}): Promise<T> {
  const promptSystem = `${system}\n\nRespond with one valid JSON object and nothing else. No prose and no markdown fences.`;
  try {
    const { text } = await geminiGenerate(
      messagesToContents([
        { role: "system", content: promptSystem },
        { role: "user", content: user },
      ]),
      { maxTokens, temperature: 0.15, retries: 1, timeoutMs: 30000, json: true, thinking: "off", ...opts }
    );
    return parseJson<T>(text);
  } catch (geminiError) {
    if (!getGroqApiKey()) throw geminiError;
    const left = opts.deadline ? opts.deadline - Date.now() : 20000;
    if (left < 2500) throw geminiError;
    console.warn("[ai] Gemini JSON generation failed; using Groq fallback", geminiError);
    const text = await groqGenerateText(promptSystem, user, maxTokens, true, Math.min(20000, left));
    return parseJson<T>(text);
  }
}

/**
 * Schema-constrained JSON extraction. `truncated` lets the caller decide
 * whether to retry with a bigger budget instead of silently losing entries.
 */
export async function askAISchema<T>(
  system: string,
  user: string,
  schema: Record<string, any>,
  opts: ChatOptions = {}
): Promise<{ data: T; truncated: boolean; model: string }> {
  const { text, truncated, model } = await geminiGenerate(
    messagesToContents([
      { role: "system", content: system },
      { role: "user", content: user },
    ]),
    {
      maxTokens: 32768,
      temperature: 0,
      retries: 1,
      timeoutMs: 45000,
      thinking: "off",
      json: true,
      schema,
      ...opts,
    }
  );
  return { data: parseJson<T>(text), truncated, model };
}

/** Kept for existing callers. */
export async function askAIJSONFast<T>(system: string, user: string, maxTokens = 16384): Promise<T> {
  const { text } = await geminiGenerate(
    messagesToContents([
      { role: "system", content: `${system}\n\nRespond with one valid JSON object and nothing else. No prose and no markdown fences.` },
      { role: "user", content: user },
    ]),
    { maxTokens, temperature: 0, retries: 1, timeoutMs: 35000, json: true, thinking: "off" }
  );
  return parseJson<T>(text);
}

/** Backward-compatible alias. */
export async function askGeminiJSON<T>(system: string, user: string, maxOutputTokens = 16384): Promise<T> {
  return askAIJSONFast<T>(system, user, maxOutputTokens);
}

/* ------------------------------------------------------------------ */
/* Multimodal (scanned PDFs and photographed resumes)                  */
/* ------------------------------------------------------------------ */

export async function askAISchemaWithFile<T>(
  system: string,
  buffer: Buffer,
  mimeType: string,
  schema: Record<string, any>,
  opts: ChatOptions = {}
): Promise<{ data: T; truncated: boolean; model: string }> {
  const safeMime = /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif))$/i.test(mimeType)
    ? mimeType
    : "application/pdf";

  const { text, truncated, model } = await geminiGenerate(
    [
      {
        role: "user",
        parts: [
          { text: system },
          { inline_data: { mime_type: safeMime, data: buffer.toString("base64") } },
        ],
      },
    ],
    {
      maxTokens: 32768,
      temperature: 0,
      retries: 1,
      timeoutMs: 45000,
      thinking: "off",
      json: true,
      schema,
      ...opts,
    }
  );
  return { data: parseJson<T>(text), truncated, model };
}

/* ------------------------------------------------------------------ */
/* Profile context for scoring / answer generation                     */
/* ------------------------------------------------------------------ */

/** Whole years across the roles on a profile, overlapping roles counted once per month. */
function totalYears(experience: any[]): number | null {
  const months = new Set<string>();
  const now = new Date();
  for (const e of experience ?? []) {
    const start = String(e?.startDate ?? "").match(/(\d{4})(?:-(\d{1,2}))?/);
    if (!start) continue;
    const end = e?.current || !e?.endDate ? null : String(e.endDate).match(/(\d{4})(?:-(\d{1,2}))?/);
    let y = Number(start[1]);
    let m = Number(start[2] || 1);
    const endY = end ? Number(end[1]) : now.getFullYear();
    const endM = end ? Number(end[2] || 12) : now.getMonth() + 1;
    for (let guard = 0; guard < 720 && (y < endY || (y === endY && m <= endM)); guard++) {
      months.add(`${y}-${m}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return months.size ? Math.round(months.size / 12) : null;
}

export function profileToContext(p: any) {
  const exp = (p.experience ?? [])
    .slice(0, 12)
    .map((e: any) =>
      `- ${e.title ?? "?"} at ${e.company ?? "?"}${e.location ? `, ${e.location}` : ""}${e.employmentType ? ` (${e.employmentType})` : ""} ` +
      `(${e.startDate ?? "?"}–${e.current ? "present" : e.endDate ?? "?"}). ${e.description ?? ""}`)
    .join("\n");
  const years = totalYears(p.experience ?? []);
  const auth = p.workAuth ?? {};
  const edu = (p.education ?? [])
    .map((e: any) =>
      `- ${e.degree || "?"}${e.fieldOfStudy ? ` in ${e.fieldOfStudy}` : ""}, ${e.school || "?"} ` +
      `(${e.startDate || "?"}–${e.current ? "present" : e.endDate || "?"}). ${e.description ?? ""}`)
    .join("\n");
  const websites = (p.websites ?? [])
    .map((w: any) => `${w.label || "Website"}: ${w.url || ""}`)
    .filter(Boolean)
    .join("\n");
  return [
    `Name: ${p.personal?.firstName ?? ""} ${p.personal?.lastName ?? ""}`,
    `Email: ${p.personal?.email ?? ""}`,
    `Phone: ${p.personal?.phone ?? ""}`,
    `Target role: ${p.targetRole || "not specified"}`,
    `Location: ${[p.personal?.city, p.personal?.state, p.personal?.country].filter(Boolean).join(", ")}`,
    p.personal?.languages?.length ? `Languages: ${p.personal.languages.join(", ")}` : "",
    p.summary ? `Summary: ${p.summary}` : "",
    exp ? `Experience:\n${exp}` : "",
    edu ? `Education:\n${edu}` : "",
    p.skills?.length ? `Skills: ${p.skills.join(", ")}` : "",
    p.certifications?.length ? `Certifications: ${p.certifications.join(", ")}` : "",
    websites ? `Websites:\n${websites}` : "",
    years != null ? `Total professional experience: about ${years} years` : "",
    `Work authorization: ${auth.authorizedToWork ?? "?"}; needs sponsorship: ${auth.requireSponsorship ?? "?"}; work authorization type: ${auth.workAuthType ?? "?"}; visa/work status: ${auth.visaStatus ?? "?"}; citizenship: ${p.personal?.citizenship || p.personal?.nationality || "?"}`,
    `Security clearance: ${auth.securityClearance || "?"}; driver's license: ${auth.driversLicense || "?"}; over 18: ${auth.over18 || "?"}`,
    `Previously employed by the hiring company: ${auth.previouslyEmployedHere || "?"}; relatives employed by the hiring company: ${auth.relativesEmployedHere || "?"}`,
    `Willing to take a drug test: ${auth.willingToDrugTest || "?"}; willing to undergo a background check: ${auth.willingToBackgroundCheck || "?"}`,
    `Availability: ${auth.availableStartDate ?? "?"}; notice period: ${auth.noticePeriod ?? "?"}; relocation: ${auth.willingToRelocate ?? "?"}; remote preference: ${auth.remotePreference ?? "?"}`,
    auth.howDidYouHear || auth.referredBy ? `Usually hears about jobs via: ${auth.howDidYouHear || "?"}; referred by: ${auth.referredBy || "nobody on file"}` : "",
    `Compensation: desired ${p.compensation?.desiredSalary ?? "?"} ${p.compensation?.salaryCurrency ?? "USD"} (${p.compensation?.salaryPeriod ?? "year"}); current ${p.compensation?.currentSalary ?? "?"}`,
    `EEO (only use when the application explicitly asks): gender identity ${p.eeo?.genderIdentity ?? "?"}; ethnicity ${p.eeo?.ethnicity ?? "?"}; gender ${p.eeo?.gender ?? "?"}; race/ethnicity ${p.eeo?.race ?? "?"}; Hispanic/Latino ${p.eeo?.hispanicLatino ?? "?"}; veteran ${p.eeo?.veteranStatus ?? "?"}; disability ${p.eeo?.disabilityStatus ?? "?"}; sexual orientation ${p.eeo?.sexualOrientation ?? "?"}; transgender ${p.eeo?.transgender ?? "?"}; decline to self-identify ${p.eeo?.declineToSelfIdentify ? "Yes" : "No"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Re-exports so existing imports keep working                         */
/* ------------------------------------------------------------------ */

export const extractResumeText = extractResumeTextImpl;
export const fallbackParseResumeText = fallbackParseResumeTextImpl;

/**
 * Kept so `import { parseResumeDocument } from "@/lib/ai"` still works.
 * Loaded dynamically because resume-parse imports this module; a static
 * re-export would make the cycle resolve at module-evaluation time.
 * New code should import from "@/lib/resume-parse" directly.
 */
export async function parseResumeDocument(input: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  deadline?: number;
  system?: string;
  shape?: string;
}): Promise<Record<string, any>> {
  const { parseResumeDocument: impl } = await import("./resume-parse");
  return impl(input);
}
