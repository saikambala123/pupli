# Appli-Fill 2.0.4 — iCIMS

## Fields covered

- Login/email, legal first name, surname, preferred first name, and middle name.
- Phone type and number, including Mobile/Cell/Cellular menu labels.
- Explicit text-message consent from the saved profile.
- Home address type, separate address lines, city, ZIP/postal code, country, and state/province. iForms with plain table-cell labels and a separate label row are supported. An apartment is not duplicated in Address Line 1 when Line 2 exists.
- How did you hear about us and the dependent Please specify menu, including a delayed LinkedIn option after its source category is selected.
- Desired pay currency and amount.
- Employee referral, referrer's first and last name, and employee ID when explicitly saved. Unknown referrer information stays blank, including fields instructing the applicant to leave an unknown ID blank.
- Highest education level and previous-employment question.
- The typed acknowledgement signature and the iCIMS Signature of Applicant checkbox shown in the screenshots, during the explicit Autofill action. Submit Profile is never clicked.

## Embedded application forms

The toolbar action now reaches cross-origin iCIMS application frames and nested inherited-origin about:blank/srcdoc iForms through the extension's runtime channel. Counts are combined across application frames. Frames fill one at a time to preserve dropdown focus. Stop cancels queued frames, and a second concurrent click cannot start a duplicate operation. Unrelated third-party forms are excluded. Page postMessage commands cannot start autofill.

## Profile

Optional referrer first name, last name, and employee ID fields are available under Work eligibility. A saved two-part Referred by name is also supported. No employee ID or other person's name is invented.

## Install

1. Extract this full project ZIP.
2. Reload the extension from `appli-fill/dist/chrome` in `chrome://extensions` (Developer mode), or extract `appli-fill/dist/appli-fill-chrome.zip` and load that extracted folder unpacked.
3. Refresh the iCIMS application page, including an already open iForm, to load the new content scripts.
4. Sync the profile and press Autofill once.

Deploy the included web project to expose the new optional referrer fields in the web profile editor. Firefox packaging is also included in `dist/firefox` and `dist/appli-fill-firefox.zip`.

## Verification

The packaged Chrome extension passed 47 screenshot-form checks, 23 frame-dispatch checks, and the existing 24 iCIMS checks. The frame test uses real Chromium documents on different offline origins and a nested srcdoc iForm, the actual content-script runtime listeners, and the actual service-worker dispatcher with isolated browser-API transport. It checks one fill per frame, aggregate results, manual-edit preservation, unrelated-frame exclusion, forged postMessage rejection, duplicate-click handling, Stop cancellation, and a new click after Stop.

Additional focused regression, profile/schema, lint, TypeScript, and production build checks passed. Logs are in `verification/v2.0.4`. Live iCIMS applications were not submitted. Firefox package integrity was checked; Firefox itself was not launched.
