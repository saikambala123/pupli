/**
 * APPLI_FILL CONTENT SCRIPT
 * ---------------------
 * Runs on every page. Decides whether the page is a job application, fills it,
 * captures whatever the user answers by hand, and reports the result.
 *
 * Flow:
 *   detect ATS -> collect fields -> plan every value -> write once
 *   -> reconcile what genuinely failed -> watch for submit -> sync to the API
 *
 * One click is one pass. Earlier builds looped: a first fill, two rescans, an
 * AI pass, a retry pass and a validation pass, each of which called the setter
 * twice per field. On a Workday or SuccessFactors form that meant the same
 * dropdown was opened four or five times, which is what the user saw as
 * flickering — and while several menus were on screen at once, options from
 * one row's list were being scored against the next row's field. Now every
 * value is decided before anything is written, each control is written once,
 * and a dropdown is never opened while another one is still open.
 */

(() => {
  if (window.__applifillLoaded) return;
  window.__applifillLoaded = true;

  const M = window.APPLI_FILL_MATCHER;
  const RULES = window.APPLI_FILL_FIELD_MAP;
  const ATS = window.APPLI_FILL_ATS;
  if (!M || !RULES || !ATS) return;

  const state = {
    session: null,      // { profile, settings, responses, premium }
    adapter: null,
    lastRun: null,
    unmatched: [],      // fields we couldn't answer — watched for manual input
    captured: new Map(),// question -> answer typed by the user
    filling: false,
    profile: null,      // the profile actually used (Premium may pick a different one)
    scoring: null,      // { score, reason, label } from Premium profile scoring
    drafted: new Set(), // elements filled by AI — the user must review these
    engaged: false,     // watchers attached: set once this looks like an application
    duplicate: null,    // a prior application for this posting, if any
    allFields: [],      // everything scanned on the last run
    stopRequested: false,
    manualSessionActive: false,
    completedRun: false,
    runId: 0,           // bumped per click; scopes "already written" to one pass
    // Programmatic writes can cause trusted change/click events after a widget
    // finishes rendering. Keep a short-lived provenance ledger outside the DOM
    // so a Workday/Ashby re-render cannot turn Appli-Fill's own value into a
    // "manual" pending answer simply because the original node was replaced.
    programmaticAnswers: new Map(), // fingerprint -> { answer, expiresAt }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Is this control still on the page?
   *
   * `document.contains` says no for anything inside a shadow root — every box
   * of ADP's application pages is drawn inside one — so each of those was
   * collected, planned and then refused as "gone" before a single write. On
   * ADP's pages `isConnected` answers the same question across shadow roots;
   * every other site is asked exactly as before.
   */
  const attached = (el) => Boolean(el) && (document.contains(el) || Boolean(M.onAdp?.() && el.isConnected));

  /* ================================================================== */
  /*  Messaging                                                          */
  /* ================================================================== */

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res ?? { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type?.startsWith("APPLI_FILL_PENDING")) {
      if (handlePendingCommand(msg, respond)) return true;
    }
    if (msg?.type === "APPLI_FILL_RUN") {
      if (msg.frameDispatch === true) {
        run({ manual: true }).then(respond);
      } else {
        if (window.top !== window) return false;
        send({type: "APPLI_FILL_FILL_TAB"}).then((r) => {
          if (r?.ok) { state.lastRun = r.data; respond(r); }
          else if (r?.error === "Already filling.") respond(r);
          else run({manual: true}).then(respond);
        });
      }
      return true;
    }
    if (msg?.type === "APPLI_FILL_STOP") {
      state.stopRequested = true;
      state.manualSessionActive = false;
      return respond({ ok: true });
    }
    if (msg?.type === "APPLI_FILL_STATUS") {
      respond({
        ok: true,
        isApplication: isApplicationPage(),
        ats: state.adapter?.label ?? null,
        lastRun: state.lastRun,
        duplicate: state.duplicate,
        profileLabel: state.profile?.label ?? null,
      });
      return true;
    }
    return false;
  });

  /* ================================================================== */
  /*  Page classification                                                */
  /* ================================================================== */

  function isApplicationPage() {
    const urlHit = /apply|application|careers?|job|candidate|opening|position|requisition/i.test(location.href) || Boolean(RULES.helpers?.onIcimsPage?.());
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea'
    );
    /**
     * A step made of choices is still an application step.
     *
     * This counted text boxes and nothing else, so a page of radio groups,
     * checkboxes and dropdowns — a demographics step, an eligibility
     * questionnaire, the second page of almost any Workday application —
     * scored zero here, the content script disengaged, and nothing the
     * applicant answered on it was ever recorded.
     */
    const choices = document.querySelectorAll(
      'select, input[type="radio"], input[type="checkbox"], [role="radiogroup"], [role="combobox"], [role="listbox"]'
    );
    const formHit = inputs.length + choices.length >= 3;
    const fileHit = Boolean(document.querySelector('input[type="file"]'));
    const eeoHit = /gender|veteran|disability|ethnicity|race/i.test(document.body?.innerText?.slice(0, 30000) || "");
    return [urlHit, formHit, fileHit, eeoHit].filter(Boolean).length >= 2;
  }

  function isExcluded(settings) {
    const list = settings?.excludedDomains ?? [];
    return list.some((d) => d && location.hostname.includes(d.trim()));
  }

  /* ================================================================== */
  /*  Field collection                                                   */
  /* ================================================================== */

  function collectSearchRoots() {
    const roots = [document];
    const seen = new Set(roots);
    const visit = (root) => {
      try {
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot && !seen.has(el.shadowRoot)) {
            seen.add(el.shadowRoot);
            roots.push(el.shadowRoot);
            visit(el.shadowRoot);
          }
        });
      } catch {}
    };
    visit(document);
    return roots;
  }

  /**
   * Is this hidden control sitting inside a field the applicant can see?
   *
   * A select that a widget has replaced is invisible itself but lives in a
   * visible field wrapper. A select inside a collapsed step or an inactive tab
   * has nothing visible above it either — and filling that would put answers
   * into a part of the form nobody is looking at.
   */
  function hasVisibleHost(el) {
    let node = el.parentElement;
    for (let d = 0; node && d < 6; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const style = getComputedStyle(node);
      // An ancestor that is switched off takes the whole region with it. The
      // visible page further up does not make this control reachable.
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  /** Rule keys that belong to a repeated Work Experience / Education block. */
  const EXPERIENCE_KEYS = new Set([
    "currentCompany", "currentTitle", "employmentType", "experienceLocation",
    "experienceLocationType", "responsibilities", "experienceStartDate",
    "experienceEndDate", "experienceStartMonth", "experienceStartYear",
    "experienceEndMonth", "experienceEndYear", "experienceDatePart", "currentJob",
    "experienceCountry", "experienceState", "experienceCity",
  ]);
  const EDUCATION_KEYS = new Set([
    "school", "degree", "fieldOfStudy", "educationLocation", "gpa",
    "graduationDate", "educationStartMonth", "educationStartYear",
    "educationEndMonth", "educationEndYear", "educationDatePart",
    "educationStartDate", "educationEndDate", "educationType", "educationCountry", "educationState", "educationCity",
  ]);

  /** Positional history rows: always the profile's nth entry, never a saved answer. */
  const ROW_KEYS = new Set([...EXPERIENCE_KEYS, ...EDUCATION_KEYS]);

  /**
   * Profile-only questions the applicant must answer themselves when the
   * profile is silent. They are highlighted rather than silently skipped, and
   * they are never handed to the answer model.
   */
  const ELIGIBILITY_KEYS = new Set([
    "over18", "under18", "previouslyEmployed", "relativesEmployed", "authorizedToWork", "requireSponsorship", "visaStatus",
    "willingToRelocate", "willingToDrugTest", "willingToBackgroundCheck", "usCitizen",
    "highSchoolDiplomaOrGED", "profileVisibility", "jobNotifications", "textMessageConsent", "restrictiveCovenant", "employmentTermination", "workplaceMisconduct", "securityClearance",
  ]);

  /**
   * Profile-only questions that name the hiring company — "Have you worked for
   * Acme?", "Do you have relatives employed by Acme?". When the profile leaves
   * one unanswered, the applicant's own saved answer to the same question as
   * another company asked it is used (see `savedAnswerAcrossEmployers`): the
   * words are the same, only the company differs.
   */
  const SAVED_ACROSS_EMPLOYER_KEYS = new Set(["previouslyEmployed", "relativesEmployed"]);

  /** Places, which a type-to-search box only accepts as one of its suggestions. */
  const PLACE_SEARCH_KEYS = new Set(["location", "city", "experienceLocation", "educationLocation"]);

  /** Parts of the address a page fills itself once the street or ZIP Code is picked. */
  const PAGE_FILLED_KEYS = new Set(["zip", "city", "state", "county", "country", "taxDistrict"]);

  /** The parts Oracle fills from the address picked in Address Line 1. */
  const STREET_FILLED_KEYS = new Set(["zip", "city", "state", "county", "taxDistrict"]);

  /**
   * The Address Line 1 that suggests whole addresses, in an Oracle Recruiting
   * address this box belongs to — or null.
   *
   * Picking the applicant's address there fills ZIP Code, City, State and
   * County. Typing into those as well is what the applicant asked never to
   * happen: it is text Oracle throws away unless it is picked from a list, and
   * it raced the address pick. They are left for the page to fill.
   */
  function streetBoxFor(el) {
    if (state.adapter?.key !== "oraclehcm" || !el) return null;
    let scope = null;
    try { scope = el.closest("apply-flow-block, section, form, [class*='apply-flow-block']") || document; } catch { scope = document; }
    let boxes = [];
    try { boxes = Array.from(scope.querySelectorAll('input[role="combobox"], input[aria-autocomplete="list"], input[aria-autocomplete="both"], input.cx-select-input, input.oj-searchselect-input')); } catch {}
    return boxes.find((box) => {
      if (box === el || !M.acceptsText?.(box) || !(M.looksLikeTypeahead?.(box) || M.isOracleSelect?.(box))) return false;
      const own = `${box.getAttribute("name") || ""} ${box.id || ""}`;
      if (/address\s*-?_?line\s*-?_?1|addressline1|address1\b/i.test(own)) return true;
      let label = "";
      try { label = String(M.deriveLabel?.(box) || "").split("|")[0]; } catch {}
      return /\baddress\s*(line\s*)?1\b|\bstreet\b/i.test(label);
    }) || null;
  }

  function streetFillsRest(el) {
    return Boolean(streetBoxFor(el));
  }

  /** Was an address picked in this street box by this fill? */
  function streetPickedThisRun(box) {
    const mine = box?.__applifillStreetPick;
    return Boolean(mine && mine.run === state.runId && mine.picked);
  }

  /** Contact and identity boxes, recognised by their own printed label. */
  const PROTECTED_LABEL_RE =
    /\b(e-?mail|phone|mobile|telephone|country\s*code|area\s*code|extension|first\s*name|last\s*name|middle\s*name|full\s*name|date\s*of\s*birth|address\s*line|postal|zip\s*code)\b/i;

  /**
   * Keys that appear more than once inside a *single* row, so they can never
   * mark where one row ends and the next begins.
   *
   * One job has two dates, and on Workday each of those is two more boxes —
   * `MM` and `YYYY`. The row finder picks the repeated key with the most
   * occurrences when no Company or Title is available, so on a form with one
   * job it chose the date parts, read the four date boxes as four separate
   * jobs, and asked the profile for jobs 2, 3 and 4. There are none, so `To`
   * was planned as blank and left blank — a required field the applicant then
   * had to fill in by hand on every Workday application.
   */
  const MULTI_PER_ROW_KEYS = new Set([
    "experienceStartDate", "experienceEndDate", "experienceDatePart",
    "experienceStartMonth", "experienceStartYear", "experienceEndMonth", "experienceEndYear",
    "graduationDate", "educationDatePart",
    "educationStartMonth", "educationStartYear", "educationEndMonth", "educationEndYear",
    "educationStartDate", "educationEndDate",
  ]);

  /**
   * Works out which repeated block each field belongs to.
   *
   * A numbered section heading is authoritative when the page provides one
   * ("Work Experience 2", "Professional Experience (1)"). Greenhouse and Oracle
   * provide nothing, so the rows are instead derived from the anchor field —
   * the Company or School box, which appears exactly once per entry — and every
   * other field is indexed by which anchor's container encloses it.
   *
   * Counting each rule key's occurrences, as the previous build did, silently
   * mis-numbered any form where the fields were not in a tidy repeating order,
   * which is why the wrong employer and the wrong dates were showing up.
   */
  function assignRowIndexes(fields, keys, anchorPreference) {
    const family = fields.filter((f) => keys.has(f.rule?.key));
    if (!family.length) return;

    // Repeated DOM rows are more reliable than a section heading. A page often
    // has one outer "Work Experience" heading plus several cloned rows, so
    // treating that outer heading as authoritative can give every row index 0.
    // Once that happens the profile's first role is copied into every row.
    const counts = new Map();
    family.forEach((f) => counts.set(f.rule.key, (counts.get(f.rule.key) || 0) + 1));
    const anchorKey =
      anchorPreference.find((k) => (counts.get(k) || 0) > 1) ||
      [...counts.entries()].sort((a, b) => b[1] - a[1])
        .find(([key, n]) => n > 1 && !MULTI_PER_ROW_KEYS.has(key))?.[0];

    let anchored = false;
    if (anchorKey) {
      const anchors = family.filter((f) => f.rule.key === anchorKey).map((f) => placeOf(f.el));
      const rows = M.rowsFromAnchors(anchors);
      if (rows.length >= 2) {
        anchored = true;
        const numbering = rowNumbering(rows, family);
        family.forEach((field) => {
          const i = rows.findIndex((row) => row.contains(placeOf(field.el)));
          if (i >= 0) field.index = numbering[i];
        });
      }
    }

    // Headings are the fallback for fields that are outside the repeated row
    // container (for example an isolated "Currently employed" control).
    // Never overwrite an index already established by the real row.
    for (const field of family) {
      if (Number.isInteger(field.index)) continue;
      const fromHeading = M.sectionContext?.(field.el)?.index;
      if (Number.isInteger(fromHeading)) field.index = fromHeading;
    }

    const unresolved = family.filter((f) => !Number.isInteger(f.index));
    if (!unresolved.length) { reconcileRows(family); return; }

    if (!anchored) {
      unresolved.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
      reconcileRows(family);
      return;
    }

    // If a field is in an anchored family but could not be placed, use the
    // nearest row's index instead of falling back to role 0. This keeps a
    // missing widget from stealing the first job's value.
    const rows = M.rowsFromAnchors(
      family.filter((f) => f.rule.key === anchorKey).map((f) => placeOf(f.el))
    );
    unresolved.forEach((field) => {
      const i = rows.findIndex((row) => row.contains(placeOf(field.el)));
      if (i >= 0) field.index = i;
    });

    // Truly isolated fields have no row context; only then is index 0 safe.
    unresolved.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
    reconcileRows(family);
  }

  /**
   * Which entry of the profile each row stands for.
   *
   * Normally that is simply the row's position on the page. But a page can
   * carry two separate repeated families — "Work Experience 1/2" followed by
   * "Professional Experience (1)/(2)" — and counting straight through them made
   * the first row of the second family the *third* job. The profile has two, so
   * the lookup returned nothing and every box in that section, dates included,
   * was left blank.
   *
   * Rows are grouped by the wording of the heading above them, ignoring its
   * number, and counted within that group. A page with one heading and several
   * cloned rows underneath has a single group, so it is unaffected.
   */
  function rowNumbering(rows, family) {
    const positional = rows.map((_, i) => i);

    const stemOf = (row) => {
      const inside = family.find((f) => row.contains(placeOf(f.el)));
      if (!inside) return "";
      let title = "";
      try { title = M.sectionContext?.(inside.el)?.title || ""; } catch { return ""; }
      // "Professional Experience (2)" and "Professional Experience (1)" are the
      // same section; the number is what tells the rows apart, not the family.
      return title.toLowerCase().replace(/[^a-z]+/g, " ").trim();
    };

    const stems = rows.map(stemOf);
    if (stems.some((s) => !s)) return positional;
    if (new Set(stems).size < 2) return positional;

    const seen = new Map();
    return stems.map((stem) => {
      const n = seen.get(stem) ?? 0;
      seen.set(stem, n + 1);
      return n;
    });
  }

  /**
   * Every field in one row must carry the same index.
   *
   * Indexes are worked out per field, from whichever numbered heading each one
   * happens to resolve to. Two boxes sitting in the same row can resolve
   * differently — a heading nested one level deeper, a wrapper that breaks the
   * ancestor walk — and then one field reads row 2 of the profile while the box
   * beside it reads row 3. Where row 3 does not exist the lookup returns nothing
   * and that single box is left blank, which is the Job Title empty beside a
   * Company that filled from the same entry.
   *
   * The fields are grouped by the container they actually share and the row is
   * given one index: the one most of its fields agree on, falling back to the
   * row's position on the page. Disagreement inside a row is always a
   * resolution error, never a real difference — a row describes one job.
   */
  function reconcileRows(family) {
    const groups = new Map();
    for (const field of family) {
      const row = rowContainerOf(field.el, family);
      if (!row) continue;
      if (!groups.has(row)) groups.set(row, []);
      groups.get(row).push(field);
    }
    if (groups.size < 2) return;

    // Page order decides the fallback numbering.
    const ordered = [...groups.entries()].sort((a, b) => {
      const pos = a[0].compareDocumentPosition(b[0]);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });

    ordered.forEach(([, members], ordinal) => {
      const votes = new Map();
      members.forEach((f) => {
        if (!Number.isInteger(f.index)) return;
        votes.set(f.index, (votes.get(f.index) || 0) + 1);
      });
      let agreed = ordinal;
      let best = 0;
      for (const [value, count] of votes) {
        if (count > best) { best = count; agreed = value; }
      }
      members.forEach((f) => { f.index = agreed; });
    });
  }

  /**
   * Where a control sits in the page's own structure. A box drawn inside one
   * of ADP's components (`sdf-input`) is placed by the component: no row on
   * the page `contains` the box itself. Elsewhere, the control itself.
   */
  function placeOf(el) {
    try { return (M.onAdp?.() && M.pageHost?.(el)) || el; } catch { return el; }
  }

  /** The smallest ancestor that holds this field and no other row's fields. */
  function rowContainerOf(el, family) {
    let node = placeOf(el).parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const inside = family.filter((f) => node.contains(placeOf(f.el)));
      // A row holds several of the row's own fields but not all of them.
      if (inside.length >= 2 && inside.length < family.length) return node;
    }
    return null;
  }

  /** Controls a person could actually answer — used to size up a candidate root. */
  const ANSWERABLE_PROBE =
    'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]), ' +
    'textarea, select, [role="combobox"], [role="radio"], [role="checkbox"], [contenteditable="true"]';

  /**
   * Regions that are never the application itself: the site's own search box,
   * a newsletter signup, a cookie banner, a login widget. These are excluded
   * from the scan so widening it never means answering the page's furniture.
   */
  const PAGE_CHROME_RE =
    /(^|[\s\-_])(site-?search|searchform|search-?form|newsletter|subscribe|cookie|consent|gdpr|login|log-?in|sign-?in|signin|locale|language|currency|promo-?code|coupon|chat|livechat|support-?widget)([\s\-_]|$)/i;

  /** A button that changes the form rather than answering a question. */
  const ACTION_BUTTON_RE =
    /^(add|remove|delete|save|next|back|previous|continue|submit|upload|browse|attach|edit|cancel|close|clear|reset|sign\s*in|log\s*in|apply|search|skip|done|finish)\b/i;

  /**
   * A date's calendar button. It opens a picker, not a list of answers: the
   * date is written into its MM / DD / YYYY boxes, never through it.
   */
  function isCalendarButton(el) {
    try {
      const machine = `${el.getAttribute("data-automation-id") || ""} ${typeof el.className === "string" ? el.className : ""}`;
      if (/dateicon|date-?picker|calendar/i.test(machine)) return true;
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") || M.visibleText?.(el) || "").trim();
      return /^(open\s+)?(calendar|date\s*picker|choose\s+(a\s+)?date|pick\s+a\s+date)\b/i.test(name);
    } catch {
      return false;
    }
  }

  function isActionButton(el) {
    try {
      if (isCalendarButton(el)) return true;
      const name = (M.visibleText?.(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      return name ? ACTION_BUTTON_RE.test(name) : false;
    } catch {
      return false;
    }
  }

  /**
   * The résumé box, and every control that drives it.
   *
   * An upload is the one part of an application the fill never touches. The
   * file input itself was already skipped, but the *button* that opens it was
   * not: Workday's "Select files" carries `data-automation-id="select-files"`,
   * which the dropdown test reads as a select. It was collected as a menu,
   * outlined as a question needing an answer, and — whenever a saved or drafted
   * answer was found for it — clicked, which opens the operating system's file
   * chooser in the middle of a fill. None of it is collected now.
   */
  const UPLOAD_HINT_RE =
    /\b(select[\s_-]*files?|choose[\s_-]*files?|upload\w*|browse|attach(ment)?s?|drop[\s_-]*(zone|files?|here)|file[\s_-]*(upload|input|picker|drop|chooser))\b|select-?files|file-?upload|dropzone/i;

  const UPLOAD_WIDGET_SEL =
    '[data-automation-id*="file-upload" i], [data-automation-id*="attachments" i], [data-automation-id*="dropzone" i], ' +
    '[data-automation-id*="resumeSection" i], [class*="dropzone" i], [class*="drop-zone" i], [class*="file-upload" i], [class*="fileupload" i]';

  function isUploadControl(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "file") return true;
      if (M.opensFilePicker?.(el)) return true;
      const tag = el.tagName;
      const role = el.getAttribute?.("role");
      const clickable =
        tag === "BUTTON" || tag === "A" || tag === "LABEL" || role === "button" ||
        (tag === "INPUT" && /^(button|submit)$/i.test(String(el.type)));
      if (!clickable) return false;
      const hint = [
        el.getAttribute?.("data-automation-id"), el.id, el.getAttribute?.("name"),
        typeof el.className === "string" ? el.className : "",
        el.getAttribute?.("aria-label"), el.getAttribute?.("title"),
        String(el.textContent || "").slice(0, 80),
      ].filter(Boolean).join(" ");
      if (UPLOAD_HINT_RE.test(hint)) return true;
      if (el.closest?.(UPLOAD_WIDGET_SEL)) return true;
      // A button in a small wrapper beside a file input is that input's trigger.
      const box = el.parentElement;
      if (box?.querySelector?.('input[type="file" i]') &&
          box.querySelectorAll("button, [role='button']").length <= 3) return true;
      return false;
    } catch {
      return false;
    }
  }

  function looksLikePageChrome(root) {
    if (!root || root === document || root.nodeType === 11) return false;
    if (root.getAttribute?.("role") === "search") return true;
    const hint = [
      root.getAttribute?.("id"), root.getAttribute?.("name"), root.getAttribute?.("class"),
      root.getAttribute?.("aria-label"), root.getAttribute?.("action"), root.getAttribute?.("data-testid"),
    ].filter(Boolean).join(" ");
    return hint ? PAGE_CHROME_RE.test(hint) : false;
  }

  /** Is this individual control part of the page furniture rather than the form? */
  function inPageChrome(el) {
    try {
      if (el.closest?.('[role="search"]')) return true;
      const form = el.closest?.("form");
      if (form && looksLikePageChrome(form)) return true;
      const self = [
        el.getAttribute?.("name"), el.id, el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
      ].filter(Boolean).join(" ");
      if (!self || !PAGE_CHROME_RE.test(self)) return false;
      if (RULES.helpers?.onIcimsPage?.() && !el.closest("header, nav, footer")) {
        const own = String(M.deriveLabel(el) || "").split("|")[0].trim();
        if (/^(?:email\s+address|signature\s+of\s+(?:the\s+)?applicant)$/i.test(own)) return false;
      }
      // The applicant's Preferred Language is a required career-profile
      // question, even when the underlying select is simply named language.
      const ownLabels = [Array.from(el.labels || []).map((label) => M.visibleText(label)).join(" "), el.getAttribute("aria-label")];
      for (const attr of ["aria-labelledby", "aria-describedby"]) {
        for (const id of (el.getAttribute(attr) || "").split(/\s+/)) ownLabels.push(M.visibleText(document.getElementById(id)));
      }
      if (!el.closest?.("header, nav, footer, [role='navigation']") &&
          ownLabels.some((label) => /^\s*(?:preferred\s+language|language\s+preference)\s*[:*]?\s*$/i.test(label || ""))) return false;
      // The currency of a desired salary — Workforce Now's "Select Currency
      // Type", beside the amount — is a question on the application, not a
      // shop's currency switcher. It was passed over, and never answered.
      if (/currenc/i.test(self) && !PAGE_CHROME_RE.test(self.replace(/currenc(y|ies)/gi, " ")) && salaryNearby(el)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Does this control sit with a salary or pay question (its own name, or the block around it)? */
  function salaryNearby(el) {
    const SALARY_RE = /\b(salary|salaries|compensation|pay|wages?|rate|remuneration|ctc)\b|salary|compensation/i;
    const own = [el.getAttribute?.("name"), el.id, el.getAttribute?.("aria-label"), el.getAttribute?.("data-model")]
      .filter(Boolean).join(" ");
    if (SALARY_RE.test(own)) return true;
    // The words around the control, not the control's own (a list of every
    // currency is long enough to hide the question beside it).
    let inner = (M.onAdp?.() && M.pageHost?.(el)) || el;
    for (let depth = 0; inner && depth < 4; depth++) {
      const parent = inner.parentElement || (inner.getRootNode?.() instanceof ShadowRoot ? inner.getRootNode().host : null);
      if (!parent || parent === document.body || parent === document.documentElement) break;
      let text = "";
      for (const child of Array.from(parent.children)) {
        if (child === inner || child.contains(inner)) continue;
        text += ` ${child.textContent || ""}`;
        if (text.length > 1500) break;
      }
      if (SALARY_RE.test(text.slice(0, 1500))) return true;
      // Past the question's own block and into the whole page: stop looking.
      if (text.length > 1500) break;
      inner = parent;
    }
    return false;
  }

  function countAnswerable(root) {
    let n = 0;
    try {
      root.querySelectorAll(ANSWERABLE_PROBE).forEach((el) => {
        if (el.disabled || el.type === "hidden") return;
        if (inPageChrome(el)) return;
        if (M.isFillable(el) || (el.tagName === "SELECT" && hasVisibleHost(el))) n++;
      });
    } catch {}
    return n;
  }

  /**
   * Where to look for the application.
   *
   * The adapter's `formSelector` used to win outright: whatever it matched
   * became the entire search area, and the whole document was consulted only
   * when it matched nothing at all. On a portal that renders its application
   * outside any <form> — most React and Vue career sites — the one <form> on
   * the page is usually the header search box, so the scan found a single
   * search input and the profile went completely unused. That is the "profile
   * data isn't used on some applications" report.
   *
   * The matched forms are now checked against the rest of the page before they
   * are trusted: they are used as the scope only when they actually hold the
   * bulk of what a person has to answer. Otherwise the scan widens to the full
   * document, minus the site's own widgets.
   */
  function chooseScanRoots(adapter, searchRoots) {
    const matched = [];
    for (const root of searchRoots) {
      try {
        root.querySelectorAll(adapter.formSelector || "form").forEach((form) => {
          if (!looksLikePageChrome(form)) matched.push(form);
        });
      } catch {}
    }
    if (!matched.length) return searchRoots;

    const inside = matched.reduce((n, root) => n + countAnswerable(root), 0);
    const onPage = searchRoots.reduce((n, root) => n + countAnswerable(root), 0);

    // The matched forms hold most of the answerable controls, so they are the
    // application. Scoping to them keeps unrelated widgets out of the results.
    if (inside >= 3 && inside >= onPage * 0.6) return matched;

    // Most of the form lives outside what matched. Widen rather than fill
    // nothing — a few extra highlighted fields beat an untouched application.
    return searchRoots;
  }

  /**
   * Put back anything the page threw away after the fill.
   *
   * Portals that hydrate after first paint re-render their sections from their
   * own model, which is still empty, and every value written before that
   * finished is wiped. The fill has already reported success by then and never
   * looks again, so the applicant reaches Next and is told the fields are
   * required — first and last name most often, because they are at the top and
   * therefore filled earliest.
   *
   * Two short passes are enough for the frameworks in play. A field is only
   * restored while it is genuinely empty, never after the applicant has touched
   * it, and never more than twice — so this cannot turn into the fill
   * repeatedly rewriting the form.
   */
  const SETTLE_DELAYS = [900, 2200];
  const MAX_SETTLE_FIXES = 2;

  /**
   * Repair a value the page is rejecting, whenever it starts rejecting it.
   *
   * The settle passes above run 900ms and 2200ms after a fill. Workday does not
   * validate then — it validates when Save & Continue is pressed, which may be
   * several minutes later, and only then renders "The field First Name is
   * required and must have a value" under a box plainly containing "Pradeep".
   * By that point nothing was watching, so the value was never committed and
   * the applicant had to retype it by hand.
   *
   * This watches for error markup appearing at any time and re-commits only the
   * fields Appli-Fill wrote, only while they still hold what Appli-Fill wrote, and at
   * most three times each. It cannot touch a field the applicant has edited and
   * it never fills anything that was not already filled, so it stays a repair
   * and never becomes a second autofill.
   */
  const MAX_REPAIRS = 3;
  let repairTimer = null;

  /**
   * Write a value again as Appli-Fill, not as "somebody".
   *
   * The repair and settle passes retyped values with no programmatic window
   * around them, and the browser reports `insertText` as trusted input — so a
   * restored field was marked edited by hand, and anything the page did to it
   * afterwards could be offered in Pending Saved Answers as the applicant's.
   */
  function retypeOwn(record, el) {
    beginProgrammatic(el);
    beginWrite();
    let ok = false;
    try { ok = M.retypeValue(el, record.value); } catch { ok = false; }
    finally { endWrite(); }
    let settled = "";
    try { settled = String(readValue(record.field) ?? "").trim(); } catch {}
    const at = Date.now();
    eachInGroup(el, (member) => {
      member.__applifillWrittenAt = at;
      member.__applifillUserEdited = false;
      if (settled) member.__applifillBaselineValue = settled;
    });
    if (settled) rememberWrittenForm(el, settled);
    setTimeout(() => endProgrammatic(el), 0);
    return ok;
  }

  /**
   * Does the box still show the very text that was planned for it?
   *
   * A retype writes the planned text again. That is only a repair while the
   * box shows that text; once the page has replaced it with something of its
   * own — Oracle's picked address "1200 HARBOR VIEW DR" in place of the typed
   * "1200 Harbor View Dr Apt 305" — writing the plan again undoes the pick.
   */
  function showsPlannedText(el, record) {
    const shown = M.norm(String(el.value ?? el.textContent ?? ""));
    const planned = M.norm(String(record?.value ?? ""));
    if (!shown || !planned) return false;
    if (shown === planned) return true;
    const digits = (s) => s.replace(/\D+/g, "");
    return digits(planned).length >= 7 && digits(shown) === digits(planned);
  }

  function repairFlaggedFields() {
    if (state.filling || state.stopRequested) return;
    for (const [el, record] of Array.from(state.applied ?? new Map())) {
      try {
        if (!attached(el)) { state.applied.delete(el); continue; }
        if (el.__applifillUserEdited) continue;
        if ((el.__applifillRepairs ?? 0) >= MAX_REPAIRS) continue;
        if (!M.flaggedInvalid?.(el)) continue;
        // Only if the box still holds what we put there. Anything else is the
        // applicant's, or the page's, and is not ours to overwrite.
        if (!M.hasValue(el) || !matchesWritten(el, String(readValue(record.field) ?? ""))) continue;
        if (typeof record.value === "string" && !showsPlannedText(el, record)) continue;
        // A type-to-search box takes a picked suggestion, never retyped text.
        if (M.looksLikeTypeahead?.(el)) continue;

        el.__applifillRepairs = (el.__applifillRepairs ?? 0) + 1;
        retypeOwn(record, el);
      } catch {}
    }
  }

  function watchValidation() {
    const ping = () => {
      clearTimeout(repairTimer);
      repairTimer = setTimeout(repairFlaggedFields, 400);
    };
    try {
      new MutationObserver((records) => {
        for (const r of records) {
          // Only wake up for something that looks like a validation message.
          const touched = [...(r.addedNodes ?? [])];
          if (r.type === "attributes" && r.attributeName === "aria-invalid") return ping();
          for (const node of touched) {
            const text = node.textContent || "";
            if (/\b(is required|must have a value|invalid|cannot be blank)\b/i.test(text)) return ping();
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-invalid"],
      });
    } catch {}
  }

  function scheduleSettleCheck() {
    if (state.settleScheduled) return;
    state.settleScheduled = true;
    SETTLE_DELAYS.forEach((delay) => setTimeout(() => { settlePass(); }, delay));
  }

  async function settlePass() {
    if (state.filling || state.stopRequested) return;
    const entries = Array.from(state.applied ?? new Map());
    if (!entries.length) return;

    let restored = 0;
    for (const [el, record] of entries) {
      if (state.stopRequested) break;
      if (!attached(el)) { state.applied.delete(el); continue; }
      if (el.__applifillUserEdited) continue;
      if (!record.readable) continue;
      if (el.__applifillNoMatch) continue;
      if ((el.__applifillSettleFixes ?? 0) >= MAX_SETTLE_FIXES) continue;

      let holds = true;
      try { holds = M.hasValue(el); } catch {}

      // The value is still in the box, but the page has flagged the field as
      // required or invalid anyway — it took the text and never registered it.
      // That is the "Address Line 1 is required" seen with the address plainly
      // in the box. Writing it again through a clear-then-set transition is
      // what gets it into the page's own model.
      if (holds) {
        if (!M.flaggedInvalid?.(el)) continue;
        if (typeof record.value === "string" && !showsPlannedText(el, record)) continue;
        if (M.looksLikeTypeahead?.(el)) continue;
        el.__applifillSettleFixes = (el.__applifillSettleFixes ?? 0) + 1;
        try { if (retypeOwn(record, el)) restored++; } catch {}
        continue;
      }

      el.__applifillSettleFixes = (el.__applifillSettleFixes ?? 0) + 1;
      // The element was cleared by a re-render, so the guards that stop a field
      // being written twice in one pass have to be released for this one write.
      el.__applifillWrittenRun = null;
      try {
        state.filling = true;
        if (await applyValue(record.field, record.value, record.rule)) restored++;
      } catch {
      } finally {
        state.filling = false;
      }
    }

    if (restored) {
      state.lastRun = { ...(state.lastRun ?? {}), restored: (state.lastRun?.restored ?? 0) + restored };
      if ((state.session?.settings ?? {}).showOverlay !== false) {
        try {
          overlay.show({
            tone: "partial",
            title: `Restored ${restored} field${restored === 1 ? "" : "s"}`,
            body: "The page cleared them while it finished loading. Check them before submitting.",
          });
        } catch {}
      }
    }
  }

  /**
   * Workday account settings. Passwords are intentionally read from the
   * dashboard Saved Answers list only; the extension has no separate password
   * input or browser-local password fallback.
   */
  async function getAccountSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["applifillAutoSubmitAccount", "zapplyAutoSubmitAccount"], (r) => resolve({ applifillAutoSubmitAccount: r?.applifillAutoSubmitAccount ?? r?.zapplyAutoSubmitAccount }));
      } catch {
        resolve({});
      }
    });
  }

  /** Every visible, fillable password box on the page — one for sign-in, two for create-account. */
  function isPasswordControl(el) {
    if (el?.tagName !== "INPUT") return false;
    if (el.type === "password") return true;
    if (!["text", ""].includes(el.type)) return false;
    if (/^(?:current|new)-password$/i.test(el.autocomplete || "")) return true;
    const references = (attr) => (el.getAttribute(attr) || "").split(/\s+/)
      .map((id) => M.visibleText(document.getElementById(id))).filter(Boolean);
    const label = [
        el.name, el.id, el.getAttribute("aria-label"),
        Array.from(el.labels || []).map((label) => M.visibleText(label)).join(" "),
        ...references("aria-labelledby"),
        ...references("aria-describedby").filter((text) => /^(?:(?:choose|enter|retype|re.?enter|confirm|verify|repeat|new|your|account)\s+)*(?:password|pass\s+word|passcode)(?:\s+(?:again|confirmation))?[:*]?\s*$/i.test(text)),
      ].filter(Boolean).join(" ").replace(/[_-]/g, " ");
    return /\b(?:password|pass\s+word|passcode)\b/i.test(label) &&
      !/\b(?:hint|requirements?|strength|security\s+question|recovery\s+answer)\b/i.test(label);
  }

  function passwordFields() {
    return Array.from(document.querySelectorAll("input")).filter((el) => isPasswordControl(el) && M.isFillable(el));
  }

  /**
   * Looks the page's own password field(s) up in the saved-answers list —
   * exactly the mechanism every other field uses (findSavedAnswer below), so
   * a response saved under a question like "Password" is reused here the same
   * way a saved "Phone number" is reused on any other form. Only a field the
   * page itself is asking is checked, in whichever order they appear, so a
   * "Confirm password" box has the same chance to match as "Password" does.
   */
  function resolveSavedPassword() {
    for (const el of passwordFields()) {
      const field = { el, label: M.deriveLabel(el), kind: "text" };
      const hit = findSavedAnswer(field);
      if (hit?.answer) return hit.answer;
    }
    // "Choose Password" and "Retype Password" may share no exact saved
    // label. Both are the same applicant-held secret named "Password".
    const el = passwordFields()[0];
    if (el) {
      const hit = findSavedAnswer({el, label: "Password", kind: "text"}, {exactOnly: true});
      if (hit?.answer) return hit.answer;
    }
    return null;
  }

  /**
   * Written the way every other answer is written.
   *
   * The password boxes were set directly, skipping the bookkeeping that marks
   * a value as Appli-Fill's — so the change listener saw a password appear with no
   * record of Appli-Fill writing it, and if the applicant had clicked into the box
   * first, "Password" and "Verify New Password" were offered back in Pending as
   * answers they had typed by hand.
   */
  async function fillAccountPasswordFields(password) {
    let filled = 0;
    for (const el of passwordFields()) {
      if (el.__applifillUserEdited || M.hasValue(el)) continue;
      let label = "";
      try { label = M.deriveLabel(el); } catch {}
      const field = { el, label, kind: "text", rule: null };
      try {
        if (await applyValue(field, password, null)) filled++;
      } catch {}
    }
    return filled;
  }

  /**
   * A box the account form needs ticked before it will submit — "I consent",
   * "I agree to the terms" — that is still clear. Consent is the applicant's
   * to give, so the form is not submitted for them while one is waiting;
   * clicking Create Account anyway only produced "Please check the box to
   * continue".
   */
  function consentStillNeeded() {
    const scope = passwordFields()[0]?.closest("form, [role='main'], [data-automation-id='shellRootRouterOutlet']") || document;
    const boxes = Array.from(scope.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter((box) => {
      try { return M.isFillable(box) || box.getBoundingClientRect().width > 0; } catch { return false; }
    });
    return boxes.some((box) => {
      const ticked = box.checked === true || box.getAttribute("aria-checked") === "true";
      if (ticked) return false;
      let text = "";
      try { text = String(M.deriveLabel(box) || ""); } catch {}
      const required = box.required || box.getAttribute("aria-required") === "true" ||
        /\b(consent|agree|accept|terms|privacy|acknowledge)\b/i.test(text);
      return required;
    });
  }

  /**
   * The button that actually submits the sign-in or create-account form.
   * Workday tags these with data-automation-id; everything else falls back to
   * matching the button's own text, scoped to the form the password lives in
   * so a "Forgot password?" or "Back" link is never mistaken for it.
   */
  function findAccountSubmitButton() {
    const scope = passwordFields()[0]?.closest("form, [role='main'], [data-automation-id='shellRootRouterOutlet'], body") || document;
    const candidates = Array.from(
      scope.querySelectorAll(
        "button[data-automation-id='createAccountSubmitButton'], button[data-automation-id='signInSubmitButton'], " +
        "button[data-automation-id*='submit'], button[type='submit'], input[type='submit'], [role='button']"
      )
    );
    return candidates.find((el) => {
      if (!M.isFillable(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      return /create account|sign in|log in|continue|submit|next/.test(t);
    }) || null;
  }

  /**
   * Workday can render the password immediately while its React state is still
   * one tick behind. Clicking the submit button at that exact moment makes the
   * UI look filled but the server receives an empty credential. Wait briefly
   * for every visible password control to contain the saved value and for the
   * submit control to become enabled. This is a bounded readiness check, not a
   * second autofill pass.
   */
  async function submitAccountWhenReady() {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !state.stopRequested) {
      const fields = passwordFields();
      const readyPasswords = fields.length > 0 && fields.every((el) => String(el.value ?? "").trim().length > 0);
      const btn = findAccountSubmitButton();
      if (readyPasswords && btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        // Let controlled-field onChange/state updates flush before the click.
        await sleep(80);
        const latest = findAccountSubmitButton();
        if (latest && !latest.disabled && latest.getAttribute("aria-disabled") !== "true") {
          latest.click();
          return true;
        }
      }
      await sleep(100);
    }
    return false;
  }

  /**
   * Is this the sign-in or create-account step rather than the application?
   *
   * Workday's apply flow opens on one of these, and filling it half way — an
   * email address and nothing else, because a password is not something to
   * invent — looks like the fill worked when nothing has happened. The account
   * step belongs to the applicant; the fill starts once they are through it.
   */
  function authPageReason() {
    const passwords = passwordFields();
    if (!passwords.length) return null;
    // SuccessFactors combines registration with the full application. A password
    // in that form must not turn off filling the applicant's other questions.
    const scope = passwords[0].closest("form") || document;
    const applicationKeys = new Set(["authorizedToWork", "requireSponsorship", "highSchoolDiplomaOrGED", "state", "country", "zip", "desiredSalary"]);
    const keys = new Set();
    for (const el of scope.querySelectorAll('input, select, textarea, [role="combobox"]')) {
      if (isPasswordControl(el) || !M.isFillable(el)) continue;
      const key = M.matchRule(el, M.deriveLabel(el), RULES)?.key;
      if (applicationKeys.has(key)) keys.add(key);
    }
    if (keys.size >= 2) return null;

    const hay = [
      location.pathname, location.search, document.title,
      M.visibleText?.(document.querySelector("h1, h2")) || "",
      Array.from(document.querySelectorAll("[data-automation-id]"))
        .slice(0, 40).map((n) => n.getAttribute("data-automation-id")).join(" "),
    ].join(" ").toLowerCase();

    if (/create\s*account|createaccount|register|sign\s*up|signup/.test(hay)) return "createAccount";
    if (/sign\s*in|signin|log\s*in|login|forgot|reset\s*password/.test(hay)) return "signIn";

    // A password box on a page with no resume upload is an account form
    // whatever it calls itself. With one, it's an application that happens to
    // ask the applicant to choose a password, and that is left to them too.
    return document.querySelector('input[type="file"]') ? null : "signIn";
  }

  // This action is limited to the application terms requested by the user.
  // Never press Apply/Create Account, optional marketing opt-ins or a generic
  // Accept button elsewhere on the page (for example a cookie banner).
  async function acceptApplicationTerms() {
    const policy = /\b(?:terms\s+(?:of\s+use|and\s+conditions)|data\s+privacy\s+statement|privacy\s+(?:statement|policy)|applicant\s+privacy)\b/i;
    const name = (el) => String(el.getAttribute("aria-label") || M.visibleText(el) || el.value || "").trim();
    const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"], dialog[open], .ui-dialog, .sapMDialog, [aria-modal="true"]'))
      .filter((el) => {
        if (!M.isFillable(el) || el.closest('[id*="cookie" i], [class*="cookie" i], #onetrust-consent-sdk')) return false;
        const title = [el.getAttribute("aria-label"),
          ...(el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => M.visibleText(document.getElementById(id))),
          M.visibleText(el.querySelector('h1, h2, h3, [role="heading"], .ui-dialog-title, .sapMDialogTitle')),
        ].filter(Boolean).join(" ");
        const text = M.visibleText(el);
        return policy.test(title || text) && !/\b(?:cookies?|tracking|advertising|marketing)\b/i.test(title || text.slice(0, 200));
      });
    let accepted = 0;
    let opened = false;
    if (!dialogs().length) {
      const link = Array.from(document.querySelectorAll('a, button, input[type="button"], [role="button"]'))
        .find((el) => M.isFillable(el) && /\b(?:read\s+and\s+accept|accept|agree\s+to)\b/i.test(name(el)) && policy.test(name(el)) &&
          !/\b(?:cookies?|tracking|advertising|marketing)\b/i.test(name(el)) &&
          (el.tagName !== "A" || !el.target || el.target === "_self"));
      if (link && !state.stopRequested) {
        // Policy links may fetch a modal asynchronously. This wait is bounded,
        // used only after opening the policy, and never blocks other fields.
        // Let the site's modal handler run, while preventing a plain policy
        // hyperlink from navigating away from an unfinished application.
        if (link.tagName === "A" && !/^javascript:/i.test(link.getAttribute("href") || "")) {
          link.addEventListener("click", (event) => event.preventDefault(), {once: true});
        }
        link.click();
        opened = true;
      }
    }
    if (opened) {
      const until = Date.now() + 1500;
      while (!dialogs().length && Date.now() < until && !state.stopRequested) await sleep(50);
    }
    for (const dialog of dialogs()) {
      if (state.stopRequested) break;
      const button = Array.from(dialog.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a'))
        .find((el) => M.isFillable(el) && /^(?:i\s+)?(?:accept|agree)(?:\s+(?:all|to\s+(?:the\s+)?(?:terms|privacy\s+statement)))?[.!]?$/i.test(name(el)));
      if (!button || button.__applifillTermsRun === state.runId) continue;
      button.__applifillTermsRun = state.runId;
      if (button.type === "submit" || button.tagName === "A") button.addEventListener("click", (event) => event.preventDefault(), {once: true});
      button.click();
      accepted++;
      await sleep(50);
    }
    for (const el of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      if (state.stopRequested) break;
      const label = String(M.deriveLabel(el) || "").split("|")[0];
      if (!policy.test(label) || !(/\b(?:agree|accept|acknowledge|consent)\b/i.test(label) || /^\s*terms\s+of\s+use\s*[:*]?\s*$/i.test(label)) ||
          /\b(?:not|decline|marketing|advertising|promotions?|notifications?|offers?|newsletter|sms|text\s+messages?)\b/i.test(label)) continue;
      if (!el.__applifillTermsWatch) {
        el.__applifillTermsWatch = true;
        const rememberChoice = (event) => {
          if (event.isTrusted && !state.filling) el.__applifillTermsDeclined = !(el.checked || el.getAttribute("aria-checked") === "true");
        };
        el.addEventListener("change", rememberChoice);
        if (el.getAttribute("role") === "checkbox") el.addEventListener("click", (event) => queueMicrotask(() => rememberChoice(event)));
      }
      if (!M.isFillable(el) || el.checked || el.getAttribute("aria-checked") === "true" || el.__applifillUserEdited || el.__applifillTermsDeclined) continue;
      const field = {el, label, kind: "checkbox", rule: null};
      if (await applyValue(field, "Yes", null)) accepted++;
    }
    return accepted;
  }

  async function expandSapSections(adapter) {
    if (adapter?.key !== "sapSuccessFactors") return;
    const headings = /^(profile\s+information|personal\s+information|professional\s+experience|work\s+experience|education|job[-\s]specific\s+information)$/i;
    const controls = document.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"], a[aria-expanded="false"], details:not([open]) > summary');
    for (const control of Array.from(controls).slice(0, 30)) {
      if (state.stopRequested) return;
      const name = String(control.getAttribute("aria-label") || M.visibleText(control) || "").replace(/^[+›▶▸−–—\s]+|[+›▶▸−–—\s]+$/g, "").trim();
      if (!headings.test(name) || !M.isFillable(control)) continue;
      // Only explicit disclosure controls, never navigation or Apply/Save.
      if (control.tagName === "A" && control.getAttribute("href") && !control.getAttribute("href").startsWith("#")) continue;
      control.click();
      await sleep(150);
    }
  }

  function collectFields(adapter) {
    const searchRoots = collectSearchRoots();
    const roots = chooseScanRoots(adapter, searchRoots);

    const seen = new Set();
    const fields = [];

    roots.forEach((root) => {
      try {
        root
          .querySelectorAll(
            'input, textarea, select, ' +
            '[role="combobox"], [role="textbox"][contenteditable="true"], ' +
            '[aria-haspopup="listbox"], [aria-haspopup="menu"], ' +
            'button[data-automation-id*="Dropdown"], button[data-automation-id*="Prompt"], ' +
            // Plain buttons are scanned so segmented Yes/No controls are found.
            // Everything that is not a choice group or a menu trigger is
            // rejected a few lines below, so this widens detection only.
            'button, [role="button"], ' +
            'div[role="button"][aria-expanded], ' +
            '[role="checkbox"], [role="radio"], [role="listbox"] [role="option"], ' +
            '[data-qa], [data-testid], [data-test-id], [contenteditable="true"]' +
            // ADP's lists, radio groups and check boxes (see `M.isSdfField`).
            (M.SDF_FIELD_SELECTOR ? `, ${M.SDF_FIELD_SELECTOR}` : "")
          )
          .forEach((el) => {
            if (seen.has(el)) return;
            seen.add(el);
            // The scan may cover the whole page, so the site's own furniture is
            // filtered out here rather than being answered or flagged.
            if (inPageChrome(el)) return;

            /**
             * ADP's SDF components draw their own choices: the list, the radio
             * group and the check box are each one question, answered through
             * the component itself. Their insides — the frame of a list, the
             * radio inside a radio button — are not questions of their own.
             */
            if (M.isSdfField?.(el)) {
              if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
              if (!M.isFillable(el)) return;
              const kind = M.fieldKind(el);
              const label = M.deriveLabel(el);
              const field = { el, label, kind, rule: M.matchRule(el, label, RULES) };
              if (kind !== "select") {
                if (!el.dataset.applifillGroupKey) el.dataset.applifillGroupKey = `s${Math.random().toString(36).slice(2)}`;
                field._groupKey = `sdf|${el.dataset.applifillGroupKey}`;
              }
              fields.push(field);
              return;
            }
            if (M.sdfInnerPart?.(el)) return;

            /**
             * A row of choice buttons is one question, collected once.
             *
             * Oracle Recruiting's pills — every Yes/No question, and Title — are
             * option buttons in a listbox, or buttons each in a wrapper of their
             * own. The checks below turned all of them away: an option inside a
             * listbox is "part of an open menu", and a button that opens no menu
             * is "not a field". So the row is recognised first. Anchored on its
             * first button so the label and row index never depend on which
             * button the scan reached first.
             */
            const segments = M.choiceButtonGroup?.(el);
            if (segments?.length) {
              if (!M.isFillable(el)) return;
              const container = M.choiceGroupContainer?.(segments) || segments[0].parentElement;
              if (container && !container.dataset.applifillChoiceKey) {
                container.dataset.applifillChoiceKey = `c${Math.random().toString(36).slice(2)}`;
              }
              const groupKey = `choice|${container?.dataset?.applifillChoiceKey || `single-${fields.length}`}`;
              segments.forEach((s) => seen.add(s));
              // Ashby keeps a zero-size checkbox beside its Yes / No buttons that
              // mirrors whichever is pressed. It is the row's value store, not a
              // question of its own, and is never answered separately.
              try {
                container?.querySelectorAll?.("input").forEach((input) => {
                  if (M.isHiddenMirror?.(input)) seen.add(input);
                });
              } catch {}
              if (fields.some((f) => f._groupKey === groupKey)) return;
              const anchor = segments[0];
              const segLabel = M.deriveLabel(anchor);
              fields.push({
                el: anchor,
                label: segLabel,
                kind: "radio",
                rule: M.matchRule(anchor, segLabel, RULES),
                _groupKey: groupKey,
              });
              return;
            }

            // The mirror checkbox of a Yes / No row, reached before its buttons.
            if (el.tagName === "INPUT" && mirrorsChoiceRow(el)) return;

            // `[data-qa]` and `[data-testid]` also match wrappers. Lever puts
            // them on the <li> and <div> around every question, and each of
            // those was collected as a text box: typing at a <div> went into
            // whichever box held the caret, and an <li> — whose `value` is its
            // list number — was then offered as a pending answer of "0".
            if (!M.isFormControl(el)) return;
            // Uploads are the applicant's: never collected, never clicked.
            if (isUploadControl(el) || isPasswordControl(el)) return;
            // Oracle JET's own inner boxes (the search box its drop-down opens,
            // the hidden copy of its value) belong to the drop-down, which is
            // answered through its own box.
            if (oracleInnerPart(el)) return;
            // A dropdown that a library has replaced with its own markup keeps
            // its real <select> in the page but hides it. That select is the
            // value the form submits, so it is collected even though it cannot
            // be seen — otherwise a widget with no ARIA of its own (iCIMS's
            // "— Make a Selection —" country picker) is never even attempted.
            const hiddenButBacking =
              el.tagName === "SELECT" && !el.disabled && (el.options?.length ?? 0) > 1 &&
              hasVisibleHost(el);
            // Oracle's Yes / No and check boxes: the input is drawn at 0 x 0 and
            // its label is what shows. See `labelDrawnChoice`.
            if (!M.isFillable(el) && !hiddenButBacking && !M.labelDrawnChoice?.(el)) return;
            if (["submit", "reset", "image"].includes(el.type)) return;
            // Never treat an option inside an open menu as a form field.
            if (el.closest?.('[role="listbox"], [role="menu"], [role="option"]')) return;

            const ownRole = el.getAttribute("role");
            // A <button role="radio"> is a radio, answered with its group below.
            if ((el.tagName === "BUTTON" || ownRole === "button") && ownRole !== "radio" && ownRole !== "checkbox") {
              const popup = el.getAttribute("aria-haspopup");
              const opensMenu =
                el.getAttribute("role") === "combobox" ||
                popup === "listbox" || popup === "menu" || popup === "true" ||
                /dropdown|select|prompt/i.test(el.getAttribute("data-automation-id") || "") ||
                // Workday renders most of its selects as a <button> carrying
                // nothing but `aria-expanded` — no aria-haspopup, no telling
                // automation id — so this has to stay. Excluding it made every
                // one of those dropdowns invisible to the fill, which is what
                // stopped Workday working.
                el.getAttribute("aria-expanded") !== null;
              if (!opensMenu) return;
              // The button that opens one of Oracle's list boxes is part of that
              // box, which is answered itself. As a field of its own it was
              // opened, found to name no question, and outlined.
              if (oracleListButton(el)) return;
              // The name is what separates a dropdown from a control that
              // changes the form: clicking "Add" or "Delete" is what opened
              // education section after education section. That check, not the
              // aria-expanded one above, is the guard that matters.
              if (isActionButton(el)) return;
            } else if (el.tagName !== "BUTTON" && el.type === "button") return;

            if (el.type === "radio" || el.type === "checkbox" ||
                el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
              const role = el.getAttribute("role") || el.type;
              const name = el.getAttribute("name");
              const container = el.closest("fieldset, [role='radiogroup'], [role='group']");
              if (container && !container.dataset.applifillGroupKey) {
                container.dataset.applifillGroupKey = `g${Math.random().toString(36).slice(2)}`;
              }
              /**
               * The row is part of the group's identity.
               *
               * A shared `name`, or one `[role="group"]` around the whole
               * section, collapsed every row's "I currently work here" into a
               * single field — so only the first job was ever asked about and
               * the other rows were never answered. Two boxes in two different
               * Work Experience blocks are two questions.
               */
              const row = M.repeatedRowKey?.(el) || "";
              /**
               * Oracle names each box of a check-box question on its own
               * ("races-0", "races-1", …), so a shared name cannot group them.
               * The boxes of one question row are one question.
               */
              let shared = name;
              if (role === "checkbox" && M.onOracleCandidateExperience?.() && el.closest?.(".input-row")) {
                const members = M.checkboxGroup?.(el) || [el];
                if (members.length > 1) {
                  const first = members[0];
                  if (!first.dataset.applifillBoxGroup) first.dataset.applifillBoxGroup = `b${Math.random().toString(36).slice(2)}`;
                  shared = `boxes:${first.dataset.applifillBoxGroup}`;
                }
              }
              const groupKey =
                `${role}|${shared || container?.dataset?.applifillGroupKey || `single-${fields.length}`}` +
                (row ? `|${row}` : "");
              if (fields.some((f) => f._groupKey === groupKey && f.el !== el)) return;
              el.dataset.applifillGroup = el.dataset.applifillGroup || (name || container?.dataset?.applifillGroupKey || `g${fields.length}`);
              const label = M.deriveLabel(el);
              fields.push({ el, label, kind: M.fieldKind(el), rule: M.matchRule(el, label, RULES), _groupKey: groupKey });
              return;
            }

            const label = M.deriveLabel(el);
            fields.push({ el, label, kind: M.fieldKind(el), rule: M.matchRule(el, label, RULES) });
          });
      } catch {}
    });

    // A decorated dropdown can be picked up twice — once as the visible widget
    // and once as the hidden select behind it. They are one question, so keep
    // whichever carries the better label and drop the other.
    const byControl = new Map();
    const deduped = [];
    for (const field of fields) {
      const key = M.backingSelect?.(field.el) ?? field.el;
      const existing = byControl.get(key);
      if (!existing) {
        byControl.set(key, field);
        deduped.push(field);
        continue;
      }
      if ((field.rule && !existing.rule) || (field.label?.length ?? 0) > (existing.label?.length ?? 0)) {
        deduped[deduped.indexOf(existing)] = field;
        byControl.set(key, field);
      }
    }

    assignRowIndexes(deduped, EXPERIENCE_KEYS, ["currentCompany", "currentTitle", "responsibilities"]);
    assignRowIndexes(deduped, EDUCATION_KEYS, ["school", "degree", "fieldOfStudy"]);
    deduped.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
    return deduped;
  }

  /**
   * How one of Oracle's address lists is searched and read.
   *
   * ZIP Code: the five digits typed, and a row that starts with them is the
   * one (with the first three digits as a second search, as Oracle lists by
   * prefix). City: a row that is the city, or starts with it ("Jacksonville,
   * Duval, FL"). State and the rest: the usual matching.
   */
  function oracleListSearch(key, value) {
    const text = String(value ?? "").trim();
    if (key === "fieldOfStudy") {
      const terms = M.studySearchTerms?.(value) || [text];
      return {search: terms[0], alternates: terms.slice(1), scorer: (row, rows) => { const score=M.studyChoiceScore(row, value); return rows.some(other=>other.text!==row && M.studyChoiceScore(other.text,value)===score) ? 0 : score; }};
    }
    if (key === "zip") {
      const zip = text.match(/\d{5}/)?.[0];
      if (!zip) return {};
      return {
        search: zip,
        alternates: [zip.slice(0, 3)],
        scorer: (row) => {
          const digits = String(row).replace(/\s+/g, "");
          if (digits === zip) return 130;
          return digits.startsWith(zip) ? 110 : 0;
        },
      };
    }
    if (key === "city") {
      const want = text.toLowerCase().replace(/\s+/g, " ");
      if (!want) return {};
      return {
        search: text,
        scorer: (row) => {
          const r = String(row).toLowerCase().replace(/\s+/g, " ").trim();
          if (r === want) return 130;
          return r.startsWith(`${want},`) || r.startsWith(`${want} (`) ? 110 : 0;
        },
      };
    }
    return {};
  }

  /**
   * One of Oracle JET's inner boxes: the search box its drop-down opens
   * (`.oj-searchselect-filter-input`), a hidden copy of the value
   * (`.oj-component-initnode`), or anything in the list layer it draws at the
   * end of the page.
   */
  function oracleInnerPart(el) {
    try {
      if (el.tagName === "INPUT" && el.matches(".oj-searchselect-filter-input, .oj-component-initnode") &&
          !el.matches(".oj-searchselect-input, .oj-combobox-input")) return true;
      return Boolean(el.closest(".oj-listbox-drop, .oj-listbox-drop-layer"));
    } catch { return false; }
  }

  /**
   * The button beside one of Oracle's list boxes that opens (or empties) it —
   * `#<id>-toggle-button`, "Open the drop-down list", "Remove value for the
   * Country field." — when the box itself is on the page.
   */
  function oracleListButton(el) {
    try {
      const id = String(el.id || "");
      if (/-toggle-button$/.test(id)) {
        const box = document.getElementById(id.replace(/-toggle-button$/, ""));
        if (box && M.isOracleSelect?.(box)) return true;
      }
      const container = el.closest(".cx-select-container, oj-select-single, oj-combobox-one");
      return Boolean(container && Array.from(container.querySelectorAll("input")).some((i) => M.isOracleSelect?.(i)));
    } catch { return false; }
  }

  /** A box of a MM / DD / YYYY widget that would not show the date in this pass. */
  function dateLeftWrong(el) {
    return Boolean(el) && el.__applifillDateFailedRun === state.runId;
  }

  /** "01/01/2000", "2026-10-01", "October 1, 2026" — a day on the calendar. */
  function looksLikeCalendarDate(text) {
    const t = String(Array.isArray(text) ? text.join(" ") : text ?? "").trim();
    if (!t) return false;
    if (/\b\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*\d{2,4}\b/.test(t)) return true;          // 01/01/2000
    if (/\b(?:19|20)\d{2}\s*-\s*\d{1,2}(?:\s*-\s*\d{1,2})?\b/.test(t)) return true;   // 2026-10-01
    if (/\b\d{1,2}\s*\/\s*(?:19|20)\d{2}\b/.test(t)) return true;                     // 10/2026
    return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/i.test(t) && /\b(19|20)\d{2}\b/.test(t);
  }

  /**
   * Does this start-date box already show a day that has passed?
   *
   * A start date in the past is never the answer — Workday refuses it, and
   * "01/01/2000" was what an old saved answer (or a widget that lost the
   * typed date) left behind. Only a date that is certainly past counts: a MM /
   * DD / YYYY widget, a native date input or an ISO date read before today,
   * or any date whose year is already over.
   */
  function shownStartDateIsPast(el) {
    let y = 0, m = 1, d = 1, exact = false;
    try {
      const parts = M.segmentedDateValue?.(el);
      if (parts && parts.year) {
        y = Number(parts.year); m = Number(parts.month || 1); d = Number(parts.day || 1); exact = true;
      } else {
        const v = String(el?.value ?? "").trim();
        let hit = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
        if (hit) { y = +hit[1]; m = +hit[2]; d = +(hit[3] || 1); exact = true; }
        else if ((hit = v.match(/\b((?:19|20)\d{2})\b/))) { y = +hit[1]; }
      }
    } catch {}
    if (!y || y < 1000) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (y < today.getFullYear()) return true;
    return exact && new Date(y, (m || 1) - 1, d || 1) < today;
  }

  /**
   * Is this control a date — a date input, one box of a MM / DD / YYYY widget,
   * a box that says it takes MM/DD/YYYY, or one of a date's Month / Day / Year
   * lists — rather than a question in words?
   */
  function isDateBox(el) {
    if (!el) return false;
    const type = String(el.getAttribute?.("type") || el.type || "").toLowerCase();
    if (type === "date" || type === "month") return true;
    try { if ((M.dateSegmentNodes?.(el)?.length ?? 0) >= 2) return true; } catch {}
    const hint = `${el.getAttribute?.("placeholder") || ""} ${el.getAttribute?.("data-automation-id") || ""} ${el.getAttribute?.("aria-label") || ""}`;
    if (/\b(mm|dd|yyyy)\b|datesection|date\s*picker|datepicker/i.test(hint)) return true;
    // One list of a date asked as Month / Day / Year lists.
    if (el.tagName === "SELECT") {
      let own = "";
      try { own = String(M.deriveLabel?.(el) || "").split("|")[0].trim(); } catch {}
      return /^(mm|dd|yy|yyyy|month|day|year)$/i.test(own);
    }
    return false;
  }

  /**
   * Does a control the applicant edited still hold something of theirs?
   *
   * Lever's location and Workday's prompts only count a pick from their own
   * lists, so text typed into them is not an answer — but it is still the
   * applicant's text, and a later Fill does not type over it.
   */
  function holdsOwnText(el) {
    if (M.hasValue(el)) return true;
    try {
      if (M.leverLocationPicked?.(el) === false || M.isWorkdayPrompt?.(el)) {
        return Boolean(String(el.value ?? "").trim());
      }
    } catch {}
    return false;
  }

  /**
   * Is this input the invisible value store of a row of Yes / No buttons?
   *
   * Ashby's checkbox sits beside the buttons it mirrors. Collected on its own
   * it was a second, unlabelled checkbox for the same question.
   */
  function mirrorsChoiceRow(input) {
    try {
      if (!M.isHiddenMirror?.(input)) return false;
      let node = input.parentElement;
      for (let d = 0; node && d < 2; d++, node = node.parentElement) {
        if (node === document.body) break;
        for (const b of node.querySelectorAll?.('button, [role="button"]') || []) {
          if (M.choiceButtonGroup?.(b)) return true;
        }
      }
    } catch {}
    return false;
  }

  /**
   * A choice field that has nothing to offer yet.
   *
   * "State/Province" reads "Please select a country" until Country is answered,
   * and iCIMS's "Please specify" stays empty until "How did you hear about us?"
   * is. Attempting these in page order fills neither, so they are set aside and
   * retried once everything else has been answered.
   */
  function isAwaitingParent(field) {
    const el = field.el;
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") return true;
    if (field.kind !== "select") return false;
    return !M.hasRealOptions(el);
  }

  /**
   * Workday often starts with one blank Work Experience row. If the saved
   * profile contains more roles, create the missing rows before filling so the
   * nth role from the profile lands in the nth ATS row.
   */
  async function ensureProfileRows(profile, adapter, kinds = ["experience", "education"]) {
    const experienceCount = kinds.includes("experience") && Array.isArray(profile?.experience) ? profile.experience.length : 0;
    const educationCount = kinds.includes("education") && Array.isArray(profile?.education) ? profile.education.length : 0;
    if (experienceCount <= 1 && educationCount <= 1) return;

    const sectionRe = (kind) => kind === "experience"
      ? /work\s+experience|employment|work\s+history|job\s+history|professional\s+experience/i
      : /education|school|university|college/i;

    const countRows = (kind) => {
      const keys = kind === "experience" ? EXPERIENCE_KEYS : EDUCATION_KEYS;
      const preference = kind === "experience"
        ? ["currentCompany", "currentTitle", "responsibilities"]
        : ["school", "degree", "fieldOfStudy"];
      const fields = collectFields(adapter).filter((f) => keys.has(f.rule?.key));
      if (!fields.length) return 0;

      // Count actual repeated anchors first. This is intentionally independent
      // of `field.index`: the old implementation used the indexer to decide
      // whether another row existed, while the indexer itself could collapse
      // two pre-rendered rows to index 0. That feedback loop clicked "Add" and
      // created a duplicate row containing the same profile data.
      const counts = new Map();
      fields.forEach((f) => counts.set(f.rule.key, (counts.get(f.rule.key) || 0) + 1));
      const anchorKey = preference.find((k) => (counts.get(k) || 0) >= 1) ||
        [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (anchorKey) {
        const anchors = fields.filter((f) => f.rule.key === anchorKey).map((f) => placeOf(f.el));
        if (anchors.length >= 2) {
          const rows = M.rowsFromAnchors(anchors);
          if (rows.length >= 2) return rows.length;
          // Two anchors are two rows even if an unusual wrapper makes the row
          // detector conservative. Never add another row merely because the
          // container could not be identified.
          return anchors.length;
        }
      }

      const indices = fields.map((f) => f.index).filter(Number.isInteger);
      return indices.length ? Math.max(...indices) + 1 : 1;
    };

    /**
     * How many rows this pass may create.
     *
     * The old ceiling was eight, and the only stop condition was countRows()
     * reporting enough rows. When an ATS renders its new sections in markup the
     * row indexer can't read, countRows never moves, the guard never fires, and
     * every one of those eight clicks lands — which is the reported "more than
     * seven education tabs". A row that never gets filled is an empty block the
     * applicant has to delete by hand, so the ceiling is now low and progress is
     * verified after every click.
     */
    const MAX_ADDED_ROWS = { experience: 5, education: 3 };

    const answerableCount = () => {
      try { return document.querySelectorAll(ANSWERABLE_PROBE).length; } catch { return 0; }
    };

    const clickAdds = async (kind, targetCount) => {
      if (targetCount <= 1) return;
      const re = sectionRe(kind);
      const limit = Math.min(MAX_ADDED_ROWS[kind] ?? 3, targetCount - 1);
      let rowsSeen = countRows(kind);
      let controlsSeen = answerableCount();

      for (let attempt = 0; attempt < limit; attempt++) {
        if (state.stopRequested) return;
        if (countRows(kind) >= targetCount) return;

        // `sdf-button`: ADP draws its "Add Employer" as a component whose own
        // <button> is inside its shadow root; the component takes the click.
        const add = Array.from(document.querySelectorAll('button, [role="button"], a, [data-automation-id], sdf-button'))
          .filter((el) => M.isFillable(el))
          .find((el) => {
            const text = M.visibleText(el) || el.getAttribute("aria-label") || el.getAttribute("data-automation-id") || "";
            if (!/^add(?:\s+|$)|add\s+(another|new|work|experience|education|school|job)/i.test(text.trim())) return false;
            const parentText = M.visibleText(el.parentElement?.parentElement) || "";
            return re.test(`${text} ${parentText}`);
          });

        if (!add) return;
        M.ensureVisible(add);
        add.click?.();
        await sleep(320);

        // Neither the row count nor the number of answerable controls moved, so
        // that click achieved nothing. Repeating it would only stack up empty
        // sections, so the pass stops here rather than spending its whole
        // allowance discovering the same thing.
        const rowsNow = countRows(kind);
        const controlsNow = answerableCount();
        // Adding an ATS row must be proven by the row detector itself. Some
        // Workday renders briefly increase the number of controls while the
        // original row is rehydrating; treating that as a new row caused the
        // Add button to be clicked twice and created duplicate Work Experience
        // sections. If the real row count did not increase, stop rather than
        // manufacture another section.
        if (rowsNow <= rowsSeen) return;
        rowsSeen = rowsNow;
        controlsSeen = controlsNow;
      }
    };

    await clickAdds("experience", experienceCount);
    await clickAdds("education", educationCount);
  }

  /* ================================================================== */
  /*  Saved answers                                                      */
  /* ================================================================== */

  /**
   * A question as printed, without the widget's own chatter.
   *
   * Workday names every dropdown "<question> <current value> Required" in its
   * aria-label — "Are you over the age of 18? Select One Required" — and that
   * string was looked up, and banked, as though the value and the word
   * "Required" were part of the question. It then matched nothing exactly and
   * only ever came back through the fuzzy path.
   */
  function cleanQuestionText(text) {
    let t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (/\srequired$/i.test(t)) {
      t = t.replace(/\s+required$/i, "").trim();
      const q = t.lastIndexOf("?");
      if (q > 8 && t.length - q - 1 <= 40) t = t.slice(0, q + 1);
    }
    return t.replace(/\s+select\s+one$/i, "").trim();
  }

  /** Words that flip a yes/no question's meaning. */
  const NEGATION_RE =
    /\b(not|never|no\s+longer|without|unable|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|haven'?t|hasn'?t|wasn'?t|weren'?t|neither|nor|except|other\s+than)\b/i;

  /* ------------------------------------------------------------------ */
  /*  The same question from a different employer                        */
  /* ------------------------------------------------------------------ */

  /**
   * Host names, portal names and page titles that are not the hiring
   * company: "careers.acme.com" reads as "careers", Workforce Now's address
   * as "workforcenow", its tab as "Current Openings | Recruitment".
   */
  const NOT_AN_EMPLOYER_RE =
    /^(careers?|career[\s-]*(center|site|portal)|jobs?|job[\s-]*(board|boards|search|details|opportunities|openings?|listings?)|apply|application|app|portal|www|boards?|job-boards|recruiting|recruitment|recruit|talent|hr|work|join|external|internal|home|current\s+openings?|openings?|workforcenow|workforce\s+now|myjobs|my\s+jobs|adp|icims|greenhouse|lever|workday|myworkdayjobs|myworkdaysite|smartrecruiters|ashby|ashbyhq|jobvite|taleo|oraclecloud|successfactors|bamboohr|paylocity|paycom|ultipro|ukg|dayforce|recruitee|breezy|workable|teamtailor|personio|pinpoint|dover|bullhorn|applytojob|jazzhr|candidate\s+(portal|experience|home))$/i;

  /** The hiring company's names this page gives: the posting's company and the address's tenant. */
  function hiringEmployers(meta) {
    const names = [];
    try { names.push(...(RULES.helpers?.hiringCompanyHints?.({ page: false }) ?? [])); } catch {}
    const company = String(meta?.company ?? "").trim();
    if (company && company.length <= 80) names.push(company);
    return Array.from(new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 && !NOT_AN_EMPLOYER_RE.test(n))));
  }

  /** The company this application is for, when the page names it — kept beside an answer the applicant saves here. */
  function pageCompany() {
    return (state.employers ?? []).find((n) => n && !NOT_AN_EMPLOYER_RE.test(n)) || undefined;
  }

  /** The employer in a saved answer's address: `gdit.wd5.myworkdayjobs.com` → "gdit". */
  function tenantOf(domain) {
    const host = String(domain ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    const first = host.split(".")[0];
    if (/myworkdayjobs\.com$/.test(host) && first && !/^(www|wd\d+)$/.test(first)) return first;
    const icims = host.match(/^(?:careers|jobs)-([a-z0-9-]+)\.icims\.com$/);
    if (icims) return icims[1].replace(/-/g, " ");
    return null;
  }

  /** The text with each of these company names replaced by the word "employer"; `found` lists the names that were in it. */
  function withoutEmployers(text, names) {
    let out = String(text ?? "");
    let replaced = false;
    const found = [];
    const list = Array.from(new Set((names || []).map((n) => String(n ?? "").trim()).filter((n) => n.length >= 2)))
      .sort((a, b) => b.length - a.length);
    for (const name of list) {
      const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const re = new RegExp(`(^|[^A-Za-z0-9])${pattern}(?=$|[^A-Za-z0-9])`, "gi");
      out = out.replace(re, (_m, pre) => {
        replaced = true;
        if (!found.includes(name)) found.push(name);
        return `${pre}employer`;
      });
    }
    return { text: out, replaced, found };
  }

  /**
   * The hiring company named without a name: "this company", "the
   * organization", "our firm", "[Company Name]", "…worked for us". A saved
   * answer to "Do you have any relatives employed by this company?" — the way
   * an applicant writes one in Saved Answers — is the answer to "…employed by
   * Acme?", and the other way round. Only a lower-case "us": "US" is a country.
   */
  const GENERIC_EMPLOYER_RE =
    /\b(?:this|the|our)\s+(?:hiring\s+)?(?:company|organi[sz]ation|employer|firm|business|corporation|institution|bank|credit\s+union|agency|hospital|health\s+system|enterprise)\b|\[\s*(?:company|organi[sz]ation|employer)(?:[\s_]+name)?\s*\]|<\s*(?:company|organi[sz]ation|employer)(?:[\s_]+name)?\s*>|\{\{?\s*(?:company|organi[sz]ation|employer)(?:[\s_]+name)?\s*\}\}?/gi;
  const US_EMPLOYER_RE = /\b(for|by|with|at|join(?:ed)?|joining)\s+us\b/g;

  /** `withoutEmployers`, and the hiring company named without a name as well. */
  function neutralizeEmployers(text, names) {
    const named = withoutEmployers(text, names);
    let out = named.text;
    let generic = false;
    out = out.replace(GENERIC_EMPLOYER_RE, () => { generic = true; return "employer"; });
    out = out.replace(US_EMPLOYER_RE, (_m, prep) => { generic = true; return `${prep} employer`; });
    return { text: out, replaced: named.replaced || generic, found: named.found, generic };
  }

  /** A question about the applicant's own ties to the company: worked there, family there, applied there. */
  const EMPLOYER_TIE_RE =
    /\b(employ\w*|worked|working|relatives?|family|related|spouse|applied|application|interview\w*|contract\w*|intern(?:ed|ship)?|consult\w*|subsidiar\w*|affiliat\w*|payroll)\b/i;

  const neutralKeys = new WeakMap();
  function neutralKeyOf(record) {
    const sig = `${record.question ?? ""}\u0001${record.lastDomain ?? ""}\u0001${record.lastCompany ?? ""}\u0001${record.answer ?? ""}`;
    const cached = neutralKeys.get(record);
    if (cached && cached.sig === sig) return cached;
    let named = null;
    try { named = RULES.helpers?.employerNamedIn?.(record.question); } catch {}
    const rawCompany = String(record.lastCompany ?? "").trim();
    const company = rawCompany && !NOT_AN_EMPLOYER_RE.test(rawCompany) ? rawCompany : null;
    const tenant = tenantOf(record.lastDomain);
    const names = [tenant, company, named].filter(Boolean);
    const { text, replaced, found } = neutralizeEmployers(record.question, names);
    const entry = {
      sig,
      key: replaced ? M.normalizeQuestion(text) : null,
      strictKey: replaced ? M.savedQuestionKey(text) : null,
      // The company the answer was about: the one the saved question named
      // ("Globex"), or — for "this company" answered on Globex's application —
      // the one it was given to. None for a question written in Saved Answers.
      found: found.length ? found : [tenant, company].filter(Boolean),
      tie: EMPLOYER_TIE_RE.test(text),
      // "Yes — I interned at GDIT in 2019" is not an answer to give Leidos.
      answerNamesEmployer: names.length ? withoutEmployers(record.answer, names).replaced : false,
    };
    try { neutralKeys.set(record, entry); } catch {}
    return entry;
  }

  /**
   * A saved answer to this question as another employer asked it.
   *
   * Portals reuse the same questionnaire with the company name swapped in —
   * "Do you have any relatives currently employed by GDIT?", then "…by
   * Leidos?" — and the one differing word kept the two below the similarity
   * floor, so the applicant was asked again on every application. Both names
   * are set aside before comparing, and so is a company named without a name
   * ("this company", "us"), which is how an answer written in Saved Answers
   * usually puts it. Never an exact match, so the profile still outranks it,
   * and only ever a choice answer.
   *
   * A yes to a question about the applicant's ties to one company — worked
   * there, family there — is a fact about that company: it is carried to
   * another company's same question only as a no, or when the saved question
   * named no company in particular.
   */
  function savedAnswerAcrossEmployers(question, responses) {
    const pageNames = [...(state.employers ?? [])];
    let named = null;
    try { named = RULES.helpers?.employerNamedIn?.(question); } catch {}
    if (named) pageNames.push(named);
    const { text, replaced } = neutralizeEmployers(question, pageNames);
    if (!replaced) return null;
    const key = M.normalizeQuestion(text);
    if (!key) return null;

    const sameCompany = (names) => {
      try { return names.some((n) => pageNames.some((m) => RULES.helpers?.sameEmployer?.(n, m))); } catch { return false; }
    };

    let best = null;
    let bestScore = 0;
    for (const r of responses) {
      if (!r?.answer || !r.question) continue;
      const neutral = neutralKeyOf(r);
      if (!neutral.key || neutral.answerNamesEmployer) continue;
      if (M.yesNoId?.(r.answer)) {
        if (M.savedQuestionKey(text) !== neutral.strictKey) continue;
      }
      if (neutral.tie && neutral.found.length && M.yesNoId?.(r.answer) === "yes" && !sameCompany(neutral.found)) continue;
      const score = neutral.key === key ? 1 : M.similarity(key, neutral.key);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 0.82) return null;
    return { ...best, confidence: Math.min(0.95, bestScore), acrossEmployers: true, sameQuestion: bestScore >= 0.999 };
  }

  /**
   * Looks a question up in the user's saved answers.
   *
   * The derived label is several descriptions joined by " | ", so each one is
   * tried separately — matching the whole joined string diluted the score badly
   * enough that saved answers routinely failed to apply.
   */
  function findSavedAnswer(field, { exactOnly = false } = {}) {
    const responses = state.session?.responses ?? [];
    if (!responses.length) return null;
    if (field?.rule?.blank || (field?.rule?.identity && !field.rule.eeo)) return null;

    const el = field?.el;
    const candidates = [];

    /**
     * The group's own option labels, which must never be looked up as
     * questions. A radio group offering "Prefer not to say" would otherwise
     * search Saved Answers for that phrase and could match an unrelated record
     * on it — the mirror image of the capture bug, and just as wrong.
     */
    let options = new Set();
    try { options = optionTextsForField(field); } catch {}

    /**
     * Headings are context, not questions.
     *
     * The derived label carries the heading of the section the field sits in —
     * "Address", "Application Questions", "Voluntary Disclosures" — and it was
     * looked up like any other description. One saved answer filed under a
     * heading then matched *every* field beneath it, which is how a single
     * record could put the same "Yes" into a whole page of unrelated questions.
     */
    const contextTitles = new Set();
    try {
      const title = M.sectionContext?.(el)?.title;
      if (title) contextTitles.add(answerKey(title));
    } catch {}

    const addCandidate = (value) => {
      const text = String(value ?? "").trim();
      if (!text) return;
      const parts = text.split(" | ").map((x) => cleanQuestionText(x)).filter(Boolean);
      for (const part of parts) {
        if (part.length < 4) continue;
        if (options.has(answerKey(part))) continue;
        if (contextTitles.has(answerKey(part))) continue;
        if (ANSWER_LIKE_RE.test(part)) continue;
        // A uuid is unique to this one form. Looking one up can only ever miss,
        // and a near-miss against an unrelated record is worse than a miss.
        if (looksMachineGenerated(part)) continue;
        if (!candidates.includes(part)) candidates.push(part);
      }
    };

    // Choice controls are commonly labelled with the *selected option* rather
    // than the question. The answer is saved under the real question heading,
    // so the same resolution has to run here or a synced radio, checkbox or
    // dropdown answer can never be found again on the next application.
    if (field) {
      try { addCandidate(primaryQuestion(field)); } catch {}
      try { groupAccessibleNames(el).forEach(addCandidate); } catch {}
      try { addCandidate(questionHeadingNear(el, options)); } catch {}
      try { addCandidate(field.question); } catch {}
      addCandidate(field.label);
    }

    if (el) {
      ["aria-label", "data-qa", "data-testid", "name", "id"].forEach((attr) => {
        const v = el.getAttribute?.(attr);
        if (v && v.trim()) addCandidate(M.humanize(v.trim()) || v.trim());
      });

      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node) addCandidate(M.visibleText?.(node) || node.textContent);
        }
      }
    }

    let best = null;
    let askedAs = "";
    for (const question of candidates.slice(0, 8)) {
      if (question.length < 4) continue;
      const hit = M.findSavedAnswer(question, responses, exactOnly ? 1 : 0.62);
      if (hit && (!best || (hit.confidence ?? 0) > (best.confidence ?? 0))) {
        best = hit;
        askedAs = question;
      }
      if ((best?.confidence ?? 0) >= 0.999 && question === candidates[0]) break;
    }
    if (!exactOnly && (!best || (best.confidence ?? 0) < 0.999)) {
      for (const question of candidates.slice(0, 3)) {
        if (question.length < 4) continue;
        let hit = null;
        try { hit = savedAnswerAcrossEmployers(question, responses); } catch {}
        if (hit && (!best || hit.confidence > (best.confidence ?? 0))) {
          best = hit;
          askedAs = question;
        }
      }
    }
    if (!best) return null;

    // Descriptions and machine attributes are lookup aids, not permission to
    // answer a different binary question. Validate against the actual prompt.
    if (M.yesNoId?.(best.answer) && !best.acrossEmployers) {
      let ownQuestion = "";
      try { ownQuestion = primaryQuestion(field); } catch {}
      if (ownQuestion && M.savedQuestionKey(ownQuestion) !== M.savedQuestionKey(best.matchedQuestion || best.question)) return null;
    }

    // Carried across employers only as a choice: a sentence written for one
    // company is not an answer to give another.
    if (best.acrossEmployers) {
      const choice = field && (field.kind === "select" || field.kind === "radio" || field.kind === "checkbox");
      if (!choice && !M.yesNoId?.(best.answer)) return null;
    }

    // Saved answers that identify an application question exactly (including an
    // alias captured on another ATS) are always eligible to replay. This is
    // deliberately checked before profile-derived values in planField so an
    // explicit Saved Answer remains the user's chosen answer.
    //
    // Fuzzy matches stay available, but only at a stronger threshold than the
    // general matcher default. This prevents an unrelated saved response from
    // winning just because two short labels share a few words.
    if ((best.confidence ?? 0) < 0.82) return null;

    // An exact match means the applicant answered this very question before,
    // by its normalized text or one of its recorded aliases. That outranks a
    // value derived from the profile; a merely similar question does not.
    best.exact = (best.confidence ?? 0) >= 0.999;

    if (!best.exact) {
      /**
       * A near match must not flip the meaning.
       *
       * Word overlap cannot see "not": "Do you require sponsorship?" and "Can
       * you work without sponsorship?", or "Have you ever been employed here?"
       * and "Have you never been employed here?", share almost every word and
       * want opposite answers. Replaying a yes/no across that gap is exactly
       * the "answered the opposite way" report, so a near match is refused
       * when one question is negated and the other is not — and a bare yes/no
       * is only carried to a question that is very nearly the same wording.
       */
      const storedAs = String(best.question ?? "");
      if (NEGATION_RE.test(askedAs) !== NEGATION_RE.test(storedAs)) return null;
      if (M.yesNoId?.(best.answer) && (best.confidence ?? 0) < 0.88) return null;
    }

    /**
     * A saved answer is not allowed to override an identity or voluntary
     * disclosure field.
     *
     * These are the fields with one correct answer that already lives in the
     * profile, and they are the ones the queue was poisoned with: a generated
     * "Yes" captured off a CC-305 Name box came back as a saved answer and was
     * replayed onto every later application, which is the loop the user
     * described — correcting it by hand only banked the correction against the
     * wrong question. The profile is authoritative here; the queue is not.
     */
    if (field?.rule?.blank) return null;
    if (field?.rule?.identity && !field.rule.eeo) return null;
    /**
     * Never a saved date for the start-date question.
     *
     * A start date belongs to one application. "01/01/2000", saved off an
     * earlier Workday form, was replayed into Available Start Date on every
     * application after it — a saved answer to the exact question outranks
     * the profile. A date box takes the profile's date, or today's, and
     * nothing else; a question asked in words may still take a saved answer
     * in words ("Immediately", "Two weeks"), but never a saved date.
     */
    if (field?.rule?.key === "startDate" && (isDateBox(field.el) || looksLikeCalendarDate(best.answer))) return null;

    /**
     * Never into a contact or identity box, rule or no rule.
     *
     * The guard above only fires when a rule matched. When one did not — which
     * is exactly what happened to Workday's Phone Number box — the field was
     * open to any saved answer whose question looked similar, and it collected
     * the email address. These boxes have one source: the profile.
     */
    if (/\b(e-?mail|phone|mobile|telephone|country\s*code|area\s*code|extension|first\s*name|last\s*name|middle\s*name|full\s*name|date\s*of\s*birth|address\s*line|postal|zip\s*code)\b/i
        .test(String(field?.label ?? "").split("|")[0])) {
      return null;
    }

    /**
     * For a disclosure question the saved answer has to reduce to a real
     * branch of that same question. "Yes" saved against "Name" does not, and a
     * saved answer from a differently-worded portal that lands on another
     * branch must not be carried across either.
     */
    if (field?.rule?.eeo) {
      const savedId = M.eeoId(best.answer, field.label);
      if (!savedId) return null;
      const profileId = M.eeoId(field.rule.value?.(state.profile) ?? "", field.label);
      if (profileId && profileId !== savedId) return null;
    }

    // A saved answer only helps if this control can actually hold it. For a
    // choice field, insist the answer resembles one of the offered options —
    // otherwise the write fails and the field is reported filled when it isn't.
    // A control still waiting on its parent has no options to compare against
    // yet, so it is judged later, when it has some.
    if (field && (field.kind === "select" || field.kind === "radio") &&
        field.el?.tagName === "SELECT" && M.hasRealOptions(field.el)) {
      const choices = Array.from(field.el.options || []).map((o) => M.normalizeChoiceText(o.textContent));
      const answer = M.normalizeChoiceText(best.answer);
      const usable = choices.some((o) => o && (o === answer || o.includes(answer) || answer.includes(o)));
      if (!usable) return null;
    }

    /**
     * The same test for radio and checkbox groups.
     *
     * It only ever covered <select>, so a saved answer from a portal offering
     * different wording was written into a group that had no such option: the
     * write silently failed and the field was reported filled while still
     * blank. A group whose options haven't rendered yet is left alone and
     * judged later, when it has some.
     */
    if (field && (field.kind === "radio" || field.kind === "checkbox")) {
      let choices = [];
      try { choices = Array.from(optionTextsForField(field)); } catch {}
      if (choices.length > 1) {
        const answer = M.normalizeChoiceText(best.answer);
        const usable = choices.some((raw) => {
          const o = M.normalizeChoiceText(raw);
          return o && answer && (o === answer || o.includes(answer) || answer.includes(o));
        });
        if (!usable) return null;
      }
    }
    return best;
  }

  /* ================================================================== */
  /*  Writing a value                                                    */
  /* ================================================================== */

  /**
   * Marks a control as ours so the capture listeners don't call it a user edit.
   *
   * The mark has to cover the whole choice group. A radio group is filled by
   * clicking whichever option matches, which is usually *not* the element the
   * field is anchored to — so marking the anchor alone left the clicked option
   * unguarded, its own change listener treated Appli-Fill's click as a person
   * answering, and the answer just replayed from Saved Answers was immediately
   * offered back as a new unsaved answer. Every fill re-queued everything it
   * had filled.
   */
  const PROGRAMMATIC_LEDGER_TTL = 15_000;

  function provenanceKey(field, answer) {
    let question = "";
    try { question = primaryQuestion(field); } catch {}
    const q = answerKey(question || field?.label || field?.el?.name || field?.el?.id || "");
    const a = answerKey(Array.isArray(answer) ? answer.join(", ") : String(answer ?? ""));
    return q && a ? `${q}::${a}` : "";
  }

  function rememberProgrammaticAnswer(field, answer) {
    const key = provenanceKey(field, answer);
    if (!key) return;
    state.programmaticAnswers.set(key, { answer: String(answer ?? ""), expiresAt: Date.now() + PROGRAMMATIC_LEDGER_TTL });
    // Keep the ledger tiny even on long-lived application tabs.
    if (state.programmaticAnswers.size > 300) {
      const now = Date.now();
      for (const [k, v] of state.programmaticAnswers) {
        if (v.expiresAt <= now) state.programmaticAnswers.delete(k);
      }
    }
  }

  function isKnownProgrammaticAnswer(field, answer) {
    const key = provenanceKey(field, answer);
    if (!key) return false;
    const hit = state.programmaticAnswers.get(key);
    if (!hit) return false;
    if (hit.expiresAt <= Date.now()) {
      state.programmaticAnswers.delete(key);
      return false;
    }
    return true;
  }

  function clearProgrammaticAnswer(field, answer) {
    const key = provenanceKey(field, answer);
    if (key) state.programmaticAnswers.delete(key);
  }

  function eachInGroup(el, fn) {
    let members = [el];
    try { members = groupMembersOf(el) || [el]; } catch {}
    if (!members.includes(el)) members = [el, ...members];
    for (const member of members) {
      try { fn(member); } catch {}
    }
  }

  function beginProgrammatic(el) {
    eachInGroup(el, (member) => {
      member.__applifillProgrammatic = true;
      member.__applifillProgrammaticUntil = Date.now() + 1500;
    });
  }
  function endProgrammatic(el) {
    eachInGroup(el, (member) => { member.__applifillProgrammatic = false; });
  }
  function isProgrammatic(el) {
    return Boolean(el.__applifillProgrammatic) || (el.__applifillProgrammaticUntil ?? 0) > Date.now();
  }

  /**
   * Is Appli-Fill currently writing anywhere in this control's group?
   *
   * Marking the group when a write begins is not enough on its own, because the
   * order in which a group's members are planned and filled decides which of
   * them carries the mark: filling the "Yes" radio commits its answer by
   * clicking "Prefer not to say", and if that member is filled later in the
   * pass it has not been marked yet when the click lands on it. Its change
   * listener then read Appli-Fill's own click as the applicant answering, and the
   * answer just replayed out of Saved Answers was offered straight back as a
   * new unsaved one — so every fill re-queued everything it had filled.
   *
   * Asking the whole group removes the ordering from the question entirely.
   */
  function isGroupProgrammatic(el) {
    if (isProgrammatic(el)) return true;
    let members = [];
    try { members = groupMembersOf(el) || []; } catch { return false; }
    return members.some((member) => member !== el && isProgrammatic(member));
  }

  /** A real interaction hands the whole group back to the applicant. */
  function releaseGroupToUser(el) {
    let members = [el];
    try { members = groupMembersOf(el) || [el]; } catch {}
    if (!members.includes(el)) members = [el, ...members];
    for (const member of members) {
      member.__applifillProgrammatic = false;
      member.__applifillProgrammaticUntil = 0;
    }
  }

  /**
   * Did the site actually accept the value? This is what stops Appli-Fill saying
   * "filled" while the ATS still shows "This field is required".
   */
  function verifyField(field, expected) {
    const el = field.el;
    if (field.kind === "file") return Boolean(el.files?.length);
    if (M.valuesEquivalent(el, expected, field.label)) return true;

    // Text controls reformat as you type (phone masks, date pickers), so an
    // exact match is too strict here — containment either way is enough.
    if (["text", "textarea", "email", "tel", "url", "number", "date", "month"].includes(field.kind)) {
      const actual = M.norm(el.value ?? el.textContent ?? "");
      const want = M.norm(expected);
      if (!actual || !want) return false;
      if (actual === want) return true;
      const digitsOnly = (s) => s.replace(/\D+/g, "");
      if (digitsOnly(want).length >= 4 && digitsOnly(actual) === digitsOnly(want)) return true;
      return want.length >= 3 && (actual.includes(want) || want.includes(actual));
    }
    return false;
  }

  /**
   * Has this control already been written during the pass now running?
   *
   * The rest of the engine decides "is this done?" by reading the value back,
   * which works right up until a widget renders its answer somewhere nothing
   * can read — and then a finished field looks blank and gets filled, retried
   * and re-answered. This is the backstop for that whole class of widget: once
   * a setter reports it committed something, this pass is finished with the
   * control, whatever reading it back suggests. It is scoped to one run, so a
   * deliberate second click can still have another go at a field that really
   * did stay empty.
   */
  function writtenThisRun(el) {
    return el.__applifillWrittenRun === state.runId;
  }

  /**
   * Writes one value into one control, once.
   *
   * The only retry here is for plain text inputs, where a second write costs
   * nothing and controlled React inputs occasionally swallow the first. Custom
   * dropdowns are deliberately never retried at this level — setComboboxValue
   * already searches, filters and drills inside a single opening, and calling
   * it twice is exactly what produced the visible open/close flicker.
   */
  async function applyValue(field, value, rule) {
    const el = field.el;
    if ((rule?.key ?? field.rule?.key) === "phone") {
      value = RULES.helpers.phoneForBox(value, el, RULES.helpers.phoneCodeForProfile(state.fillProfile) || state.fillProfile?.personal?.phoneCountryCode);
      if (!value) return false;
    }

    // Preserve a user-owned value, but allow an explicitly cleared control to
    // be populated again on the next manual Autofill pass.
    if (el.__applifillUserEdited && holdsOwnText(el)) return false;
    if (el.__applifillUserEdited && !holdsOwnText(el)) {
      el.__applifillUserEdited = false;
      el.__applifillProgrammatic = false;
      el.__applifillProgrammaticUntil = 0;
    }
    if (!attached(el)) return false;
    // Uploads are never written or clicked, by any path.
    if (field.kind === "file" || isUploadControl(el)) return false;
    // Already answered by this pass. Opening the same dropdown again cannot
    // improve the answer and is precisely what the user sees as autofill
    // "going back and editing the fields it just completed".
    if (writtenThisRun(el)) return true;
    // A date widget that would not show the date, in this pass.
    if (el.__applifillDateFailedRun === state.runId) return false;

    beginProgrammatic(el);
    beginWrite();
    const quirks = state.adapter?.quirks ?? {};
    let ok = false;
    // A whole date across MM / DD / YYYY boxes: its writer reads every box
    // back, and its answer is the only one that counts (see below).
    let wholeDateWritten = false;

    /**
     * A place asked for in a type-to-search box, even one drawn as a combobox.
     *
     * Ashby's Location is an `<input role="combobox">` whose suggestions only
     * exist once something is typed. As a "dropdown" it was opened, found to
     * offer nothing, and left empty; it is typed into and then completed from
     * its own suggestions instead.
     */
    const placeSearch =
      PLACE_SEARCH_KEYS.has(rule?.key ?? field.rule?.key) &&
      el.tagName === "INPUT" && Boolean(M.acceptsText?.(el)) && Boolean(M.looksLikeTypeahead?.(el));
    /**
     * A street box drawn as a list you type into, as Oracle Recruiting's
     * refreshed Address Line 1 is (`<input role="combobox">` that suggests
     * whole addresses). It is typed into and the applicant's own address is
     * picked from its suggestions — never opened as a drop-down.
     */
    const streetSearch =
      (rule?.key ?? field.rule?.key) === "address" && field.kind === "select" &&
      el.tagName === "INPUT" && Boolean(M.acceptsText?.(el)) && Boolean(M.looksLikeTypeahead?.(el));
    /**
     * A street list that keeps nothing but an address picked from it (Oracle's).
     * A Google Places box marked as a combobox (Workforce Now's Address Line 1)
     * keeps the street typed into it, picked or not, so it is never retyped
     * with the city added nor outlined for want of a pick.
     */
    const pickOnlyStreet = streetSearch && !(M.onAdp?.() && M.isPlacesBox?.(el));

    try {
      if ((rule?.key ?? field.rule?.key) === "school" && M.isWorkdayPrompt?.(el)) {
        /**
         * Workday's School or University, drawn as a search prompt: the school
         * is searched and the matching result picked. Typing it in and leaving
         * — which is all this used to do — is text Workday throws away, and
         * Save and Continue reported the field as empty.
         */
        const picked = await M.setPromptValue(el, String(value), { allowOther: true });
        ok = Boolean(picked);
        // Not on the tenant's list, answered "Other": shown as a draft to check.
        if (picked === "other") field.review = true;
        // Searched and not found: another attempt in this pass cannot change that.
        if (!picked) el.__applifillNoMatch = true;
      } else if ((rule?.key ?? field.rule?.key) === "howDidYouHear" && M.isWorkdayPrompt?.(el)) {
        /**
         * Workday's "How Did You Hear About Us?" is a prompt too, often in
         * categories ("Job Board ›", "Social Media ›"). The profile's answer is
         * searched or browsed for and picked, so a pill appears — typed text
         * in the search box is refused on Save and Continue.
         */
        ok = Boolean(await M.setPromptChoice(el, String(value), { synonyms: rule?.options ?? field.rule?.options }));
        if (!ok) el.__applifillNoMatch = true;
      } else if (M.isSdfField?.(el)) {
        /**
         * One of ADP's SDF components — a list, a radio group or a check box —
         * answered through the component and read back from it. See
         * `setSdfSelectValue`.
         */
        const synonyms = rule?.options ?? field.rule?.options;
        if (field.kind === "select") ok = await M.setSdfSelectValue(el, value, { synonyms, hint: field.label, force: (rule?.key ?? field.rule?.key) === "phoneCountryCode" });
        else if (field.kind === "radio") ok = await M.setSdfRadioValue(el, value, { synonyms, hint: field.label });
        else ok = await M.setSdfCheckbox(el, value);
        // A list with no such choice: opening it again cannot change that.
        if (!ok && field.kind === "select") el.__applifillNoMatch = true;
      } else if (field.kind === "select" && M.isOracleSelect?.(el)) {
        /**
         * One of Oracle Recruiting's list boxes (Candidate Experience's own,
         * or Oracle JET's): the answer is picked from its list and the box read
         * back — see `setOracleSelectValue`. Address Line 1 is Oracle's address
         * search: the applicant's own address is picked from it, which is what
         * fills ZIP Code, City, State and County.
         */
        const key = rule?.key ?? field.rule?.key;
        if (key === "address") {
          const personal = state.fillProfile?.personal ?? {};
          el.__applifillStreetPick = { run: state.runId, picked: false };
          let picked = null;
          try { picked = await M.pickOracleAddress(el, String(value), { city: personal.city, state: personal.state, zip: personal.zip }); } catch {}
          ok = Boolean(picked);
          if (ok) {
            el.__applifillStreetPick = { run: state.runId, picked: true };
            await keepUnitAfterPick(field, String(value));
          } else {
            /**
             * Oracle's search found no such address. A person would type the
             * street and move on; where Oracle keeps a street typed that way,
             * that is the answer (the apartment goes to Address Line 2), and
             * ZIP Code, City, State and County are chosen below. Where it
             * throws the text away, the box is outlined for the applicant.
             */
            const hasLine2 = (state.allFields ?? []).some((f) => f.rule?.key === "addressLine2" && attached(f.el));
            const typedStreet = hasLine2 ? M.streetWithoutUnit?.(String(value)) : String(value).split(",")[0].trim();
            let kept = false;
            // An Oracle JET list keeps nothing typed into it, ever.
            if (typedStreet && !M.isJetSelect?.(el) && M.setTextValue(el, typedStreet)) {
              await sleep(450);
              kept = M.norm(el.value ?? "") === M.norm(typedStreet) && !M.oracleFieldInvalid?.(el);
            }
            ok = kept;
            if (kept) {
              await keepUnitAfterPick(field, String(value));
            } else {
              field.streetNotPicked = true;
              el.__applifillNoMatch = true;
            }
          }
        } else {
          ok = await M.setOracleSelectValue(el, value, { synonyms: rule?.options ?? field.rule?.options, hint: field.label, force: key === "phoneCountryCode", ...oracleListSearch(key, value) });
        }
      } else if (field.kind === "select" && !placeSearch && !streetSearch) {
        const key = rule?.key ?? field.rule?.key;
        const hint = key === "fieldOfStudy" ? `Field of Study | ${field.label}` : field.label;
        const place = key === "city" || (key === "location" && state.adapter?.key === "greenhouse");
        const context = place ? { place: true, placeHint: state.fillProfile?.personal } :
          key === "phoneCountryCode" ? { force: true } : null;
        ok = el.tagName === "SELECT"
          ? M.setSelectValue(el, value, rule?.options, hint, context)
          : await M.setComboboxValue(el, value, quirks.dropdownDelay ?? 900, rule?.options, hint, context);
      } else if (field.kind === "radio") {
        ok = M.setRadioValue(el, value, rule?.options, field.label);
      } else if (field.kind === "checkbox") {
        ok = M.setCheckboxValue(el, value, rule?.options, field.label);
      } else if (field.kind === "file" || isUploadControl(el)) {
        /**
         * Never. A résumé or any other upload is left empty for the applicant,
         * whatever reaches this point and whatever the settings say — the
         * planner already refuses uploads, and this makes it impossible for any
         * other path (a retry, the settle pass, a draft) to attach a document
         * or click the control that opens the file chooser.
         */
        ok = false;
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // A document object or anything else that is not an answer is never typed.
        ok = false;
      } else {
        const key = rule?.key ?? field.rule?.key;
        // A box answered by picking one of its own suggestions keeps the caret
        // while they arrive: typing and then blurring at once is what emptied
        // Oracle's City and closed Lever's list before anything was picked.
        const searchBox = (placeSearch || PLACE_SEARCH_KEYS.has(key) || key === "address") &&
          Boolean(M.looksLikeTypeahead?.(el));
        // A whole date across Workday's MM / DD / YYYY boxes goes in one box at
        // a time and is read back — see `setSegmentedDateAsync`. A box's own
        // number is written as before.
        const wholeDate = !searchBox && !/^\d{1,4}$/.test(String(value).trim()) &&
          (M.dateSegmentNodes?.(el)?.length ?? 0) >= 2 && typeof M.setSegmentedDateAsync === "function";
        if (wholeDate) {
          wholeDateWritten = true;
          ok = await M.setSegmentedDateAsync(el, String(value));
          // The widget would not show the date: its boxes are outlined for the
          // applicant, and not tried again box by box in this pass.
          if (!ok) for (const box of M.dateSegmentNodes?.(el) || []) box.__applifillDateFailedRun = state.runId;
        } else {
          ok = M.setTextValue(el, String(value), { keepFocus: searchBox });
          if (!ok) { await sleep(60); ok = M.setTextValue(el, String(value), { keepFocus: searchBox }); }
        }
        /**
         * A place typed into a type-to-search box is only an answer once one
         * of the box's own suggestions is picked — Lever's "Current location"
         * submits the hidden place it stores on that click, and typing alone
         * left the list open under a box the page still counted as empty.
         */
        if (ok && searchBox && PLACE_SEARCH_KEYS.has(key)) {
          let picked = null;
          const home = key === "city" || key === "location";
          const placeHint = home ? state.fillProfile?.personal : null;
          const cityOnly = key === "city" || (key === "location" && state.adapter?.key === "greenhouse");
          try { picked = await M.completeTypeahead(el, String(value), { placeHint, cityOnly }); } catch {}
          // It offered suggestions and none is the applicant's place: the text
          // stays, and the box is outlined for them to choose from its list.
          // (null: it never behaved like a search box, and is left as typed.)
          if (picked === false) field.needsPick = true;
          if (picked === null) commitTyped(el);
          /**
           * Lever submits only a place picked from its list. Typed text with
           * nothing picked is refused when the application is sent, so it is
           * never reported as done: the box is outlined, and the pick is
           * finished as soon as the applicant clicks into it (or Lever's list
           * turns up late, after its human check).
           */
          if (picked !== true && M.leverLocationPicked?.(el) === false) {
            field.needsPick = true;
            watchLatePlacePick(field, String(value));
          }
        } else if (ok && searchBox && key === "address") {
          // Oracle's Address Line 1: the suggestion that is the applicant's own
          // address is picked, which also fills ZIP Code, City, State and County.
          el.__applifillStreetPick = { run: state.runId, picked: false };
          const personal = state.fillProfile?.personal ?? {};
          const near = { zip: personal.zip, city: personal.city };
          let picked = null;
          try { picked = await M.completeAddressSuggestion(el, String(value), near); } catch {}
          /**
           * Not among the suggestions for the street alone: the street with
           * its city and state, which is how the address search narrows down
           * to one place ("4685 Old Oaks Dr, Jacksonville, FL").
           */
          if (typeof picked !== "string" && pickOnlyStreet) {
            const fuller = [String(value), personal.city, personal.state].map((v) => String(v ?? "").trim()).filter(Boolean).join(", ");
            const stale = new Set(M.suggestionTexts?.(el) || []);
            if (fuller !== String(value).trim() && M.setTextValue(el, fuller, { keepFocus: true })) {
              try { picked = await M.completeAddressSuggestion(el, fuller, { ...near, stale }); } catch {}
            }
          }
          if (typeof picked === "string") {
            el.__applifillStreetPick = { run: state.runId, picked: true };
            await keepUnitAfterPick(field, String(value));
          } else {
            commitTyped(el);
            // A list box keeps only an address picked from it: outlined for
            // the applicant, not counted as filled, and not typed into again
            // by the passes that restore cleared boxes — only a pick helps.
            if (pickOnlyStreet) {
              field.streetNotPicked = true;
              el.__applifillNoMatch = true;
            }
          }
        }
      }
    } catch {
      ok = false;
    } finally {
      endWrite();
    }

    // Setters commit synchronously; a short yield lets a controlled component
    // re-render before the value is read back. It used to be 40ms per field.
    await sleep(field.kind === "select" || field.kind === "radio" || field.kind === "checkbox" ? 12 : 4);
    // A row of Yes / No buttons marks the pressed one a moment after the click
    // (Ashby paints its "active" state on the next render). Read too early, an
    // answered question looks blank and is counted as a failure.
    if (ok && field.kind === "radio" && M.isChoiceButton?.(el) && !M.hasValue(el)) {
      for (let waited = 0; waited < 600 && !M.hasValue(el); waited += 40) await sleep(40);
    }
    // The setter reported that it committed a value. Even if we cannot read it
    // back, the control has been interacted with and must not be touched again
    // in this pass.
    if (ok) {
      if ((rule?.key ?? field.rule?.key) === "phoneCountryCode") {
        el.__applifillPhoneCodeCommitted = String(value);
        // Phone widgets often recreate/clear the number input when their
        // calling country changes. Finish that transition before typing it.
        if (field.kind === "select" || M.isSdfSelect?.(el)) await sleep(100);
      }
      el.__applifillWrittenRun = state.runId;
      // Kept so the settle pass can put the value back if the page throws it
      // away while finishing its own rendering.
      try {
        // `readable` records whether the value could be read back straight after
        // the write. A widget we cannot read is indistinguishable from one the
        // page cleared, so restoring it would just re-open the same dropdown on
        // every settle pass — visible flicker for a result that cannot change.
        let readable = false;
        try { readable = M.hasValue(el); } catch {}
        (state.applied ??= new Map()).set(el, { field, value, rule, readable });
      } catch {}
      // Remembered so the answer sweep can tell our own writing apart from the
      // applicant's. Without it, every field Appli-Fill filled would be queued as
      // though they had answered it by hand. Recorded on every member of a
      // choice group, because the option actually clicked is rarely the element
      // the field is anchored to.
      const written = typeof value === "object" ? null : String(value);
      let settled = "";
      try { settled = String(readValue(field) ?? "").trim(); } catch {}
      eachInGroup(el, (member) => {
        member.__applifillWrittenValue = written;
        // What the control showed straight after the write is Appli-Fill's answer
        // too — "FL" for "Florida", the long CC-305 wording for "No", the
        // suggestion a location box settled on.
        member.__applifillWrittenValues = [written, settled].filter(Boolean);
        // The sweep compares against this to decide whether a value changed. A
        // fill is a change it must not read as the applicant answering, so the
        // baseline moves with the write.
        member.__applifillBaselineValue = settled;
        // A fill is not an edit. Clearing this stops a later blur on a control
        // Appli-Fill just wrote from banking the value it wrote.
        member.__applifillUserEdited = false;
      });
      // DOM nodes are disposable on modern ATS pages. Keep provenance by
      // question+answer as well, so a trusted trailing event on a freshly
      // rendered node cannot turn our own fill into a pending manual answer.
      rememberProgrammaticAnswer(field, value);
      if (settled && settled !== written) rememberProgrammaticAnswer(field, settled);
    }
    // Written — or at least attempted — now. Only a touch after this moment
    // makes whatever the control shows the applicant's.
    const writtenAt = Date.now();
    eachInGroup(el, (member) => { member.__applifillWrittenAt = writtenAt; });

    /**
     * A whole date written across a MM / DD / YYYY widget answered every box of
     * it. The other boxes are the same answer: they are not written again in
     * this pass, and what they now show is Appli-Fill's, not the applicant's.
     */
    if (ok && typeof value === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value.trim())) {
      let boxes = null;
      try { boxes = M.dateSegmentNodes?.(el); } catch {}
      for (const box of boxes || []) {
        if (box === el) continue;
        const shown = String(box.value ?? "");
        box.__applifillWrittenRun = state.runId;
        box.__applifillWrittenAt = writtenAt;
        box.__applifillUserEdited = false;
        box.__applifillWrittenValue = shown;
        box.__applifillWrittenValues = shown ? [shown] : [];
        box.__applifillBaselineValue = shown;
      }
    }

    // Each setter self-verifies; verifyField is an independent second opinion.
    // A field counts as filled when the strict check passes, or when the setter
    // succeeded and the control now visibly holds something.
    //
    // Not for one box of a whole date: its "01" is contained in "10/01/2026",
    // so a widget left showing 01/01/2000 passed the check and was reported as
    // filled. The date's writer has read every box back already.
    const verified = wholeDateWritten ? ok : verifyField(field, value);
    const filled = wholeDateWritten ? ok : (verified || (ok && M.hasValue(el)));
    setTimeout(() => endProgrammatic(el), 0);
    return Boolean(filled);
  }

  /**
   * Finish a place pick the page could not offer during the fill.
   *
   * Lever lists places only while its box has the caret, and its lookup can
   * be held up behind an hCaptcha check. When the fill had to leave the box
   * with the place typed but not picked, this waits — for up to two minutes —
   * for the applicant to click into the box, then asks Lever for the place
   * again and picks it. It stops as soon as a place is picked (by either of
   * them) or the applicant types something else.
   */
  const LATE_PICK_MS = 120_000;
  function watchLatePlacePick(field, typed) {
    const el = field.el;
    if (!el || el.__applifillLatePick) return;
    el.__applifillLatePick = true;
    const until = Date.now() + LATE_PICK_MS;
    let busy = false;
    let timer = null;
    let focusTimer = null;
    let typedByHandAt = 0;
    const same = (a, b) => M.norm(String(a ?? "")) === M.norm(String(b ?? ""));
    const stop = () => {
      el.__applifillLatePick = false;
      clearInterval(timer);
      clearTimeout(focusTimer);
      try {
        el.removeEventListener("focus", onFocus, true);
        el.removeEventListener("keydown", onKey, true);
        el.removeEventListener("paste", onKey, true);
      } catch {}
    };
    const settled = () => {
      if (M.leverLocationPicked?.(el) === true) {
        unmark(el);
        flash(el);
        state.unmatched = (state.unmatched ?? []).filter((f) => f.el !== el);
        return true;
      }
      return false;
    };
    const attempt = async ({ retype }) => {
      if (busy || state.filling) return;
      if (!attached(el) || Date.now() > until) return stop();
      if (settled()) return stop();
      const startedAt = Date.now();
      // The applicant is typing their own place: it is theirs to finish.
      if (typedByHandAt) return stop();
      const shown = String(el.value ?? "");
      if (shown && !same(shown, typed)) return stop();
      busy = true;
      // Everything the box shows from here on is Appli-Fill's, until the applicant
      // types — the click that brought them here is not an edit.
      el.__applifillWrittenAt = startedAt;
      beginProgrammatic(el);
      beginWrite();
      try {
        const picked = await M.completeTypeahead(el, typed, {
          retypeFirst: retype, waitMs: 2500, abort: () => typedByHandAt > startedAt,
        });
        if (picked === true && !typedByHandAt) {
          const shownNow = String(el.value ?? "");
          el.__applifillWrittenAt = Date.now();
          el.__applifillWrittenValue = typed;
          el.__applifillWrittenValues = [typed, shownNow].filter(Boolean);
          el.__applifillBaselineValue = shownNow;
          el.__applifillUserEdited = false;
          rememberProgrammaticAnswer(field, typed);
          if (shownNow) rememberProgrammaticAnswer(field, shownNow);
        }
      } catch {} finally {
        endWrite();
        setTimeout(() => endProgrammatic(el), 0);
        busy = false;
      }
      if (settled() || typedByHandAt) stop();
    };
    function onKey(event) {
      if (!event?.isTrusted) return;
      // Moving about the list is not typing a place.
      if (event.type === "keydown" && /^(Tab|Shift|Control|Alt|Meta|Arrow\w+|Escape|Enter)$/.test(event.key || "")) return;
      typedByHandAt = Date.now();
      clearTimeout(focusTimer);
    }
    function onFocus(event) {
      if (!event?.isTrusted) return;
      // A moment first: a click that is the start of typing a different place
      // must not be answered by retyping ours over it.
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => attempt({ retype: true }), 450);
    }
    try {
      el.addEventListener("focus", onFocus, true);
      el.addEventListener("keydown", onKey, true);
      el.addEventListener("paste", onKey, true);
    } catch {}
    // The list may also come back by itself once Lever's check clears.
    timer = setInterval(() => {
      if (Date.now() > until || !attached(el)) return stop();
      if (settled()) return stop();
      if (!busy && !typedByHandAt && M.holdsFocus?.(el) && (M.suggestionRowsFor?.(el) ?? []).length) attempt({ retype: false });
    }, 700);
  }

  /**
   * Typed text that no suggestion replaced is committed the ordinary way: the
   * box is left, which is what makes the browser report the change.
   */
  function commitTyped(el) {
    let changed = false;
    const note = () => { changed = true; };
    try { el.addEventListener("change", note, true); } catch {}
    try { if (M.holdsFocus?.(el)) el.blur?.(); } catch {}
    try { el.removeEventListener("change", note, true); } catch {}
    if (!changed) { try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {} }
  }

  /**
   * The apartment a picked address suggestion dropped.
   *
   * Oracle's suggestion is the building — "1200 HARBOR VIEW DR" — and picking
   * it replaces Address Line 1 without "Apt 305". The unit goes into Address
   * Line 2 when the form has one that is empty and not about to be filled from
   * the profile.
   */
  async function keepUnitAfterPick(field, typed) {
    const unit = M.parseStreet?.(typed)?.unit;
    if (!unit) return false;
    if (M.norm(field.el.value ?? "").includes(M.norm(unit))) return false;
    const line2 = (state.allFields ?? []).find((f) =>
      f.rule?.key === "addressLine2" && attached(f.el) && (f.index ?? 0) === (field.index ?? 0));
    if (!line2 || M.hasValue(line2.el) || line2._plan?.status === "fill") return false;
    let ok = false;
    try { ok = await applyValue(line2, unit, line2.rule); } catch {}
    if (ok) {
      unmark(line2.el);
      flash(line2.el);
    }
    return ok;
  }

  function collectRequiredErrors() {
    const nodes = Array.from(document.querySelectorAll(
      '[aria-invalid="true"], .error, .field-error, [class*="error"], [data-automation-id*="error"], [role="alert"]'
    ));
    return nodes.filter((n) => {
      const text = (n.textContent || "").trim();
      return text && /required|please select|please enter|invalid|must be/i.test(text) && n.getBoundingClientRect().height > 0;
    }).map((n) => (n.textContent || "").trim()).slice(0, 30);
  }

  /* ================================================================== */
  /*  Planning — decide every value before touching the page             */
  /* ================================================================== */

  /**
   * Returns what this field should contain, and where the answer came from,
   * without writing anything. Doing the whole form's thinking first is what
   * lets the write phase be a single uninterrupted sweep.
   */
  function instructedNA(field) {
    const el = field.el;
    if (isPasswordControl(el) || !["text", "textarea", "select"].includes(field.kind)) return null;
    if (el.tagName === "INPUT" && !["text", ""].includes(el.type)) return null;
    const own = String(field.label || "").split("|")[0];
    const help = (el.getAttribute("aria-describedby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const text = `${own} ${help}`;
    if (/\b(?:do\s+not|don't|never|must\s+not)\s+(?:enter|indicate|type|write|use|put|provide)\s+["'“”‘’]*(?:n\s*\/\s*a|not applicable)\b|\bn\s*\/\s*a\s+(?:is\s+)?not\s+(?:allowed|accepted|permitted)/i.test(text)) return null;
    return /\b(?:enter|indicate|type|write|use|put|provide)\s+(?:(?:the\s+)?(?:answer|value)\s+)?["'“”‘’]*(?:n\s*\/\s*a|not applicable)\b/i.test(text)
      ? { status: "fill", key: "instructedNA", value: "N/A", rule: null, source: "instruction" } : null;
  }

  function planField(field, profile, settings) {
    const { el, label, kind } = field;

    // A non-empty field that the applicant edited is theirs and must never be
    // overwritten on a later Fill click. If they explicitly cleared it, however,
    // the field is empty again and should be eligible for Autofill on that next
    // explicit click.
    if (el.__applifillUserEdited && holdsOwnText(el)) return { status: "skipped" };
    if (el.__applifillUserEdited && !holdsOwnText(el)) {
      el.__applifillUserEdited = false;
      el.__applifillProgrammatic = false;
      el.__applifillProgrammaticUntil = 0;
    }

    // Written a moment ago by this same pass. Nothing that happens later in the
    // run — a re-scan, a reconcile, the AI pass — may plan it a second time.
    if (writtenThisRun(el)) return { status: "already", key: field.rule?.key ?? null };

    /**
     * Nothing in the fill touches an upload.
     *
     * Not written, and not counted as a gap either — whichever rule matched it
     * and whatever the profile holds. Attaching the right document is the one
     * decision on an application worth leaving to the applicant, and a dashed
     * "needs your answer" outline over a Workday upload only reads as Appli-Fill
     * having tried and failed at it.
     */
    if (kind === "file") return { status: "skipped", key: field.rule?.key ?? null };

    // An answered question is finished. Appli-Fill does not second-guess a value
    // that is already in the form — whether the applicant typed it, the portal
    // prefilled it, or an earlier run put it there. Running autofill again
    // therefore only ever fills what is still blank.
    // …except a start date that has already passed ("01/01/2000", left by an
    // old saved answer): it is replaced with the profile's date or today's.
    const staleStart = field.rule?.key === "startDate" && isDateBox(el) && shownStartDateIsPast(el);
    let initializePhoneCode = false;
    if (field.rule?.key === "phoneCountryCode") {
      const expected = RULES.helpers.phoneCodeForProfile(profile);
      const current = RULES.helpers.phoneCodeOfControl(el);
      const row = el.closest?.('.phone-number-input, [role="group"], .input-row, adp-form-group') || el.parentElement;
      let numberPresent = Array.from(row?.querySelectorAll?.('input[type="tel"], input[name*="phone" i], input[id*="phone" i]') || [])
        .some((node) => node !== el && !M.isPhoneCodeControl?.(node) && M.hasValue(node));
      if (!numberPresent) {
        const form = el.closest?.("form");
        const phoneFields = (state.allFields || []).filter((f) => f.rule?.key === "phone" &&
          (!form || form.contains(f.el)));
        if (phoneFields.length === 1) numberPresent = M.hasValue(phoneFields[0].el);
      }
      initializePhoneCode = Boolean(expected && !numberPresent &&
        (current !== expected || ((M.onAdp?.() || M.isOracleSelect?.(el)) && el.__applifillPhoneCodeCommitted !== expected)));
    }
    if (/^(?:experience|education|graduation)/.test(field.rule?.key || "")) {
      const pieces = M.oracleDateControls?.(el) || [];
      if (pieces.some((piece) => piece.__applifillUserEdited && M.hasValue(piece))) return {status: "skipped", key: field.rule.key};
      if (pieces.length >= 2 && pieces.some((piece) => !M.hasValue(piece)) && !pieces.some((piece) => piece.__applifillUserEdited)) field.repairPartialDate = true;
    }
    if (kind !== "file" && M.hasValue(el) && settings?.overwriteExisting !== true && !staleStart && !initializePhoneCode && !field.repairPartialDate) {
      return { status: "already", key: field.rule?.key ?? null };
    }

    let rule = field.rule;
    if (rule?.key === "phoneCountryCode") rule = { ...rule, options: RULES.helpers.phoneCodeOptions(profile) };
    const canReuse = settings?.reuseSavedResponses !== false && kind !== "file";

    // Oracle fills ZIP Code, City, State and County itself from the address
    // picked in Address Line 1. They are left to it — see `streetFillsRest` —
    // unless no address could be picked there (`streetFallback`).
    if (STREET_FILLED_KEYS.has(rule?.key) && !field.streetFallback && streetFillsRest(el)) {
      return { status: "skipped", key: rule.key, reason: "filled-from-address" };
    }

    // A field the rule table says has no answer for an applicant — "Employee ID
    // (if applicable)" is the standing example. Returning early keeps it away
    // from saved answers and the AI pass as well as from the profile, which is
    // the only way it stays genuinely blank.
    if (rule?.blank) return instructedNA(field) || { status: "skipped", key: rule.key };

    let profileValue;
    if (rule) {
      // Eligibility polarity must come from this question, never a nearby
      // question or section included in the joined discovery label.
      let valueLabel = label;
      if (rule.profileOnly && !ROW_KEYS.has(rule.key)) {
        const own = String(label ?? "").split("|")[0].trim();
        // Long legal prompts can exceed the capture label's length limit.
        // Keep their real wording instead of accepting a machine-name fallback
        // such as "q auth 0", which loses "without sponsorship" entirely.
        if (own && !ANSWER_LIKE_RE.test(own) && !looksMachineGenerated(own) &&
            !/^(?:dropdown|text field)$/i.test(own)) valueLabel = own;
        else { try { valueLabel = primaryQuestion(field) || label; } catch {} }
      }
      try { profileValue = rule.value(profile, el, valueLabel, field.index ?? 0); } catch { profileValue = null; }
      if (rule.key === "location" && state.adapter?.key === "greenhouse" && !profile?.personal?.city) profileValue = null;
    }

    /**
     * Documents are never attached, and never typed.
     *
     * The resume and cover-letter rules answer with a marker rather than text.
     * With the old "attach my resume" switch on, a typed cover-letter box was
     * handed the document object itself and filled with "[object Object]"; with
     * it off, an upload was still sometimes driven. The upload stays empty for
     * the applicant, whatever the settings say.
     */
    if (profileValue === "__RESUME__" || profileValue === "__COVER_LETTER__") {
      return { status: "skipped", key: rule?.key ?? null };
    }

    // A fuzzy response cannot outrank a known profile value. An indexed exact
    // lookup is sufficient here, rather than scanning every saved question.
    const saved = canReuse ? findSavedAnswer(field, { exactOnly: Boolean(profileValue) }) : null;

    const protectedIdentity =
      Boolean(rule?.identity && !rule?.eeo) ||
      PROTECTED_LABEL_RE.test(String(field?.label ?? "").split("|")[0]);

    /**
     * Where each answer comes from, in order:
     *
     *   1. the applicant's own saved answer to *this exact question*;
     *   2. the profile;
     *   3. a saved answer to a closely similar question.
     *
     * The order used to let any saved answer — exact or merely similar — beat
     * the profile, except on "profile-only" rules, where the applicant's saved
     * answer was ignored even when it was for the very same question. Those
     * rules match on keywords, and a keyword is not a question: "Have you ever
     * been employed by the Federal Government?" was answered as "have you
     * worked *here* before", overriding the answer the applicant had saved for
     * that exact wording. Their own answer to the same question now comes
     * first; a similar-looking one never outranks the profile.
     *
     * Contact and identity boxes, and the rows of a work or education history,
     * are the exception: they come from the profile, and a saved answer only
     * fills one the profile leaves empty.
     */
    const profileFirst = protectedIdentity || ROW_KEYS.has(rule?.key) ||
      (Boolean(profileValue) && (PAGE_FILLED_KEYS.has(rule?.key) || ["address", "addressLine2", "location"].includes(rule?.key)));

    if (saved?.answer && saved.exact && !profileFirst) {
      return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
    }
    if (rule?.key === "phone" && !profileValue && saved?.answer && saved.exact) {
      return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
    }

    if (rule) {
      if (profileValue) return { status: "fill", key: rule.key, value: profileValue, rule, source: "profile" };

      /**
       * A field whose only legitimate source is the profile. If the profile
       * does not have it, it stays empty — no similar saved answer from a
       * different application, no generated sentence. A question the applicant
       * has to answer (age, eligibility, consent) is highlighted for them; the
       * rows of a work history are simply left alone.
       */
      if (!saved?.answer) {
        const na = instructedNA(field);
        if (na) return na;
      }

      if (rule.profileOnly) {
        /**
         * …except the applicant's own answer to this same question, asked by
         * another company: "Do you have any relatives employed by Globex?"
         * saved on one application is the answer to "…employed by Acme?" on
         * the next. The words are the same, only the company differs; a yes
         * for one named company is never carried to another (see
         * `savedAnswerAcrossEmployers`).
         */
        if (saved?.answer && saved.sameQuestion && SAVED_ACROSS_EMPLOYER_KEYS.has(rule.key)) {
          return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
        }
        return ELIGIBILITY_KEYS.has(rule.key) || (rule.onlyChoice && M.isRequired?.(el))
          ? { status: "unmatched", key: rule.key }
          : { status: "skipped", key: rule.key };
      }

      /**
       * A box most applicants leave empty — Middle Name, Title, Suffix, Address
       * Line 2. With nothing in the profile it stays empty, and is outlined
       * only when the form marks it required: an outline on an optional Title
       * reads as Appli-Fill having failed at it.
       */
      if (rule.optional) {
        let required = false;
        try { required = Boolean(M.isRequired?.(el)); } catch {}
        if (!required) return { status: "skipped", key: rule.key };
      }

      // No profile value: a close saved answer is the next best source.
      if (saved?.answer && !protectedIdentity) {
        return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
      }

      // Voluntary self-identification. Declining is a permitted answer, but it
      // is still an answer the applicant did not give, so it is opt-in and off
      // by default. Without it the question is left blank for them.
      if (rule.eeo && rule.decline && settings?.eeoFallbackDecline === true) {
        return { status: "fill", key: rule.key, value: rule.decline, rule, source: "decline" };
      }

      return { status: "unmatched", key: rule.key };
    }

    if (saved?.answer) {
      return { status: "fill", key: "saved-answer", value: saved.answer, rule: null, source: "saved" };
    }

    // Nothing known. The field stays empty — a guess on a real application is
    // worse than a blank the applicant can see and fill in.
    return instructedNA(field) || { status: "unmatched" };
  }

  /* ================================================================== */
  /*  Premium                                                            */
  /* ================================================================== */

  /**
   * Which profile each job was filled with, so it is chosen once per job.
   *
   * Every Fill click used to wait on a model call to score the profiles before
   * a single field was written — on every step of a Workday application, for
   * up to fifteen seconds when the service was slow. The choice is now made
   * once per job, never waits more than a few seconds (the active profile is
   * used if the score isn't back), and every later step reuses it, so one
   * application is never filled from two profiles.
   */
  const profileChoices = new Map();   // job -> { profileId, scoring }
  const SCORE_WAIT_MS = 4000;

  function jobKey(meta) {
    const path = String(location.pathname || "").replace(/\/(apply|application)(\/.*)?$/i, "");
    return `${location.hostname}${path}|${meta?.company ?? ""}`;
  }

  async function pickProfile(session, meta) {
    const profiles = session.profiles ?? [];
    if (!session.premium || profiles.length < 2) return { profile: session.profile, scoring: null };

    const key = jobKey(meta);
    const remembered = profileChoices.get(key);
    if (remembered) {
      const again = profiles.find((p) => p._id === remembered.profileId);
      if (again) return { profile: again, scoring: remembered.scoring };
    }

    let timer = null;
    const res = await Promise.race([
      send({
        type: "APPLI_FILL_SCORE",
        payload: { jobTitle: meta.jobTitle, company: meta.company, jobDescription: meta.description },
      }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), SCORE_WAIT_MS); }),
    ]);
    clearTimeout(timer);

    let choice = { profile: session.profile, scoring: null };
    const best = res?.ok && res.data?.best ? profiles.find((p) => p._id === res.data.best.profileId) : null;
    if (best) {
      choice = {
        profile: best,
        scoring: { score: res.data.best.score, reason: res.data.best.reason, label: best.label },
      };
    }
    if (choice.profile?._id) profileChoices.set(key, { profileId: choice.profile._id, scoring: choice.scoring });
    return choice;
  }

  /**
   * Questions the model must never be asked.
   *
   * A voluntary self-identification block is the worst possible place for a
   * generated answer: every field in it is a factual declaration on a federal
   * form, and the model has the disability question sitting in its context when
   * it reads the neighbouring "Name" box. That is exactly what happened — the
   * Name field came back "Yes" and Employee ID came back with the applicant's
   * name. Both are now unreachable, three ways over:
   *
   *   - any rule marked `identity` (names, contact details, dates, all EEO);
   *   - any field whose label mentions self-identification, whatever it matched;
   *   - any choice control inside a self-identification section.
   *
   * These questions are answerable from the profile or not at all.
   */
  const SELF_ID_LABEL_RE =
    /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number\s*1250|voluntary\s+disclosure|equal\s+employment\s+opportunity|eeo)/i;

  /**
   * Declarations only the applicant can make.
   *
   * Criminal history, dismissals, debarment, health, religion and the like are
   * statements of fact about the applicant's past or person. A draft is never
   * the right source for them: the applicant's own saved answer to the exact
   * question is used when there is one, and otherwise the question waits for
   * them, highlighted.
   */
  const SENSITIVE_QUESTION_RE =
    /\b(convict\w*|felon\w*|misdemeanou?r\w*|criminal|arrest\w*|plead(ed)?\s+(guilty|no\s+contest)|probation|parole|offen[cs]es?|sex\s+offender|court[-\s]martial\w*|dishonou?rabl\w*|terminated|fired|dismissed|discharged\s+from|asked\s+to\s+resign|disciplin\w*|debarred|suspended\s+from|bankrupt\w*|restraining\s+order|medical\s+condition|pregnan\w*|religio\w*|marital|sexual\s+orientation|date\s+of\s+birth|social\s+security|ssn|national\s+origin|genetic)\b/i;

  /**
   * Profile-only questions the model may still answer from the history.
   *
   * "Have you worked for Leidos?" has a factual answer in the applicant's own
   * list of employers, which the model is shown; legal status, age and consent
   * do not, and stay with the profile or the applicant.
   */
  // The relatives question went to the model as a draft before the profile had
  // an answer for it; with the profile silent it still does, shown as a draft.
  const AI_READABLE_PROFILE_KEYS = new Set(["previouslyEmployed", "relativesEmployed"]);

  function offLimitsToAi(field) {
    if (field.rule?.identity || field.rule?.eeo || field.rule?.blank) return true;
    if (PAGE_FILLED_KEYS.has(field.rule?.key) || ["address", "addressLine2", "location"].includes(field.rule?.key)) return true;
    // Age, eligibility, consent and citizenship are declarations: the profile
    // or the applicant answers them, never a draft.
    if (field.rule?.profileOnly && !AI_READABLE_PROFILE_KEYS.has(field.rule.key)) return true;
    if (ROW_KEYS.has(field.rule?.key)) return true;
    if (isUploadControl(field.el)) return true;
    if (SELF_ID_LABEL_RE.test(field.label || "")) return true;
    if (SENSITIVE_QUESTION_RE.test(questionForAi(field))) return true;
    try {
      const section = M.visibleText(field.el.closest("fieldset, section, [role='group']"));
      if (section && SELF_ID_LABEL_RE.test(section)) return true;
    } catch {}
    return false;
  }

  /**
   * The question text the answer service is asked.
   *
   * `field.label` is a derivation aid, not a question: it is every source of
   * text about the control joined with " | " — the visible label, the
   * placeholder, `data-automation-id`, the autocomplete token, the section
   * heading, and the humanized `name` and `id`. Sending that blob cost three
   * things at once. The model was shown placeholder chatter and machine names
   * as if they were part of what was being asked. The route's identity guard
   * ran over the blob, so a harmless question sitting inside a section headed
   * "Voluntary Self-Identification" was refused on its neighbours' words. And
   * the route normalizes the question to look up what this applicant has
   * answered before — a blob normalizes to nothing any stored key matches, so
   * the saved-answer memory never fired for a drafted answer.
   *
   * `primaryQuestion` is the same resolution the capture path already uses to
   * decide what a control is asking, which also means a question drafted here
   * and a question banked later agree on their wording.
   */
  function questionForAi(field) {
    let question = "";
    try { question = primaryQuestion(field) || ""; } catch {}
    if (!question) {
      question = String(field?.label ?? "").split("|")[0].trim();
    }
    return question.slice(0, 300);
  }

  /** Why the answer pass will not run, or null when it will. */
  function aiGate(session, settings) {
    // On unless the applicant turned it off: the dashboard default is on, and
    // an older sync that carries no setting at all must not read as "off".
    if (settings?.aiAnswers === false) return "off";
    if (!session?.premium) return "premium";
    return null;
  }

  /** The blank questions worth asking about, one control per question. */
  function aiTargets(fields, exclude = new Set()) {
    const seen = new Set();
    const out = [];
    for (const f of fields ?? []) {
      if (!f?.el || exclude.has(f.el)) continue;
      if (f.kind === "file" || !attached(f.el)) continue;
      if (M.hasValue(f.el) || f.el.__applifillUserEdited || writtenThisRun(f.el)) continue;
      if (offLimitsToAi(f)) continue;
      const q = questionForAi(f);
      if (q.length < 4 || q.length > 300) continue;
      // A radio or checkbox group is one question however many controls it has.
      let members = [f.el];
      try { if (f.kind === "radio" || f.kind === "checkbox") members = groupMembersOf(f.el); } catch {}
      if (members.some((m) => seen.has(m))) continue;
      members.forEach((m) => seen.add(m));
      out.push(f);
      if (out.length >= 40) break;
    }
    return out;
  }

  /**
   * Each question with the choices it offers, read one control at a time.
   *
   * These used to be read inside the requests themselves, four at once — and
   * a Workday menu is a single popup on the page, so opening the second closed
   * the first. Most menus reached the model with no choices at all, the
   * answers that came back matched nothing on offer, and the questions were
   * left blank. Reading them in turn costs a fraction of a second each.
   */
  async function readAiOptions(targets) {
    const items = [];
    for (const field of targets) {
      if (state.stopRequested) break;
      if (!attached(field.el) || M.hasValue(field.el)) continue;
      let options = [];
      try { options = await optionsFor(field); } catch { options = []; }
      if (isMenuField(field)) await M.closeOpenMenu();
      let required = false;
      try { required = Boolean(M.isRequired?.(field.el)); } catch {}
      items.push({
        field,
        id: `q${items.length + 1}`,
        question: questionForAi(field),
        options: (options || []).slice(0, 60),
        kind: field.kind,
        multiple: field.kind === "checkbox" && (options || []).length > 1,
        maxWords: field.kind === "textarea" ? 130 : 40,
        required,
      });
    }
    return items;
  }

  const jobPayload = (meta) => ({
    jobTitle: meta?.jobTitle,
    company: meta?.company,
    companyDomain: meta?.companyDomain,
    jobDescription: meta?.description?.slice(0, 3000),
    profileId: state.profile?._id,
  });

  /** A worker or server from before batched answers, which knows only one question at a time. */
  const olderAnswerService = (res) =>
    (res?.ok && !Array.isArray(res?.data?.answers)) ||
    (!res?.ok && /unknown message|question text/i.test(String(res?.error ?? "")));

  /**
   * Every open question in one request.
   *
   * One question per request meant one model call per question: a page of ten
   * spent ten round trips, a Workday application of four pages spent the
   * hourly allowance, and each answer was written without knowing the others.
   * One call answers the page.
   */
  async function requestAnswers(items, meta) {
    if (!items.length) return { ok: true, answers: [] };
    const res = await send({
      type: "APPLI_FILL_ANSWER_BATCH",
      payload: {
        ...jobPayload(meta),
        questions: items.map((it) => ({
          id: it.id, question: it.question, options: it.options, fieldType: it.kind,
          multiple: it.multiple, maxWords: it.maxWords, required: it.required,
        })),
      },
    });
    if (res?.ok && Array.isArray(res.data?.answers)) {
      const byId = new Map(res.data.answers.map((a) => [String(a?.id ?? ""), a?.answer]));
      return { ok: true, answers: items.map((it) => byId.get(it.id) ?? "") };
    }
    if (olderAnswerService(res)) return requestAnswersOneByOne(items, meta);
    return { ok: false, error: res?.error || "The answer service didn't respond." };
  }

  /** The one-question-per-request form, for an answer service that predates batches. */
  async function requestAnswersOneByOne(items, meta) {
    const answers = new Array(items.length).fill("");
    let next = 0;
    let failures = 0;
    let error = null;
    const worker = async () => {
      while (next < items.length && failures < 3 && !state.stopRequested) {
        const i = next++;
        const it = items[i];
        const res = await send({
          type: "APPLI_FILL_ANSWER",
          payload: {
            ...jobPayload(meta),
            question: it.question, options: it.options, maxWords: it.maxWords,
            fieldType: it.kind, multiple: it.multiple,
          },
        });
        if (!res?.ok) { failures++; error = res?.error || "The answer service didn't respond."; continue; }
        answers[i] = res.data?.answer ?? "";
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (failures && answers.every((a) => !a || (Array.isArray(a) && !a.length))) return { ok: false, error, answers };
    return { ok: true, answers, error };
  }

  /** Does the reply name one of the choices this question offered? */
  function answerOnOffer(item, answer) {
    const options = (item.options || []).filter(Boolean);
    // A menu with sub-menus is answered with a value one level down, which is
    // not in the list read here; the setter matches it inside the menu.
    if (!options.length || options.some((o) => /\(category/i.test(o))) return answerFitsOptions(item.field, answer);
    const norm = (x) => {
      try { return M.normalizeChoiceText(String(x)); } catch { return String(x).toLowerCase().trim(); }
    };
    const offered = options.map(norm).filter(Boolean);
    const wanted = Array.isArray(answer) ? answer : [answer];
    return wanted.length > 0 && wanted.every((one) => {
      const a = norm(one);
      return Boolean(a) && offered.some((b) => a === b || a.includes(b) || b.includes(a));
    });
  }

  /** Writes the service's answers in page order; returns how many landed. */
  async function applyAiAnswers(items, answers) {
    let done = 0;
    for (let i = 0; i < items.length; i++) {
      if (state.stopRequested) break;
      const item = items[i];
      const { field } = item;
      // Re-checked here, not just when the list was built: the fill ran while
      // the model was answering, and the applicant may have answered it too.
      if (!attached(field.el) || writtenThisRun(field.el) || M.hasValue(field.el) || field.el.__applifillUserEdited) continue;

      let answer = answers[i];
      if (field.kind === "checkbox") {
        if (typeof answer === "string") {
          try { answer = JSON.parse(answer); } catch { /* one choice, or a comma list */ }
        }
        if (Array.isArray(answer)) answer = answer.map((x) => String(x ?? "").trim()).filter(Boolean);
        else answer = String(answer ?? "").trim();
      } else {
        answer = String(Array.isArray(answer) ? answer[0] ?? "" : answer ?? "").trim();
      }
      if (!answer || (Array.isArray(answer) && !answer.length)) continue;

      // On a menu, a drafted answer is only usable if it is one of the choices
      // actually on offer. Anything else gets fuzzily matched onto whichever
      // option scores best, which is how a question ends up confidently
      // answered with something the applicant never would have picked. A blank
      // they can see and fill in is the better outcome.
      if (!answerOnOffer(item, answer) || !answerFitsFormat(field, answer)) {
        state.unmatched.includes(field) || state.unmatched.push(field);
        mark(field.el);
        continue;
      }

      if (isMenuField(field)) await M.waitForMenusClosed(600);
      let ok = false;
      try { ok = await applyValue(field, answer, null); } catch { ok = false; }
      if (ok) {
        done++;
        state.drafted.add(field.el);
        unmark(field.el);
        markDrafted(field.el);
        flash(field.el);
      }
    }
    await M.closeOpenMenu();
    return done;
  }

  /**
   * Premium — asks about everything the profile and saved answers left open,
   * as soon as that is known, and lets the fill carry on meanwhile.
   *
   * Returns null when there is nothing to ask or the pass is not available;
   * otherwise the questions and a promise for their answers.
   */
  async function startAiBatch(session, meta, settings, fields) {
    if (aiGate(session, settings)) return null;
    const targets = aiTargets(fields);
    if (!targets.length) return null;
    const items = await readAiOptions(targets);
    if (!items.length) return null;
    return { items, result: requestAnswers(items, meta) };
  }

  /**
   * Premium — answers everything the profile and saved answers couldn't cover.
   *
   * Returns why it did nothing as well as how much it drafted. Silence was the
   * problem before: with the setting off, or on a free plan, or with the API
   * key missing, the pass returned 0 and the applicant was told only that some
   * fields "need you" — with no hint that the feature existed or why it had not
   * run. The reason is reported so the popup can say which of those it was.
   */
  async function answerRemaining(session, meta, settings, early = null) {
    const gate = aiGate(session, settings);
    if (gate) return { drafted: 0, skipped: gate };

    let drafted = 0;
    let error = null;
    let stopAsking = false;
    const covered = new Set();

    if (early?.items?.length) {
      early.items.forEach((it) => covered.add(it.field.el));
      const res = await early.result;
      if (res.ok) drafted += await applyAiAnswers(early.items, res.answers);
      else { error = res.error; stopAsking = true; }
      if (res.error && !error) error = res.error;
    }

    // Questions that only exist now — a follow-up revealed by an answer, a
    // dependent menu, a history row added during the fill — get one more call.
    if (!stopAsking && !state.stopRequested) {
      const late = aiTargets(state.unmatched, covered);
      if (late.length) {
        const items = await readAiOptions(late);
        const res = await requestAnswers(items, meta);
        if (res.ok) drafted += await applyAiAnswers(items, res.answers);
        else error = error || res.error;
      }
    }
    return { drafted, skipped: drafted ? null : (error ? "error" : null), error };
  }

  /**
   * Remove only exact duplicate profile jobs before sizing/filling repeated
   * Work Experience blocks. Resume/profile imports can contain the same job
   * twice; treating those as two distinct rows makes the extension deliberately
   * create a duplicate experience section. We compare all meaningful job data,
   * so two genuinely different roles at the same employer are preserved.
   */
  function profileForAutofill(profile) {
    if (!profile || !Array.isArray(profile.experience)) return profile;
    const seen = new Set();
    const experience = profile.experience.filter((job) => {
      const key = [
        job?.company, job?.title, job?.location, job?.locationType,
        job?.employmentType, job?.startDate, job?.endDate, job?.current,
        job?.description,
      ].map((v) => String(v ?? "").trim().toLowerCase()).join("\u001f");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...profile, experience };
  }

  async function readyNativeDependents(profile) {
    if (!M.onAdp?.() && !["sapSuccessFactors", "icims"].includes(state.adapter?.key)) return [];
    const until = Date.now() + 1600;
    do {
      if (state.stopRequested) return [];
      const controls = Array.from(document.querySelectorAll("select"))
        .filter((el) => hasVisibleHost(el))
        .map((el) => {
          const label = M.deriveLabel(el);
          return { el, label, kind: "select", rule: M.matchRule(el, label, RULES), index: 0 };
        });
      const ready = [];
      let waiting = false;
      for (const field of controls) {
        if (!["state", "county", "sourceDetail"].includes(field.rule?.key)) continue;
        if (writtenThisRun(field.el) || M.hasValue(field.el) || field.el.__applifillUserEdited) continue;
        let value = null;
        try { value = field.rule.value(profile, field.el, field.label, 0); } catch {}
        if (!value && state.session?.settings?.reuseSavedResponses !== false) {
          try { value = findSavedAnswer(field, { exactOnly: true })?.answer; } catch {}
        }
        const one = field.rule.onlyChoice && Array.from(field.el.options || [])
          .filter((opt) => !opt.disabled && opt.value && !M.isPlaceholderChoice(opt.textContent)).length === 1;
        if (!value && !one) {
          if (field.rule.onlyChoice && isAwaitingParent(field) && controls.some((parent) =>
              ["country", "state"].includes(parent.rule?.key) && M.hasValue(parent.el))) waiting = true;
          continue;
        }
        if (isAwaitingParent(field)) waiting = true;
        else ready.push(field);
      }
      if (ready.length) return ready;
      // Legacy ADP inserts the source-specific question after the category's
      // change handler returns. Wait only for an actual category selection.
      const sourceCategory = controls.some((f) => f.rule?.key === "howDidYouHear" &&
        writtenThisRun(f.el) && /^(?:social\s*media|social\s*network|job\s*board|internet\s*site)/i
          .test(String(f.el.options?.[f.el.selectedIndex]?.textContent || "").trim()));
      if (sourceCategory && !controls.some((f) => f.rule?.key === "sourceDetail")) waiting = true;
      if (!waiting) return [];
      await sleep(50);
    } while (Date.now() < until);
    return [];
  }

  /* ================================================================== */
  /*  The run                                                            */
  /* ================================================================== */

  async function run({ manual = false } = {}) {
    /**
     * Autofill has exactly one entry point: a person pressing Fill. There is no
     * longer an `auto` path — see `boot()` — so anything reaching here without
     * a click, including a page mutation or a reload, is refused.
     */
    if (!manual) return { ok: false, error: "manual-start-required" };
    if (state.filling) return { ok: false, error: "Already filling." };

    state.stopRequested = false;
    state.manualSessionActive = true;
    state.completedRun = false;
    // A fresh pass. Anything written by the previous one is fair game again if
    // it somehow ended up empty, but nothing written by *this* one will be.
    state.runId++;

    /**
     * A manual Fill click is an explicit request for the latest profile/settings/
     * Saved Answers state. Never start from a stale cached response list: a user
     * can press Sync in the popup and immediately press Fill on the application,
     * and that click must see the newly synced answers.
     */
    let session = await loadSession(true);
    if (session) state.session = session;
    if (session?.profile) {
      state.profile = null;
      state.scoring = null;
    }
    if (!session?.profile) {
      overlay.show({ tone: "warn", title: "Not connected", body: "Open the Appli-Fill popup and pair with your dashboard." });
      return { ok: false, error: "not-connected" };
    }
    if (isExcluded(session.settings)) return { ok: false, error: "excluded" };

    state.filling = true;
    startTouchTracking();
    watchOnFocus();
    document.documentElement.classList.add("applifill-running");
    const started = performance.now();

    const result = { filled: 0, failed: 0, unmatched: 0, detected: 0, keys: [] };

    try {
      const adapter = state.adapter ?? (state.adapter = ATS.detect());
      const settings = session.settings ?? {};
      const meta = ATS.readJobMeta(adapter);
      // Who this application is for, so a saved answer given to another
      // employer ("…relatives employed by GDIT?") can answer the same question
      // here ("…employed by Leidos?").
      state.employers = hiringEmployers(meta);
      // The rule table checks "Have you worked here before?" against the work
      // history by these names too (`hiringCompanyHints`).
      try { window.__applifillPageEmployers = state.employers.slice(); } catch {}

      // The account step is not the application. Passwords are never invented
      // and are only restored from the Saved Answers entry named "Password".
      const authPage = authPageReason();

      if (!state.profile) {
        const picked = await pickProfile(session, meta);
        state.profile = picked.profile;
        state.scoring = picked.scoring;
      }
      const profile = profileForAutofill(state.profile ?? session.profile);
      // Keep the sanitized profile local to this fill. The dashboard/profile
      // record is never mutated; exact duplicate roles are simply not treated
      // as separate ATS rows during autofill.
      state.fillProfile = profile;

      if (authPage) {
        // Only the email/username and the user's saved "Password" answer are
        // restored here. There is no separate password field or local fallback.
        M.beginFillSession();
        const emailField = collectFields(adapter).find((f) => f.rule?.key === "email");
        if (emailField && !M.hasValue(emailField.el)) {
          const plan = planField(emailField, profile, session.settings ?? {});
          if (plan.status === "fill") {
            try {
              if (await applyValue(emailField, plan.value, plan.rule)) {
                result.filled = 1;
                result.keys.push("email");
              }
            } catch {}
          }
        }

        // Passwords come only from the user's Saved Answers entry named
        // "Password". There is deliberately no separate browser-local fallback.
        const savedPassword = resolveSavedPassword();
        const accountSettings = await getAccountSettings();
        if (savedPassword) {
          const pwFilled = await fillAccountPasswordFields(savedPassword);
          if (pwFilled) {
            result.filled += pwFilled;
            result.keys.push("password");

            if (accountSettings.applifillAutoSubmitAccount !== false) {
              if (consentStillNeeded()) {
                // Left for the applicant to tick and submit.
                result.autoSubmitted = false;
                result.consentNeeded = true;
              } else {
                result.autoSubmitted = await submitAccountWhenReady();
              }
              if (!result.autoSubmitted) {
                result.accountSubmitBlocked = true;
              }
            }
          }
        }

        result.skipped = authPage;
        // Reported under its own name too. `skipped` is what the popup reads
        // and is kept as-is, but "skipped" says nothing about *which* step this
        // was, so anything else asking has to string-match a field named for a
        // different question.
        result.authPage = authPage;
        result.detected = 0;
      }

      // A tiny pause between writes keeps controlled components in sync without
      // being visible. Dropdowns supply their own, longer, settle time.
      /**
       * The pause between writes.
       *
       * The dashboard stores 120ms by default and it was spent after *every*
       * field, dropdowns included — which already wait for their own menus — so
       * a thirty-field Workday page spent several seconds doing nothing at all.
       * Only typed boxes get a pause now, and a short one.
       */
      const delay = Math.min(30, Math.max(0, Number(settings.fillDelayMs ?? 0)));
      let fields = [];

      if (!authPage) {
      // Remember what the page already shows that merely looks like an open
      // menu, so the engine never waits on — or tries to close — the site's own
      // navigation or styled lists.
      M.beginFillSession();

      await M.closeOpenMenu();

      await expandSapSections(adapter);
      const savedPassword = resolveSavedPassword();
      if (savedPassword) {
        const count = await fillAccountPasswordFields(savedPassword);
        result.filled += count;
        if (count) result.keys.push("password");
      }
      fields = collectFields(adapter);
      state.allFields = fields;
      state.unmatched = [];
      result.detected = fields.length;

      /* ---- Phase 1: plan everything, write nothing ---- */
      const plans = new Map();
      const pending = [];      // dependent controls — decided after their parent
      for (const field of fields) {
        // A control with no real choices yet cannot be planned: its options
        // arrive only once the field it depends on has been answered.
        if (isAwaitingParent(field)) { pending.push(field); continue; }
        const plan = planField(field, profile, settings);
        plans.set(field, plan);
        field._plan = plan;
        if (plan.status === "unmatched") {
          state.unmatched.push(field);
          mark(field.el);
        }
      }

      // Start one AI batch after the known answers. Reading unknown custom
      // dropdowns opens their menus, so it must not hold up saved/profile data.
      let early = null;

      /* ---- Phase 2: one write per field ----
         Simple controls go first so the form visibly fills straight away, then
         the dropdowns are worked through strictly one at a time. */
      const queue = fields.filter((f) => plans.get(f)?.status === "fill");
      const simple = queue.filter((f) => !isMenuField(f)).sort((a, b) =>
        Number(b.rule?.key === "phoneCountryCode") - Number(a.rule?.key === "phoneCountryCode"));
      // A source picker may need a remote search and category traversal.
      // Finish the other known questions before opening it.
      const menus = queue.filter((f) => isMenuField(f)).sort((a, b) =>
        Number(b.rule?.key === "phoneCountryCode") - Number(a.rule?.key === "phoneCountryCode") ||
        Number(a.rule?.key === "howDidYouHear") - Number(b.rule?.key === "howDidYouHear"));
      const failed = [];
      const waiting = [];

      const write = async (field, { allowDefer = true } = {}) => {
        const plan = plans.get(field);
        if (!plan || plan.status !== "fill") return;
        if (!attached(field.el)) return;

        // Hold back a dropdown whose parent has not been answered yet.
        if (allowDefer && isAwaitingParent(field)) { waiting.push(field); return; }

        /**
         * Filled by the page since it was planned.
         *
         * Picking Oracle's address suggestion fills ZIP Code, City, State and
         * County, and a ZIP Code fills the City and State that go with it.
         * Those are the page's own verified values; typing over them would
         * reopen each list for nothing, and could replace a value the page
         * requires with a spelling it does not.
         */
        if (PAGE_FILLED_KEYS.has(field.rule?.key) && !writtenThisRun(field.el) &&
            !field.el.__applifillUserEdited && M.hasValue(field.el)) {
          result.filled++;
          result.keys.push(field.rule.key);
          unmark(field.el);
          return;
        }

        // Never start a dropdown while another menu is still on screen.
        if (isMenuField(field)) await M.waitForMenusClosed(600);

        let ok = false;
        try { ok = await applyValue(field, plan.value, plan.rule); } catch { ok = false; }

        if (ok && ((field.needsPick && M.leverLocationPicked?.(field.el) === false) || field.streetNotPicked)) {
          // Lever's location, typed but with no place picked from its list:
          // not an answer Lever will submit. Outlined, and counted as needing
          // the applicant; the pick finishes when they click into the box.
          mark(field.el);
          if (!state.unmatched.includes(field)) state.unmatched.push(field);
        } else if (ok) {
          result.filled++;
          if (plan.key) result.keys.push(plan.key);
          unmark(field.el);
          flash(field.el);
          // Declines, and answers read off the history rather than stated in
          // the profile, are shown as drafts to look over.
          if (plan.source === "decline" || plan.rule?.review || field.review) markDrafted(field.el);
          // Typed, but the box only accepts a place picked from its own list
          // and none of them was the applicant's.
          if (field.needsPick) mark(field.el);
        } else if (!failed.includes(field)) {
          failed.push(field);
        }
        if (delay && !isMenuField(field)) await sleep(delay);
      };

      const sources = menus.filter((f) => f.rule?.key === "howDidYouHear");
      const phoneCodes = queue.filter((f) => f.rule?.key === "phoneCountryCode");
      for (const field of [...phoneCodes, ...simple.filter((f) => !phoneCodes.includes(f)), ...menus.filter((f) => !sources.includes(f) && !phoneCodes.includes(f))]) {
        if (state.stopRequested) break;
        await write(field);
      }

      if (!state.stopRequested) {
        try { early = await startAiBatch(session, meta, settings, state.unmatched); } catch { early = null; }
      }
      // The source search can now run while the single answer request is in
      // flight; all other known controls have already been answered.
      for (const field of sources) {
        if (state.stopRequested) break;
        await write(field);
      }

      /* ---- The rest of the address ----
         ZIP Code, City, State and County are left for Oracle to fill from the
         address picked in Address Line 1. Whatever is still empty once Oracle
         has had a moment — no suggestion was the applicant's, the search found
         nothing, or Oracle filled only part of it — is answered here, as the
         applicant would: ZIP Code first (picking it fills the County and State
         that go with it), then City, then the rest, each only if it is still
         empty by then. County, which no profile holds, is the one Oracle
         offers for the address. */
      const streetLeft = (field) => plans.get(field)?.reason === "filled-from-address";
      const leftFields = fields.filter(streetLeft).filter((f) => attached(f.el));
      if (!state.stopRequested && leftFields.length) {
        const empty = (f) => !M.hasValue(f.el) || Boolean(M.oracleFieldInvalid?.(f.el));
        const settle = async (ms) => {
          const until = Date.now() + ms;
          while (Date.now() < until && leftFields.some(empty)) await sleep(120);
        };
        if (leftFields.some((f) => streetPickedThisRun(streetBoxFor(f.el)))) await settle(2600);
        const ORDER = ["zip", "city", "state", "county", "taxDistrict"];
        const rank = (f) => { const i = ORDER.indexOf(f.rule?.key); return i < 0 ? ORDER.length : i; };
        for (const field of [...leftFields].sort((a, b) => rank(a) - rank(b))) {
          if (state.stopRequested) break;
          if (!attached(field.el)) continue;
          if (!empty(field)) {
            // Filled by Oracle from the address.
            result.filled++;
            result.keys.push(field.rule.key);
            unmark(field.el);
            continue;
          }
          field.streetFallback = true;
          const plan = planField(field, profile, settings);
          plans.set(field, plan);
          field._plan = plan;
          if (plan.status === "fill") {
            await write(field, { allowDefer: false });
            if (M.isOracleSelect?.(field.el)) await settle(900);
          } else if (field.rule?.onlyChoice && M.isOracleSelect?.(field.el)) {
            /**
             * County and Tax District, which no profile holds: the one Oracle
             * offers for the address is taken. With more than one, County is
             * left for the applicant to pick; Tax District too, when the page
             * requires it.
             */
            let ok = false;
            try { ok = await M.setOracleSelectValue(field.el, "", { onlyChoice: true }); } catch {}
            let required = field.rule.key === "county";
            if (!ok && !required) { try { required = Boolean(M.isRequired?.(field.el)); } catch {} }
            if (ok) {
              result.filled++;
              result.keys.push(field.rule.key);
              unmark(field.el);
              flash(field.el);
            } else if (required && !state.unmatched.includes(field)) {
              state.unmatched.push(field);
              mark(field.el);
            }
          } else if (plan.status === "unmatched" && !state.unmatched.includes(field)) {
            state.unmatched.push(field);
            mark(field.el);
          }
        }
      }

      // Dependent controls now have their real choices: a State list exists
      // because Country was answered a moment ago, and "Please specify" has a
      // source list because "How did you hear about us?" does. Plan them now,
      // against the options they actually offer.
      const dependents = [...pending, ...waiting];
      if (dependents.length && !state.stopRequested) {
        await sleep(160);
        for (const field of dependents) {
          if (state.stopRequested) break;
          if (!attached(field.el)) continue;
          const plan = planField(field, profile, settings);
          plans.set(field, plan);
          if (plan.status === "fill") {
            await write(field, { allowDefer: false });
          } else if (plan.status === "unmatched" && !state.unmatched.includes(field)) {
            state.unmatched.push(field);
            mark(field.el);
          }
        }
      }

      /* ---- Lists with a single answer ----
         County and Tax District follow from the address: once the ZIP Code,
         City and State are in, the list offers just the one that applies. A
         profile holds neither, so a list offering exactly one real choice is
         answered with it; with more than one, the applicant chooses. */
      if (!state.stopRequested) {
        for (const field of fields) {
          if (state.stopRequested) break;
          if (!field.rule?.onlyChoice || field.kind !== "select") continue;
          if (!attached(field.el) || writtenThisRun(field.el) || field.el.__applifillUserEdited) continue;
          // Oracle's own lists are answered with the rest of the address above.
          if (M.isOracleSelect?.(field.el)) continue;
          if (M.hasValue(field.el) || M.looksLikeTypeahead?.(field.el)) continue;
          let only = null;
          try { only = await soleChoice(field); } catch { only = null; }
          if (!only) continue;
          let ok = false;
          try { ok = await applyValue(field, only, field.rule); } catch { ok = false; }
          if (ok) {
            result.filled++;
            result.keys.push(field.rule.key);
            unmark(field.el);
            flash(field.el);
            state.unmatched = state.unmatched.filter((f) => f !== field);
          }
        }
      }

      await M.closeOpenMenu();

      /* ---- Extra rows, only for sections that actually answered ----
         These used to be created before anything was written, from the number
         of entries in the profile alone. On a Greenhouse form whose School,
         Degree and Discipline pickers can't be driven, that produced block after
         block of empty "Select..." rows — added, never filled, and left for the
         applicant to delete. A row is now created only after the first one of
         its kind has actually been answered, so a section that cannot be filled
         never grows beyond the one row the page came with. The new rows are
         picked up as fresh fields by the reconcile pass below. */
      if (!state.stopRequested) {
        const answered = new Set(result.keys);
        const kinds = [];
        if ([...EXPERIENCE_KEYS].some((k) => answered.has(k))) kinds.push("experience");
        if ([...EDUCATION_KEYS].some((k) => answered.has(k))) kinds.push("education");
        if (kinds.length) {
          await ensureProfileRows(profile, adapter, kinds);
          await M.closeOpenMenu();
        }
      }

      /* ---- Phase 3: one reconcile pass ----
         Dependent controls (State after Country, questionnaires that unhide on
         an earlier answer) only exist now, and a handful of writes genuinely
         lose a race with a re-render. Both get exactly one more attempt. */
      if (!state.stopRequested) {
        await sleep(120);
        const known = new Set(fields.map((f) => f.el));
        const fresh = collectFields(adapter).filter((f) => !known.has(f.el));
        if (fresh.length) {
          fields.push(...fresh);
          state.allFields = fields;
          result.detected = fields.length;

          /*
           * A newly-created Work Experience row is collected by itself. If we
           * index that small collection in isolation, its only Company/Title
           * anchor becomes row 0 and the second profile job is copied into the
           * new row. This is the exact duplication seen on Workday: the row was
           * genuinely new, but its fields were planned as if they belonged to
           * the first job. Re-index against the complete DOM collection before
           * planning any fresh controls.
           */
          assignRowIndexes(fields, EXPERIENCE_KEYS, [
            "currentCompany", "currentTitle", "responsibilities",
          ]);
          assignRowIndexes(fields, EDUCATION_KEYS, ["school", "degree", "fieldOfStudy"]);
        }

        const retry = [
          ...fresh.filter((f) => {
            // The row indexes above are now final for this pass. Re-plan from
            // the full collection so the newly-created row reads profile[index]
            // rather than defaulting to profile[0].
            const plan = planField(f, profile, settings);
            plans.set(f, plan);
            if (plan.status === "unmatched") { state.unmatched.push(f); mark(f.el); }
            return plan.status === "fill";
          }),
          ...failed.filter((f) =>
            attached(f.el) &&
            !M.hasValue(f.el) &&
            !f.el.__applifillUserEdited &&
            // The setter already committed something here; we simply cannot
            // read this widget back. Trying again would re-edit a finished
            // field rather than fix anything.
            !writtenThisRun(f.el) &&
            // A dropdown that opened and offered nothing usable is not worth
            // opening again — that second opening is pure visible flicker for
            // a result that cannot change.
            !f.el.__applifillNoMatch
          ),
        ];

        for (const field of retry) {
          if (state.stopRequested) break;
          const plan = plans.get(field);
          if (!plan || plan.status !== "fill") continue;
          if (isMenuField(field)) await M.waitForMenusClosed(600);

          let ok = false;
          try { ok = await applyValue(field, plan.value, plan.rule); } catch { ok = false; }

          if (ok) {
            result.filled++;
            if (plan.key) result.keys.push(plan.key);
            unmark(field.el);
            if (plan.rule?.review || field.review) markDrafted(field.el);
            flash(field.el);
          } else if (!state.unmatched.includes(field)) {
            result.failed++;
            state.unmatched.push(field);
            mark(field.el);
          }
          if (delay && !isMenuField(field)) await sleep(delay);
        }

        // Anything that failed twice is the user's to answer, not a silent loss.
        // So is a date whose widget would not show it, whatever it shows.
        for (const field of failed) {
          if (!state.unmatched.includes(field) && attached(field.el) && (!M.hasValue(field.el) || dateLeftWrong(field.el))) {
            state.unmatched.push(field);
            mark(field.el);
          }
        }
      }

      await M.closeOpenMenu();
      // Native ADP State -> County and Source -> Source Detail may arrive in
      // separate asynchronous waves. Resolve at most three dependency levels
      // within this one click; never start a background refill loop.
      for (let wave = 0; wave < 3 && !state.stopRequested; wave++) {
        const ready = await readyNativeDependents(profile);
        if (!ready.length) break;
        for (const candidate of ready) {
          let field = fields.find((f) => f.el === candidate.el);
          if (!field) { field = candidate; fields.push(field); }
          const plan = planField(field, profile, settings);
          if (plan.status === "fill") {
            plans.set(field, plan);
            await write(field, { allowDefer: false });
          } else if (field.rule?.onlyChoice) {
            const only = await soleChoice(field);
            if (only) {
              plans.set(field, { status: "fill", key: field.rule.key, value: only, rule: field.rule, source: "portal" });
              await write(field, { allowDefer: false });
            }
          }
          if (!M.hasValue(field.el) && !state.unmatched.includes(field)) { state.unmatched.push(field); mark(field.el); }
        }
      }
      if (!state.stopRequested) {
        result.termsAccepted = await acceptApplicationTerms();
        result.filled += result.termsAccepted;
        if (result.termsAccepted) result.keys.push("applicationTerms");
      }
      state.allFields = fields;
      result.detected = fields.length;
      state.unmatched = Array.from(new Set(state.unmatched)).filter((f) => attached(f.el) && (!M.hasValue(f.el) || dateLeftWrong(f.el)));
      result.unmatched = state.unmatched.length;

      if (state.stopRequested) {
        result.stopped = true;
        overlay.show({
          tone: "warn",
          title: `Stopped — ${result.filled} fields filled`,
          body: "Autofill stopped. You can review the form and edit fields manually.",
        });
      } else {
        /* ---- Phase 4: Premium drafts what is left ---- */
        const ai = await answerRemaining(session, meta, settings, early);
        result.drafted = ai.drafted;
        result.aiSkipped = ai.skipped;
        result.aiError = ai.error ?? null;
        if (result.drafted) {
          result.filled += result.drafted;
          state.unmatched = state.unmatched.filter((f) => !M.hasValue(f.el));
          result.unmatched = state.unmatched.length;
        }

        await sleep(80);
        result.validationErrors = collectRequiredErrors();
        // A validation message means something on this page still needs an
        // answer, so surface the empty fields — but only the empty ones. The
        // old build re-queued every field on the page, which is why the count
        // in the pill was always alarming and mostly wrong.
        if (result.validationErrors.length) {
          for (const field of fields) {
            if (field.kind === "file") continue;
            if (!attached(field.el)) continue;
            if (!M.hasValue(field.el) && !state.unmatched.includes(field)) {
              state.unmatched.push(field);
              mark(field.el);
            }
          }
          result.unmatched = state.unmatched.length;
        }
      }
      } // end if (!authPage)
    } finally {
      await M.closeOpenMenu();
      document.documentElement.classList.remove("applifill-running");
      state.filling = false;
      state.manualSessionActive = false;
      state.completedRun = true;
    }

    result.durationMs = Math.round(performance.now() - started);
    result.profileLabel = state.profile?.label ?? null;
    result.matchScore = state.scoring?.score ?? null;
    state.lastRun = result;

    watchUnmatched();
    queueAnswersFromForm();
    scheduleSettleCheck();

    const settings = state.session?.settings ?? {};
    if (settings.showOverlay !== false && result.unmatched && !result.stopped) {
      const scoreLine = state.scoring ? `Profile match: ${state.scoring.score}%. ` : "";
      // Lever's location list did not come up during the fill (its lookup sits
      // behind a human check): one click into the box lets Appli-Fill finish it.
      const placeLine = (state.unmatched ?? []).some((f) => f.needsPick && M.leverLocationPicked?.(f.el) === false)
        ? "Click into Current location and Appli-Fill will pick your city from its list. "
        : "";
      overlay.show({
        tone: "partial",
        title: `${result.unmatched} field${result.unmatched === 1 ? "" : "s"} need your answer`,
        body:
          scoreLine + placeLine +
          `${result.validationErrors?.length ? `${result.validationErrors.length} validation message${result.validationErrors.length === 1 ? "" : "s"} detected. ` : ""}` +
          "The highlighted questions were not safely answered.",
        // Three seconds, then out of the way. It used to stay until dismissed,
        // which parked it over the bottom of the form — exactly where the
        // remaining questions are. The fields themselves stay highlighted, so
        // nothing is lost when the pill goes.
        autoHide: 3000,
      });
    } else if (!result.stopped) {
      overlay.hide();
    }

    // One explicit click = one complete fill pass. Never click Save/Next and
    // never start another run from DOM mutations.
    return { ok: true, data: result };
  }

  /** The one real choice a list offers, or null when it offers none or several. */
  async function soleChoice(field) {
    const el = field.el;
    let texts = [];
    if (el.tagName === "SELECT") {
      texts = Array.from(el.options || [])
        .filter((o) => o.value && !o.disabled && !M.isPlaceholderChoice(o.textContent))
        .map((o) => M.clean(o.textContent));
    } else if (M.isSdfField?.(el)) {
      texts = (await M.readSdfSelectOptions(el)).filter((t) => t && !M.isPlaceholderChoice(t));
    } else {
      texts = (await M.readComboboxOptions(el, 700))
        .filter((t) => t && !M.isPlaceholderChoice(t) && !/has sub-options/.test(t));
      await M.closeOpenMenu();
    }
    return texts.length === 1 ? texts[0] : null;
  }

  /** Does filling this control involve opening a popup menu? */
  function isMenuField(field) {
    return Boolean(M.isWorkdayPrompt?.(field.el)) ||
      (field.kind === "select" && field.el.tagName !== "SELECT");
  }

  /* ================================================================== */
  /*  Capturing what the user answers by hand                            */
  /* ================================================================== */

  const pending = new Map();

  function queueAnswer(entry) {
    if (!entry.question || !String(entry.answer ?? "").trim()) return;
    const key = String(entry.question).trim();
    // One question, one queued answer. Several paths can legitimately report the
    // same edit — the control's own change event, a sibling in the same choice
    // group, and the sweep that re-reads everything afterwards — so the queue is
    // made idempotent here rather than relying on each of them to notice.
    // A genuinely different answer still supersedes the old one.
    const previous = pending.get(key);
    if (previous && previous.answer === entry.answer) return;
    pending.set(key, entry);
    state.captured.set(key, entry);
    // Saved Responses are not written to the database here — the user controls
    // persistence with Sync. The background worker keeps a durable local queue.
    send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [entry] });
  }

  async function flushAnswers() {
    return true;
  }

  /** Reads whatever the user has put in a field, in a comparable form. */
  function readValue(field) {
    const el = field.el;
    // ADP's lists, radio groups and check boxes say what they hold themselves.
    if (M.isSdfField?.(el)) return M.sdfValueText(el);
    if (el.type === "checkbox" || el.getAttribute("role") === "checkbox") {
      const role = el.getAttribute("role");
      // M.choiceGroup resolves a group the same way everywhere. This branch used
      // to fall back to `[el]` when the boxes shared no `name`, so a three-option
      // group read as a single yes/no and the answer stored never matched the
      // options stored beside it.
      const group = M.choiceGroup(el);
      const checked = group.filter((cb) => role === "checkbox" ? cb.getAttribute("aria-checked") === "true" : cb.checked);
      if (!checked.length) return "No";
      if (group.length === 1) return "Yes";
      return checked.map((cb) => M.radioOptionText(cb)).filter(Boolean).join(", ");
    }
    if (el.type === "radio" || el.getAttribute("role") === "radio") {
      const custom = el.getAttribute("role") === "radio";
      const group = M.choiceGroup(el);
      const picked = group.find((r) => custom ? r.getAttribute("aria-checked") === "true" : r.checked);
      return picked ? M.radioOptionText(picked) : "";
    }
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return opt && opt.value ? (opt.textContent || "").trim() : "";
    }
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "combobox") {
      /**
       * A segmented control is answered by which segment is pressed.
       *
       * comboboxDisplayValue reads the control's own text, which for a row of
       * Yes/No buttons is the label of whichever button the field happens to be
       * anchored to — "Yes", pressed or not. It therefore never changed when
       * the applicant pressed "No", and once capture required a real change to
       * count as an edit, segmented answers stopped being recorded at all.
       */
      const segmented = M.choiceButtonGroup?.(el);
      if (segmented?.length) return M.choiceButtonGroupValue(el) || "";
      return M.comboboxDisplayValue(el);
    }
    return el.value ?? "";
  }

  /**
   * The choices a field offers. Custom dropdowns have to be opened to be read,
   * which is done through the menu registry so the menu is closed again before
   * anything else runs.
   */
  async function optionsFor(field) {
    const el = field.el;
    if (M.isSdfField?.(el)) {
      try { return M.isSdfSelect(el) ? await M.readSdfSelectOptions(el) : M.sdfOptionTexts(el); }
      catch { return []; }
    }
    if (el.tagName === "SELECT") {
      return Array.from(el.options || [])
        .map((o) => (o.textContent || "").trim())
        .filter(Boolean)
        .filter((x) => !/^(select|choose|please select|--)/i.test(x))
        .slice(0, 60);
    }
    // Pills and segmented buttons carry their choices on the buttons: the model
    // was asked Oracle's Yes/No questions with no choices at all.
    if (el.type === "radio" || el.type === "checkbox" ||
        el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox" ||
        (field.kind === "radio" && M.isChoiceButton?.(el))) {
      return M.optionTextsFor(el);
    }
    if (field.kind === "select") {
      try { return await M.readComboboxOptions(el, state.adapter?.quirks?.dropdownDelay ?? 800); }
      catch { return []; }
    }
    return [];
  }

  /**
   * The question as a person would read it.
   *
   * `field.label` is several descriptions joined with " | ", ending with the
   * humanized name attribute — so answers were being stored under headings like
   * "Why are you interested in this role? | q why", which is what the dashboard
   * then displayed. The first description is the visible label, and it is also
   * the first candidate findSavedAnswer looks up, so storing it keeps the round
   * trip exact as well as readable.
   */
  /**
   * The question heading that sits above a group of choices.
   *
   * A radio or checkbox is usually wrapped in a <label> holding its *option*
   * text, so the derived label starts with "Referral" or "Evenings" — and those
   * were being stored as the question. The real question is the nearest heading
   * in the group container that isn't itself an option.
   */
  /**
   * Text that is an answer rather than a question.
   *
   * A choice group's own option labels are the single commonest thing to be
   * mistaken for its question, which is how an answer was saved under the
   * question "Prefer not to say". Anything matching this is never a question,
   * whatever else recommends it.
   */
  const ANSWER_LIKE_RE = new RegExp(
    "^(?:" +
      "yes|no|y|n|true|false|maybe|other|none|n\\/?a|not applicable|unsure|" +
      "male|female|man|woman|non[-\\s]?binary|transgender|" +
      "prefer not to (?:say|answer|disclose|respond|specify)|" +
      "i (?:do not|don't|dont) (?:wish|want|choose) to (?:answer|say|disclose|self[-\\s]?identify|specify)|" +
      "(?:i )?(?:decline|choose not|do not wish|don't wish) to (?:self[-\\s]?identify|answer|disclose|specify|state)|" +
      "declined? to self[-\\s]?identify|do not wish to disclose|" +
      /**
       * "I prefer to self-describe".
       *
       * An option on every demographic question Ashby and Greenhouse render,
       * and the one that was banked as a *question* — the humanized `id` reads
       * back as "i prefer to self describe", which the exact-match options test
       * missed because humanize() had already turned the hyphen into a space.
       * Matching it here settles it however the punctuation lands.
       */
      "(?:i )?(?:prefer|choose|wish|want|would like) (?:not )?to self[-\\s]?describe|" +
      "self[-\\s]?describe|" +
      "select(?:\\s*an?\\s*option|\\s*one)?|please select|choose(?:\\s*an?\\s*option|\\s*one)?|" +
      /**
       * A typeahead's resting prompt. Ashby's location combobox says "Start
       * typing…", which reached Saved Answers as the question for the city the
       * applicant picked.
       */
      "start typing.*|begin typing.*|type to search.*|type here.*|search\\.*|none selected|" +
      "-{2,}.*|\\u2014.*" +
    ")\\s*[.?!*]?$",
    "i"
  );

  /**
   * Every label the controls in this field's group carry.
   *
   * Built from the group members themselves rather than only from
   * `optionTextsFor`, because that helper resolves a group through the `name`
   * attribute and a great many ATS radio groups have no `name` at all. When it
   * fell back to the single anchor control, every *other* option in the group
   * looked like a legitimate question — which is exactly how "Prefer not to
   * say" became one.
   */
  /**
   * One spelling for one answer.
   *
   * The options set used to hold plain lowercased text, so membership was an
   * exact string test. `humanize()` reaches it having already replaced every
   * hyphen and underscore with a space, so the option "I prefer to
   * self-describe" and the machine name "i prefer to self describe" were two
   * different strings — the option test missed, and the option label was saved
   * as the question. Stripping punctuation on both sides removes the whole
   * class of near-miss.
   */
  function answerKey(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /**
   * Is this text an identifier the form generated, rather than words a person
   * wrote?
   *
   * `deriveLabel` ends with the humanized `name` and `id` attributes so that a
   * rule can match "firstName". On Ashby those attributes are uuids:
   * `4409827-edb-0c17-447a-b4c5-8a5afa5ba1a9_gh_quest_labeled_checkbox_2`
   * humanizes to "edb 0c17 447a b4c5 8a5afa5ba1a9 gh quest labeled checkbox 2",
   * which is long enough and unlike enough to any option that it passed every
   * test a question candidate had to pass — and that string is what the popup
   * displayed as the question, and what the answer was banked under. Banked
   * there it could never match again, because the next form's uuid is a
   * different uuid, so the applicant was asked the same question on every
   * application.
   */
  function looksMachineGenerated(text) {
    const value = String(text || "");
    if (!value) return false;

    // A uuid fragment: four or more hex characters carrying both a letter and a
    // digit. "0c17", "b4c5" and "8a5afa5ba1a9" all qualify; "2024" has no
    // letter and "cafe" has no digit, so ordinary words and years are safe.
    if (/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{4,}\b/i.test(value)) return true;

    // The scaffolding ATS builders leave in `name` and `id`.
    if (/\b(?:gh[\s_-]?quest|systemfield|system[\s_-]?field|labell?ed[\s_-]?(?:checkbox|radio|select|input)|urn[\s_-]?li|data[\s_-]?automation[\s_-]?id|customfield|custom[\s_-]?field)\b/i.test(value)) {
      return true;
    }

    // A generated ordinal — "... checkbox 2", "... question 14". A real
    // question does not end by numbering its own widget.
    if (/\b(?:checkbox(?:es)?|radio|select|dropdown|input|textarea|field|question|answer|option)\s*\d+\s*$/i.test(value)) {
      return true;
    }

    // One hyphenated or underscored token naming a widget: "why-input",
    // "location_field", "org-question". "E-mail" and "follow-up" are words.
    if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(value.trim()) &&
        /(?:^|[-_])(?:input|field|question|select|textarea|dropdown|checkbox|radio|answer|label|qa|id|value|text)(?:$|[-_])/i.test(value.trim())) {
      return true;
    }

    return false;
  }

  /**
   * Every humanized machine name attached to this control's group.
   *
   * Kept separate so a name-derived candidate can be demoted rather than
   * banned: a bare text box whose only description is `name="notice_period"`
   * still needs "notice period" as its question, and that is a perfectly good
   * one. It just must never outrank the heading printed above a choice group.
   */
  function machineNameParts(el) {
    const out = new Set();
    const add = (value) => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      if (text) out.add(text);
    };
    if (!el) return out;
    let members = [el];
    try { members = groupMembersOf(el) || [el]; } catch {}
    if (!members.includes(el)) members = [el, ...members];
    for (const member of members) {
      if (!member?.getAttribute) continue;
      try {
        add(M.humanize?.(member.getAttribute("name")));
        add(M.humanize?.(member.id));
        // Test hooks and automation ids are names too. Lever's textarea
        // carries `data-qa="why-input"`, and that — not "What interests you
        // about Virtualitics?" printed above it — became the pending question.
        for (const attr of ["data-qa", "data-testid", "data-test-id", "data-automation-id", "data-field", "autocomplete"]) {
          const raw = member.getAttribute(attr);
          if (!raw) continue;
          add(raw);
          add(M.humanize?.(raw));
        }
      } catch {}
    }
    return out;
  }

  /**
   * A dropdown's resting row is a prompt, not a choice.
   *
   * "Start typing…" is Ashby's; the rest cover the typeaheads and native
   * selects everywhere else. Stored as a choice it padded every saved dropdown
   * answer with a fake option and showed the wrong count in the dashboard.
   */
  const PLACEHOLDER_OPTION_RE =
    /^(?:select|choose|please\s+select|pick\s+one|start\s+typing|begin\s+typing|type\s+to\s+search|type\s+here|search|none\s+selected|-{2,})\b|^[-\u2013\u2014\s\u2026.]*$/i;

  function optionTextsForField(field) {
    const out = new Set();
    const add = (value) => {
      const key = answerKey(value);
      if (key) out.add(key);
    };

    const el = field?.el;
    if (!el) return out;

    try { (M.optionTextsFor(el) || []).forEach(add); } catch {}

    if (field.kind === "radio" || field.kind === "checkbox") {
      let members = [el];
      try { members = groupMembersOf(el); } catch {}

      /**
       * A lone checkbox is its own question.
       *
       * "I agree to the terms and conditions" is what the box asks, not one of
       * several answers to something else. Treating its label as an option
       * disqualified it from being the question, so the search fell through to
       * whatever heading happened to be above it — an edit to the consent box
       * was banked under "Work Experience 2". A group of one offers no choice
       * to compare against.
       */
      if (field.kind === "checkbox" && members.length <= 1) return new Set();

      for (const member of members) {
        /**
         * The group itself is where the question hangs, not an answer.
         *
         * ADP's radio groups (`sdf-radio-group`) are collected as the group,
         * and the group is its own only member — so its `aria-label`, the
         * `<label for>` that names it (Workforce Now's `label.qLabel`) and the
         * text of its buttons ("Yes No") were all counted as options. The
         * question was then refused as being one of its own answers: a saved
         * answer for it could never be found, and an answer the applicant gave
         * by hand was banked under the section heading ("Questions") or not
         * at all. The options come from the buttons (`M.optionTextsFor`).
         */
        if (isChoiceGroupHost(member)) continue;
        try {
          add(M.radioOptionText?.(member));
          add(member.getAttribute?.("aria-label"));
          add(member.getAttribute?.("value"));
          const wrapping = member.closest?.("label");
          if (wrapping) add(M.visibleText?.(wrapping) ?? wrapping.textContent);
          if (member.id) {
            const escaped = (window.CSS && CSS.escape) ? CSS.escape(member.id) : member.id;
            document
              .querySelectorAll(`label[for="${escaped}"]`)
              .forEach((l) => add(M.visibleText?.(l) ?? l.textContent));
          }
        } catch {}
      }
    }
    return out;
  }

  /**
   * The element of a whole radio group — ADP's `sdf-radio-group`, an ARIA
   * radiogroup or group, a fieldset — as opposed to one of its choices.
   */
  function isChoiceGroupHost(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = String(node.tagName || "").toUpperCase();
    if (tag === "SDF-RADIO-GROUP" || tag === "FIELDSET") return true;
    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    return role === "radiogroup" || role === "group";
  }

  /** The ids of every control answering the same question as this one. */
  function groupMemberIds(el) {
    const ids = new Set();
    try { groupMembersOf(el).forEach((m) => { if (m?.id) ids.add(m.id); }); } catch {}
    return ids;
  }

  /**
   * The question a heading near this control is asking.
   *
   * `exclude` carries the group's own option labels. Without it this walked up
   * the DOM and returned the first text of eight characters or more, which on a
   * Yes / No / Prefer not to say group is "Prefer not to say" — the third
   * option, purely because the first two are too short to pass the length test.
   */
  function questionHeadingNear(el, exclude) {
    const skip = exclude instanceof Set ? exclude : new Set();
    const memberIds = groupMemberIds(el);
    const CONTROL_SEL =
      "input, select, textarea, button, [role='radio'], [role='checkbox'], [role='combobox'], [role='listbox']";

    /**
     * Is this text the label of a *different* question on the same form?
     *
     * Without this the search climbed out of its own field and read the rest of
     * the form. On an iCIMS profile block it answered "Address" with the
     * heading "How did you hear about us?" two fields further down, and the
     * saved answer for that question — "LinkedIn" — was then written into the
     * address and city boxes. A candidate is rejected when any ancestor between
     * it and the level being scanned wraps a form control but not this one:
     * that ancestor is another field's container, so the text inside it belongs
     * to another field.
     */
    const inAnotherField = (cand, stopAt) => {
      let node = cand.parentElement;
      while (node && node !== stopAt && node !== document.body) {
        if (!node.contains(el)) {
          try { if (node.querySelector(CONTROL_SEL)) return true; } catch {}
        }
        node = node.parentElement;
      }
      return false;
    };

    const readCandidate = (cand, stopAt) => {
      if (!cand) return "";
      // Cheapest test first: a node holding more text than any question is a
      // container, and reading it cost a full walk of the form per field.
      const raw = cand.textContent || "";
      if (raw.length < 8 || raw.length > 1500) return "";
      if (cand.contains(el)) return "";
      // A node wrapping a control is an option label, not the question.
      if (cand.querySelector(CONTROL_SEL)) return "";
      // A <label for> pointing at one of this group's own controls is an option
      // label too, even though it does not wrap it.
      const forId = cand.getAttribute?.("for");
      if (forId) {
        if (memberIds.has(forId)) return "";
        // A label aimed at some other control on the page is that control's
        // label, never this one's question.
        try { if (document.getElementById(forId) && !memberIds.has(forId)) return ""; } catch {}
      }
      if (inAnotherField(cand, stopAt)) return "";
      const text = (cand.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length < 8 || text.length > 300) return "";
      if (skip.has(answerKey(text))) return "";
      if (ANSWER_LIKE_RE.test(text)) return "";
      if (looksMachineGenerated(text)) return "";
      return text;
    };

    const CAND_SEL =
      'legend, [class*="question"], [class*="Question"], h2, h3, h4, h5, p, label, span, div';

    /**
     * Is this text printed *above this control*, with nothing else in between?
     *
     * The search used to accept any acceptable text found anywhere inside the
     * ancestor being scanned. One level up from its own wrapper, that ancestor
     * is usually the form itself — so every field in the form inherited the
     * first heading in it that ended in a question mark. On a Workday page
     * whose sections are bare `<h3>`s that is "How Did You Hear About Us?",
     * and the saved answer to it, "LinkedIn", was written into City, into
     * Address, and into every other box whose own wrapper carried no label of
     * its own. `inAnotherField` did not catch it: that heading is a direct
     * child of the form, so it sits in no other field's container.
     *
     * A heading only describes a control when it comes before it and no other
     * control comes between them. Anything past the next control belongs to
     * that control, not to this one.
     */
    const nearestHeadingIn = (scope) => {
      let candidates;
      let controls;
      try {
        candidates = Array.from(scope.querySelectorAll(CAND_SEL));
        controls = Array.from(scope.querySelectorAll(CONTROL_SEL));
      } catch { return ""; }

      const precedesEl = (n) =>
        Boolean(n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);

      // Controls that answer a different question, in document order.
      const foreign = controls.filter(
        (c) => c !== el && !memberIds.has(c.id) && !c.contains(el) && precedesEl(c)
      );
      const lastForeign = foreign.length ? foreign[foreign.length - 1] : null;

      // Everything printed after the last of those belongs to this control.
      const own = candidates.filter((cand) => {
        if (!precedesEl(cand)) return false;                       // below the field
        if (cand.contains(el)) return true;                        // a wrapper of ours
        if (!lastForeign) return true;
        // Strictly after the previous field's control.
        return Boolean(lastForeign.compareDocumentPosition(cand) & Node.DOCUMENT_POSITION_FOLLOWING);
      });

      // A question mark, or a <legend>, is the form telling us outright which
      // text is the question. Anything else here is only a fallback.
      let fallback = "";
      for (const cand of own) {
        const text = readCandidate(cand, scope);
        if (!text) continue;
        if (cand.tagName === "LEGEND" || /\?\s*\*?$/.test(text)) return text;
        if (!fallback) fallback = text;
      }
      return fallback;
    };

    let node = el?.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const found = nearestHeadingIn(node);
      if (found) return found;
    }
    return "";
  }

  /** The accessible name of the group this control belongs to, if it has one. */
  function groupAccessibleNames(el) {
    const names = [];
    if (!el) return names;
    const push = (value) => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      if (text) names.push(text);
    };
    const fromIdList = (list) => {
      String(list || "").split(/\s+/).forEach((id) => {
        if (!id) return;
        const node = document.getElementById(id);
        if (node && !node.contains(el)) push(M.visibleText?.(node) ?? node.textContent);
      });
    };

    try {
      const container = el.closest?.("fieldset, [role='radiogroup'], [role='group']");
      if (container) {
        const legend = container.querySelector("legend");
        if (legend && !legend.contains(el)) push(M.visibleText?.(legend) ?? legend.textContent);
        push(container.getAttribute("aria-label"));
        fromIdList(container.getAttribute("aria-labelledby"));
      }
      // Some portals name the question on the control instead of the group.
      fromIdList(el.getAttribute?.("aria-labelledby"));
    } catch {}
    return names;
  }

  /**
   * The question as a person would read it.
   *
   * `field.label` is several descriptions joined with " | ", ending with the
   * humanized name attribute. The first description is normally the visible
   * label — except on choice groups, where it is one of the options.
   *
   * Every candidate is now checked against the group's own option labels and
   * against a list of answer phrasings, so a dropdown, radio group or checkbox
   * group is saved under the question it asks rather than under the answer that
   * was picked.
   */
  function primaryQuestion(field, { floor = 5 } = {}) {
    // Resolved once per field per pass: planning, the saved-answer lookup and
    // capture all ask, and the heading search behind it walks the form.
    const memoKey = `pq:${floor}`;
    const memo = field?.__memo?.[memoKey];
    if (memo && Date.now() - memo.at < 8000) return memo.value;
    const result = computePrimaryQuestion(field, { floor });
    try { if (field) (field.__memo ??= {})[memoKey] = { value: result, at: Date.now() }; } catch {}
    return result;
  }

  function computePrimaryQuestion(field, { floor = 5 } = {}) {
    const el = field?.el;
    const parts = String(field?.label ?? "").split("|").map((x) => cleanQuestionText(x)).filter(Boolean);
    const options = optionTextsForField(field);
    const machine = machineNameParts(el);

    // The section heading is where a field is, not what it asks. Filed under
    // "Application Questions", one answer would match every question on the
    // page on the next application.
    let contextKey = "";
    try { contextKey = answerKey(M.sectionContext?.(el)?.title || ""); } catch {}

    const acceptable = (value) => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      if (text.length < floor || text.length > 300) return "";
      if (options.has(answerKey(text))) return "";
      if (contextKey && answerKey(text) === contextKey) return "";
      if (ANSWER_LIKE_RE.test(text)) return "";
      if (looksMachineGenerated(text)) return "";
      return text;
    };

    /** Acceptable *and* actually printed on the page, rather than derived from an attribute. */
    const fromPage = (value) => {
      const text = acceptable(value);
      if (!text) return "";
      return machine.has(text.toLowerCase()) ? "" : text;
    };

    // 1. The group's own accessible name — a <legend>, a radiogroup's
    //    aria-label, or whatever its aria-labelledby points at. This is the
    //    form stating which text is the question, so it outranks everything.
    for (const name of groupAccessibleNames(el)) {
      const text = fromPage(name);
      if (text) return text;
    }

    const isChoice = field?.kind === "radio" || field?.kind === "checkbox" || field?.kind === "select";

    // 2. A visible label part that reads like a question rather than an answer.
    if (isChoice) {
      for (const part of parts) {
        const text = fromPage(part);
        if (text && (/\?/.test(text) || text.length > 12)) return text;
      }
    }

    // 3. Any remaining visible label part that is not one of the answers.
    for (const part of parts) {
      const text = fromPage(part);
      if (text) return text;
    }

    /**
     * 4. The heading printed above the control.
     *
     * This used to sit *below* the raw label parts for everything except a
     * choice group, and below only some of them even there — so on a form whose
     * controls are named with uuids the humanized attribute won, and the
     * question the applicant could plainly read above the boxes was never
     * consulted. The search is now reached by every field before any
     * attribute-derived text is considered.
     */
    const heading = questionHeadingNear(el, options);
    if (heading) return heading;

    /**
     * 5. Last resort: the humanized `name` or `id`.
     *
     * Still worth having — a bare text box carrying nothing but
     * `name="notice_period"` is asking about a notice period, and that is the
     * only description of it that exists. `acceptable` has already rejected the
     * uuid-shaped ones, so what reaches here reads like English.
     */
    for (const part of parts) {
      const text = acceptable(part);
      if (text) return text;
    }
    return "";
  }

  /**
   * Which repeated block this control sits in, spelled out for a person.
   *
   * The pending list is keyed by the question text, all the way through to
   * extension storage. A form with two Work Experience rows asks "Company"
   * twice, so correcting both employers produced two entries under one key and
   * the second silently replaced the first — the applicant made two edits and
   * the popup offered them one. The row is part of what makes those two
   * questions different, so it belongs in the question.
   *
   * The number is written outside any brackets on purpose: the background's
   * key normaliser strips bracketed text, so "Professional Experience (1)" and
   * "(2)" would collapse back to the same key.
   */
  function sectionQualifier(field) {
    /**
     * Only a repeated history row is qualified.
     *
     * A qualified question does not travel — "Company — Work Experience 2"
     * matches nothing on the next application, which is exactly right for a
     * positional row and exactly wrong for "What is your notice period?". So
     * this is limited to the two families that actually repeat; anything else
     * keeps its plain question and stays reusable. Two unrelated boxes that
     * still land on the same wording are separated by `uncontestedQuestion`.
     */
    const key = field?.rule?.key;
    if (!key || !(EXPERIENCE_KEYS.has(key) || EDUCATION_KEYS.has(key))) return "";

    let title = "";
    let index = null;
    try {
      const section = M.sectionContext?.(field?.el);
      title = String(section?.title ?? "").trim();
      index = section?.index;
    } catch {}

    const row = Number.isInteger(field?.index) ? field.index : index;
    if (!title) return Number.isInteger(row) && row > 0 ? `row ${row + 1}` : "";

    // "Work Experience 2" and "Professional Experience (2)" both reduce to the
    // heading's wording plus a bare number.
    const stem = title.replace(/[([{#\-–—:]*\s*\d+\s*(?:of|\/)?\s*\d*\s*[)\]}]*\s*$/, "").trim();
    if (!Number.isInteger(row)) return stem || title;
    return `${stem || title} ${row + 1}`;
  }

  /**
   * The question a manual edit is filed under.
   *
   * Separate from `primaryQuestion` because that one is also the lookup key for
   * replaying a saved answer onto the next application, and a row-qualified
   * question deliberately does not travel: "Company — Work Experience 2" means
   * nothing on a different form. What it does do is keep two edits on *this*
   * page apart, and give a two-letter label like "To" enough text to survive
   * the length floor instead of being dropped without trace.
   */
  function capturedQuestion(field) {
    const qualifier = sectionQualifier(field);
    const base = primaryQuestion(field, { floor: qualifier ? 2 : 5 });
    if (!base) return "";
    if (!qualifier) return base;
    if (base.toLowerCase().includes(qualifier.toLowerCase())) return base;
    return `${base} \u2014 ${qualifier}`;
  }

  /** Every control that answers the same question as this one. */
  function groupMembersOf(el) {
    try {
      const group = M.choiceGroup?.(el);
      if (group?.length) return group;
    } catch {}
    return [el];
  }

  /** Is the value in this control simply the one Appli-Fill put there? */
  function matchesWritten(el, answer) {
    const written = el.__applifillWrittenValue;
    if (written == null) return false;
    try {
      const a = M.normalizeChoiceText(String(answer));
      const b = M.normalizeChoiceText(String(written));
      if (!a || !b) return false;
      return a === b || a.includes(b) || b.includes(a);
    } catch {
      return String(answer) === String(written);
    }
  }

  /** Does this control still hold precisely the value Appli-Fill wrote into it? */
  function sameAsWritten(el, answer) {
    const written = el.__applifillWrittenValue;
    if (written == null) return false;
    try {
      const a = M.normalizeChoiceText(String(answer));
      const b = M.normalizeChoiceText(String(written));
      return Boolean(a) && a === b;
    } catch {
      return String(answer) === String(written);
    }
  }

  /** Was this control, or any member of its group, filled by the model? */
  function isDrafted(el) {
    const drafted = state.drafted;
    if (!drafted?.size) return false;
    if (drafted.has(el)) return true;
    try { return groupMembersOf(el).some((m) => drafted.has(m)); } catch { return false; }
  }

  /**
   * Queue whatever this control currently holds, if it is the applicant's.
   *
   * `userDriven` means an event proved a person did it. The sweep has no such
   * proof, so it additionally refuses anything that still matches what Appli-Fill
   * wrote — otherwise re-running a fill would bank the whole form as answers.
   */
  /**
   * An answer the applicant typed is held, not banked.
   *
   * Every edit used to go straight into the sync queue. That is how a wrong
   * value became a permanent one: the AI put "Yes" in a Name box, the applicant
   * corrected it, and *both* the correction and the original were captured
   * against questions they had never knowingly saved — so the next application
   * was filled from the same bad queue. Worse, there was no moment at which
   * they were told any of it was being kept.
   *
   * An edit now lands here and stays visible as an unsaved answer until it is
   * explicitly saved. Nothing reaches Saved Answers without a click.
   */
  const pendingSave = new Map();   // question -> { entry, field }

  /**
   * Two controls, two entries — always.
   *
   * The Map and the storage behind it are both keyed by the question, and
   * `sectionQualifier` cannot always tell two boxes apart: Workday's `From` and
   * `To` each render a segment labelled only "Month", inside the same row. When
   * that happens the second edit used to overwrite the first and one of the
   * applicant's corrections simply vanished from the list. A numeric suffix is
   * added instead, so nothing is ever silently lost. Brackets are avoided
   * because the background's key normaliser strips them.
   */
  function uncontestedQuestion(field, question) {
    const held = pendingSave.get(question);
    if (!held || held.field?.el === field?.el) return question;
    for (let n = 2; n <= 20; n++) {
      const candidate = `${question} \u2014 ${n}`;
      const taken = pendingSave.get(candidate);
      if (!taken || taken.field?.el === field?.el) return candidate;
    }
    return question;
  }

  function holdAnswer(field, entry) {
    pendingSave.set(entry.question, { entry, field });
    try { field.el.classList.add("applifill-unsaved"); } catch {}
    /**
     * Held in extension storage, not in this Map.
     *
     * The Map is kept only to know which control on *this* page to outline and
     * to clear the outline when the answer is saved. It cannot be the record:
     * a Workday application navigates on every step, each navigation tears this
     * content script down, and the Map went with it — so an answer edited on
     * step 2 was gone before the applicant reached the popup. That is why
     * saving answers looked like it did nothing.
     *
     * Storage survives navigation, reload and closing the tab, and the popup
     * reads it from there, so it works even on a page where this script never
     * loaded.
     */
    send({ type: "APPLI_FILL_HOLD_ANSWERS", items: [entry] });
    publishPending();
  }

  /**
   * Take back what was held for this control.
   *
   * Used when the applicant puts Appli-Fill's own answer back: the answer they
   * tried in between is no longer on the form and is not theirs to review.
   */
  function withdrawHeldFor(el) {
    el.__applifillLastCaptured = undefined;
    const members = new Set(groupMembersOf(el));
    members.add(el);
    const questions = [];
    for (const [question, held] of pendingSave) {
      if (!held?.field?.el || !members.has(held.field.el)) continue;
      try { held.field.el.classList.remove("applifill-unsaved"); } catch {}
      pendingSave.delete(question);
      questions.push(question);
    }
    if (!questions.length) return;
    send({ type: "APPLI_FILL_DISCARD_HELD", questions, withdrawn: true });
    publishPending();
  }

  /** Nudge any open popup to re-read the held list. */
  function publishPending() {
    const items = Array.from(pendingSave.values()).map(({ entry }) => ({
      question: entry.question,
      answer: entry.answer,
      inputType: entry.inputType,
      options: entry.options,
      ats: entry.ats,
      domain: entry.domain,
    }));
    try {
      chrome.runtime.sendMessage({ type: "APPLI_FILL_PENDING", items, url: location.href });
    } catch {}
  }

  function commitPendingAnswers() {
    const held = Array.from(pendingSave.values());
    for (const { field } of held) {
      try {
        field.el.classList.remove("applifill-unsaved");
        field.el.classList.add("applifill-saved");
      } catch {}
    }
    pendingSave.clear();
    // Saving is done against storage, so it covers answers held on earlier
    // steps of this application as well as the ones still on screen.
    send({ type: "APPLI_FILL_SAVE_HELD" });
    publishPending();
    return held.length;
  }

  function discardPendingAnswers() {
    for (const { field } of pendingSave.values()) {
      try { field.el.classList.remove("applifill-unsaved"); } catch {}
    }
    pendingSave.clear();
    publishPending();
  }

  /**
   * Saving and discarding are now driven from the extension popup, which is
   * where the applicant can see a pending answer beside the saved ones it would
   * join. Nothing about the hold model changed: an edit is still held, and still
   * reaches Saved Answers only on an explicit action.
   */
  function handlePendingCommand(msg, respond) {
    if (msg.type === "APPLI_FILL_PENDING_LIST") {
      respond({
        ok: true,
        items: Array.from(pendingSave.values()).map(({ entry }) => ({
          question: entry.question,
          answer: entry.answer,
          inputType: entry.inputType,
          domain: entry.domain,
        })),
      });
      return true;
    }
    if (msg.type === "APPLI_FILL_PENDING_SAVE") {
      const saved = msg.question ? commitOne(msg.question) : commitPendingAnswers();
      respond({ ok: true, saved });
      return true;
    }
    if (msg.type === "APPLI_FILL_PENDING_DISCARD") {
      if (msg.question) {
        const held = pendingSave.get(msg.question);
        if (held) { try { held.field.el.classList.remove("applifill-unsaved"); } catch {} }
        pendingSave.delete(msg.question);
        send({ type: "APPLI_FILL_DISCARD_HELD", questions: [msg.question] });
        publishPending();
      } else {
        discardPendingAnswers();
        send({ type: "APPLI_FILL_DISCARD_HELD" });
      }
      respond({ ok: true });
      return true;
    }
    return false;
  }

  function commitOne(question) {
    const held = pendingSave.get(question);
    if (held) {
      try {
        held.field.el.classList.remove("applifill-unsaved");
        held.field.el.classList.add("applifill-saved");
      } catch {}
      pendingSave.delete(question);
    }
    send({ type: "APPLI_FILL_SAVE_HELD", questions: [question] });
    publishPending();
    return 1;
  }

  /** Is the page currently showing an error against this control? */
  function pageFlagsInvalid(el) {
    try {
      if (el.getAttribute?.("aria-invalid") === "true") return true;
      const described = el.getAttribute?.("aria-describedby");
      if (described) {
        for (const id of described.split(/\s+/)) {
          const node = document.getElementById(id);
          const msg = node && M.visibleText(node);
          if (msg && /\b(enter a maximum|maximum of \d+|too long|invalid|must be|is required|field is required)\b/i.test(msg)) return true;
        }
      }
    } catch {}
    return false;
  }

  function worthSaving(field, answer) {
    const el = field.el;
    const text = String(answer ?? "");
    if (!text) return false;

    const cap = Number(el?.getAttribute?.("maxlength") ?? el?.maxLength ?? 0);
    if (cap > 0 && text.length > cap) return false;

    // The page's own verdict. If it is showing an error for this field, its
    // current contents are by definition not an answer worth reusing.
    if (pageFlagsInvalid(el)) return false;

    // A short structured box holding a sentence is a box something got wrong.
    const structured = /suffix|prefix|title|initial|city|state|county|district|zip|postal|country|line\s*\d/i;
    if (structured.test(field.label || "") && (text.length > 100 || /\.\s+\S/.test(text))) return false;

    // The same fragment repeated back to back is the accumulation signature.
    if (/(\b[A-Za-z]{4,}\b)\1/.test(text.replace(/\s+/g, ""))) return false;

    return true;
  }

  /**
   * A Yes / No / Prefer-not-to-say group is a question, not a profile field.
   *
   * Rules match on wording, and a demographic question can easily contain a
   * word a profile rule watches for: "Are you the first member of your
   * immediate family to attend university?" matched the **school** rule on
   * "university". School is profile-owned, so the answer was silently refused
   * and the applicant's choice never appeared to save — while the same
   * question in different markup saved perfectly, which is what made it look
   * intermittent.
   *
   * A profile field holds a value like "Osmania University". A group whose only
   * choices are yes, no and a decline option cannot be one, whatever its
   * wording, so a profile rule has no claim on it.
   */
  function isGenericChoiceGroup(field) {
    /**
     * Dropdowns count too.
     *
     * This covered radios and checkboxes only, so the identical question drawn
     * as a <select> — which is how most ATSs draw "Are you at least 18 years of
     * age?" — kept whatever profile rule its wording happened to match, and
     * correcting the answer by hand was silently refused. The applicant saw
     * their change on the form and nothing in the unsaved list, which is the
     * "dropdown answers don't save" report.
     */
    if (field?.kind !== "radio" && field?.kind !== "checkbox" && field?.kind !== "select") return false;
    let options = [];
    try { options = M.optionTextsFor(field.el) || []; } catch { return false; }
    // The opening "Select…" row says nothing about what the question is.
    options = options.map((o) => String(o).trim()).filter((o) => o && !PLACEHOLDER_OPTION_RE.test(o));
    if (options.length < 2) return false;
    return options.every((option) => ANSWER_LIKE_RE.test(option));
  }

  /**
   * Answers that belong to the profile and must never reach Saved Answers.
   *
   * Everything else an applicant edits is fair game — a corrected employer, a
   * date, a dropdown, a radio group — and is held for review. These are not.
   * A name or an email address is edited in the profile, and banking one
   * against a question would both put it on the next application under a
   * question it does not answer and copy personal details into a reusable
   * store the applicant never asked to keep them in.
   *
   * Deliberately narrower than the old `if (field.rule) return`, which excluded
   * every field a rule had matched and is what made corrections to work history
   * and dropdown answers vanish from the pending list.
   */
  const NEVER_BANKED_KEYS = new Set([
    "firstName", "lastName", "middleName", "preferredName", "fullName", "signature",
    "namePrefix", "nameSuffix", "dateOfBirth", "email", "emailConfirm",
    "phone", "phoneCountryCode", "phoneType",
    "address", "addressLine2", "city", "state", "zip",
    "linkedin", "github", "portfolio", "twitter", "facebook",
    "resume", "coverLetter",
  ]);

  const IDENTITY_LABEL_RE =
    /\b(e-?mail|first\s*name|last\s*name|middle\s*name|full\s*name|given\s*name|family\s*name|surname|date\s*of\s*birth|social\s*security|national\s*id|address\s*line|postal\s*code|zip\s*code)\b/i;

  /** Rules that answer with a place — never with "Yes" or "No". */
  const PLACE_KEYS = new Set(["address", "addressLine2", "city", "state", "zip", "country", "county", "location"]);

  function belongsToProfile(field) {
    const key = field?.rule?.key;
    // A start date is one application's, not an answer to bank for the next.
    if (key === "startDate" && isDateBox(field?.el)) return true;
    if (key && NEVER_BANKED_KEYS.has(key)) {
      /**
       * A place rule sitting on a question.
       *
       * Rules match on words, and "Are you willing to travel out of state?" or
       * "Do you live within commuting distance of the city?" contain one. The
       * applicant's "No" there is an answer to a question, not an address, and
       * refusing it is why those edits never appeared in the pending list.
       */
      if (PLACE_KEYS.has(key)) {
        let answer = "";
        try { answer = String(readValue(field) ?? "").trim(); } catch {}
        const own = String(field?.label ?? "").split("|")[0].trim();
        if (answer && M.yesNoId?.(answer) && !M.regionId?.(answer)) return false;
        if (/\?\s*\*?$/.test(own) && own.split(/\s+/).length >= 5) return false;
      }
      return true;
    }
    // A generic yes/no group cannot be a name box however its wording reads, so
    // the label test is skipped for one — that mix-up is what used to refuse
    // demographic answers whose question happened to contain a watched word.
    if (isGenericChoiceGroup(field)) return false;
    return IDENTITY_LABEL_RE.test(String(field?.label ?? ""));
  }

  function recordAnswer(field, { userDriven, untrustedChange = false }) {
    const el = field.el;
    if (!attached(el)) return false;

    /**
     * Only an answer a person actually gave.
     *
     * The unsaved list used to fill with the entire form after every fill,
     * because a post-fill pass offered every field that held a value — the
     * profile's, a saved answer's, the model's — as though the applicant had
     * just typed it. Nothing is held now unless something marked this control
     * as edited by hand, which is what the applicant expects to review.
     */
    if (!el.__applifillUserEdited) return false;

    /**
     * …and the hand was a person's, on this control, after Appli-Fill's write.
     * Every path into the pending list passes through here, so this is the
     * one place the rule is enforced: whatever marked the control edited, a
     * value nobody touched since Appli-Fill wrote it is Appli-Fill's.
     */
    if (!personTouched(el) && !untrustedChange) return false;

    /**
     * A name is not a saved answer.
     *
     * The guard for this lived in the sweep only, so correcting an autofilled
     * First Name or Email on the page — an ordinary thing to do — offered it as
     * an answer to bank against a question, and reusing it on the next
     * application is both wrong and a privacy problem. These fields are edited
     * in the profile; the check belongs on every path into the queue, not on
     * one of them.
     */
    if (belongsToProfile(field)) return false;

    const answer = String(readValue(field) ?? "").trim();
    if (!answer) return false;
    if (PLACEHOLDER_OPTION_RE.test(answer)) return false;
    if (el.__applifillLastCaptured === answer) return false;

    /**
     * Appli-Fill's answer, in any form it has taken on this control — what was
     * asked for, what the widget showed, what the page reformatted it into.
     * An applicant who changed an answer and then changed it back has not
     * edited it, so whatever was held for the detour is withdrawn.
     */
    if (isOurValue(el, answer)) {
      withdrawHeldFor(el);
      return false;
    }

    // This is the re-render-safe provenance guard. The element-local marker can
    // disappear when Workday/Ashby replaces the node, but the short-lived ledger
    // still knows that this exact question+answer came from Appli-Fill.
    if (isKnownProgrammaticAnswer(field, answer)) return false;

    /**
     * An answer Appli-Fill wrote is never the applicant's answer.
     *
     * `__applifillUserEdited` was the only provenance test, and it is set by an
     * `input` listener as soon as the 1500ms programmatic window lapses. The
     * settle passes that repair a form the page cleared run at 900ms and
     * 2200ms — the "Restored 7 fields" notice — so the second of them writes
     * outside that window, the listener called it typing, and answers the
     * applicant had never touched appeared in the unsaved list. Asking whether
     * the control still holds exactly what we put in it settles provenance
     * without depending on the timing of any event.
     *
     * Exact equality, not the containment `matchesWritten` uses: ticking a
     * second box in a group leaves the first one in the value, and that is a
     * new answer, not our old one.
     */
    if (sameAsWritten(el, answer)) return false;

    /**
     * A drafted answer is held to the stricter test.
     *
     * A model's paragraph is the one thing on the form that was neither the
     * applicant's nor the profile's, and a widget that reflows or trims it
     * would slip past exact equality. Until they change it, it is not theirs.
     */
    if (isDrafted(el) && matchesWritten(el, answer)) return false;

    // readValue reports an empty checkbox group as "No". That is the right
    // reading for a single "I agree" box the person deliberately left clear,
    // but for a group nobody has touched yet it is not an answer at all.
    if (field.kind === "checkbox") {
      const members = groupMembersOf(el);
      const anyTicked = members.some((m) => m.checked === true || m.getAttribute?.("aria-checked") === "true");
      // An unchecked checkbox group is an empty field, not a reusable "No"
      // answer. Never save that empty state back into Saved Answers.
      if (!anyTicked) return false;
    }

    let question = capturedQuestion(field);
    if (!question || question.length > 300) return false;

    /**
     * A password typed by hand is held once, as "Password", and never shown.
     *
     * The confirm box only repeats it, so "Verify New Password" is never held
     * as an answer of its own; the password itself is filed under the one
     * name the account step looks it up by.
     */
    const secret = isPasswordControl(el);
    if (secret) {
      if (/\b(confirm|verify|verification|re-?enter|re-?type|repeat|again|retype)\b/i.test(`${question} ${field.label ?? ""}`)) return false;
      question = "Password";
    }

    /**
     * Remembered only once the answer is actually held.
     *
     * This was set before `worthSaving` ran, so an answer refused once — the
     * page still flagging the field invalid for the few milliseconds after the
     * applicant fixed it, which Workday does on every required dropdown after a
     * failed Save and Continue — was marked as already captured and every later
     * attempt to record the same answer returned early. The edit never reached
     * the pending list at all.
     */
    if (!worthSaving(field, answer)) {
      // Refused only because the page has not yet cleared its error from the
      // previous, empty value: look again once it has had a moment to revalidate.
      if (pageFlagsInvalid(el) && (el.__applifillInvalidRetries ?? 0) < 3) {
        el.__applifillInvalidRetries = (el.__applifillInvalidRetries ?? 0) + 1;
        setTimeout(() => {
          try {
            if (String(readValue(field) ?? "").trim() === answer) recordAnswer(field, { userDriven });
          } catch {}
        }, 700);
      }
      return false;
    }
    el.__applifillInvalidRetries = 0;
    el.__applifillLastCaptured = answer;

    /**
     * The choices this question offered, kept whatever markup drew them.
     *
     * `optionTextsFor` alone returns a single entry for a radio group with no
     * `name` attribute, so a saved "choice" answer arrived with no choices
     * beside it and the dashboard had nothing to render as options. The group
     * members are the authority; the helper is merged in for the select and
     * segmented-button cases it handles better.
     */
    let options = [];
    if (field.kind === "select" || field.kind === "radio" || field.kind === "checkbox") {
      const seen = new Set();
      const add = (value) => {
        const text = String(value ?? "").trim().replace(/\s+/g, " ");
        if (!text || seen.has(text.toLowerCase())) return;
        seen.add(text.toLowerCase());
        options.push(text);
      };
      try { (M.optionTextsFor(el) || []).forEach(add); } catch {}
      if (field.kind === "radio" || field.kind === "checkbox") {
        // Not the group's own text ("Yes No"): its buttons are listed above.
        try { groupMembersOf(el).forEach((m) => { if (!isChoiceGroupHost(m)) add(M.radioOptionText?.(m)); }); } catch {}
      }
      options = options
        .filter((o) => !PLACEHOLDER_OPTION_RE.test(o))
        .filter((o) => o.length <= 200)
        .slice(0, 50);
    }

    clearProgrammaticAnswer(field, answer);
    holdAnswer(field, {
      question: uncontestedQuestion(field, question),
      answer,
      // The control the answer came from, so the popup and the dashboard can
      // both say whether this was a dropdown, a radio group or a text box.
      inputType: secret ? "password" : field.kind || "text",
      options,
      ats: state.adapter?.key,
      domain: location.hostname,
      // The company asking, so the same question from another company can be
      // recognised as this one with the name swapped ("…employed by Acme?").
      company: pageCompany(),
      source: "user",
      // When the applicant made this change. A dismissal recorded before it
      // cannot silence it: a deliberate new edit is always shown.
      editedAt: Date.now(),
    });
    unmark(el);
    return true;
  }

  /**
   * Every control being watched, re-read after anything the person does.
   *
   * Listeners alone only ever caught typing. A native <select> fires `change`
   * on itself, but a custom dropdown paints its answer into a button while the
   * click lands on an option in a portal somewhere else in the document, and a
   * radio group fires on whichever member was clicked rather than the one the
   * field was anchored to. All of those went unrecorded, which is why picking a
   * dropdown or radio answer never produced anything to sync.
   */
  const watched = new Map();
  let sweepTimer = null;

  /**
   * When a real person last did something anywhere on this page.
   *
   * The browser marks events it synthesises for page scripts as untrusted, so a
   * trusted event is proof a human is at the keyboard. The sweep needs this
   * because a custom dropdown paints its answer into a button while the click
   * lands on an option in a portal elsewhere in the document — the control that
   * changed never sees an event of its own, so without a page-level signal the
   * only choices were to bank every dropdown or to bank none of them.
   */
  let lastHumanAt = 0;

  /**
   * `isTrusted` is not by itself proof of a person.
   *
   * Text is written with `execCommand("insertText")`, which is what gets a
   * value into Workday's own model — and the *user agent* dispatches the
   * resulting `beforeinput` and `input`, so the browser marks them trusted.
   * Appli-Fill's own fill therefore announced that a human was at the keyboard.
   * When Workday then hydrated and wiped First and Last Name 400ms later, the
   * sweep read the wipe as the applicant clearing the fields, marked them
   * user-owned, and the settle pass refused to restore them — leaving "The
   * field First Name is required" at Next with nothing in the box.
   *
   * An event arriving on a control Appli-Fill is mid-write on is Appli-Fill's.
   */
  const noteHuman = (event) => {
    if (!event?.isTrusted) return;
    try {
      const target = event.target;
      if (target && target.nodeType === 1 && isGroupProgrammatic(target)) return;
    } catch {}
    lastHumanAt = Date.now();
  };

  /* ---------------- Who changed this control? ---------------- */

  /**
   * Proof that a person worked *this* control.
   *
   * Pending Saved Answers is for what the applicant changed by hand, never for
   * what Appli-Fill wrote. The test used to be page-wide: any trusted event
   * anywhere in the previous eight seconds made every changed field "the
   * applicant's". A click anywhere on the page — or the in-page Fill button
   * itself — followed by the page reformatting a value Appli-Fill had just written,
   * a typeahead settling, or a widget re-rendering, was enough to offer
   * Appli-Fill's own answers back as manual edits.
   *
   * A change is now the applicant's only when that control, its group, or the
   * menu it opened was touched by a real pointer, key, paste or drop *after*
   * Appli-Fill last wrote to it. None of those can be produced by the fill: script
   * can only dispatch untrusted events. Trusted `input` counts as well — it is
   * what typing, dictation and paste produce — but never while Appli-Fill is
   * writing, because `execCommand("insertText")` makes the browser emit
   * trusted input for Appli-Fill's own typing.
   */
  let writeDepth = 0;
  function beginWrite() { writeDepth++; }
  function endWrite() { setTimeout(() => { writeDepth = Math.max(0, writeDepth - 1); }, 0); }

  const TOUCH_CONTROL_SEL =
    "input, select, textarea, button, [role='radio'], [role='checkbox'], [role='combobox'], " +
    "[role='listbox'], [role='switch'], [role='option'], [role='textbox'], [role='spinbutton'], " +
    "[role='button'], [role='menuitem'], [role='menuitemradio'], [role='treeitem'], [contenteditable='true']";
  const MENU_SEL = "[role='listbox'], [role='menu'], [role='tree'], [role='grid'], [role='dialog']";
  /** An open menu, including those drawn without ARIA roles (Workday's prompts, react-select, MUI). */
  const POPUP_SEL =
    "[role='listbox'], [role='menu'], [role='tree'], [data-automation-id='menuList'], [data-automation-id='promptOptions']" +
    ", [class*='select__menu'], [class*='dropdown-menu'], [class*='menuList'], [class*='MuiPopper']";
  /** One choice inside such a menu. */
  const OPTION_SEL =
    "[role='option'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='treeitem']" +
    ", [data-automation-id*='promptOption'], [data-automation-id='promptLeafNode'], [class*='select__option']";

  /**
   * When the applicant last picked something in a menu whose owner could not
   * be worked out. Only a custom dropdown whose answer changes within moments
   * of such a pick, while Appli-Fill is not writing, is credited with it.
   */
  let lastLooseMenuTouchAt = 0;
  const LOOSE_MENU_WINDOW_MS = 2500;

  /** The control whose menu this node sits in. */
  function menuOwnerOf(node) {
    const menu = node.closest?.(POPUP_SEL);
    let owner = null;
    try {
      if (menu?.id) {
        const id = CSS.escape(menu.id);
        owner = document.querySelector(`[aria-controls~="${id}"], [aria-owns~="${id}"]`);
      }
    } catch {}
    if (owner && owner !== node) return owner;
    try {
      return document.querySelector(
        "[role='combobox'][aria-expanded='true'], [aria-haspopup][aria-expanded='true'], button[aria-expanded='true']"
      );
    } catch { return null; }
  }

  /**
   * The controls a trusted event at `target` was aimed at.
   *
   * The click may land on a label, the tick inside an option, an option in a
   * menu drawn at the end of <body>, or the calendar button beside a
   * MM / DD / YYYY date — each resolves to the control whose answer it moves.
   */
  function controlsTouchedBy(target) {
    const found = [];
    if (!target?.closest) return found;

    /**
     * ADP: a click on one of its lists, radio groups or check boxes reaches the
     * page as the component (or one of its buttons), and the component is the
     * control that is watched. Nothing here mapped it back, so an answer the
     * applicant gave by hand on an ADP application was taken for the page's
     * own doing and never offered to save — which is why those answers never
     * came back on the next application.
     */
    if (M.onAdp?.()) {
      let host = null;
      try { host = target.closest(M.SDF_FIELD_SELECTOR); } catch {}
      if (host && M.isSdfField?.(host)) { found.push(host); return found; }
    }

    // A choice in an open menu belongs to the control that opened the menu.
    const option = target.closest(OPTION_SEL);
    const popup = target.closest(POPUP_SEL) || option?.parentElement;
    if (option || popup) {
      // A listbox that is itself the question, always open on the page.
      if (popup?.matches?.("[role='listbox']") && watched.has(popup)) {
        found.push(popup);
        return found;
      }
      const owner = menuOwnerOf(target);
      if (owner && !(popup && popup.contains(owner))) found.push(owner);
      else lastLooseMenuTouchAt = Date.now();
      // A search box inside the menu is still typed into as itself.
      const box = target.closest("input, textarea");
      if (box) found.push(box);
      return found;
    }

    let el = target.closest(TOUCH_CONTROL_SEL);
    if (!el) {
      const label = target.closest("label");
      const forId = label?.getAttribute?.("for");
      if (forId) { try { el = document.getElementById(forId); } catch {} }
      if (!el && label) el = label.control || label.querySelector(TOUCH_CONTROL_SEL);
    }
    if (el) {
      const role = el.getAttribute?.("role");
      const inMenu = role !== "combobox" && el.closest?.(MENU_SEL);
      if (role === "option" || role === "menuitem" || role === "menuitemradio" || role === "treeitem" || inMenu) {
        const owner = menuOwnerOf(el);
        if (owner) found.push(owner);
        if (!inMenu || role === "option") return found;
      }
      found.push(el);
    }
    // A button, or the frame of a small widget: the boxes it belongs to — the
    // calendar beside MM / DD / YYYY, a clear button. Never a form's own
    // Next, Save or Submit, which says nothing about any one answer.
    const formAction = el && (el.type === "submit" || (isActionButton(el) && !isCalendarButton(el)));
    if (!formAction && (!el || el.tagName === "BUTTON" || el.getAttribute?.("role") === "button")) {
      let node = (el || target).parentElement;
      for (let d = 0; node && d < 3; d++, node = node.parentElement) {
        if (node === document.body || node.tagName === "FORM") break;
        let boxes = [];
        try {
          boxes = Array.from(node.querySelectorAll(
            "input:not([type='hidden']), select, textarea, [role='combobox'], [role='spinbutton'], [role='textbox']"
          ));
        } catch {}
        if (!boxes.length) continue;
        if (boxes.length <= 4) found.push(...boxes);
        break;
      }
    }
    return found;
  }

  function markTouched(el, at = Date.now()) {
    eachInGroup(el, (member) => { member.__applifillTouchedAt = at; });
  }

  /**
   * Where a trusted event really landed. Inside an ADP component the page only
   * sees the component; the box the applicant typed into is the first element
   * of the event's composed path, and that box is the watched field.
   */
  function touchTargetsOf(event) {
    const out = [event.target];
    if (M.onAdp?.()) {
      try {
        const inner = event.composedPath?.()[0];
        if (inner && inner !== event.target && inner.nodeType === 1) out.push(inner);
      } catch {}
    }
    return out;
  }

  let touchTracking = false;
  function startTouchTracking() {
    if (touchTracking) return;
    touchTracking = true;
    const onTouch = (event) => {
      if (!event?.isTrusted) return;
      try { touchTargetsOf(event).forEach((t) => controlsTouchedBy(t).forEach((el) => markTouched(el))); } catch {}
    };
    ["pointerdown", "mousedown", "touchstart", "keydown", "paste", "cut", "drop", "compositionstart"]
      .forEach((type) => document.addEventListener(type, onTouch, true));
    const onTrustedInput = (event) => {
      if (!event?.isTrusted || writeDepth > 0) return;
      for (const target of touchTargetsOf(event)) {
        if (!target || target.nodeType !== 1 || isGroupProgrammatic(target)) continue;
        try { controlsTouchedBy(target).forEach((el) => markTouched(el)); } catch {}
      }
    };
    ["beforeinput", "input"].forEach((type) => document.addEventListener(type, onTrustedInput, true));
  }

  function lastTouchOf(el) {
    let at = 0;
    eachInGroup(el, (member) => { at = Math.max(at, member.__applifillTouchedAt || 0); });
    return at;
  }

  function lastWriteOf(el) {
    let at = 0;
    eachInGroup(el, (member) => { at = Math.max(at, member.__applifillWrittenAt || 0); });
    return at;
  }

  /** Was this control worked by a person since Appli-Fill last wrote to it? */
  function personTouched(el) {
    const touched = lastTouchOf(el);
    return touched > 0 && touched > lastWriteOf(el);
  }

  /**
   * A pick in a menu whose owner could not be identified, credited to the
   * custom dropdown whose answer just changed — and only while Appli-Fill is not
   * writing, and only moments after the pick.
   */
  function creditLooseMenuPick(field) {
    if (field?.kind !== "select" || field.el?.tagName === "SELECT") return false;
    if (writeDepth > 0 || state.filling) return false;
    if (Date.now() - lastLooseMenuTouchAt > LOOSE_MENU_WINDOW_MS) return false;
    if (lastLooseMenuTouchAt <= lastWriteOf(field.el)) return false;
    markTouched(field.el, lastLooseMenuTouchAt);
    return true;
  }

  /**
   * Everything a control has shown as Appli-Fill's answer: what was asked for, what
   * the widget displayed straight afterwards ("FL" for "Florida"; "No, I do not
   * have a disability…" for "No"), and anything the page turned it into later
   * with nobody touching it — a phone mask, a thousands separator, a typeahead
   * settling on "City of Jacksonville, FL, USA".
   */
  function writtenForms(el) {
    const forms = new Set();
    eachInGroup(el, (member) => {
      if (member.__applifillWrittenValue != null) forms.add(String(member.__applifillWrittenValue));
      (member.__applifillWrittenValues || []).forEach((v) => { if (v != null) forms.add(String(v)); });
    });
    forms.delete("");
    return Array.from(forms);
  }

  function rememberWrittenForm(el, value) {
    const text = String(value ?? "").trim();
    if (!text) return;
    eachInGroup(el, (member) => {
      const list = member.__applifillWrittenValues || (member.__applifillWrittenValues = []);
      if (!list.includes(text)) list.push(text);
      if (list.length > 12) list.splice(0, list.length - 12);
    });
  }

  const digitsOf = (s) => String(s ?? "").replace(/\D+/g, "");
  const numberOf = (s) => {
    const t = String(s ?? "").replace(/[\s,$€£₹]/g, "").replace(/\.0+$/, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  };

  /** Do two renderings of an answer say the same thing? */
  function sameMeaning(a, b) {
    const x = String(a ?? "").trim();
    const y = String(b ?? "").trim();
    if (!x || !y) return false;
    let nx = x.toLowerCase(), ny = y.toLowerCase();
    try { nx = M.normalizeChoiceText(x); ny = M.normalizeChoiceText(y); } catch {}
    if (nx === ny) return true;
    try {
      const canonical = M.canonicalAgreement(x, y);
      if (canonical !== null) return canonical;
    } catch {}
    const nX = numberOf(x), nY = numberOf(y);
    if (nX !== null && nY !== null) return nX === nY;
    // A phone number, however the page chose to punctuate it — with or
    // without the country code in front.
    const dX = digitsOf(x), dY = digitsOf(y);
    const wordy = (s) => /[a-z]{3,}/i.test(s.replace(/\b(ext|extension)\b/gi, ""));
    if (!wordy(x) && !wordy(y) && Math.min(dX.length, dY.length) >= 7 &&
        (dX === dY || ((dX.endsWith(dY) || dY.endsWith(dX)) && Math.abs(dX.length - dY.length) <= 3))) return true;
    // The same date written another way. Only between two things that are
    // plainly dates: the fallback date parser reads a date into odd strings.
    const looksLikeDate = (s) => /\b\d{4}\b/.test(s) &&
      (/\d[/.-]\d/.test(s) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(s));
    if (looksLikeDate(x) && looksLikeDate(y)) {
      try {
        const pX = M.dateParts?.(x), pY = M.dateParts?.(y);
        if (pX?.year && pY?.year && pX.year === pY.year &&
            Number(pX.month || 0) === Number(pY.month || 0) && Number(pX.day || 0) === Number(pY.day || 0)) return true;
      } catch {}
    }
    return false;
  }

  /**
   * Is this value one Appli-Fill put here?
   *
   * `loose` also accepts one rendering sitting inside the other at a word
   * boundary ("Yes" inside "Yes, I am authorized"). It is not used for a change
   * a person is known to have made, where "2 weeks" becoming "2 weeks notice"
   * is a real edit.
   */
  function isOurValue(el, answer, { loose = false } = {}) {
    const forms = writtenForms(el);
    if (!forms.length) return false;
    for (const form of forms) {
      if (sameMeaning(answer, form)) return true;
      if (loose) {
        try {
          const a = M.normalizeChoiceText(String(answer));
          const b = M.normalizeChoiceText(form);
          if (a && b && (M.containsAtWord(a, b) || M.containsAtWord(b, a))) return true;
        } catch {}
      }
    }
    return false;
  }

  /** What this control held the last time we looked, so a change is detectable. */
  function baseline(field) {
    try { return String(readValue(field) ?? "").trim(); } catch { return ""; }
  }

  /**
   * What a control held before the page replaced it.
   *
   * React portals re-render a control when its value changes, so the element
   * the applicant just answered is often not the element that was being
   * watched. The replacement came under watch holding the *new* answer as its
   * starting point, compared equal to itself, and the edit was never seen —
   * one of the ways a manual change on Workday never reached the pending list.
   * The replacement now inherits its predecessor's starting point, matched by
   * the id, name or question they share.
   */
  const lostBaselines = new Map();   // identity -> { baseline, written, at }
  const LOST_TTL_MS = 20000;

  function controlIdentity(field) {
    const el = field?.el;
    if (!el?.getAttribute) return "";
    const own = el.id || el.getAttribute("name") || "";
    if (own) return `${el.tagName}#${own}`;
    const auto = el.getAttribute("data-automation-id") || "";
    const question = String(field?.label ?? "").split("|")[0].trim().slice(0, 120);
    return auto || question ? `${el.tagName}@${auto}::${question}` : "";
  }

  /** Everything a replacement control needs to know about who wrote what. */
  function provenanceOf(el) {
    return {
      baseline: el.__applifillBaselineValue,
      written: el.__applifillWrittenValue,
      writtenValues: Array.isArray(el.__applifillWrittenValues) ? el.__applifillWrittenValues.slice() : [],
      writtenAt: el.__applifillWrittenAt || 0,
      touchedAt: el.__applifillTouchedAt || 0,
    };
  }

  function rememberLost(el, field) {
    const key = controlIdentity(field);
    if (!key || el.__applifillBaselineValue === undefined) return;
    lostBaselines.set(key, { ...provenanceOf(el), at: Date.now() });
    if (lostBaselines.size > 200) {
      const cutoff = Date.now() - LOST_TTL_MS;
      for (const [k, v] of lostBaselines) if (v.at < cutoff) lostBaselines.delete(k);
    }
  }

  /** The starting point a freshly rendered control should compare against. */
  function inheritedBaseline(field) {
    const key = controlIdentity(field);
    if (!key) return null;
    // A predecessor still sitting detached in the watch list, not yet swept.
    for (const [oldEl, oldField] of watched) {
      if (oldEl === field.el || attached(oldEl)) continue;
      if (controlIdentity(oldField) !== key) continue;
      watched.delete(oldEl);
      if (oldEl.__applifillBaselineValue === undefined) continue;
      return provenanceOf(oldEl);
    }
    const lost = lostBaselines.get(key);
    if (!lost) return null;
    lostBaselines.delete(key);
    return Date.now() - lost.at < LOST_TTL_MS ? lost : null;
  }

  function sweepWatched() {
    for (const [el, field] of watched) {
      if (!attached(el)) { rememberLost(el, field); watched.delete(el); continue; }

      let current = "";
      try { current = baseline(field); } catch { continue; }

      // Unchanged since the last look: nothing happened here.
      if (current === (el.__applifillBaselineValue ?? "")) continue;

      // It changed, so re-baseline whatever the verdict below is — otherwise
      // one ignored change is re-examined on every subsequent sweep.
      const previous = el.__applifillBaselineValue ?? "";
      el.__applifillBaselineValue = current;

      /**
       * Nobody touched this control since Appli-Fill last wrote it, so the page
       * made this change: a late render, a phone mask, a thousands separator,
       * a typeahead settling on its own wording. When Appli-Fill wrote the control,
       * what it shows now is Appli-Fill's answer in the page's words, and is
       * remembered as such so a later look can never mistake it for an edit.
       *
       * This replaces a page-wide "was anyone here in the last eight seconds",
       * under which one click anywhere made every such change look manual.
       */
      if (!personTouched(el) && !creditLooseMenuPick(field)) {
        if (current && lastWriteOf(el)) rememberWrittenForm(el, current);
        continue;
      }

      // Still holding what Appli-Fill wrote, in any of the forms it has shown:
      // the applicant looked and left Appli-Fill's answer as it was — or put it
      // back, in which case what was held for the detour is withdrawn.
      if (isOurValue(el, current)) { withdrawHeldFor(el); continue; }
      if (isGroupProgrammatic(el) && !previous) continue;

      // Any changed field can be a manual edit, including profile-backed work
      // history/date fields. The earlier profile-owned guard made edits to
      // extension-filled Work Experience, dates, radios and checkboxes vanish
      // from Pending Saved Answers. Provenance is already established by the
      // written-value/programmatic checks above.
      el.__applifillUserEdited = true;
      try { recordAnswer(field, { userDriven: false }); } catch {}
    }
  }

  function scheduleSweep() {
    clearTimeout(sweepTimer);
    // Long enough for a menu to close and the widget to paint its choice.
    sweepTimer = setTimeout(sweepWatched, 350);
  }

  let sweepStarted = false;
  function startSweep() {
    if (sweepStarted) return;
    sweepStarted = true;
    ["click", "change", "keyup", "focusout"].forEach((type) =>
      document.addEventListener(type, scheduleSweep, true)
    );
    // Separate from scheduleSweep: these establish that a person is present,
    // which the sweep then uses to decide whether a changed value is theirs.
    ["pointerdown", "keydown", "beforeinput", "input", "paste", "cut", "change"].forEach((type) =>
      document.addEventListener(type, noteHuman, true)
    );
  }

  function captureOn(field) {
    if (field.el.__applifillWatched || field.el.__applifillGroupWatched) return;
    field.el.__applifillWatched = true;
    // The whole group answers one question, so no other member may be watched
    // separately — otherwise focusing a second radio queued the same answer
    // twice, once against each element's own bookkeeping.
    groupMembersOf(field.el).forEach((m) => { m.__applifillGroupWatched = true; });
    watched.set(field.el, field);
    // Whatever the control holds the moment it comes under watch is the
    // starting point. The sweep only reacts to a change from this, so a page
    // that arrives pre-populated queues nothing until someone alters it —
    // unless this control replaced one that was already being watched, in
    // which case it continues from where its predecessor left off.
    let inherited = false;
    if (field.el.__applifillBaselineValue === undefined) {
      const previous = inheritedBaseline(field);
      if (previous) {
        const el = field.el;
        el.__applifillBaselineValue = previous.baseline;
        if (previous.written != null && el.__applifillWrittenValue == null) {
          el.__applifillWrittenValue = previous.written;
        }
        // Who wrote it and who touched it carry over too, or a control the
        // page re-rendered would forget that Appli-Fill's answer is Appli-Fill's.
        if (previous.writtenValues?.length) {
          el.__applifillWrittenValues = [...new Set([...(el.__applifillWrittenValues || []), ...previous.writtenValues])];
        }
        if (previous.writtenAt > (el.__applifillWrittenAt || 0)) el.__applifillWrittenAt = previous.writtenAt;
        if (previous.touchedAt > (el.__applifillTouchedAt || 0)) el.__applifillTouchedAt = previous.touchedAt;
        inherited = true;
      } else {
        field.el.__applifillBaselineValue = baseline(field);
      }
    }
    startSweep();
    startTouchTracking();
    if (inherited) scheduleSweep();

    const capture = (event) => {
      // A trusted event is proof a person is acting on this control, so it ends
      // the window that marks the control as ours immediately — otherwise an
      // edit made straight after a fill was dropped for a second and a half.
      /**
       * Our own write is settled before the event is believed.
       *
       * `isTrusted` is not proof of a person here. Committing a radio or
       * checkbox answer calls .click() on the option, and the browser's own
       * activation behaviour then fires `input` and `change` — which the spec
       * marks **trusted**, because the user agent dispatched them. So Appli-Fill's
       * click cleared its own programmatic window, the handler concluded a
       * person had answered, and the answer just replayed out of Saved Answers
       * was offered straight back as a new unsaved one. Asking whether we are
       * mid-write first, and only then believing the event, breaks that loop.
       */
      if (isGroupProgrammatic(field.el)) return;
      if (event?.isTrusted) lastHumanAt = Date.now();

      /**
       * Being present at a field is not answering it.
       *
       * This ran on every blur, so clicking into a box the portal had already
       * filled and clicking away again marked it edited and offered its
       * contents as an answer to save. Tabbing through a form was enough to
       * queue most of it. An edit has to actually change something: the value
       * is compared against what the control held when it came under watch, and
       * that reference is re-taken after each accepted change.
       */
      const current = baseline(field);
      if (current === (field.el.__applifillBaselineValue ?? "")) return;

      /**
       * A change is the applicant's only if they worked this control.
       *
       * The one exception is a native select, checkbox or radio reporting an
       * untrusted `change` while Appli-Fill is not writing: that is a styled
       * widget (Select2, Chosen, a custom radio card) passing on a choice the
       * applicant made in its own markup, which the touch tracking cannot map
       * back to the hidden control.
       */
      const el = field.el;
      const nativeChoice = el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio";
      const untrustedChange = Boolean(
        event && event.type === "change" && event.isTrusted === false &&
        nativeChoice && writeDepth === 0 && !state.filling
      );
      if (!personTouched(el) && !untrustedChange && !creditLooseMenuPick(field)) {
        // The page changed it — Appli-Fill's answer as the page chose to show it.
        if (current && lastWriteOf(el)) rememberWrittenForm(el, current);
        el.__applifillBaselineValue = current;
        return;
      }

      // Once the user changes a field it is user-owned for this session.
      el.__applifillUserEdited = true;
      recordAnswer(field, { userDriven: true, untrustedChange });
      el.__applifillBaselineValue = current;
    };

    // A setter marks a control as ours for up to 1.5s so the widget's own
    // trailing events aren't mistaken for typing. A real key press or click is
    // proof the person has taken over, so it ends that window immediately —
    // otherwise an edit made straight after a fill was silently discarded.
    const releaseToUser = (e) => {
      if (!e.isTrusted) return;
      // Appli-Fill's own typing, which the browser reports as trusted input.
      if (e.type === "beforeinput" && writeDepth > 0) return;
      // The whole group, so choosing a different radio with the keyboard or the
      // mouse counts as taking over from the fill however the group is wired.
      releaseGroupToUser(field.el);
    };
    // Any of these can only come from a real person: the browser marks events
    // it synthesises for page scripts as untrusted. A trusted `input` is the
    // one that matters most — typing over an AI draft produces it, and without
    // it that edit was dropped for the first second and a half after a fill.
    // `input` is deliberately absent: activation behaviour fires a *trusted*
    // `input` when Appli-Fill clicks a radio or checkbox, so treating it as proof
    // of a person handed our own write back to the applicant. Everything left
    // here can only come from a real interaction — typing still releases the
    // control immediately through `keydown` and `beforeinput`.
    ["keydown", "pointerdown", "beforeinput", "paste", "cut"].forEach((type) =>
      field.el.addEventListener(type, releaseToUser, true)
    );

    /**
     * Typing marks the box as the applicant's straight away, so a fill or a
     * settle pass running meanwhile cannot overwrite it. Only real typing:
     * trusted, on this control itself, and not while Appli-Fill is writing — the
     * browser reports Appli-Fill's own `insertText` as trusted input too, and an
     * event merely passing through on its way to a child is not this box's.
     */
    field.el.addEventListener("input", (event) => {
      if (!event?.isTrusted || writeDepth > 0 || isGroupProgrammatic(field.el)) return;
      const target = event.target;
      if (target !== field.el && !groupMembersOf(field.el).includes(target)) return;
      field.el.__applifillUserEdited = true;
    }, true);
    field.el.addEventListener("blur", capture, true);
    field.el.addEventListener("change", capture);

    /**
     * Typing is captured when it pauses, not only on blur.
     *
     * A text answer used to reach the pending list only once the box lost
     * focus — and opening the Appli-Fill popup straight after typing does not
     * always blur the page, so the answer the applicant had just written was
     * missing from the list they opened to save it.
     */
    let typingTimer = null;
    field.el.addEventListener("input", (event) => {
      if (!event?.isTrusted || writeDepth > 0 || isGroupProgrammatic(field.el)) return;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { try { capture({ isTrusted: true }); } catch {} }, 800);
    });
    field.el.__applifillCaptureNow = () => { clearTimeout(typingTimer); try { capture({ isTrusted: true }); } catch {} };

    // A segmented control answers on a click, and the person may well click the
    // segment that isn't the one we anchored the field to.
    // A widget answers after its menu closes, so the capture has to be delayed
    // — but the delay loses the event, and with it the proof that a person did
    // this. The trusted flag is carried across by hand.
    const deferredCapture = (event, delay) => {
      const trusted = Boolean(event?.isTrusted);
      if (trusted) lastHumanAt = Date.now();
      setTimeout(() => capture(trusted ? { isTrusted: true } : null), delay);
    };

    const segments = M.choiceButtonGroup?.(field.el);
    if (segments?.length) {
      segments.forEach((seg) => {
        seg.addEventListener("pointerdown", releaseToUser, true);
        seg.addEventListener("click", (e) => deferredCapture(e, 250));
      });
    } else if (field.el.tagName === "BUTTON") {
      field.el.addEventListener("click", (e) => deferredCapture(e, 700));
    }

    // Native radio and checkbox groups fire on whichever member was clicked,
    // not on the one this field is anchored to.
    if (field.kind === "radio" || field.kind === "checkbox") {
      try {
        groupMembersOf(field.el).forEach((member) => {
          if (member === field.el) return;
          // Keyboard selection moves through a radio group with arrow keys and
          // never produces a pointer event, so the release has to cover both.
          ["pointerdown", "keydown"].forEach((type) =>
            member.addEventListener(type, releaseToUser, true)
          );
          member.addEventListener("change", capture);
          member.addEventListener("click", (e) => deferredCapture(e, 120));
        });
      } catch {}
    }
  }

  /**
   * Rule keys whose answer belongs to the profile rather than to Saved Answers.
   *
   * Everything else is watched, which is the fix for "I corrected the answer and
   * it never saved". The old rule was `if (field.rule) return` — any field a
   * rule had matched was excluded from capture entirely, so changing a notice
   * period from "2 weeks" to "30 days", or a work-authorisation answer from Yes
   * to No, was never recorded and the stale answer stayed in the dashboard.
   *
   * Identity, contact, history and voluntary-disclosure fields stay out: they
   * are edited in the profile, and copying a name or an EEO answer into a
   * question bank would be both noise and a privacy problem.
   */
  const PROFILE_OWNED_KEYS = new Set([
    "firstName", "lastName", "middleName", "preferredName", "fullName", "signature",
    "dateOfBirth", "email", "emailConfirm",
    "phone", "phoneCountryCode", "phoneType",
    "address", "addressLine2", "city", "state", "zip", "location",
    "linkedin", "github", "portfolio", "twitter",
    "resume", "coverLetter",
    // Repeated history rows are positional — "Company (row 2)" means nothing on
    // the next site — so they are answered from the profile, never banked.
    "currentCompany", "currentTitle", "experienceLocation", "responsibilities",
    "experienceStartDate", "experienceEndDate", "experienceDatePart",
    "experienceStartMonth", "experienceStartYear", "experienceEndMonth", "experienceEndYear",
    "school", "educationLocation", "graduationDate", "educationDatePart",
    "educationStartMonth", "educationStartYear", "educationEndMonth", "educationEndYear",
  ]);

  function watchUnmatched() {
    state.unmatched.forEach(captureOn);
    state.drafted.forEach((el) => {
      const field = state.allFields?.find((f) => f.el === el);
      if (field) captureOn(field);
    });
    (state.allFields ?? []).forEach((field) => {
      if (field.kind === "file") return;
      captureOn(field);
    });
  }

  /**
   * Does a drafted answer have the shape this field will accept?
   *
   * Asked for a LinkedIn profile it has no URL for, the model answers in
   * sentences — "I do not have a LinkedIn profile or social network account" —
   * which is a perfectly sensible reply and completely unusable. Workday
   * rejects it as an invalid URL and the applicant is left holding a validation
   * error they did nothing to cause. A blank is what they wanted anyway.
   */
  function answerFitsFormat(field, answer) {
    const el = field.el;
    const text = String(Array.isArray(answer) ? answer.join(", ") : answer ?? "").trim();
    if (!text) return false;
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    const label = String(field.label ?? "");

    const wantsUrl =
      type === "url" ||
      /\b(url|link|linked-?in|git-?hub|portfolio|website|web\s*site|profile\s*(link|url))\b/i.test(label);
    if (wantsUrl) {
      return /^(https?:\/\/|www\.)\S+$/i.test(text) || /^[\w-]+(\.[\w-]+)+\/\S*$/i.test(text);
    }

    if (type === "email" || /\be-?mail\b/i.test(label)) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    }

    if (type === "tel" || /\b(phone|mobile|telephone)\b/i.test(label)) {
      return (text.match(/\d/g) || []).length >= 7;
    }

    return true;
  }

  /**
   * Is a drafted answer one of the choices this control actually offers?
   *
   * Free-text fields have nothing to check against, so they always pass.
   */
  function answerFitsOptions(field, answer) {
    const isChoice = field.kind === "select" || field.kind === "radio" || field.kind === "checkbox";
    if (!isChoice) return true;

    let choices = [];
    try { choices = M.optionTextsFor(field.el) || []; } catch {}
    // A remote menu that has not loaded yet offers nothing to compare against;
    // the setter opens it and does its own matching from there.
    if (!choices.length) return true;

    const norm = (x) => {
      try { return M.normalizeChoiceText(String(x)); } catch { return String(x).toLowerCase().trim(); }
    };
    const wanted = Array.isArray(answer) ? answer : [answer];
    const normalised = choices.map(norm).filter(Boolean);

    return wanted.every((one) => {
      const a = norm(one);
      if (!a) return false;
      return normalised.some((b) => a === b || a.includes(b) || b.includes(a));
    });
  }

  /**
   * Offer the answers the applicant gave by hand, and only those.
   *
   * This used to walk every field on the page and offer whatever it held, on
   * the reasoning that an answer is worth keeping whoever produced it. In
   * practice that meant one Fill click filled the unsaved list with the entire
   * form — the profile's own values, replayed saved answers, AI drafts — and
   * buried the handful of answers the applicant had actually chosen. The
   * dropdown, radio and checkbox answers picked by hand are the ones worth
   * reviewing, so those are the ones offered.
   *
   * The values Appli-Fill wrote are not lost by being left out: profile data lives
   * in the profile, and a replayed saved answer is already saved.
   */
  function queueAnswersFromForm() {
    for (const field of state.allFields ?? []) {
      try {
        if (field.kind === "file") continue;
        if (!attached(field.el)) continue;
        // The one test that matters: did a person put this here?
        if (!field.el.__applifillUserEdited) continue;

        const answer = String(readValue(field) ?? "").trim();
        if (!answer) continue;

        // Already saved with exactly this answer — re-queueing it would just be
        // noise in a list meant for reviewing what changed.
        const saved = findSavedAnswer(field);
        if (saved?.exact && String(saved.answer).trim() === answer) continue;

        recordAnswer(field, { userDriven: true });
      } catch {}
    }
  }

  /**
   * Attach the capture listeners without filling anything.
   *
   * These used to be attached only at the end of a fill, so a person who opened
   * an application and simply typed their answers — never pressing Fill — had
   * nothing recorded at all.
   */
  function watchPage() {
    try {
      const adapter = state.adapter ?? (state.adapter = ATS.detect());
      const fields = collectFields(adapter);
      if (!state.allFields?.length) state.allFields = fields;
      else {
        const known = new Set(state.allFields.map((f) => f.el));
        state.allFields.push(...fields.filter((f) => !known.has(f.el)));
      }
      watchUnmatched();
    } catch {}
  }

  /**
   * Anything the person clicks is watched from that moment on.
   *
   * `focusin` is not enough on its own. A great many ATS controls are divs —
   * `role="radio"`, `role="checkbox"`, a react-select combobox — carrying no
   * tabindex, so they can be clicked but never focused and the focus watcher
   * never fired for them. Their answers were only ever picked up if the field
   * happened to be in the one scan done at load, and on a step that rendered
   * later it never was, so answering them produced nothing to save.
   *
   * The click may land on a wrapper, a label, or the tick mark inside an
   * option, so the search runs from the target outwards and then inwards.
   */
  function watchClicks() {
    const CONTROL_SEL =
      "input, select, textarea, [role='radio'], [role='checkbox'], [role='combobox'], [role='listbox'], [role='switch'], [role='option']";

    document.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted) return;
      try {
        const target = event.target;
        if (!target?.closest) return;

        // Outwards: the control itself, or the label/option wrapping the click.
        let el = target.closest(CONTROL_SEL);

        // A <label> commits to the control it names rather than one inside it.
        if (!el) {
          const label = target.closest("label");
          const forId = label?.getAttribute?.("for");
          if (forId) { try { el = document.getElementById(forId); } catch {} }
          if (!el && label) el = label.querySelector(CONTROL_SEL);
        }

        // An option row in a portal belongs to whichever dropdown is open —
        // Workday's is a plain button, not a combobox. The menu's choices are
        // remembered on it while they are still on screen, because once it
        // closes they cannot be read again to store beside the answer.
        if (el?.getAttribute?.("role") === "option") {
          const menu = el.closest("[role='listbox'], [role='menu'], [role='tree']");
          let owner = null;
          try {
            if (menu?.id) {
              const id = CSS.escape(menu.id);
              owner = document.querySelector(`[aria-controls~="${id}"], [aria-owns~="${id}"]`);
            }
          } catch {}
          owner = owner || document.querySelector(
            "[role='combobox'][aria-expanded='true'], [aria-haspopup][aria-expanded='true'], button[aria-expanded='true']"
          );
          if (!owner) return;
          try {
            const texts = Array.from((menu || document).querySelectorAll("[role='option']"))
              .map((o) => M.clean(o.textContent || "")).filter(Boolean).slice(0, 60);
            if (texts.length) owner.__applifillMenuOptions = texts;
          } catch {}
          el = owner;
        }

        if (!el) return;
        watchControl(el);
      } catch {}
    }, true);
  }

  /**
   * Bring one control under watch, working out its label and rule first.
   *
   * Shared by the focus and pointer watchers so both apply the same rules about
   * what may be banked — in particular that a profile-owned box is never
   * offered as a saved answer.
   */
  function watchControl(el) {
    if (!el || el.__applifillWatched || el.__applifillGroupWatched || el.__applifillIgnored) return;
    if (!M.isFormControl(el)) return;
    if (!M.isFillable(el)) return;
    if (["submit", "reset", "button", "image", "file"].includes(el.type)) return;
    if (inPageChrome(el)) { el.__applifillIgnored = true; return; }
    const label = M.deriveLabel(el);
    const rule = M.matchRule(el, label, RULES);
    const field = { el, label, kind: M.fieldKind(el), rule };
    /**
     * Profile-owned fields are not banked as answers. This was opened up in
     * 1.8.0 so hand-corrections could be saved, and that was a mistake: an
     * email address captured off one form is an *answer* to a question whose
     * wording resembles half the contact boxes on the next one, so it came
     * back in the phone field. Contact details and identity belong in the
     * profile, which is the only place they can be stored once and used
     * everywhere without being matched by question text.
     *
     * A Yes/No/decline group is exempt — see isGenericChoiceGroup. Those are
     * questions that merely share a word with a profile rule, and refusing
     * them is what made demographic answers look like they never saved.
     */
    captureOn(field);
  }

  /**
   * Anything the person focuses is watched from that moment on. A single scan
   * can't see fields a step hasn't rendered yet, and focus is the cheapest
   * possible signal that a control is about to be answered.
   */
  function watchOnFocus() {
    document.addEventListener("focusin", (event) => {
      try { watchControl(event.target); } catch {}
    }, true);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAnswers();
  });
  window.addEventListener("pagehide", flushAnswers);

  /**
   * The page losing focus — the popup opening, another tab — is the moment the
   * applicant goes to look at what was captured. Anything still mid-edit is
   * recorded now rather than after a blur that may never come.
   */
  window.addEventListener("blur", () => {
    try {
      const active = document.activeElement;
      if (active?.__applifillCaptureNow) active.__applifillCaptureNow();
      if (sweepStarted) sweepWatched();
    } catch {}
  });

  /* ================================================================== */
  /*  Submit detection + sync                                            */
  /* ================================================================== */

  function watchSubmit() {
    const report = () => {
      const settings = state.session?.settings ?? {};
      const meta = ATS.readJobMeta(state.adapter ?? ATS.detect());
      const responses = Array.from(state.captured.values());

      flushAnswers();
      const payload = { responses };
      if (settings.trackAutomatically !== false && state.lastRun) {
        payload.application = {
          jobTitle: meta.jobTitle,
          company: meta.company,
          companyDomain: meta.companyDomain,
          location: meta.location,
          url: meta.url,
          ats: meta.ats,
          autofill: {
            fieldsDetected: state.lastRun.detected,
            fieldsFilled: state.lastRun.filled,
            durationMs: state.lastRun.durationMs,
          },
        };
      }
      if (payload.application || responses.length) send({ type: "APPLI_FILL_SYNC", payload });
      state.captured.clear();
    };

    document.addEventListener("submit", () => setTimeout(report, 300), true);

    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target?.closest?.('button, input[type="submit"], a[role="button"]');
        if (!btn) return;
        const text = (btn.textContent || btn.value || "").trim().toLowerCase();
        if (/^(submit|submit application|apply|send application|finish|complete)/.test(text)) {
          setTimeout(report, 700);
        }
      },
      true
    );
  }

  /* ================================================================== */
  /*  Visual feedback                                                    */
  /* ================================================================== */

  /**
   * Where a mark shows. A box drawn inside one of ADP's components (`sdf-input`)
   * is out of reach of the page's styles, so the component it sits in carries
   * the mark as well — that component only, never a page-wide element around
   * it. Everywhere else the mark goes on the control alone, as before.
   */
  function markTargets(el) {
    if (!el) return [];
    let host = null;
    try { host = M.onAdp?.() ? M.pageHost?.(el) || null : null; } catch {}
    return host && host !== el && /^SDF-/.test(host.tagName || "") ? [el, host] : [el];
  }
  function flash(el) {
    for (const node of markTargets(el)) {
      node.classList.add("applifill-filled");
      setTimeout(() => node.classList.remove("applifill-filled"), 1200);
    }
  }
  function mark(el) {
    for (const node of markTargets(el)) node.classList.add("applifill-needs-you");
  }
  function unmark(el) {
    for (const node of markTargets(el)) node.classList.remove("applifill-needs-you");
  }
  function markDrafted(el) {
    for (const node of markTargets(el)) node.classList.add("applifill-drafted");
  }

  const overlay = {
    node: null,
    timer: null,
    ensure() {
      if (this.node?.isConnected) return this.node;
      const el = document.createElement("div");
      el.className = "applifill-pill";
      const logoURL = typeof chrome.runtime.getURL === "function" ? chrome.runtime.getURL("icons/icon48.png") : "";
      el.innerHTML = `
        ${logoURL ? `<img class="applifill-pill__logo" src="${logoURL}" alt="Appli-Fill" />` : ""}
        <span class="applifill-pill__dot"></span>
        <span class="applifill-pill__text">
          <span class="applifill-pill__title"></span>
          <span class="applifill-pill__body"></span>
        </span>
        <button class="applifill-pill__stop" type="button">Stop</button>
        <button class="applifill-pill__close" aria-label="Dismiss">&times;</button>`;
      el.querySelector(".applifill-pill__close").addEventListener("click", () => this.hide());
      el.querySelector(".applifill-pill__stop").addEventListener("click", async () => {
        state.stopRequested = true;
        state.manualSessionActive = false;
        await send({ type: "APPLI_FILL_STOP" });
        el.querySelector(".applifill-pill__stop").disabled = true;
        el.querySelector(".applifill-pill__stop").textContent = "Stopping…";
      });
      (document.body || document.documentElement).appendChild(el);
      this.node = el;
      return el;
    },
    show({ tone = "busy", title, body, autoHide = false }) {
      const el = this.ensure();
      el.dataset.tone = tone;
      el.querySelector(".applifill-pill__title").textContent = title;
      el.querySelector(".applifill-pill__body").textContent = body ?? "";
      const stop = el.querySelector(".applifill-pill__stop");
      stop.disabled = !state.filling;
      stop.textContent = "Stop";
      stop.hidden = !state.filling;
      el.classList.add("applifill-pill--visible");
      clearTimeout(this.timer);
      // `autoHide` may be a duration in milliseconds or just `true` for the
      // default. It was previously a flag with one hard-coded delay, so a
      // caller asking for three seconds silently got four and a half.
      const delay = typeof autoHide === "number" ? autoHide : autoHide ? 4500 : 0;
      if (delay > 0) this.timer = setTimeout(() => this.hide(), delay);
    },
    hide() {
      this.node?.classList.remove("applifill-pill--visible");
    },
  };

  /* ================================================================== */
  /*  Boot                                                               */
  /* ================================================================== */

  async function loadSession(force = false) {
    const res = await send({ type: "APPLI_FILL_GET_SESSION", force });
    if (res?.ok) state.session = res.data;
    return state.session;
  }

  /**
   * Re-scan as the page grows.
   *
   * `watchPage()` used to run exactly once, at load. Everything rendered after
   * that — the next step of a Workday application, an "Add another" section, a
   * demographics block that hydrates a second late — was invisible to it, and
   * the only remaining way to attach a watcher was focus, which never fires for
   * a div-based control. So on a multi-step form the applicant answered a whole
   * page of questions and the popup showed nothing to save.
   *
   * Debounced, and only woken by mutations that actually add an element, so a
   * page animating its own DOM does not turn this into a scan loop.
   */
  const RESCAN_DELAY_MS = 500;
  /**
   * A floor on how often the page is actually re-scanned.
   *
   * Debouncing alone is not enough on a portal that mutates continuously —
   * Workday repaints on scroll — because the quiet period never arrives and
   * the scans stack up. `collectFields` walks the whole document, so this has
   * to stay cheap or it is a jank source on every page the extension runs on.
   */
  const RESCAN_MIN_GAP_MS = 1500;
  let rescanTimer = null;
  let rescanObserver = null;
  let lastRescanAt = 0;

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    const since = Date.now() - lastRescanAt;
    const wait = Math.max(RESCAN_DELAY_MS, RESCAN_MIN_GAP_MS - since);
    rescanTimer = setTimeout(rescanForFields, wait);
  }

  function watchForNewFields() {
    if (rescanObserver) return;
    try {
      rescanObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes ?? []) {
            if (node.nodeType !== 1) continue;
            scheduleRescan();
            return;
          }
        }
      });
      rescanObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  function rescanForFields() {
    /**
     * Not while filling.
     *
     * Every dropdown the fill opens adds nodes to the page, which woke this
     * observer, and it re-scanned the whole form every second and a half for
     * the length of the fill — the most expensive thing the content script
     * does, repeated for nothing while the fill itself was waiting on menus.
     * The fill attaches its own watchers when it finishes.
     */
    if (state.filling) { scheduleRescan(); return; }
    lastRescanAt = Date.now();
    /**
     * The application-page test is re-run here, not only at load.
     *
     * It counts the text boxes on the page, and a form that renders from
     * JavaScript has none of them at DOMContentLoaded. The whole content script
     * disengaged on exactly the modern applications it is most needed on, and
     * nothing the applicant typed was ever recorded. Once engaged it stays
     * engaged; this only ever turns capture on.
     */
    if (!state.engaged) {
      if (!isApplicationPage()) return;
      engage();
      return;
    }
    try { watchPage(); } catch {}
  }

  /** Attach every watcher, once, as soon as this looks like an application. */
  function engage() {
    if (state.engaged) return;
    state.engaged = true;
    // First, so a control the applicant works before any fill is known to be
    // theirs from the first keystroke.
    startTouchTracking();
    watchSubmit();
    // Answers typed by hand are recorded from now on, whether or not a fill is
    // ever run on this page.
    watchOnFocus();
    watchClicks();
    watchPage();
    watchValidation();
    startSweep();
  }

  async function boot() {
    state.adapter = ATS.detect();

    const session = await loadSession();
    if (!session?.profile) return;
    if (isExcluded(session.settings)) return;

    // Watch for the form arriving even if it is not here yet.
    watchForNewFields();
    if (isApplicationPage()) engage();
    if (!state.engaged) return;

    const meta = ATS.readJobMeta(state.adapter);
    const dupe = await send({
      type: "APPLI_FILL_CHECK",
      payload: { url: meta.url, jobTitle: meta.jobTitle, company: meta.company },
    });

    if (dupe?.ok && dupe.data?.duplicate) {
      state.duplicate = dupe.data.application;
      const when = new Date(state.duplicate.appliedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      overlay.show({
        tone: "warn",
        title: "You already applied to this",
        body: `Sent ${when} — currently "${state.duplicate.stage}". Click the Appli-Fill icon to fill it anyway.`,
      });
      return; // manual fill still works via the popup
    }

    /**
     * Nothing is filled here. Ever.
     *
     * `boot()` used to honour a "Fill as soon as a form loads" setting with one
     * pass. One pass per load is still one pass per *reload* — and a Workday
     * application reloads itself constantly: a validation error, a step change,
     * a tab switched back to. Every one of those restarted a fill over answers
     * the applicant had already corrected by hand, which is the behaviour
     * reported as "when we refresh the tab it fills the form again".
     *
     * The setting is ignored rather than merely defaulted off, so an account
     * that switched it on in the past does not keep the old behaviour. Filling
     * now has exactly one trigger: the Fill button (or its keyboard shortcut).
     */
    if (state.duplicate) return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Test hook. Only ever attached when a harness sets the flag before the
  // content script loads, so nothing is exposed to real pages.
  if (window.__APPLI_FILL_TEST === true) {
    window.__applifill = { run, collectFields, planField, state, M, RULES };
  }
})();
