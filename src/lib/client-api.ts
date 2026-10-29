"use client";

/**
 * One place that knows how to talk to this app's API from the browser.
 *
 * Every dashboard component previously wrote its own `fetch` + `res.json()`
 * pair, and each one had at least one of these three holes:
 *
 *   1. `await res.json()` outside a try/catch. `fetch` rejects on any network
 *      failure and `res.json()` rejects on an empty or HTML body — which is
 *      exactly what a platform 502/504 returns, bypassing the JSON envelope in
 *      lib/api.ts. The rejection skipped the `setBusy(false)` that followed, so
 *      the submit button kept its spinner and stayed disabled until a reload.
 *   2. No `res.ok` check on optimistic writes, so a 401 or 500 left the UI
 *      showing a change that was never persisted.
 *   3. A missing `json.error` producing `new Error(undefined)`, whose message is
 *      the empty string — rendering no error text at all.
 *
 * `apiRequest` never rejects. It always resolves to a tagged result, so callers
 * can handle failure without a try/catch and without ever getting stuck.
 */

export type ApiResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

const NETWORK_ERROR =
  "We couldn't reach the server. Check your connection and try again.";

/** Human-readable fallback for a response that carried no usable JSON error. */
function statusMessage(status: number) {
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "We couldn't find that.";
  if (status === 413) return "That file or record is too large.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "The server had a problem with that request. Please try again.";
  return `That request failed (${status}).`;
}

export async function apiRequest<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers:
        init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
          : init.headers,
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }

  // A 502/504 or a redirect to a login page returns HTML, not JSON. Never let
  // the parser's own message ("Unexpected token '<'…") reach the user.
  const json: any = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      (json && typeof json.error === "string" && json.error.trim()) || statusMessage(res.status);
    return { ok: false, error: message, status: res.status };
  }

  return { ok: true, data: (json?.data ?? json) as T };
}

/** Convenience wrappers. `body` is JSON-encoded unless it is already FormData. */
const encode = (body: unknown) => (body instanceof FormData ? body : JSON.stringify(body));

export const apiGet = <T = any>(path: string) => apiRequest<T>(path);

export const apiPost = <T = any>(path: string, body?: unknown) =>
  apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : encode(body) });

export const apiPatch = <T = any>(path: string, body?: unknown) =>
  apiRequest<T>(path, { method: "PATCH", body: body === undefined ? undefined : encode(body) });

export const apiDelete = <T = any>(path: string, body?: unknown) =>
  apiRequest<T>(path, { method: "DELETE", body: body === undefined ? undefined : encode(body) });
