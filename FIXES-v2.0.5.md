# Appli-Fill 2.0.5 — Oracle, major matching, and Ashby validation

## Oracle phone

The national phone-number input is distinguished from the country-code picker even when both share a floating-label container. Telephone autocomplete semantics take priority over dropdown styling. The number inherits the Phone Number question and uses national digits when the selected calling code is separate. Existing manually edited phone numbers remain protected.

## Education and experience dates

Oracle Month/Year controls are grouped as one date despite their separate dropdown toggles. Month, Year and Day prompt text is treated as a placeholder. Date Acquired/Awarded/Conferred/Earned in education maps to the education record's completion date. Both split controls and whole date inputs are supported.

A partial date such as an unanswered Month beside a default 2026 is repaired as a consistent pair from the corresponding saved record. Multiple education and employment records keep their own indices. A manually owned date is preserved rather than combined with a month from another saved date. No missing year or month is invented. An education date is not copied into an unrelated certification date.

## Major / Field of Study

Native and standard custom dropdowns use exact, normalized, abbreviation, subject-family and close-related-subject matching against the saved record. Examples of recognized abbreviations include CS/CSE, IT, MIS, ECE, EEE, MBA and BBA. The closest exact option wins when available. Oracle lookup search uses a suitable subject search term and selects an offered option, rather than leaving uncommitted typed text.

The value remains tied to the corresponding education record. Unrelated or equally ambiguous choices stay available for review. Matching selects a portal option; it does not rewrite the user's profile or claim an unrelated qualification. Generic controls with accessibility-linked question text are supported.

## Ashby validation

Yes/No buttons now receive the pointer/mouse interaction and announced focus/blur sequence used to commit answers to form state. They no longer receive synthetic input/change events carrying an empty button value. Custom dropdown trigger buttons likewise do not overwrite an option's committed value with the trigger's empty value.

Regression checks cover pointer-driven, mouse-driven, click-driven, role-radio and native-radio controls, Yes and No answers, form-state validation on Submit, normal page focus, popup-style focus, and manual changes. Application submission remains manual. Required checks are not disabled and hidden checkboxes are not forced to Yes to bypass validation.

## Update

1. Extract the ZIP.
2. In `chrome://extensions`, reload the extension from `appli-fill/dist/chrome`, or extract `appli-fill/dist/appli-fill-chrome.zip` and load that folder unpacked.
3. Refresh the Oracle/Ashby application tab so it uses the new content script.
4. Sync the saved profile and press Autofill once.

The full web project and Firefox package are included. Verification logs are under `verification/v2.0.5`.

## Verification scope

The final packaged Chrome scripts passed 28 Oracle phone/education/date checks, 22 Ashby submission-state checks and 18 study-matching checks. Cross-portal major fixtures cover Greenhouse, Lever, iCIMS, Workday and a generic form, with native and custom controls. Ashby fixtures render real React components and validate the submitted model. Oracle fixtures use real extension code, dropdown selection handlers, and date/phone models. These are offline tests; no live application was submitted. Firefox package contents were verified; Firefox itself was not launched.
