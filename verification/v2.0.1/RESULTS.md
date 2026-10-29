# Verification — Appli-Fill 2.0.1

Date: 27 October 2026

| Check | Result |
| --- | --- |
| Extension specs | 56/56 spec files passed across the batch run and corrective/final reruns |
| New answer accuracy and latency regressions | 20/20 checks passed |
| Portal fixtures | 189/189 checks passed across 12 suites |
| Oracle Candidate Experience integration fixture | 149/149 checks passed |
| Workday application questions | 53/53 checks passed |
| Workday source search/tree selection | 18/18 checks passed |
| Workday school prompt | 30/30 checks passed |
| Saved-answer replay/capture | 28/28 checks passed |
| General eligibility wording | 51/51 checks passed |
| Career profile fields | 57/57 checks passed |
| Late-rendered field capture | 9/9 checks passed |
| ESLint | Passed |
| TypeScript (`tsc --noEmit`) | Passed |
| Next.js production build | Passed |
| Chrome and Firefox packaging | Passed; final source matches both packaged folders |

## Scope

Browser tests ran in Chromium against offline portal fixtures. They verify DOM values, portal change/blur handling, selected source pills, dependent controls, answer provenance, and menu ordering. They did not submit real applications or test every live employer tenant.

The initial 56-file batch was followed by corrective reruns of affected specs. `extension-results.json` records the final outcome for every spec; `extension-specs/` contains its successful log. The long Oracle integration spec exceeded the batch runner's three-minute per-file limit and was rerun separately to completion (149/149).

The existing late-fields test originally used a file URL that supplied no job-application context. Its harness now uses an offline careers URL. The corrected harness passes both the original and updated extensions; production capture logic was not changed for that test.

The existing eligibility tests were updated to require explicit authorization/sponsorship declarations instead of inferring them from a citizenship or visa label. The AI timing assertion now verifies that known profile answers finish before unknown-menu option collection.

The production build received a temporary build-only JWT secret. No generated secret, node_modules folder, or Next.js build output is included in the deliverable.
