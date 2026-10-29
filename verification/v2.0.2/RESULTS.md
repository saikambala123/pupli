# Verification — Appli-Fill 2.0.2

Date: 27 October 2026

| Check | Result |
| --- | --- |
| Extension spec files | 57/57 passed across the batch and corrective/final reruns |
| New contact/location/screenshot regressions | 22/22 checks passed |
| Profile model and normalization helpers | 61/61 checks passed |
| Portal suites | 189/189 checks passed across 12 suites |
| Oracle Candidate Experience integration | 149/149 checks passed |
| Oracle refreshed phone/address widgets | 47/47 checks passed |
| Oracle classic widgets and questions | 78/78 checks passed |
| ADP Recruiting Management | 140/140 checks passed |
| ADP Workforce Now | 89/89 checks passed |
| ESLint | Passed |
| TypeScript (`tsc --noEmit`) | Passed |
| Next.js production build | Passed |
| Chrome/Firefox packaging | Passed; version 2.0.2 and byte-for-byte final source verified |

## What the new regressions check

- Same-named Greenhouse cities in different states, including adjacent Google Places spans, native city selects, and custom read-only lists.
- A stale saved Location (City) answer cannot override the current profile address. A state/country suggestion cannot replace a city.
- A stale default calling code cannot override the full international number. The code is committed before the national number, including a widget that clears the number when its calling country changes.
- An Oracle code that only looks preselected is selected into the form model. A second fill preserves the committed phone number.
- ADP's `Please Specify` placeholders, asynchronous State -> County choices, two-level source selection, and native race/ethnicity/gender radio markup matching the screenshots.
- County survives the actual Mongoose/BSON serialization path and profile normalization. A known county or exact saved County answer is used; a sole portal-provided choice is allowed; multiple unknown counties are not guessed.
- An unknown city remains blank for review and is excluded from AI generation.

## Test execution and scope

`extension-results.json` lists all 57 final spec outcomes. Each corresponding successful log is in `extension-specs/`. Performance-sensitive specs and a transient fixture-load/capture failure were rerun serially after the batch; no performance thresholds were relaxed. The offline Workday application-question fixture now waits for DOM readiness rather than page-wide resource loading.

The settings regression now expects the current profile city to outrank an old generic saved City answer, while explicitly checking that saved application answers still outrank profile defaults. The Workday phone regression checks the calling code and national number separately.

`portals/` contains all 12 portal-suite logs and their results. Browser tests used offline Chromium fixtures; they did not submit applications or test every live employer tenant. Screenshots supply visual requirements, not the live page DOM.

The new county field requires updating the web portal as well as the extension. If county is absent and the portal offers several counties, enter it in the profile or review that field manually.

A temporary build-only JWT secret was supplied for production verification. No generated secret, node_modules, or Next.js build output is included in the ZIP.
