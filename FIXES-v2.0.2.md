# Appli-Fill 2.0.2 — portal contact fields

## Install

1. Update the web portal from this full project to enable the new County / district profile field.
2. Review your profile's city, state, county, phone number and calling code. A full international phone number takes precedence over a conflicting default calling code.
3. Reload the unpacked Chrome/Edge extension from `dist/chrome`, or use `dist/appli-fill-chrome.zip`. Firefox is in `dist/firefox` and `dist/appli-fill-firefox.zip`.
4. Refresh application tabs that were already open before the extension update, then press Autofill.

## Greenhouse

- Current profile address data takes precedence over stale generic saved City/State/Location answers. Saved answers remain available when that profile value is absent.
- City suggestions are compared using the saved city, state and country, rather than taking the first same-named city.
- Google Places' adjacent city/region spans are read with separators; native and custom city lists use the same geographic matching.
- A city field is never completed with a state/country fallback. Ambiguous matches remain for review.
- Missing address facts are excluded from AI generation.

## Oracle and other phone controls

- Recognize calling-code labels and phone-country control identifiers separately from the phone number.
- Resolve calling codes from explicit international numbers, saved codes, or supported country names when the code is absent. A conflicting default is not joined to another country's international number.
- Commit the calling-code picker before writing the national number. Wait for widgets that recreate their phone input after a calling-country change.
- A visually preselected Oracle code can be selected and committed even when its displayed text already looks correct.
- Preserve committed values on later Fill clicks and respect manually edited calling codes.

## Legacy ADP forms shown in the screenshots

- Treat `— Please Specify —` as an unanswered placeholder.
- Handle asynchronous native State -> County and Candidate Source -> Social Media -> LinkedIn controls in bounded dependency passes within the original click.
- Read native radio options printed beside inputs, with the correct preceding question heading. Race definitions and neighbouring gender/ethnicity groups do not become another option's label.
- Add county to the MongoDB profile model, profile editor, and profile normalization. Use the saved county, an exact saved County answer when the profile has none, or the single county the portal offers. Multiple unknown county choices remain for the applicant.

## Verification

`verification/v2.0.2/RESULTS.md` contains outcomes and links to the test logs. Browser tests use offline fixtures, including forms reflecting the supplied screenshots. No real application was submitted.
