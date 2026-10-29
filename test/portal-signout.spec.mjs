/**
 * The dashboard asks before signing out.
 *
 *   node test/portal-signout.spec.mjs
 *
 * Asked for (1 October 2026): "when we click logout logo in portal it should
 * ask are u sure to logout". The sign-out icon sits right beside the account
 * name in the sidebar, and one click ended the session at once.
 *
 * The real Sidebar component is rendered in a browser — compiled with the
 * project's own TypeScript, on the project's own React and icons — with the
 * Next.js router and the logout request stubbed and recorded.
 */

import { chromium } from "playwright";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

/** A source file of the app, as CommonJS the page can run. */
async function compiled(rel) {
  const source = await readFile(join(ROOT, rel), "utf8");
  return ts.transpileModule(source, {
    fileName: rel,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
}

/** A package's own folder, found through its entry point (its exports hide the rest). */
function packageDir(name) {
  let dir = dirname(require.resolve(name));
  while (!dir.endsWith(`node_modules/${name}`) && dir !== dirname(dir)) dir = dirname(dir);
  return dir;
}
const vendor = await Promise.all([
  readFile(join(packageDir("react"), "umd/react.development.js"), "utf8"),
  readFile(join(packageDir("react-dom"), "umd/react-dom.development.js"), "utf8"),
  readFile(join(packageDir("lucide-react"), "dist/umd/lucide-react.js"), "utf8"),
]);
const app = {
  "@/lib/utils": await compiled("src/lib/utils.ts"),
  "@/components/ui/Logo": await compiled("src/components/ui/Logo.tsx"),
  sidebar: await compiled("src/components/dashboard/Sidebar.tsx"),
};

/**
 * The app's own stylesheet, built by the app's own Tailwind: the dialog's
 * backdrop only covers the page once its classes mean something.
 */
let styles = "";
try {
  const { default: postcss } = await import("postcss");
  const { default: tailwind } = await import("tailwindcss");
  const from = join(ROOT, "src/app/globals.css");
  styles = (await postcss([tailwind({ config: join(ROOT, "tailwind.config.ts") })]).process(await readFile(from, "utf8"), { from })).css;
} catch (err) {
  console.log(`  (no stylesheet: ${err.message.split("\n")[0]})`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});

async function mount() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>`);
  if (styles) await page.addStyleTag({ content: styles });
  const [react, reactDom, icons] = vendor;
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  // The icons' browser build looks React up as `react`.
  await page.addScriptTag({ content: "window.react = window.React;" });
  await page.addScriptTag({ content: icons });
  await page.evaluate((app) => {
    window.__requests = [];
    window.__pushed = [];
    window.fetch = async (url, init) => {
      window.__requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true, data: { signedOut: true } }), { headers: { "content-type": "application/json" } });
    };
    const modules = {
      react: window.React,
      "lucide-react": window.LucideReact,
      clsx: { clsx: (...a) => a.flat().filter(Boolean).join(" ") },
      "tailwind-merge": { twMerge: (s) => s },
      "next/link": {
        __esModule: true,
        default: ({ href, children, onClick, ...rest }) =>
          window.React.createElement("a", { href, ...rest, onClick: (e) => { e.preventDefault(); onClick?.(e); } }, children),
      },
      "next/image": {
        __esModule: true,
        default: ({ priority, unoptimized, fill, ...props }) => window.React.createElement("img", props),
      },
      "next/navigation": {
        usePathname: () => "/dashboard",
        useRouter: () => ({ push: (u) => window.__pushed.push(u), refresh() {} }),
      },
    };
    const load = (code) => {
      const module = { exports: {} };
      new Function("require", "module", "exports", code)((name) => {
        if (!(name in modules)) throw new Error(`no module ${name}`);
        return modules[name];
      }, module, module.exports);
      return module.exports;
    };
    modules["@/lib/utils"] = load(app["@/lib/utils"]);
    modules["@/components/ui/Logo"] = load(app["@/components/ui/Logo"]);
    const Sidebar = load(app.sidebar).default;
    window.ReactDOM.createRoot(document.getElementById("root")).render(
      window.React.createElement(Sidebar, {
        account: { name: "Pradeep Reddy", email: "pradeepbeeram91@gmail.com", premium: true, trialDaysLeft: 0 },
      })
    );
  }, app);
  await page.waitForTimeout(150);
  return page;
}

const state = (page) => page.evaluate(() => {
  const dialog = document.querySelector('[role="alertdialog"]');
  return {
    dialog: Boolean(dialog),
    text: dialog?.innerText.replace(/\s+/g, " ").trim() ?? "",
    focused: document.activeElement?.textContent?.trim() ?? "",
    loggedOut: window.__requests.some((r) => r.url.includes("/api/auth/logout")),
    pushed: window.__pushed,
  };
});

// The desktop sidebar's icon (the mobile drawer has its own copy of the nav).
const signOutIcon = 'aside.lg\\:block button[aria-label="Sign out"]';

console.log("\nclicking the sign-out icon");
{
  const page = await mount();
  await page.click(signOutIcon);
  await page.waitForTimeout(100);
  let s = await state(page);
  check("asks \"Are you sure you want to log out?\"", s.dialog && /Are you sure you want to log out\?/.test(s.text), JSON.stringify(s));
  check("  offers Cancel and Log out", /Cancel/.test(s.text) && /Log out/.test(s.text), s.text);
  check("  and has not signed out yet", !s.loggedOut && s.pushed.length === 0, JSON.stringify(s));
  check("  Cancel has the focus, so a reflex Enter keeps you in", s.focused === "Cancel", `focused: ${s.focused}`);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });

  await page.click('[role="alertdialog"] button:has-text("Cancel")');
  await page.waitForTimeout(100);
  s = await state(page);
  check("Cancel closes it and you stay signed in", !s.dialog && !s.loggedOut, JSON.stringify(s));

  await page.click(signOutIcon);
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  s = await state(page);
  check("Escape closes it too", !s.dialog && !s.loggedOut, JSON.stringify(s));

  await page.click(signOutIcon);
  await page.waitForTimeout(100);
  await page.mouse.click(1200, 60);
  await page.waitForTimeout(100);
  s = await state(page);
  check("so does a click outside it", !s.dialog && !s.loggedOut, JSON.stringify(s));

  await page.click(signOutIcon);
  await page.waitForTimeout(100);
  await page.click('[role="alertdialog"] button:has-text("Log out")');
  await page.waitForTimeout(200);
  s = await state(page);
  const request = await page.evaluate(() => window.__requests.find((r) => r.url.includes("/api/auth/logout")));
  check("Log out signs you out", s.loggedOut && request?.method === "POST", JSON.stringify(request));
  check("  and goes to the home page", s.pushed.includes("/"), JSON.stringify(s.pushed));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
