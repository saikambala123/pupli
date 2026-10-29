# Appli-Fill 2.0.3

## Career application fixes

- A career application that also asks for an account password now fills the complete application. The presence of a password no longer makes the whole page a login-only form when the same form has application fields.
- Choose Password and Retype Password use the existing Saved Answer named **Password**, including when Show Password changes an input to text. Without a saved password they remain empty. A combined application is never submitted automatically.
- Autofill accepts the application's Terms of Use checkbox and the Data Privacy Statement dialog shown in the supplied screenshot. It opens the statement, selects Accept, and leaves Apply for the applicant. Cookie banners, marketing offers, Decline and Print are excluded. A terms checkbox manually cleared after autofill stays cleared.
- The default Gender radio labelled No Selection is recognized as unanswered.
- Preferred Language is recognized as an application question rather than a site language switcher.
- SuccessFactors State/Province dropdowns that load after Country are resolved during the same click with a bounded dependency check.
- Ethnicity menus offering only Hispanic/Latino choices use the explicit Hispanic/Latino declaration; race-category menus retain the saved race. Gender identity uses its own explicit profile value when set, otherwise the applicant’s saved gender.

## Profile fields

In **Profile → Work eligibility**, save the answer to **Do you have a minimum education level of high school diploma or GED?** Choose Yes or No; there is no assumed answer. Exact saved answers also work. A university record does not silently create this declaration.

This section also contains other names/aliases, preferred application language, career-profile visibility and job-posting notification preferences for the fields in the screenshots. Gender identity and separate ethnicity are available in EEO. Optional preferences stay unset until chosen.

The profile schema and normalization preserve these fields. Normalization also preserves existing sexual-orientation, transgender and self-identification signature values.

## Explicit N/A instructions

When a question explicitly says to enter, indicate, type, write, use, put or provide N/A, autofill uses the known profile/saved answer first. If no answer is known, it fills N/A in a text field or an offered N/A choice. Linked aria-describedby instructions are supported. A question without that instruction stays available for review. Instructions prohibiting N/A, passwords, numeric fields and date fields do not receive this fallback. Manual edits remain protected.

## Install

1. Deploy the updated web project using the existing environment configuration.
2. In Chrome's extension manager, reload the extension using `dist/chrome`, or extract `dist/appli-fill-chrome.zip` into a folder and load that folder unpacked.
3. Reload the career application page so its content script is version 2.0.3.
4. Save the relevant profile answers, sync the extension, and press Autofill.

Firefox packaging is included in `dist/firefox` and `dist/appli-fill-firefox.zip`.

## Verification scope

The screenshot regressions run the actual extension scripts in offline Chromium forms with DOM change handlers, password confirmation, a delayed privacy dialog, legacy JavaScript policy links, accessibility-linked labels, and a delayed State dropdown. They do not access or submit a live McDonald's application. Logs for this release are in `verification/v2.0.3`.
