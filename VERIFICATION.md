# Appli-Fill 2.0.0 verification

Verified 5 October 2026 using Node.js 24 and Chromium 153 in an isolated local environment.

| Check | Result |
| --- | --- |
| Production Next.js build (`npm run build`) | Passed |
| ESLint (`npm run lint`) | Passed, no warnings or errors |
| TypeScript (`npx tsc --noEmit`) | Passed |
| Extension regression suites | All 55 completed successfully |
| Portal fixture suites | All 12 completed successfully |
| API regression checks | 12 passed |
| UI source regression checks | 25 passed |
| Browser sign-out confirmation checks | 9 passed |
| Popup opening, welcome and stable scrolling checks | Passed |
| Pending-answer popup checks after final styling | 16 passed |
| Popup, overlay and global CSS syntax | Passed |
| Chrome and Firefox extension packaging | Passed |
| Manifest file references and icon dimensions | Passed |
| Favicon frames | Verified 16, 32, 48, 64, 128 and 256 pixels |
| Transparent logo export | Verified 4096 × 4096 pixels |
| Banner export | Verified 3840 × 2160 pixels |

## Real local application flows

The production build was run against a fresh local MongoDB instance, using temporary test accounts. No existing user database was used.

- Created an account through the rendered sign-up form and reached the dashboard.
- Loaded overview, profile, applications, saved answers, settings and Premium pages.
- Edited a profile, saved it through the UI, reloaded and verified persistence.
- Generated a pairing code through the dashboard button, redeemed it, and retrieved the extension bootstrap with the issued bearer token.
- Verified that an existing legacy session cookie still opens the dashboard.
- Verified the sign-out confirmation, cancellation, logout, and cleanup of both session cookie names.
- Opened the mobile navigation and closed it with Escape.
- Loaded the icon and web manifest routes successfully.
- Observed no browser JavaScript errors in these flows.

## Visual checks

Reviewed screenshots of the landing page, authentication, dashboard, profile, applications, saved answers, settings, Premium and both popup states. Representative mobile layouts were checked at 390 × 844; desktop at 1440 × 1000; the landing page was also checked at 3840 × 2160. The checked pages had no horizontal document overflow.

Popup screenshots use the project's deterministic extension API fixture. The actual pairing and bootstrap API were verified separately against the running app. Screenshots are in `screenshots/`.

## Scope

Autofill tests run the real extension engine against local fixture pages. They do not submit applications to real employers or establish universal compatibility with changing employer websites. The tests named for live portal layouts reproduce those layouts locally.

External Gemini/Groq requests, Google OAuth, email delivery, payment processing, browser-store publication, operating-system icon caches and a production deployment were not exercised. These retain their existing implementations and need the owner's deployment configuration.

The browser download supplied by Playwright was unavailable in this environment, so the browser suites used Chromium 153 through the supported `CHROMIUM_PATH` override. Local MongoDB was started without a Unix socket for this execution environment. These QA environment adjustments are not required in the deployed web app.

`verification/regression-results.txt` contains the completed regression output; `verification/workspace-results.txt` records the local app checks; `verification/build-results.txt` records the final production build.
