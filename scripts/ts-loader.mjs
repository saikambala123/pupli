/**
 * Minimal TypeScript loader so the parsing scripts can import the app's
 * `src/lib/*.ts` modules directly. Types are stripped, not checked - run
 * `npx tsc --noEmit` for that.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  let target = specifier;
  if (target.startsWith("@/")) {
    target = new URL(`../src/${target.slice(2)}`, import.meta.url).href;
  }
  // TypeScript's `bundler` resolution omits the extension; add it back.
  if (/^[.\/]|^file:/.test(target) && !/\.(ts|tsx|js|mjs|cjs|json)$/.test(target)) {
    try {
      return await next(`${target}.ts`, context);
    } catch {
      /* fall through to the original specifier */
    }
  }
  return next(target, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const ts = await import("typescript");
    const { outputText } = (ts.default ?? ts).transpileModule(source, {
      compilerOptions: { module: 99, target: 99, jsx: 1 },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
