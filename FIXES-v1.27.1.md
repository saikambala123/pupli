# Appli-Fill v1.27.1

This update fixes phone formatting and country-code handling, SAP SuccessFactors detection and empty dropdowns, education fields, and security-clearance choices. Work eligibility now includes explicit answers for SMS consent, restrictive employment agreements, termination, and discipline for harassment or workplace violence.

Deploy the updated portal, reload the extension from `dist/chrome` (or install the Firefox package), save the new Work eligibility answers, then use **Sync now** in the extension. The existing portal URL configuration is preserved.

Profile values and saved answers supply factual fields. The existing AI service remains available for supported unanswered questions. Missing consent and personal declarations require the applicant's answer. Fields requiring information absent from both the profile and saved answers may remain unanswered.

No API route, page route, deployment configuration, dependency version, or unrelated feature was changed.

## Verification

| Check | Result |
| --- | --- |
| Production Next.js build | Passed |
| TypeScript (`npx tsc --noEmit`) | Passed |
| Syntax checks for changed extension JavaScript | Passed |
| New schema, normalization and phone helper tests | 57/57 passed on final source |
| Existing API query/data tests | 12/12 passed on final source |
| New offline Chromium screenshot regressions | 57/57 passed before final phone compatibility adjustments |
| Existing regression scripts | Last full run: 63/68 passed; five failures were addressed afterward |
| Final Chromium rerun and local MongoDB integration | Blocked by execution permissions; no final browser or database round trip is claimed |
| ESLint | Existing project has no ESLint configuration; `npm run lint` opens the setup prompt |
| Live employer portals and live Gemini | Not tested |

The five earlier failures covered an unconstrained Workday phone, an ADP international phone, Oracle phone formatting, and older non-compete expectations. The final helper tests cover the phone cases. The related browser tests now require explicit profile/saved non-compete answers instead of assuming or generating an answer.

`verification/` contains the available test logs. To rerun the full suite, install the project dependencies and Chromium, set `CHROMIUM_PATH` to that browser executable, and run `npm test`. The two added tests are included in `npm run ext:test`.

Browser regressions use local fixtures based on the reported form structures. They check field values, change events reaching form state, repeated fills preserving edits, and no application submission. They cannot establish that every employer's current portal works.
