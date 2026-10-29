# Appli-Fill · 2.0.5

Oracle/Ashby update: [2.0.5 release notes](FIXES-v2.0.5.md). Current verification logs are in `verification/v2.0.5`.

Appli-Fill combines a browser extension for job application forms with a Next.js workspace for profiles, saved answers and application tracking.

This complete source package includes the new gorilla shield identity, a redesigned charcoal/orange/turquoise interface, responsive layouts, local fonts, rebuilt Chrome/Edge and Firefox extensions, and 4K artwork exports.

## Start locally

Use Node.js 22 or later with npm. The project includes a lockfile.

```bash
npm ci
cp .env.example .env.local
```

Set a private `JWT_SECRET` in `.env.local` (generate one with `openssl rand -base64 48`). Set `MONGODB_URI` to your database, or leave it empty for a temporary local database. The temporary database is erased when the server stops and may download MongoDB on first use.

```bash
npm run dev
```

Open http://localhost:3000, create an account, and complete your profile. Private environment files and database contents are intentionally excluded from this archive. Keep your existing deployment environment variables when updating your app.

## Install the included extension

### Chrome and Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `dist/chrome` from this package.
4. Pin **Appli-Fill** to the toolbar.

### Firefox

Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then select `dist/firefox/manifest.json`. Store distribution requires the usual signed add-on release process.

### Connect your account

Open the dashboard, generate an extension pairing code, then enter it in the extension popup. The popup's **Server URL** must match your app deployment; use `http://localhost:3000` for local development. Review filled fields before submitting any job application.

## Update an existing installation

- Replace the existing project files, retain your private deployment configuration, install dependencies, and redeploy.
- For an unpacked extension, replace the contents of the same extension folder and click **Reload** on the browser extensions page. Keeping the same installation preserves its pairing storage.
- Close and reopen the popup, and reload open application tabs so they load the new content script.
- If a previously installed web shortcut still shows the old name/icon, remove that shortcut and install it again after deploying. Browsers and operating systems may retain installed icon caches.
- Use the original PNG/ICO files in this package. Do not take a screenshot of a GitHub image preview or convert a small icon into a large JPEG.

Existing sessions and preferences have compatibility reads during the rename. The existing server origin and Firefox add-on identifier are preserved for continuity; they are technical identifiers, not visible product branding. See `UPGRADE.md`.

## Upload to GitHub

Extract this ZIP and put the contents of its `appli-fill` folder at your repository root. Include `src`, `extension`, `public`, `brand`, `scripts`, `test`, the package files, configuration files and documentation. Keep the supplied `.gitignore`; it excludes private environment files, dependencies and build caches. Do not upload `node_modules`, `.next` or `.env.local`.

Vercel should build this repository root. The browser extension is installed separately from the `dist` folders or published using the included extension ZIPs.

## Brand assets

| Asset | Location | Use |
| --- | --- | --- |
| Transparent 4096 × 4096 PNG | `brand/appli-fill-logo-4k.png` | Large artwork export with Appli-Fill wordmark |
| 3840 × 2160 PNG | `brand/appli-fill-banner-4k.png` | Dark presentation/banner export |
| Source raster artwork | `brand/source/appli-fill-logo.png` | Regenerate every export |
| Optimized web logo | `public/brand/appli-fill-logo.webp` | Hero and authentication layouts |
| PNG icon sizes 16–1024 | `public/brand/` | Web/app icons and sharing |
| Multi-resolution ICO | `src/app/favicon.ico` | Browser favicon: 16, 32, 48, 64, 128, 256 |
| Apple touch icon | `src/app/apple-icon.png` | 180-pixel home screen icon |
| Web app manifest | `src/app/manifest.webmanifest` | App name, regular and maskable icons |
| Extension icons | `extension/icons/` | Browser toolbar and extension management |

The 4K files are high-resolution raster exports from the included generated source artwork. Small toolbar icons are exported separately at native display sizes. Live text beside the logo keeps the product name readable in compact UI.

Regenerate the icon family after changing the source artwork:

```bash
npm run brand:build
npm run ext:build
```

## Build for your deployment

```bash
npm run build
npm run start
```

The web app and extension are separate builds. Configure your production environment with `MONGODB_URI`, a strong `JWT_SECRET`, and `NEXT_PUBLIC_APP_URL`. Keep your existing database name and credentials to retain your account data.

Build extensions with your app URL explicitly supplied in the shell:

```bash
APPLI_FILL_API_BASE="https://your-app.example" npm run ext:build
```

On PowerShell:

```powershell
$env:APPLI_FILL_API_BASE="https://your-app.example"
npm run ext:build
```

This writes `dist/chrome`, `dist/firefox`, `dist/appli-fill-chrome.zip`, and `dist/appli-fill-firefox.zip`. The script does not automatically read `.env.local`. Without an exported URL, it preserves the existing deployment origin in `extension/background.js`; you can also change Server URL in the popup.

### Optional services

| Configuration | Enables |
| --- | --- |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Gemini answer drafts and resume parsing |
| `GROQ_API_KEY` | Existing optional text-generation fallback |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `RESEND_API_KEY`, `EMAIL_FROM` | Account email delivery |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Your contact address |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PREMIUM_PRICE_ID` | Subscription billing |

The original local/demo billing behavior is retained: without Stripe configuration, the checkout route grants demo Premium access. Configure Stripe before offering paid subscriptions. External services need your own valid credentials; the rebrand does not provision them.

## Verify changes

```bash
npm run lint
npx tsc --noEmit
npm run test:setup
npm test
npm run build
npm run ext:build
```

If Chromium is installed in a custom location, set `CHROMIUM_PATH=/absolute/path/to/chromium` before running tests. Tests otherwise use Playwright's browser installation. Browser suites use local fixture pages, not real submissions to employers. See `VERIFICATION.md` for this package's checks and limitations.

## Project contents

- `src/`: web pages, dashboard, API routes, models and shared code.
- `extension/`: editable browser-extension source.
- `dist/`: ready-to-load extension folders and extension ZIP files.
- `brand/`: source artwork and large exports.
- `public/brand/`: web asset exports.
- `scripts/`: asset generation, extension packaging and development utilities.
- `test/`: existing extension, portal, API and UI regression suites.
- `screenshots/`: previews of the rebranded interface.
- `CHANGES.md`: implementation history from the original project.

Inter and Manrope are bundled locally. Their license files accompany the extension font files; npm package licenses accompany the web font dependencies.
