# Appli-Fill 2.0.1

## Install the update

- For an unpacked Chrome/Edge installation, replace the installed extension with `dist/chrome`, reload it at `chrome://extensions`, and refresh application tabs that were already open.
- Chrome/Edge package: `dist/appli-fill-chrome.zip`.
- Firefox package: `dist/appli-fill-firefox.zip`.
- The web application and deployment configuration remain included in this full project.

## Changes

- Fill known profile fields and saved answers before opening unknown dropdowns for AI option collection.
- Process Workday search prompts as menus even when the DOM control is a text input. Finish other known dropdowns before the referral-source picker.
- Keep the initial AI questions in one batch, overlapping the answer request with source selection and reconciliation.
- Index saved questions and aliases once per response snapshot. Stop searching after an exact primary-question match and avoid fuzzy scans when the profile already supplies the answer.
- Preserve negation, parenthesized conditions, conjunctions, numbers and modal wording when comparing Yes/No questions. Legacy lossy keys and fuzzy overlap cannot replay a binary answer into a different declaration.
- Require the actual question or an explicit saved alias for a binary replay. Conflicting answers require review. Cross-employer replays retain their employer guards and now preserve question polarity.
- Separate work authorization from adjacent sponsorship questions. Correct inverse sponsorship and negated authorization wording, including long Oracle legal prompts.
- Accept explicit boolean or textual authorization/sponsorship values. Citizenship or visa labels alone no longer fabricate these declarations.
- Treat “I have never …” as negative.
- Pick an exact selectable Workday search result as soon as it arrives. Do not wait for a category to produce a selected pill.
- Commit Workday prompt blur/focusout once instead of triggering duplicate validation.

## Verification

See `verification/v2.0.1/RESULTS.md` and the accompanying logs. Tests use offline browser fixtures, not submitted applications or live employer accounts. Unsupported or ambiguous Yes/No questions remain available for manual review.
