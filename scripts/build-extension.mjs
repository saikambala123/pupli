/**
 * Packages the extension for each browser.
 *
 *   node scripts/build-extension.mjs
 *
 * Chrome/Edge use manifest.json (MV3 service worker).
 * Firefox uses manifest.firefox.json (MV3 event page) — Firefox doesn't support
 * `background.service_worker`, so shipping one manifest for both silently breaks
 * the add-on there.
 */

import { cp, mkdir, rm, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "dist");

const SHARED_SKIP = new Set(["manifest.firefox.json", ".DS_Store"]);

/**
 * Where the packaged extension should talk to.
 *
 * The default preserves the existing deployed origin. Set APPLI_FILL_API_BASE
 * (or NEXT_PUBLIC_APP_URL) in the shell when targeting a different deployment.
 */
const API_BASE = (process.env.APPLI_FILL_API_BASE || process.env.ZAPPLY_API_BASE || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

const API_BASE_MARKER = /^const DEFAULT_API = .*\/\* build:api-base \*\/$/m;

/** Rewrites the `DEFAULT_API` line that background.js marks with `build:api-base`. */
async function stampApiBase(destFile) {
  if (!API_BASE) return;
  const source = await readFile(destFile, "utf8");

  // Check for the marker itself. Comparing before/after would also "fail" when
  // the source already carries the target URL, which is a no-op, not an error.
  if (!API_BASE_MARKER.test(source)) {
    throw new Error(
      "background.js is missing the `/* build:api-base */` marker on its DEFAULT_API line — " +
        "the packaged extension would point at the wrong server."
    );
  }

  await writeFile(
    destFile,
    source.replace(API_BASE_MARKER, `const DEFAULT_API = ${JSON.stringify(API_BASE)}; /* build:api-base */`)
  );
}

async function build(target, manifestFile) {
  const dest = join(OUT, target);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  for (const entry of await readdir(SRC)) {
    if (SHARED_SKIP.has(entry)) continue;
    await cp(join(SRC, entry), join(dest, entry), { recursive: true });
  }

  // Swap in the target's manifest.
  const manifest = await readFile(join(SRC, manifestFile), "utf8");
  await writeFile(join(dest, "manifest.json"), manifest);

  await stampApiBase(join(dest, "background.js"));

  // Zip it if the system has `zip`; otherwise leave the folder for manual loading.
  try {
    await run("zip", ["-rq", join(OUT, `appli-fill-${target}.zip`), "."], { cwd: dest });
    console.log(`  dist/${target}/  ->  dist/appli-fill-${target}.zip`);
  } catch {
    console.log(`  dist/${target}/  (install \`zip\` to produce an archive)`);
  }
}

await rm(OUT, { recursive: true, force: true });
console.log("Building extension packages:");
console.log(
  API_BASE
    ? `  API base: ${API_BASE}`
    : "  ! API base not set — the build keeps background.js's default.\n" +
      "    Set APPLI_FILL_API_BASE=https://your-app.vercel.app before packaging a release."
);
await build("chrome", "manifest.json");
await build("firefox", "manifest.firefox.json");
console.log(`
  Chrome/Edge : load dist/chrome as an unpacked extension, or upload the zip.
  Firefox     : about:debugging -> Load Temporary Add-on -> dist/firefox/manifest.json
`);
