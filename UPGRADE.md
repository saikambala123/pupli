# Appli-Fill 2.0 upgrade notes

## What changed

- Product name, shared logo, page metadata, emails, documentation and extension display names now use **Appli-Fill**.
- The old lightning-bolt identity is replaced by the supplied gorilla concept, recreated with the Appli-Fill wordmark.
- The marketing site, authentication, workspace navigation, overview, popup and in-page status display use a coordinated orange, turquoise and charcoal design.
- Shared controls, focus styles, responsive layouts, reduced-motion behavior and local fonts are included.
- Favicon, touch icon, web app manifest, maskable icons and Chrome/Firefox assets use purpose-sized exports. The large artwork is available separately at 4K dimensions.
- Extension version is 2.0.0. Existing profiles, application models, API paths and application logic are retained.

## Existing accounts and settings

Use the same database and `JWT_SECRET` as your existing deployment. Changing the database name can make an existing account appear missing; changing the JWT secret signs users out.

The following old identifiers are intentionally recognized or retained to avoid breaking upgrades:

- `zapply_session` and `zapply_oauth_state`: existing cookies are read during transition; new cookies use the Appli-Fill namespace. Logout clears both session cookie names.
- `zapply.popup.view`, `zapplyWelcomed`, `zapplyAutoSubmitAccount`: existing popup preferences can be read. New writes use the new namespace. Old password keys are cleared.
- `ZAPPLY_*` messages: accepted by the background router while open pages transition to the new content script.
- `ZAPPLY_API_BASE`: accepted as a fallback build variable; prefer `APPLI_FILL_API_BASE`.
- `zapply@example.com`: existing Firefox add-on ID, kept so updates retain the add-on identity.
- `https://zapply.vercel.app`: the existing server origin, preserved as the default instead of inventing a new deployment. Set `APPLI_FILL_API_BASE` to your new domain when it exists.

These are compatibility details. Visible product branding uses Appli-Fill.

## Refresh icons after deployment

Reload unpacked extensions in the browser's extension manager. Reload previously open job pages. For a cached installed web shortcut, remove and reinstall the shortcut after deployment. Existing browser-store installs require a store update of the same extension listing.

The web manifest supplies versioned icon URLs. The browser favicon has multiple embedded sizes. Use the supplied files directly; enlarging a 16-pixel icon cannot recover detail.

## Private configuration

The downloadable source package excludes private `.env.local` credentials, build caches and installed dependencies. Preserve your private values in your deployment settings and use `.env.example` for the variable names.
