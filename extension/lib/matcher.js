/**
 * APPLI_FILL MATCHER
 * --------------
 * Two jobs:
 *   1. Work out what a form field is actually asking (deriveLabel)
 *   2. Put a value into it so the page's own JS believes a human typed it (setValue)
 *
 * (2) is the part that breaks naive autofill tools. React, Vue and Angular
 * track input state internally; assigning `el.value = x` updates the DOM but
 * not the framework's state, so the value vanishes on submit. The fix is to
 * call the *native* value setter from the prototype, then dispatch the events
 * the framework listens for.
 *
 * Custom dropdowns are the other hard part, and the reason older builds
 * flickered. A portalled listbox renders at the end of <body>, nowhere near the
 * control that owns it, so "find the visible options" used to mean "search the
 * whole document". If a previous menu was still on screen, its options were
 * scored against the *next* field — which is how a Year got 2035 and a Country
 * got a neighbouring row's answer. Every menu interaction now goes through the
 * MENU registry below: exactly one menu is open at a time, its option nodes are
 * scoped to that menu, and the next field does not start until the menu has
 * actually closed.
 */

(function (global) {
  /* ------------------------------------------------------------------ */
  /*  Small helpers                                                      */
  /* ------------------------------------------------------------------ */

  const clean = (s) => (s || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").replace(/[*✱]/g, "").trim();
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Text of the element, ignoring nested inputs and hidden helper text. */
  function visibleText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("input,select,textarea,button,svg,script,style").forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  function onScreen(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const w = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom > 0 && r.top < h && r.right > 0 && r.left < w;
  }

  /**
   * Scrolling on every single field is what made the page visibly jump around
   * during a fill. Only move when the control is genuinely out of view, and
   * then by the smallest amount that brings it on screen.
   */
  function ensureVisible(el) {
    try {
      if (!el?.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || document.documentElement.clientHeight;
      if (r.height && r.top >= 8 && r.bottom <= h - 8) return;   // already comfortably visible
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    } catch {}
  }

  /* ------------------------------------------------------------------ */
  /*  Label derivation                                                   */
  /* ------------------------------------------------------------------ */

  const HEADING_SELECTOR =
    'h1, h2, h3, h4, h5, h6, legend, [role="heading"], ' +
    '[class*="sectionTitle"], [class*="section-title"], [class*="sectionHeader"], ' +
    '[class*="SectionTitle"], [class*="groupTitle"], [data-automation-id*="Title"], ' +
    '[data-automation-id*="title"], [data-automation-id="formLabel"]';

  /** Section names that change what a generic label like "Location" means. */
  const SECTION_WORDS =
    /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|experience|education|school|university|college|academic|certifications?|licen[cs]es?|language|reference|skill|address|contact|personal|voluntary|disclosures?|application\s*questions?|questionnaire)\b/i;

  /**
   * Pulls a 1-based row number out of a section heading and returns it 0-based.
   *
   * ATSs number repeated blocks in every style there is:
   *   "Work Experience 2"   "Professional Experience (1)"   "Experience #3"
   *   "Employment 2 of 4"   "Education - 2"
   * The old parser only understood a bare trailing digit, so iCIMS's
   * parenthesised numbering silently produced index null for every row and all
   * of them fell back to the first job in the profile.
   */
  function headingIndex(text) {
    const t = clean(text);
    if (!t) return null;
    const patterns = [
      /(\d+)\s*(?:of|\/)\s*\d+\s*$/i,      // "2 of 4"
      /[(\[]\s*#?\s*(\d+)\s*[)\]]\s*$/,    // "(1)"  "[2]"
      /#\s*(\d+)\s*$/,                     // "#3"
      /[-–—:]\s*(\d+)\s*$/,                // "- 2"
      /(?:^|\s)(\d+)\s*$/,                 // "Work Experience 2"
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 40) return n - 1;
      }
    }
    return null;
  }

  const sectionCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function sectionContext(el) {
    if (!el) return { title: "", index: null };
    const cached = sectionCache?.get(el);
    if (cached) return cached;
    // A box drawn inside one of ADP's components sits in the page where the
    // component does.
    const result = computeSectionContext(adpShadowHost(el) ? pageHost(el) : el);
    sectionCache?.set(el, result);
    return result;
  }

  /**
   * Which entry of a repeated section this control belongs to, if any.
   *
   * "I currently work here" is asked once per job, and the three boxes on a
   * three-row form are three questions with three different answers — not one
   * question with three options. Everything that groups choice controls used to
   * put them together anyway, because they share a `name` or sit inside one
   * `[role="group"]`, and the consequences ran both ways: only the first box
   * was ever collected as a field, so rows two and three were never answered at
   * all; and when the group *was* written to, every box in it was set at once,
   * ticking "I currently work here" against jobs the applicant left years ago.
   *
   * Returns null for a control that is not inside a numbered repeated block, so
   * ordinary radio and checkbox groups are unaffected.
   */
  const ROW_WRAPPER_RE =
    /(work\s*experience|experience|employment|work\s*history|job\s*history|education|school)[^a-z0-9]{0,3}(\d{1,2})\b/i;

  function repeatedRowKey(el) {
    if (!el) return null;
    if (adpShadowHost(el)) el = pageHost(el);
    try {
      let node = el;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        if (node === document.body) break;
        const machine = `${node.getAttribute?.("data-automation-id") || ""} ${node.id || ""}`;
        const hit = machine.match(ROW_WRAPPER_RE);
        if (hit) return `${hit[1].toLowerCase().replace(/\s+/g, "")}#${Number(hit[2])}`;
      }
    } catch {}

    // No row wrapper in the markup — fall back to the numbered heading above it.
    try {
      const section = sectionContext(el);
      if (section && Number.isInteger(section.index)) {
        const stem = String(section.title || "").toLowerCase().replace(/[^a-z]+/g, "");
        if (stem) return `${stem}#${section.index}`;
      }
    } catch {}
    return null;
  }

  /**
   * Is this heading a section header for the form, or just part of the page
   * around it?
   *
   * A job posting usually shows its own details beside the application —
   * "Location", "Department", and, fatally, "Employment Type / Full time". Those
   * headings share an ancestor with the form, sit before it in document order,
   * and match SECTION_WORDS, so they were accepted as the field's section. The
   * derived label for the Name box became "Name | Employment Type | name", the
   * employmentType rule (weight 12) beat fullName (weight 6), and the applicant
   * got "Full-time" written into their name and email.
   *
   * A heading only counts when it labels the fields themselves: either it sits
   * on the field's own ancestor path, or it is a sibling heading immediately
   * above them. A heading buried inside a separate block of content — a details
   * sidebar, a summary card — is page furniture and is ignored.
   */
  function headingOwnsField(heading, el) {
    let branch = heading;
    while (branch.parentElement && !branch.parentElement.contains(el)) branch = branch.parentElement;

    // Another question's own label is that question's, never a section heading.
    if (labelsAnotherControl(heading, branch, el)) return false;

    if (branch === heading) return true;      // a bare heading beside the fields
    if (branch.contains(el)) return true;     // on the field's own path

    // The heading is nested inside a sibling block. That block is a heading
    // wrapper if it carries nothing but the heading, and unrelated content —
    // the posting's details panel — if it carries more.
    const headingText = clean(heading.textContent) || "";
    const branchText = clean(branch.textContent) || "";
    return branchText.length <= headingText.length + 40;
  }

  /**
   * Is this "heading" really the label of some other question?
   *
   * Workday prints each question's label in an element the heading search
   * accepts — a <legend>, or a label carrying data-automation-id="formLabel" —
   * and the question's own block (its label and one dropdown) is short enough
   * to pass for a heading's wrapper. So a label holding a section word became
   * the "section" of every question after it: on SEI's questionnaire
   * "Employment Type Desired" headed Shift Preference, Available Start Date,
   * the other-opportunities question and the salary question, and the
   * employment rules took all four — the job's start date went into Available
   * Start Date ("Invalid Date: 01//2022") and the rest were left outlined.
   */
  const QUESTION_CONTROL_SELECTOR =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], ' +
    '[role="spinbutton"], [role="listbox"], [contenteditable="true"], button[aria-haspopup], button[aria-expanded], ' +
    // ADP's SDF components draw their boxes inside themselves.
    'sdf-input, sdf-textarea, sdf-select-simple, sdf-radio-group, sdf-checkbox, sdf-date-picker, sdf-phone-number-input';

  function labelsAnotherControl(heading, branch, el) {
    try {
      const forId = heading.getAttribute?.("for");
      if (forId) {
        const target = document.getElementById(forId);
        if (target && target !== el && !target.contains(el) && !el.contains?.(target)) return true;
      }
      const tag = heading.tagName;
      const labelish = tag === "LABEL" || tag === "LEGEND" ||
        /^formlabel$/i.test(heading.getAttribute?.("data-automation-id") || "");
      if (!labelish) return false;
      // The block this label heads: a legend's fieldset, or the label's own
      // wrapper. A block around this field is its section; one holding some
      // other control is that control's question.
      const block = tag === "LEGEND" ? (heading.parentElement || branch) : branch;
      if (!block || block.contains(el)) return false;
      if (block.querySelector?.(QUESTION_CONTROL_SELECTOR)) return true;
      // A label sitting loose beside its control: the control comes right after.
      if (block === heading) {
        let sib = heading.nextElementSibling;
        for (let i = 0; sib && i < 3; i++, sib = sib.nextElementSibling) {
          if (sib === el || sib.contains(el)) return false;
          if (sib.matches?.(QUESTION_CONTROL_SELECTOR) || sib.querySelector?.(QUESTION_CONTROL_SELECTOR)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  function computeSectionContext(el) {
    let node = el.parentElement;

    const candidateText = (value) => {
      const text = clean(value);
      if (!text || text.length > 120) return null;
      if (!SECTION_WORDS.test(text)) return null;
      return text;
    };

    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;

      let headings;
      try {
        if (node.childElementCount > 0 && node.getElementsByTagName("*").length > 5000) break;
        headings = node.querySelectorAll(HEADING_SELECTOR);
      } catch { headings = []; }

      let nearest = null;
      for (const heading of headings) {
        const raw = heading.textContent;
        if (!raw || raw.length > 400) continue;
        if (heading.contains(el)) continue;
        const pos = heading.compareDocumentPosition(el);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const text = candidateText(raw);
        if (!text) continue;
        if (!headingOwnsField(heading, el)) continue;
        nearest = text;
      }
      if (nearest) return { title: nearest, index: headingIndex(nearest) };

      // Fallback for Workday/custom ATS labels that are plain div/span text.
      try {
        const local = node.querySelectorAll(
          '[data-automation-id*="section"], [data-automation-id*="Section"], ' +
          '[class*="section"], [class*="Section"], [class*="group"], [class*="Group"], ' +
          'label, legend, h1, h2, h3, h4, h5, h6, p, span, div'
        );
        for (const item of local) {
          // Cheap tests first. This walks every div and span in the ancestor,
          // and reading and cleaning the text of a large container for each of
          // them is what made label derivation slow on a long Workday form.
          const raw = item.textContent;
          if (!raw || raw.length > 200) continue;
          if (item.contains(el)) continue;
          const pos = item.compareDocumentPosition(el);
          if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const text = candidateText(raw);
          if (!text) continue;
          if (!headingOwnsField(item, el)) continue;
          // Section labels are short. Reject paragraphs that merely mention the
          // words, but accept every numbering style the ATSs actually use.
          if (/^(?:work\s+experience|experience|employment|work\s+history|job\s+history|professional\s+experience|education|school|university|college)\s*(?:[-–—:#(\[]?\s*\d+\s*[)\]]?|\d+\s*(?:of|\/)\s*\d+)?$/i.test(text)) {
            nearest = text;
          }
        }
      } catch {}

      if (nearest) return { title: nearest, index: headingIndex(nearest) };
    }

    return { title: "", index: null };
  }

  /**
   * Which repeated block a field sits in, when the page gives no numbered
   * heading at all (Greenhouse and Oracle both do this).
   *
   * `anchors` are the elements that occur once per row — usually the Company or
   * School field. A row is the largest ancestor of an anchor that still holds
   * only that one anchor, which is exactly the repeated container the ATS
   * clones per entry.
   */
  function rowsFromAnchors(anchorEls) {
    const anchors = anchorEls.filter(Boolean);
    if (anchors.length < 2) return [];
    return anchors.map((anchor) => {
      let node = anchor;
      let best = anchor;
      for (let d = 0; node?.parentElement && d < 14; d++) {
        node = node.parentElement;
        if (node === document.body || node === document.documentElement) break;
        let inside = 0;
        for (const other of anchors) if (node.contains(other)) inside++;
        if (inside > 1) break;
        best = node;
      }
      return best;
    });
  }

  const CONTROL_SELECTOR =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], ' +
    '[role="checkbox"], [contenteditable="true"], button[aria-haspopup], ' +
    // ADP's SDF components: each is one question, its box inside it.
    'sdf-input, sdf-textarea, sdf-select-simple, sdf-radio-group, sdf-checkbox, sdf-date-picker, sdf-phone-number-input';

  /**
   * Is `node` a container for this field alone?
   *
   * A radio or checkbox group counts as one field, since its options share a
   * name and a single question. Anything else with two or more controls is a
   * section, and its labels belong to whichever field they sit next to — not
   * necessarily this one.
   */
  function ownsOnlyThisField(node, el, ignore = null) {
    let controls;
    try { controls = node.querySelectorAll(CONTROL_SELECTOR); } catch { return false; }
    if (ignore) controls = Array.from(controls).filter((c) => c === el || !ignore(c));
    // An SDF component and the box it draws in its own light DOM are one
    // control, not two.
    if (controls.length > 1 && Array.from(controls).some((c) => /^SDF-/.test(c.tagName))) {
      const all = Array.from(controls);
      controls = all.filter((c) => !(/^SDF-/.test(c.tagName) && c !== el &&
        (c.contains(el) || all.some((other) => other !== c && c.contains(other)))));
    }
    if (controls.length <= 1) return true;

    const names = new Set();
    for (const control of controls) {
      const type = (control.type || "").toLowerCase();
      const role = control.getAttribute("role");
      const isChoice = type === "radio" || type === "checkbox" || role === "radio" || role === "checkbox";
      if (!isChoice) return false;
      names.add(control.getAttribute("name") || "");
    }
    return names.size <= 1;
  }

  /**
   * The "Country code" picker of a phone row.
   *
   * Oracle Recruiting draws Phone Number as one row: a "Country code" list box
   * (+1) and, beside it under the same label, the box for the number. Because
   * the row held two controls, the number box was not allowed the row's label,
   * and it could end up described as "Country code" — or as nothing at all.
   */
  const PHONE_CODE_NAME_RE = /countrycodes?dropdown|(?:phone|mobile|telephone)countrycode|country(?:phone|mobile|calling)code|dialcode|callingcode|isdcode/i;
  const PHONE_CODE_TEXT_RE = /^\s*(?:phone\s*)?(?:country\s*(?:phone|calling|dial(?:l?ing)?)?|international\s*(?:calling|dial(?:l?ing)?)?|dial(?:l?ing)?|calling|isd)\s*code\s*\*?\s*$/i;
  function isPhoneCodeControl(node) {
    if (!node || node.nodeType !== 1) return false;
    // A national-number box can share the country picker's outer wrapper.
    // Its own telephone semantics outrank a floating label in that wrapper.
    if (/^(?:tel-national|tel-local|tel)$/i.test(node.getAttribute?.("autocomplete") || "") ||
        (/^(?:tel|numeric)$/i.test(node.getAttribute?.("inputmode") || "") && node.getAttribute?.("role") !== "combobox")) return false;
    // ADP: the country list of an `sdf-phone-number-input`, and Workforce
    // Now's `select[name=phoneCountry]` beside its number box.
    if (node.tagName === "SDF-SELECT-SIMPLE" && /phone/i.test(node.getAttribute("embedded-context") || "")) return true;
    if (node.tagName === "SELECT" && onAdp() && /^phone_?country$/i.test(node.getAttribute("name") || "")) return true;
    const machine = `${node.getAttribute?.("name") || ""} ${node.id || ""} ${node.getAttribute?.("data-automation-id") || ""}`;
    if (PHONE_CODE_NAME_RE.test(machine.replace(/[\s_-]+/g, ""))) return true;
    if (PHONE_CODE_TEXT_RE.test(node.getAttribute?.("aria-label") || "") || PHONE_CODE_TEXT_RE.test(node.getAttribute?.("placeholder") || "")) return true;
    try {
      if (node.labels && Array.from(node.labels).some((label) => PHONE_CODE_TEXT_RE.test(visibleText(label)))) return true;
      for (const id of String(node.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
        if (PHONE_CODE_TEXT_RE.test(document.getElementById(id)?.textContent || "")) return true;
      }
      // The picker's name drawn as a floating label inside its own box.
      const box = node.closest?.(".cx-select-container, [class*='select-container' i]");
      const floating = box?.querySelector?.(".input-field__label, [class*='field__label' i]");
      const peers = Array.from(box?.querySelectorAll("input:not([type=hidden]), select") || []).filter((peer) => peer !== node);
      if (floating && !peers.length && PHONE_CODE_TEXT_RE.test(floating.textContent || "")) return true;
    } catch {}
    return false;
  }

  /** A label that names a phone row's country-code picker rather than the row. */
  function namesPhoneCodePicker(node) {
    try {
      if (PHONE_CODE_TEXT_RE.test(node.textContent || "")) return true;
      const target = node.getAttribute?.("for") ? document.getElementById(node.getAttribute("for")) : null;
      if (target && isPhoneCodeControl(target)) return true;
      const box = node.closest?.(".cx-select-container, [class*='select-container' i]");
      return Boolean(box && Array.from(box.querySelectorAll("input, [role='combobox']")).some(isPhoneCodeControl));
    } catch { return false; }
  }

  /** A control that belongs to a phone row's country-code picker (its box, or its buttons). */
  function partOfPhoneCodePicker(control) {
    if (isPhoneCodeControl(control)) return true;
    if (control?.tagName !== "BUTTON") return false;
    try {
      const box = control.closest?.(".cx-select-container, [class*='select-container' i]");
      return Boolean(box && Array.from(box.querySelectorAll("input, [role='combobox']")).some(isPhoneCodeControl));
    } catch { return false; }
  }

  /** Oracle Recruiting's Candidate Experience (…/hcmUI/CandidateExperience/…)? */
  function onOracleCandidateExperience() {
    try {
      return /\/hcmUI\/|CandidateExperience/i.test(location.pathname) || /\.oraclecloud\.com$/i.test(location.hostname);
    } catch { return false; }
  }

  /**
   * The question an Oracle Recruiting control answers: the label of the
   * `.input-row` it sits in.
   *
   * Oracle prints a Yes / No question, a list of check boxes ("Select the
   * races you identify with.") and a date's Day / Month / Year boxes under one
   * `label.input-row__label` that names no control, with each choice's own
   * `<label for>` ("Yes", "Asian", "Day") beside its input. The choice's label
   * was read first and the question last — or not at all when the question
   * ran past 300 characters — so "Are you a former employee…?" read as "Yes",
   * and nothing answered it. A row with no label of its own (a date's Day box)
   * takes the label of the row around it.
   */
  function oracleRowLabel(el) {
    if (!onOracleCandidateExperience()) return "";
    try {
      let row = el.closest?.(".input-row");
      for (let i = 0; row && i < 3; i++, row = row.parentElement?.closest?.(".input-row")) {
        const label = Array.from(row.querySelectorAll(".input-row__label")).find((l) => {
          if (l.closest(".input-row") !== row || l.contains(el)) return false;
          const forId = l.getAttribute("for");
          if (forId && forId !== el.id) {
            const target = document.getElementById(forId);
            if (target && target !== el && !target.contains(el)) return false;
          }
          return true;
        });
        const text = label ? visibleText(label) : "";
        if (text) return text.length > 300 ? `${text.slice(0, 300)}…` : text;
      }
    } catch {}
    return "";
  }

  /**
   * Collects every plausible description of a field, best source first.
   * Returned as a single string so one regex test covers all of them.
   */
  function icimsQuestionLabel(el) {
    if (!global.APPLI_FILL_FIELD_MAP?.helpers?.onIcimsPage?.() && !/(^|\.)icims\.com$/i.test(location.hostname)) return "";
    let label = Array.from(el.labels || []).map(visibleText).join(" ").trim();
    if (!label) {
      const cell = el.closest("td, th");
      if (cell && cell.querySelectorAll("input:not([type=hidden]), select, textarea").length === 1) {
        const text = visibleText(cell);
        if (text && text.length < 180) label = text;
        if (!label) {
          const previous = cell.previousElementSibling;
          if (previous && !previous.querySelector("input, select, textarea")) label = visibleText(previous);
        }
        if (!label) {
          const row = cell.parentElement?.previousElementSibling;
          const above = row?.cells?.[cell.cellIndex];
          if (above && !above.querySelector("input, select, textarea")) label = visibleText(above);
        }
      }
    }
    label = String(label || "").replace(/^[!\s]+|[:*\s]+$/g, "");
    if (label.length > 180) return "";
    if (/^login$/i.test(label) && el.tagName === "INPUT") return "Email address";
    if (/^(?:type|number)$/i.test(label)) {
      for (let parent = el.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
        const text = visibleText(parent).slice(0, 180);
        if (/^phones?\s*\(?\d*\)?/i.test(text)) return /^number$/i.test(label) ? "Phone number" : "Phone type";
        if (/^(?:current\s+)?address(?:es|\s+information)?\b/i.test(text)) return "Address type";
      }
    }
    if (/\bdesired\s+pay\b/i.test(label) && el.tagName === "SELECT" &&
        Array.from(el.options || []).some((o) => /\b(?:USD|INR|EUR|GBP|CAD|AUD)\b/.test(o.textContent))) return "Salary currency";
    return label;
  }

  function deriveLabel(el) {
    const parts = [];
    const push = (v) => {
      const c = clean(v);
      if (c && !parts.includes(c)) parts.push(c);
    };
    push(icimsQuestionLabel(el));
    if (onOracleCandidateExperience() && !isPhoneCodeControl(el)) {
      const question = oracleRowLabel(el);
      if (/\b(?:phone|mobile|telephone)\s*(?:number)?\b/i.test(question) && el.tagName === "INPUT" && !isOracleSelect(el)) push(question);
    }

    // One answer in a row of choice buttons: the question is asked around the
    // whole row, never by the button ("Yes") that happens to be first.
    let row = null;
    try { row = choiceButtonGroup(el); } catch {}
    if (row) return choiceGroupLabel(el, row);

    if (el.type === "radio" || el.type === "checkbox") {
      const fs = el.closest("fieldset");
      const legend = fs?.querySelector("legend");
      if (legend && !legend.contains(el)) push(visibleText(legend));
    }

    // 0. Oracle Recruiting: the question of the row a choice sits in comes
    //    before the choice's own label ("Yes"). See `oracleRowLabel`.
    const oracleQuestion = oracleRowLabel(el);
    const oracleChoice = el.type === "radio" || el.type === "checkbox";
    if (oracleQuestion && oracleChoice) push(oracleQuestion);

    // 0b. ADP: the question an SDF component — or the box drawn inside one —
    //     answers. See `adpQuestion`.
    push(adpQuestion(el));
    // 0c. ADP: what a list says before anything is picked ("Select currency
    //     type"), which is often all that tells it from the amount beside it.
    push(sdfPlaceholder(el));
    if (isPhoneCodeControl(el)) push("Phone country code");

    // Labels are looked up in the tree the control lives in: a box inside one
    // of ADP's components is named by the component's shadow root, never by a
    // `<label for="input">` somewhere else on the page.
    const ownRoot = adpShadowHost(el) ? el.getRootNode() : document;
    const byId = (id) => {
      try { return ownRoot.getElementById ? ownRoot.getElementById(id) : document.getElementById(id); } catch { return null; }
    };

    // 1. <label for="id">
    if (el.id) {
      const escaped = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
      try { ownRoot.querySelectorAll(`label[for="${escaped}"]`).forEach((l) => push(visibleText(l))); } catch {}
    }

    // 2. aria-labelledby -> the referenced nodes
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const node = byId(id);
        if (node) push(visibleText(node));
      });
    }

    // 3. Direct attributes
    push(el.getAttribute("aria-label"));
    push(el.getAttribute("placeholder"));
    push(el.getAttribute("title"));
    push(el.getAttribute("data-label"));
    push(el.getAttribute("data-automation-id"));   // Workday / Oracle / SAP
    push(el.getAttribute("data-qa"));              // Lever / Ashby
    push(el.getAttribute("data-testid"));          // React / MUI / custom ATS
    push(el.getAttribute("data-test-id"));
    push(el.getAttribute("data-field"));
    push(el.getAttribute("autocomplete"));

    // An Oracle box with no label of its own (a date's Day / Month / Year)
    // takes the question of its row.
    if (oracleQuestion && !oracleChoice) push(oracleQuestion);

    // 3b. aria-describedby -> referenced description/hint nodes.
    //
    // SAP SuccessFactors, Oracle HCM, and several Workday widgets put the
    // question text in a description node linked via `aria-describedby`
    // rather than `aria-label` or `aria-labelledby`. Without reading it, the
    // derived label is empty or generic, no rule matches, and the field is
    // left unmatched. The first referenced id is usually the question text;
    // later ones are often error/help text and are still useful signal.
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      describedBy.split(/\s+/).forEach((id) => {
        if (!id) return;
        const node = byId(id);
        if (node) push(visibleText(node));
      });
    }

    // 4. Wrapping <label>
    const wrapping = el.closest("label");
    if (wrapping) push(visibleText(wrapping));

    // 5. Nearest labelled container.
    //
    // Only ever a container that holds this one field. Walking up blindly and
    // taking the first label in the subtree is how a question inherited the
    // *previous* question's label on Greenhouse and Lever, which put "Immediately"
    // into a "full legal name" box and a date into "Years of relevant experience".
    // The moment an ancestor contains a second field, its labels stop being ours.
    /**
     * A choice group's question sits further out than a text box's.
     *
     * Lever draws a Yes / No question as radio → its own label → <li> → <ul>
     * → the field wrapper → the question block, and the question's text is on
     * that outermost block. The walk stopped one level short, and the option
     * labels it passed on the way ("Yes") are answers, not the question, so
     * the rule table never saw "Are you legally authorized to work…" and the
     * question was left unanswered. A choice control walks two levels further
     * and skips the labels of its own options.
     */
    const isChoice = el.type === "radio" || el.type === "checkbox" ||
      el.getAttribute?.("role") === "radio" || el.getAttribute?.("role") === "checkbox";
    let members = [el];
    if (isChoice) { try { members = choiceGroup(el); } catch {} }
    const isOptionLabel = (node) => members.some((m) =>
      node.contains(m) || (m.id && node.getAttribute?.("for") === m.id));

    // The number box of a phone row shares its row with the country-code
    // picker, and the row's label is its own (see `isPhoneCodeControl`).
    const besidePhoneCode = isPhoneCodeControl(el) ? null : partOfPhoneCodePicker;
    let node = el.parentElement;
    for (let depth = 0; node && depth < (isChoice ? 6 : 4); depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (!ownsOnlyThisField(node, el, besidePhoneCode)) break;

      const HEADING_CANDIDATES =
        'label, legend, .label, [class*="label"], [class*="question"], [class*="Label"], h3, h4, p';
      let heading = null;
      if (isChoice) {
        try {
          heading = Array.from(node.querySelectorAll(HEADING_CANDIDATES))
            .find((c) => !c.contains(el) && !isOptionLabel(c) && !c.querySelector?.("input, select, textarea")) || null;
        } catch {}
      } else if (besidePhoneCode) {
        // Not the picker's own "Country code": that names the picker.
        try {
          heading = Array.from(node.querySelectorAll(HEADING_CANDIDATES)).find((c) => !c.contains(el) && !namesPhoneCodePicker(c)) || null;
        } catch {}
      } else {
        heading = node.querySelector(HEADING_CANDIDATES);
      }
      if (heading && !heading.contains(el)) {
        const t = visibleText(heading);
        if (t && t.length < 300) { push(t); break; }
      }
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector("legend");
        if (legend) { push(visibleText(legend)); break; }
      }
    }

    // 6. Group label — the "Start Date (Month / Day / Year)" wrapper around a
    //    bare Month/Day/Year control. Without it a lone "Year" select has no
    //    idea which date it belongs to.
    const group = groupLabel(el);
    if (group) push(group);

    // 7. Section context — which part of the form this field belongs to.
    const section = sectionContext(el);
    if (section.title) push(section.title);

    // 8. Machine names, split into words so /first name/ matches "firstName"
    push(humanize(el.getAttribute("name")));
    push(humanize(el.id));

    return parts.join(" | ").slice(0, 400);
  }

  /**
   * The question a row of choice buttons answers.
   *
   * Oracle's pills name their question on the row (`aria-labelledby` on the
   * listbox) or in a label beside it; the buttons themselves only say "Yes"
   * and "No". The walk outwards stops at the first container that also holds
   * some other question's controls, so a neighbour's label is never taken.
   */
  const CHOICE_HEADINGS =
    'label, legend, .label, [class*="label"], [class*="question"], [class*="Label"], [class*="title" i], h2, h3, h4, h5, p';

  function choiceGroupLabel(el, members) {
    const parts = [];
    const push = (v) => {
      const c = clean(v);
      if (c && !parts.includes(c)) parts.push(c);
    };
    const container = choiceGroupContainer(members) || el.parentElement;
    const answers = new Set(members.map((m) => norm(visibleText(m) || m.getAttribute("aria-label") || "")));
    const isAnswer = (text) => answers.has(norm(text));
    const touchesRow = (node) => node === container || container.contains(node) || node.contains(container) ||
      members.some((m) => m.contains(node));

    // 1. The row names its question.
    for (let node = container, d = 0; node && d < 3 && node !== document.body; d++, node = node.parentElement) {
      const byRef = labelledByText(node);
      if (byRef && !isAnswer(byRef)) push(byRef);
      const own = node.getAttribute?.("aria-label");
      if (own && !isAnswer(own)) push(own);
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector(":scope > legend");
        if (legend) push(visibleText(legend));
      }
      if (parts.length) break;
      // Only while the wrapper holds this row alone.
      if (node.parentElement && otherControlsIn(node.parentElement, members)) break;
    }

    // 2. The nearest heading beside the row that is not one of its answers.
    if (!parts.length) {
      let node = container.parentElement;
      for (let d = 0; node && d < 5; d++, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (otherControlsIn(node, members)) break;
        let heading = null;
        try {
          heading = Array.from(node.querySelectorAll(CHOICE_HEADINGS)).find((c) => {
            if (touchesRow(c)) return false;
            const t = visibleText(c);
            // A question may carry a link to a policy; any other control
            // inside makes it something else.
            const controls = interactiveIn(c).filter((x) => !(x.tagName === "A" && !x.getAttribute?.("role")));
            return t && t.length < 300 && !isAnswer(t) && !controls.length;
          }) || null;
        } catch {}
        if (heading) { push(visibleText(heading)); break; }
      }
    }

    const section = sectionContext(el);
    if (section.title) push(section.title);
    push(humanize(container.getAttribute?.("name") || container.getAttribute?.("data-name") || ""));
    push(humanize(container.id));
    return parts.join(" | ").slice(0, 400);
  }

  /**
   * Does `node` hold a control that is not one of these choice buttons? A
   * link in the question's help text is not another question.
   */
  function otherControlsIn(node, members) {
    let controls = [];
    // Ashby's mirror checkbox sits in the same wrapper as the question and its
    // buttons; it is part of the row, not another question.
    try { controls = usableControlsIn(node); } catch { return true; }
    return controls.some((c) => !members.includes(c) && !members.some((m) => m.contains(c) || c.contains(m)) &&
      !(c.tagName === "A" && !c.getAttribute?.("role")));
  }

  /**
   * The label of the *group* a sub-control belongs to.
   *
   * iCIMS and Oracle render a date as three controls labelled only "Month",
   * "Day" and "Year" under one heading that says "Start Date (Month / Day /
   * Year)". That heading is the only thing distinguishing a start year from an
   * end year, so it has to make it into the derived label.
   */
  /** A lone segment's own name, which says nothing about which date it is. */
  const SEGMENT_NAME_RE = /^(mm|dd|yy|yyyy|month|day|year)\s*\*?$/i;

  function labelledByText(node) {
    const ids = String(node?.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return clean(ids.map((id) => document.getElementById(id)?.textContent || "").join(" "));
  }

  function groupLabel(el) {
    let node = el.parentElement;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      // Only a container that wraps this field alone, or the two or three
      // controls of one date. Any wider and its headings belong to other
      // questions: a Greenhouse block holding "What is your earliest available
      // start date?" next to five unrelated boxes handed that question's text
      // to every one of them.
      const dateGroup = isDateGroup(node);
      if (!ownsOnlyThisField(node, el) && !dateGroup) break;

      const own = clean(node.getAttribute?.("aria-label") || "");
      if (own && /\b(start|end|from|to|graduat|acquired|awarded|conferred|earned)\b/i.test(own) && own.length < 120) return own;

      /**
       * A date widget named by reference, or simply called "Date".
       *
       * Workday's CC-305 signature date is a MM / DD / YYYY widget whose only
       * label is "Date", attached with `aria-labelledby`. Each segment is
       * labelled just "Month", "Day" or "Year", so without the group's name the
       * segments matched nothing at all and today's date was never written.
       * Inside a date group the word "date" on its own is the group's name.
       */
      if (dateGroup) {
        const named = labelledByText(node) || own;
        if (named && named.length < 120 && !SEGMENT_NAME_RE.test(named) &&
            /\b(date|start|end|from|to|graduat|acquired|awarded|conferred|earned)\b/i.test(named)) return named;
      }
      for (const cand of node.querySelectorAll(":scope > label, :scope > legend, :scope > span, :scope > div, :scope > p, :scope > h3, :scope > h4, :scope > h5")) {
        if (cand.contains(el)) continue;
        const t = clean(cand.textContent);
        if (!t || t.length > 120) continue;
        if (/\b(start|end|from|to|thru|through|graduat|completion|expected)\b/i.test(t) && /\b(date|month|year|day)\b/i.test(t)) return t;
        if (dateGroup && /\bdate\b/i.test(t) && !SEGMENT_NAME_RE.test(t)) return t;
      }
    }
    return "";
  }

  /**
   * A container whose every control is one piece of a single date — the
   * Month / Day / Year trio that iCIMS and Oracle render under one heading.
   */
  function isDateGroup(node) {
    let controls;
    try { controls = Array.from(node.querySelectorAll(CONTROL_SELECTOR)); } catch { return false; }
    // The calendar button beside the boxes opens a picker; it is not a
    // fourth part of the date and must not stop the boxes counting as one.
    controls = controls.filter((c) => !(c.tagName === "BUTTON" &&
      /calendar|date\s*picker|datepicker|dateicon/i.test(
        `${c.getAttribute("aria-label") || ""} ${c.getAttribute("data-automation-id") || ""} ${c.getAttribute("title") || ""} ${c.className || ""}`)));
    if (onOracleCandidateExperience()) controls = controls.filter((control) => {
      if (control.tagName !== "BUTTON") return true;
      return !control.closest(".cx-select-container")?.querySelector(ORACLE_SELECT_INPUT);
    });
    if (!controls.length || controls.length > 4) return false;
    return controls.every((control) => {
      const text = [
        control.getAttribute("aria-label"), control.getAttribute("name"), control.id,
        control.getAttribute("placeholder"), accessibleName(control),
        control.closest?.(".cx-select-container")?.querySelector(".input-field__label, [class*='field__label' i]")?.textContent,
      ].filter(Boolean).join(" ").replace(/[_\-.]+/g, " ");
      return /\b(mm|dd|yy|yyyy|month|day|year)\b/i.test(text);
    });
  }

  function oracleDateControls(el) {
    if (!onOracleCandidateExperience()) return [];
    for (let node = el?.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      if (node === document.body || node === document.documentElement) break;
      const controls = Array.from(node.querySelectorAll("input:not([type=hidden]), select"));
      if (controls.length >= 2 && controls.length <= 3 && isDateGroup(node)) return controls;
      if (controls.length > 3) break;
    }
    return [];
  }

  /** firstName / first_name / first-name -> "first name" */
  function humanize(s) {
    if (!s) return "";
    return s
      .replace(/[_\-.]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/\d{4,}/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /* ------------------------------------------------------------------ */
  /*  Rule matching                                                      */
  /* ------------------------------------------------------------------ */

  /** The normalized "kind" of a control, used to filter which rules may apply. */
  function fieldKind(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && onOracleCandidateExperience() && /^(?:tel|tel-national|tel-local)$/i.test(el.getAttribute("autocomplete") || "")) return "tel";
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    // ADP's SDF components, answered as a whole.
    if (tag === "sdf-select-simple") return "select";
    if (tag === "sdf-radio-group") return "radio";
    if (tag === "sdf-checkbox") return "checkbox";
    if (el.getAttribute("role") === "checkbox") return "checkbox";
    if (el.getAttribute("role") === "radio") return "radio";
    if (choiceButtonGroup(el)) return "radio";
    if (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-haspopup") === "true" ||
      (el.tagName === "BUTTON" && /dropdown|select|prompt/i.test(el.getAttribute("data-automation-id") || ""))
    ) {
      return "select";
    }
    if (el.getAttribute("role") === "textbox" || el.isContentEditable) return "text";
    const type = (el.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "date", "month", "number", "email", "tel", "url"].includes(type)) return type;
    return "text";
  }

  /**
   * Is this control part of a voluntary self-identification (CC-305) form?
   *
   * The self-identification rules only apply inside that form — "Name" and
   * "Date" are the signature there and something else anywhere else — and the
   * form used to be recognised through the section heading alone. Workday's
   * Self Identify step has no heading that names it: the step is titled "Self
   * Identify", and "Voluntary Self-Identification of Disability · Form CC-305
   * · OMB Control Number 1250-0005" is a paragraph of rich text above the
   * fields. So the Name, Date and disability boxes on that step matched
   * nothing and were left for the applicant. The form's own printed markers,
   * above the control inside the same form, now count as well.
   */
  const SELF_ID_MARKER_RE =
    /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|\bcc-?305\b|omb\s*control\s*number\s*1250)/i;
  let selfIdMarkerCache = { at: 0, nodes: [] };

  function selfIdMarkers() {
    const now = Date.now();
    if (now - selfIdMarkerCache.at < 1000) return selfIdMarkerCache.nodes;
    const nodes = [];
    try {
      const body = document.body;
      if (body && SELF_ID_MARKER_RE.test(body.textContent || "")) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n && nodes.length < 12; n = walker.nextNode()) {
          const text = n.nodeValue;
          if (!text || text.length > 4000 || !SELF_ID_MARKER_RE.test(text)) continue;
          const host = n.parentElement;
          if (host && !host.closest("script, style, noscript, template")) nodes.push(host);
        }
      }
    } catch {}
    selfIdMarkerCache = { at: now, nodes };
    return nodes;
  }

  function inSelfIdBlock(el) {
    if (!el?.compareDocumentPosition) return false;
    // A box inside one of ADP's components is placed in the page by the component.
    if (adpShadowHost(el)) el = pageHost(el);
    for (const marker of selfIdMarkers()) {
      try {
        if (!(marker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        // The same form, not merely the same page.
        let common = marker.parentElement;
        while (common && !common.contains(el)) common = common.parentElement;
        if (common && common !== document.body && common !== document.documentElement) return true;
      } catch {}
    }
    return false;
  }

  function matchRule(el, label, rules) {
    const kind = fieldKind(el);
    // deriveLabel joins several descriptions with " | ". Testing only the joined
    // string made every anchored pattern in the table unreachable: a box
    // labelled exactly "Name" derives "Name | f name", so /^name$/ never fired
    // and the applicant's name was left blank on any form that labels it that
    // way. Each description is now tested in its own right.
    //
    // The joined string is still tested too, because some rules deliberately
    // span two of them — "Work Experience 2" from the section heading plus
    // "Location" from the field's own label. Denials keep working against the
    // whole label, so a disqualifying word anywhere still disqualifies.
    /**
     * The section heading is context, never the field's own description.
     *
     * `deriveLabel` appends the heading of the section a control sits in, and
     * it was tested as a description in its own right — so every box under an
     * "Address" heading matched `^address$`, and a free-text application
     * question placed below one was answered with the applicant's street. The
     * heading still counts inside the joined label, where rules that genuinely
     * need it ("Work Experience 2" + "Location") look for it.
     */
    let sectionTitle = "";
    try { sectionTitle = clean(sectionContext(el)?.title || ""); } catch {}
    const parts = String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    const haystacks = [
      label,
      ...parts.filter((part, i) => !(i > 0 && sectionTitle && part === sectionTitle)),
    ];
    let best = null;
    let bestScore = -1;

    for (const rule of rules) {
      // Authorization and sponsorship often share one wrapper on Greenhouse.
      // Their neighbouring labels must neither deny the right rule nor select
      // a different declaration. Use the field's own descriptive label.
      const legalRule = ["authorizedToWork", "requireSponsorship", "visaStatus"].includes(rule.key);
      const own = parts[0] || "";
      const scopedLegal = legalRule && own.length > 6 &&
        !/^(?:dropdown|text field|select(?: an? option)?|choose(?: an? option)?)$/i.test(own);
      const ruleLabel = scopedLegal ? own : label;
      const ruleHaystacks = scopedLegal ? [own, own] : haystacks;
      const types = rule.type ?? ["text"];
      const typeOk =
        types.includes(kind) ||
        (kind === "email" && types.includes("text")) ||
        (kind === "tel" && types.includes("text")) ||
        (kind === "url" && types.includes("text")) ||
        (kind === "number" && types.includes("text")) ||
        (kind === "radio" && types.includes("select")) ||
        (kind === "date" && types.includes("text")) ||
        (kind === "month" && types.includes("text")) ||
        // A list box the rule says it answers too (Oracle's Address Line 1).
        (kind === "select" && typeof rule.listBox === "function" && Boolean(rule.listBox(el)));
      if (!typeOk) continue;

      // A denial may be a pattern or a predicate. The predicate form exists
      // because some disqualifying words are only disqualifying in context:
      // "Hispanic or Latino" next to a race dropdown is the category list, but
      // on its own it is a separate yes/no question. See the `race` rule.
      if (rule.deny?.some((d) => (typeof d === "function" ? d(ruleLabel) : d.test(ruleLabel)))) continue;

      // `require` is the positive counterpart to `deny`: tested against the
      // whole label, including the section heading. It is what lets a rule say
      // "a bare Date, but only inside a Voluntary Self-Identification block" —
      // a condition no single pattern in `match` can express, because those are
      // OR'd against each description separately.
      if (rule.require && !rule.require.test(label) &&
          !(rule.context === "selfId" && inSelfIdBlock(el))) continue;

      /**
       * Where the match landed decides how much it counts.
       *
       * `haystacks[0]` is the joined label — the field's own text *plus* the
       * section heading and whatever the portal renders nearby. The rest are
       * the individual descriptions, and `haystacks[1]` is the field's own.
       *
       * Matching only the joined string used to count exactly as much as
       * matching the field's own label, and that is how Workday's phone block
       * broke: it renders "Country Phone Code" directly above "Phone Number",
       * that text lands in the joined label, and `phoneCountryCode` — two
       * weights above `phone` — claimed the Phone Number box on the strength of
       * its neighbour's name. The number then went into the country-code box and
       * the phone box fell through to whatever the saved answers offered.
       *
       * A rule that matches the field's own description now outranks one that
       * only matched the surroundings. Rules that deliberately span two
       * descriptions still work — "Work Experience 2" plus "Location" — because
       * a joined-only match still counts, just for less.
       */
      let hitIndex = -1;
      let placeBonus = 0;
      ruleHaystacks.forEach((hay, position) => {
        const i = rule.match.findIndex((re) => re.test(hay));
        if (i === -1) return;
        // haystacks[0] is the joined text, [1] is the field's own primary
        // description, and the rest are the surroundings — the section heading
        // and the labels of neighbouring fields.
        const bonus = position === 1 ? 40 : position > 1 ? 12 : 0;
        if (bonus > placeBonus) placeBonus = bonus;
        if (hitIndex === -1 || i < hitIndex) hitIndex = i;
      });
      if (hitIndex === -1) continue;

      const score = (rule.weight ?? 5) * 10 - hitIndex + placeBonus;
      if (score > bestScore) {
        bestScore = score;
        best = rule;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /*  Choice normalisation                                               */
  /* ------------------------------------------------------------------ */

  function normalizeChoiceText(s) {
    return norm(s)
      .replace(/[’‘`]/g, "'")
      .replace(/\s*&\s*/g, " and ")
      .replace(/\bmasters?(?:'s)?\b/g, "master's")
      .replace(/\bbachelors?(?:'s)?\b/g, "bachelor's")
      .replace(/\bph\.?d\.?\b/g, "doctorate")
      .replace(/\bdoctor of philosophy\b/g, "doctorate")
      .replace(/\bhigh school diploma\b/g, "high school")
      .replace(/\bunited states of america\b/g, "united states")
      .replace(/\busa\b/g, "united states")
      .replace(/\bus\b/g, "united states")
      .replace(/\bmobile phone\b/g, "mobile")
      .replace(/\bcell phone\b/g, "mobile")
      .replace(/\bfull time\b/g, "full-time")
      .replace(/\bpart time\b/g, "part-time")
      .replace(/\bnon binary\b/g, "non-binary")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * How well one option matches a set of targets, on a fixed ladder of
   * confidence. Callers pass a lower ladder for synonym-derived targets so an
   * exact hit on the answer itself can never lose to a looser alias.
   */
  /**
   * Prefix and containment tests that respect word boundaries.
   *
   * The bare `startsWith` / `includes` tests scored an option "No" as a prefix
   * of the answer "North Carolina" and "None", and "no" as contained in "Not
   * applicable" and "I do not know". On a Yes/No dropdown that is how a State,
   * a clearance level or a location was turned into a confident "No" — the
   * reported "application questions are answered the opposite way". A match
   * now has to end (and start) on a word boundary: "Master's" is still a prefix
   * of "Master's Degree", "No" is no longer a prefix of "North".
   */
  const isWordChar = (ch) => Boolean(ch) && /[a-z0-9]/i.test(ch);

  function startsAtWord(hay, needle) {
    if (!hay || !needle || !hay.startsWith(needle)) return false;
    return !isWordChar(hay[needle.length]) || !isWordChar(needle[needle.length - 1]);
  }

  function containsAtWord(hay, needle) {
    if (!hay || !needle) return false;
    let from = 0;
    for (let guard = 0; guard < 50; guard++) {
      const i = hay.indexOf(needle, from);
      if (i < 0) return false;
      const okBefore = !isWordChar(hay[i - 1]) || !isWordChar(needle[0]);
      const okAfter = !isWordChar(hay[i + needle.length]) || !isWordChar(needle[needle.length - 1]);
      if (okBefore && okAfter) return true;
      from = i + 1;
    }
    return false;
  }

  function tieredScore(text, value, targets, tiers) {
    let best = 0;
    for (const raw of targets || []) {
      const target = normalizeChoiceText(raw);
      if (!target) continue;
      if (text === target || (value && value === target)) best = Math.max(best, tiers.exact);
      else if (
        startsAtWord(text, target) || startsAtWord(value, target) ||
        // The option is the start of the answer ("Master's" for "Master's
        // Degree"). A one- or two-letter option is never read this way.
        (text.length >= 3 && startsAtWord(target, text))
      ) best = Math.max(best, tiers.prefix);
      else if (
        containsAtWord(text, target) || containsAtWord(value, target) ||
        (text.length >= 3 && containsAtWord(target, text))
      ) best = Math.max(best, tiers.contains);
      else best = Math.max(best, Math.round(choiceSimilarity(text, target) * tiers.fuzzy));
    }
    return best;
  }

  function choiceSimilarity(a, b) {
    const A = new Set(normalizeChoiceText(a).split(/\W+/).filter((x) => x.length > 1));
    const B = new Set(normalizeChoiceText(b).split(/\W+/).filter((x) => x.length > 1));
    if (!A.size || !B.size) return 0;
    let hits = 0;
    A.forEach((x) => { if (B.has(x)) hits++; });
    return hits / Math.max(A.size, B.size);
  }

  /* ------------------------------------------------------------------ */
  /*  States and provinces                                               */
  /* ------------------------------------------------------------------ */

  /**
   * One id per state, however it is written.
   *
   * The profile's "State / region" box is free text, so it holds "NC" as often
   * as "North Carolina" — and Workday's State menu lists full names only. The
   * option scoring treated "NC" as a string to be found somewhere in an option,
   * which picked Maine for "MA", Michigan for "GA", Nevada for "VA" and
   * California for "IA". And when the country was offered to the State menu
   * instead, "United States" was a prefix of "United States Minor Outlying
   * Islands", which is what landed on the form.
   *
   * Every state, territory and province is reduced to one id here — `US-NC` for
   * "NC", "N.C.", "North Carolina" and "North Carolina (NC)" alike — and a
   * choice list made of places is matched on that id and nothing else. The
   * right state, or no answer: never a neighbour that happens to share letters.
   *
   * Two-letter codes are only read for the US and Canada, whose codes do not
   * collide. Indian and Australian states are matched by name.
   */
  const REGIONS = (() => {
    const us = [
      ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
      ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
      ["DC", "District of Columbia", "Washington DC", "Washington D C", "Washington District of Columbia"],
      ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
      ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
      ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
      ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
      ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
      ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"],
      ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
      ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
      ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
      ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"], ["PR", "Puerto Rico"],
      ["VI", "Virgin Islands", "US Virgin Islands", "U S Virgin Islands", "Virgin Islands US", "Virgin Islands U S",
        "United States Virgin Islands", "Virgin Islands of the United States"],
      ["UM", "United States Minor Outlying Islands", "US Minor Outlying Islands", "U S Minor Outlying Islands"],
      ["AA", "Armed Forces Americas"],
      ["AE", "Armed Forces Europe", "Armed Forces Africa", "Armed Forces Canada", "Armed Forces Middle East"],
      ["AP", "Armed Forces Pacific"],
    ];
    const ca = [
      ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"], ["NB", "New Brunswick"],
      ["NL", "Newfoundland and Labrador", "Newfoundland"], ["NS", "Nova Scotia"], ["NT", "Northwest Territories"],
      ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"], ["QC", "Quebec"],
      ["SK", "Saskatchewan"], ["YT", "Yukon", "Yukon Territory"],
    ];
    const india = [
      ["Andhra Pradesh"], ["Arunachal Pradesh"], ["Assam"], ["Bihar"], ["Chhattisgarh", "Chattisgarh"], ["Goa"],
      ["Gujarat"], ["Haryana"], ["Himachal Pradesh"], ["Jharkhand"], ["Karnataka"], ["Kerala"],
      ["Madhya Pradesh"], ["Maharashtra"], ["Manipur"], ["Meghalaya"], ["Mizoram"], ["Nagaland"],
      ["Odisha", "Orissa"], ["Punjab"], ["Rajasthan"], ["Sikkim"], ["Tamil Nadu"], ["Telangana"], ["Tripura"],
      ["Uttar Pradesh"], ["Uttarakhand", "Uttaranchal"], ["West Bengal"], ["Andaman and Nicobar Islands"],
      ["Chandigarh"], ["Dadra and Nagar Haveli and Daman and Diu", "Dadra and Nagar Haveli", "Daman and Diu"],
      ["Delhi", "New Delhi", "NCT of Delhi", "National Capital Territory of Delhi"], ["Jammu and Kashmir"],
      ["Ladakh"], ["Lakshadweep"], ["Puducherry", "Pondicherry"],
    ];
    const au = [
      ["New South Wales"], ["Victoria"], ["Queensland"], ["Western Australia"], ["South Australia"],
      ["Tasmania"], ["Australian Capital Territory"], ["Northern Territory"],
    ];

    const byName = new Map();
    const byCode = new Map();
    const nameOf = new Map();
    const codeOf = new Map();
    const key = (s) => regionKey(s);
    for (const [code, ...names] of us) {
      const id = `US-${code}`;
      byCode.set(code, id); nameOf.set(id, names[0]); codeOf.set(id, code);
      names.forEach((n) => byName.set(key(n), id));
    }
    for (const [code, ...names] of ca) {
      const id = `CA-${code}`;
      byCode.set(code, id); nameOf.set(id, names[0]); codeOf.set(id, code);
      names.forEach((n) => byName.set(key(n), id));
    }
    for (const [prefix, list] of [["IN", india], ["AU", au]]) {
      for (const names of list) {
        const id = `${prefix}-${key(names[0]).replace(/\s+/g, "")}`;
        nameOf.set(id, names[0]);
        names.forEach((n) => byName.set(key(n), id));
      }
    }
    return { byName, byCode, nameOf, codeOf };
  })();

  function regionKey(s) {
    return String(s ?? "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\bst\.?\s+/g, "saint ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const COUNTRY_WORD_RE =
    /^(us|usa|u s|u s a|united states|united states of america|america|ca|can|canada|in|ind|india|au|aus|australia)$/;

  /**
   * The state or province this text names, as `US-NC` / `CA-ON` / `IN-telangana`,
   * or null.
   *
   * `loose` is for the applicant's own value, which may carry a city in front
   * ("Stanley, NC"). Option text is read strictly: an option either names one
   * place or it is not a place.
   */
  function regionId(text, { loose = false } = {}) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 80) return null;
    const whole = regionKey(raw);
    if (!whole) return null;
    if (REGIONS.byName.has(whole)) return REGIONS.byName.get(whole);

    const bare = raw.replace(/[.\s]/g, "");
    if (/^[A-Za-z]{2}$/.test(bare)) return REGIONS.byCode.get(bare.toUpperCase()) ?? null;

    const prefixed = raw.match(/^(?:us|usa|u\.s\.(?:a\.)?|united states|ca|canada)\s*[-:,/]\s*([A-Za-z]{2})$/i);
    if (prefixed) return REGIONS.byCode.get(prefixed[1].toUpperCase()) ?? null;

    // "North Carolina (NC)", "NC - North Carolina", "North Carolina, USA", "Stanley, NC".
    const pieces = raw.split(/\s*[(),\-–—/|:;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (pieces.length < 2) return null;
    const named = new Set();
    const coded = new Set();
    let other = 0;
    for (const piece of pieces) {
      const k = regionKey(piece);
      if (!k) continue;
      if (REGIONS.byName.has(k)) { named.add(REGIONS.byName.get(k)); continue; }
      const b = piece.replace(/[.\s]/g, "");
      // Upper case only: "in" and "or" are words, "IN" and "OR" are states.
      if (/^[A-Z]{2}$/.test(b) && REGIONS.byCode.has(b)) { coded.add(REGIONS.byCode.get(b)); continue; }
      if (COUNTRY_WORD_RE.test(k)) continue;
      other++;
    }
    // A full name decides it. A two-letter piece beside it is either the same
    // state's code or a country code ("Karnataka, IN"), never a second state.
    if (named.size === 1) return other === 0 || loose ? [...named][0] : null;
    if (named.size > 1) return null;
    if (coded.size === 1 && (other === 0 || loose)) return [...coded][0];
    return null;
  }

  /** The name a menu of states would use for this region id. */
  function regionName(id) {
    return REGIONS.nameOf.get(id) ?? null;
  }

  /** The two-letter postal code for a US state or Canadian province, if it has one. */
  function regionCode(value) {
    const id = regionId(value, { loose: true });
    return id ? REGIONS.codeOf.get(id) ?? null : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Yes / No                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Reduces an answer or an option to yes / no / decline / na / maybe, or null.
   *
   * A Yes/No menu is only ever answered with a yes or a no. The old scoring let
   * any stored value compete for it on spelling alone: a state of "North
   * Carolina" and a clearance of "None" both began with "No", so both were
   * written as a confident "No" into questions they had nothing to do with.
   * When the menu is a Yes/No menu, the answer has to be a yes or a no too —
   * otherwise the question is left for the applicant.
   */
  // Tested against text with apostrophes removed ("don't" → "dont"). Every
  // alternative ends on a word boundary: "No" must never be read inside
  // "North Carolina", "Norway" or "Nothing", nor "1" inside "10".
  const YN_YES_RE =
    /^(?:(?:yes|y|yeah|yep|yup|true|affirmative|correct|agreed?|accepts?|consent)\b|i (?:agree|accept|consent)\b|i (?:am|do|have|will|can|would|certify|confirm|acknowledge|understand)\b(?! not\b))/;
  const YN_NO_RE =
    /^(?:(?:no|n|nope|false|none|never|negative|disagree)\b|i (?:am|do|have|will|can|would|did|was) (?:not|never)\b|i (?:am|was) unable\b|i (?:dont|havent|wont|cant|cannot|didnt|wasnt)\b|not (?:a|an|currently|now|at this time)\b)/;
  const YN_MAYBE_RE =
    /^(?:maybe|not sure|unsure|uncertain|dont know|do not know|i dont know|i do not know|undecided|possibly|depends|it depends)\b/;
  const YN_NA_RE = /^(?:n\/a|n a|na|not applicable|none of the above|does not apply|doesnt apply)\b/;

  function yesNoId(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 160) return null;
    const lower = norm(raw).replace(/[’‘`]/g, "'");
    if (DECLINE_RE.test(lower)) return "decline";
    const t = lower.replace(/'/g, "").replace(/[^a-z0-9\s/]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^decline\b/.test(t)) return "decline";
    if (/^(?:1|t)$/.test(t)) return "yes";
    if (/^(?:0|f)$/.test(t)) return "no";
    if (YN_NA_RE.test(t)) return "na";
    if (YN_MAYBE_RE.test(t)) return "maybe";
    if (YN_NO_RE.test(t)) return "no";
    if (YN_YES_RE.test(t)) return "yes";
    return null;
  }

  /** Is this a menu whose choices are all yes / no / decline answers? */
  function isYesNoList(texts) {
    const real = (texts || []).map((t) => String(t ?? "").trim()).filter((t) => t && !isPlaceholderChoice(t));
    if (real.length < 2 || real.length > 6) return false;
    const ids = real.map(yesNoId);
    return ids.every(Boolean) && ids.includes("yes") && ids.includes("no");
  }

  /**
   * Scores for choice lists that only admit a canonical answer.
   *
   * Returns an array of scores, one per option, when the list is a list of
   * places or a Yes/No list; null when neither applies and ordinary scoring
   * should decide. A zero means "never this option", and an all-zero result
   * leaves the question unanswered rather than guessed.
   */
  function strictChoiceScores(optionTexts, value, optionValues = []) {
    const texts = (optionTexts || []).map((t) => String(t ?? ""));
    const values = (optionValues || []).map((v) => String(v ?? ""));
    const answer = Array.isArray(value) ? value.join(", ") : String(value ?? "");

    const wantRegion = regionId(answer, { loose: true });
    if (wantRegion) {
      const ids = texts.map((t, i) => regionId(t) || (values[i] && !/^\d+$/.test(values[i]) ? regionId(values[i]) : null));
      if (ids.filter(Boolean).length >= 2 || ids.some((id) => id === wantRegion)) {
        return ids.map((id, i) =>
          id && id === wantRegion ? 140 + Math.round(choiceSimilarity(texts[i], answer) * 5) : 0);
      }
    }

    if (isYesNoList(texts)) {
      const want = yesNoId(answer);
      return texts.map((t) => {
        if (!want || isPlaceholderChoice(t)) return 0;
        return yesNoId(t) === want ? 120 + Math.round(choiceSimilarity(t, answer) * 10) : 0;
      });
    }

    const ranged = rangeScores(texts, answer);
    if (ranged) return ranged;
    return null;
  }

  /**
   * "13" against "0-2 years | 3-5 years | 6-10 years | More than 10 years".
   *
   * A number was matched to menus of ranges by its text, and "13" is not in
   * any of them — so "How many years of experience do you have?" was left
   * blank on every portal that asks it as a menu. The option whose range
   * holds the number is the answer; with no such option, nothing is chosen.
   */
  function numericAnswer(answer) {
    const m = String(answer ?? "").trim().match(/^(\d{1,3}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)?\.?$/i);
    return m ? Number(m[1]) : null;
  }

  function rangeOf(text) {
    const t = String(text ?? "").toLowerCase().replace(/[–—]/g, "-").replace(/,/g, "").trim();
    if (!t || isPlaceholderChoice(t)) return null;
    if (!/\d/.test(t)) return /^(none|no\s+experience|no\s+prior\s+experience|n\/a)\b/.test(t) ? [0, 0] : null;
    if (/\bmonths?\b/.test(t) && !/\byears?\b/.test(t)) return null;
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|through)\s*(\d+(?:\.\d+)?)/))) return [Number(m[1]), Number(m[2])];
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*\+/)) ||
        (m = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?\s*(?:or|and)\s*(?:more|above|over|greater|higher|up)\b/))) return [Number(m[1]), Infinity];
    if ((m = t.match(/\b(?:more|greater)\s+than\s+(\d+(?:\.\d+)?)|\b(?:over|above|exceeds?)\s+(\d+(?:\.\d+)?)|>\s*(\d+(?:\.\d+)?)/))) {
      return [Number(m[1] ?? m[2] ?? m[3]) + 1e-6, Infinity];
    }
    if ((m = t.match(/\b(?:at\s+least|minimum(?:\s+of)?)\s+(\d+(?:\.\d+)?)/))) return [Number(m[1]), Infinity];
    if ((m = t.match(/\b(?:less|fewer)\s+than\s+(\d+(?:\.\d+)?)|\bunder\s+(\d+(?:\.\d+)?)|<\s*(\d+(?:\.\d+)?)/))) {
      return [0, Number(m[1] ?? m[2] ?? m[3]) - 1e-6];
    }
    if ((m = t.match(/\b(?:up\s+to|at\s+most|maximum(?:\s+of)?)\s+(\d+(?:\.\d+)?)/))) return [0, Number(m[1])];
    if ((m = t.match(/^\D*?(\d+(?:\.\d+)?)\D*$/))) return [Number(m[1]), Number(m[1])];
    return null;
  }

  function rangeScores(texts, answer) {
    const n = numericAnswer(answer);
    if (n == null) return null;
    const ranges = texts.map(rangeOf);
    if (ranges.filter(Boolean).length < 2) return null;
    // Whole years on a menu of whole-year ranges: 5.5 sits in "3-5", not in a gap.
    const whole = ranges.every((r) => !r || (Number.isInteger(r[0]) || r[0] === 0 || !Number.isFinite(r[0]) || Math.abs(r[0] - Math.round(r[0])) < 1e-3));
    const value = whole ? Math.floor(n) : n;
    let picked = -1;
    ranges.forEach((r, i) => {
      if (picked === -1 && r && value >= r[0] - 1e-9 && value <= r[1] + 1e-9) picked = i;
    });
    return texts.map((_, i) => (i === picked ? 125 : 0));
  }

  /* ------------------------------------------------------------------ */
  /*  EEO answers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Voluntary-disclosure questions are the ones every portal words
   * differently and the ones where a near-miss is genuinely harmful: picking
   * "I identify as one or more of the classifications of protected veteran"
   * when the answer is "I am not a protected veteran" is a false statement on
   * a federal form.
   *
   * Each answer is reduced to a canonical id. Two ids that differ inside the
   * same question are a hard block (score 0), never a fuzzy near-match.
   */
  const DECLINE_RE =
    /(decline|prefer\s+not|prefer\s+to\s+not|do\s*n[o']?t\s+wish|don'?t\s+wish|not\s+wish\s+to|wish\s+not\s+to|choose\s+not\s+to|rather\s+not|not\s+to\s+(?:disclose|answer|identify|say)|not\s+disclose|no\s+response|i\s+do(?:\s+not|n'?t)\s+want\s+to\s+(?:answer|say|disclose|identify)|i\s+do\s+not\s+wish\s+to\s+(?:answer|disclose|identify)|not\s+want\s+to\s+answer|opt\s+out|self[-\s]?identify\s+later)/i;

  const EEO_DOMAINS = [
    /**
     * VEVRAA lists FOUR answers, not two, and two of them contain the words
     * "not a protected veteran":
     *
     *   I identify as one or more of the classifications of a protected veteran
     *   I identify as a veteran, just not a protected veteran
     *   I am not a protected veteran  (or: I am not a veteran)
     *   I don't wish to answer
     *
     * The middle one is an assertion that the applicant *is* a veteran. It used
     * to reduce to the same id as "I am not a protected veteran", so a
     * non-veteran was given it whenever the portal happened to list it first —
     * which is a false statement on a federal form. It is now its own branch,
     * and a branch mismatch is a hard block, so the answer either lands on the
     * matching wording or the question is left for the applicant.
     *
     * Ordering matters: the narrower wordings are tested before the broader
     * ones so "…just not a protected veteran" can never fall through to "not".
     */
    ["veteran", [
      ["unprotected", /(identify\s+as\s+a\s+veteran|veteran[,\s]+(?:but|just)\s+not|am\s+a\s+veteran[,\s]+(?:but|just)\s+not|veteran\s+but\s+not\s+a\s+protected)/i],
      ["protected", /(identify\s+as\s+one\s+or\s+more|one\s+or\s+more\s+of\s+the\s+classification|i\s+am\s+a\s+protected\s+veteran|i\s+am\s+one\s+or\s+more|yes[,\s].{0,30}veteran|am\s+a\s+veteran)/i],
      ["not", /(not\s+a\s+protected\s+veteran|i\s+am\s+not\s+a\s+veteran|i\s+am\s+not\s+a\s+protected|no[,\s].{0,30}not\s+a\s+.{0,20}veteran|non[-\s]?protected|not\s+a\s+veteran|no[,\s].{0,20}veteran)/i],
    ], /veteran|military/i],

    /**
     * An answer that opens with Yes or No is that answer, whatever follows.
     *
     * Chainalysis's Ashby survey words its No as "No, I don't have a disability
     * or have a history/record of having a disability". The Yes patterns were
     * tested first, "or have a history" is one of them, and so the No option
     * was read as a Yes: both options landed on the Yes branch, a "No" profile
     * matched neither, and "Do you live with a disability?" was left blank. A
     * leading Yes / No now decides, and a denial ("don't have a disability") is
     * recognised before the affirmations it contains.
     */
    ["disability", [
      ["yes", /^\s*yes\b/i],
      ["no", /^\s*no\b/i],
      ["no", /(i\s+do\s+not\s+have\s+(?:a\s+|any\s+)?disab|don'?t\s+have\s+(?:a\s+|any\s+)?disab|do\s+not\s+have\s+(?:a\s+|any\s+)?disab|no\s+disabilit|have\s+not\s+had\s+a\s+disab|(?:do\s+not|don'?t)\s+live\s+with\s+a\s+disab|(?:am|are)\s+not\s+(?:a\s+)?(?:person\s+)?(?:with|living\s+with)\s+a\s+disab)/i],
      ["yes", /(yes[,\s].{0,60}disab|i\s+have\s+a\s+disab|do\s+have\s+a\s+disab|have\s+had\s+a\s+disab|history\s+of\s+a\s+disab|or\s+have\s+a\s+history|(?:i\s+)?live\s+with\s+a\s+disab)/i],
    ], /disabilit|section\s*503|cc-?305/i],

    ["gender", [
      ["male", /(^|[^a-z])male\b|(^|[^a-z])man\b|identify\s+as\s+male/i],
      ["female", /(^|[^a-z])female\b|(^|[^a-z])woman\b|identify\s+as\s+female/i],
      ["nonbinary", /non[-\s]?binary|genderqueer|gender\s*non[-\s]?conform|another\s+gender/i],
    ], /gender|\bsex\b/i],

    /**
     * Race / ethnicity had no domain at all, so it was answered by token
     * overlap — and "Asian" against a list containing "American Indian or
     * Alaska Native (Not Hispanic or Latino)" is exactly the kind of near-miss
     * that produces. Every EEO-1 category is now its own branch, so a race
     * answer lands on its own category or on nothing.
     *
     * "American Indian" is tested first: it is the one category whose wording
     * contains another category's name, and an applicant from India describing
     * themselves as "Indian" or "Asian Indian" must never be routed into it.
     */
    ["race", [
      ["americanindian", /(american\s+indian|alaska(n)?\s+native|native\s+american)/i],
      ["nativehawaiian", /(native\s+hawaiian|pacific\s+islander)/i],
      ["black", /(black|african\s+american|afro[-\s]?caribbean)/i],
      ["asian", /(^|[^a-z])asian\b|asian\s+indian|south\s+asian|east\s+asian|indian\s+subcontinent/i],
      ["white", /(^|[^a-z])white\b|caucasian/i],
      ["twoormore", /(two\s+or\s+more|multi[-\s]?racial|mixed\s+race)/i],
      ["hispanic", /(hispanic|latino|latina|latinx)/i],
    ], /\brace\b|ethnic|racial|eeo[-\s]?1/i],

    ["yesno", [
      ["yes", /^\s*yes\b/i],
      ["no", /^\s*no\b/i],
    ], /hispanic|latino/i],
  ];

  /**
   * Reduces an answer or option to `domain:id`, or `decline`, or null when the
   * text carries no canonical meaning. `hint` (the field label) disambiguates
   * a bare "Yes"/"No" that could belong to several questions.
   */
  function eeoId(text, hint = "") {
    // Every EEO-1 race option but one is suffixed "(Not Hispanic or Latino)".
    // That qualifier says what the category is *not*, so leaving it in made
    // "Two or More Races (Not Hispanic or Latino)" reduce to `race:hispanic`.
    // It carries no category of its own and is dropped before branch testing.
    // Workday also spells it "(Not Hispanic/Latino)".
    // Typographic apostrophes too: Ashby prints "I don’t wish to answer", and
    // "don’t" never matched a pattern written with a straight one.
    const t = norm(text).replace(/[’‘`]/g, "'")
      .replace(/\(?\s*not\s+hispanic\s*(?:or|\/)\s*latin[oax]\s*\)?/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (DECLINE_RE.test(t)) return "decline";
    const h = norm(hint);
    for (const [domain, branches, hintRe] of EEO_DOMAINS) {
      const relevant = hintRe.test(t) || (h && hintRe.test(h));
      if (!relevant) continue;
      for (const [id, re] of branches) {
        if (re.test(t)) return `${domain}:${id}`;
      }
    }
    return null;
  }

  /** Kept for callers that still use the old name. */
  function canonicalChoice(value, hint) {
    const id = eeoId(value, hint);
    return id ? id : norm(value);
  }

  /**
   * Score for an option that is on the right EEO branch.
   *
   * A flat score for every same-branch option is what put "I IDENTIFY AS A
   * VETERAN, JUST NOT A PROTECTED VETERAN" into a form whose answer was "I am
   * not a protected veteran": both reduced to the same id, both scored 130, and
   * the winner came down to which one the portal listed first. Splitting those
   * two into separate branches fixes that particular pair, but any list can
   * word one branch two ways — "No, I do not have a disability" and "No, I do
   * not have a disability and have not had one in the past" are the same answer
   * — so the branch decides *whether* an option is eligible and closeness to
   * the stored answer decides *which* eligible option wins.
   */
  const EEO_BRANCH_BASE = 118;
  function eeoBranchScore(optionText, wantText) {
    return EEO_BRANCH_BASE + Math.round(choiceSimilarity(optionText, wantText) * 15);
  }

  /* ------------------------------------------------------------------ */
  /*  Value setting (framework-safe)                                     */
  /* ------------------------------------------------------------------ */

  function nativeSetter(el) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value")?.set;
  }

  function fire(el, ...types) {
    types.forEach((type) => {
      let evt;
      if (type.startsWith("key")) {
        evt = new KeyboardEvent(type, { bubbles: true, cancelable: true });
      } else if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
        evt = new PointerEvent(type, { bubbles: true, cancelable: true });
      } else if (type.startsWith("mouse") || type === "click") {
        evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
      } else if (type.startsWith("focus") || type === "blur") {
        evt = new FocusEvent(type, { bubbles: true, cancelable: true });
      } else {
        evt = new Event(type, { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(evt);
    });
  }

  /**
   * The longest value a control will accept, or 0 when it does not say.
   *
   * Oracle Recruiting caps Suffix at 80 characters and Tax District at 150 and
   * rejects anything longer with a validation message. Writing past the cap
   * leaves the applicant with a red field they have to find and clear by hand,
   * so an over-long value is refused here instead of written and rejected.
   */
  function maxLengthOf(el) {
    const raw = Number(el?.getAttribute?.("maxlength") ?? el?.maxLength ?? 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * Workday's date control is not one box, it is two or three.
   *
   * `From *` renders as separate `MM` and `YYYY` inputs inside one wrapper,
   * each a spinbutton with its own two- or four-character cap. Writing
   * "12/2019" at it put the whole string into a segment that could not hold it,
   * and the page came back "Invalid Date: /2019" — the year had landed and the
   * month never had.
   *
   * Segments are found through the wrapper rather than by guessing from the
   * element handed in, because either segment may be the one the field scan
   * picked up.
   */
  const DATE_SEGMENT_SELECTOR =
    '[data-automation-id*="dateSection" i] input, input[data-automation-id*="dateSection" i], ' +
    'input[role="spinbutton"], input[aria-label*="Month" i], input[aria-label*="Year" i], input[aria-label*="Day" i]';

  function dateSegments(el) {
    if (!el) return null;
    const wrapper = el.closest?.(
      '[data-automation-id*="dateInput" i], [data-automation-id*="datePicker" i], [data-automation-id*="dateWidget" i], .css-dateinput, [role="group"], [class*="dateInput" i]'
    ) || el.parentElement;
    if (!wrapper) return null;

    let inputs = [];
    try {
      inputs = Array.from(wrapper.querySelectorAll(DATE_SEGMENT_SELECTOR));
    } catch {}
    if (inputs.length < 2) return null;

    // Only short numeric boxes count. A wrapper that also holds a free-text
    // field is not a segmented date and must not be treated as one.
    /**
     * A segment is identified by what it says it is, not by having a cap.
     *
     * The filter used to require `maxlength` between 1 and 4. Workday's date
     * spinbuttons do not carry one — they bound themselves with `aria-valuemax`
     * — so every segment was dropped, detection returned null, and the whole
     * "12/2022" string went into a single box again. That is the `MM/2022` and
     * "Invalid Date: /2022" still showing after the first date fix.
     *
     * A cap is now only used to *reject*: anything that admits to holding more
     * than four characters is a free-text field, not a date segment.
     */
    const looksLikeSegment = (node) => {
      const cap = maxLengthOf(node);
      if (cap > 4) return false;
      const hint = `${node.getAttribute?.("data-automation-id") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("placeholder") || ""} ${node.getAttribute?.("name") || ""} ${node.getAttribute?.("id") || ""}`;
      if (/datesection|\bmonth\b|\byear\b|\bday\b|\bmm\b|\byyyy\b|\bdd\b/i.test(hint)) return true;
      if (node.getAttribute?.("role") === "spinbutton") return true;
      return cap > 0 && cap <= 4;
    };

    const segs = inputs.filter(looksLikeSegment);
    if (segs.length < 2 || segs.length > 3) return null;
    /**
     * Only the date's own boxes are the date.
     *
     * The wrapper above is the nearest thing that could hold a date, and on
     * Workday that can be a `role="group"` around a whole page of questions.
     * Every other box inside it was then taken for part of the date. The
     * self-identification Name was "written" as a date: nothing went into it,
     * and the Date beside it was given up on, so both stayed empty. An answer
     * such as a bonus of "20000" was read as the year 20000 and typed over
     * Available Start Date as 01/01/0000, which Workday shows as 01/01/2000.
     *
     * Something that is not one of the boxes now counts only when it lies
     * inside the boxes' own container and is not a box of its own that one
     * types into or picks from.
     */
    if (!segs.includes(el)) {
      let common = segs[0].parentElement;
      while (common && !segs.every((s) => common.contains(s))) common = common.parentElement;
      if (!common || !common.contains(el)) return null;
      try {
        if (el.matches?.('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], [role="listbox"]')) return null;
      } catch {}
    }

    const kindOf = (node) => {
      const hint = `${node.getAttribute?.("data-automation-id") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("placeholder") || ""} ${node.getAttribute?.("name") || ""}`;
      if (/month|\bmm\b/i.test(hint)) return "month";
      if (/year|\byyyy\b|\byy\b/i.test(hint)) return "year";
      if (/\bday\b|\bdd\b/i.test(hint)) return "day";
      const cap = maxLengthOf(node);
      if (cap === 4) return "year";
      // No cap and no name: a segment whose upper bound is a four-digit number
      // is the year box.
      const max = Number(node.getAttribute?.("aria-valuemax") ?? 0);
      if (max >= 1000) return "year";
      return null;
    };

    const mapped = segs.map((node) => ({ node, kind: kindOf(node) }));
    if (!mapped.some((s) => s.kind === "year")) return null;

    // Segments with no usable hint are assigned by document order: on a
    // US-locale Workday form that is month, then day, then year.
    const order = ["month", "day", "year"];
    let next = 0;
    for (const seg of mapped) {
      if (seg.kind) { next = Math.max(next, order.indexOf(seg.kind) + 1); continue; }
      while (next < order.length && mapped.some((s) => s.kind === order[next])) next++;
      seg.kind = order[next] ?? null;
      next++;
    }
    return mapped.filter((s) => s.kind);
  }

  /** Every box of the segmented date `el` belongs to, or null when it is one box. */
  function dateSegmentNodes(el) {
    try {
      const segs = dateSegments(el);
      return segs && segs.length >= 2 ? segs.map((s) => s.node) : null;
    } catch {
      return null;
    }
  }

  /** A month written as a word: "October", "Oct", "Sept." — but not "Marketing". */
  const MONTH_WORD_RE =
    /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

  /** Pull month / day / year out of the formats a profile date arrives in. */
  function dateParts(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    /**
     * Only a day a calendar could show: a four-digit year from 1900 to 2100,
     * a month from 1 to 12 and a day from 1 to 31.
     */
    const real = (parts) => {
      const year = Number(parts.year);
      if (!/^\d{4}$/.test(String(parts.year)) || year < 1900 || year > 2100) return null;
      if (parts.month && !(Number(parts.month) >= 1 && Number(parts.month) <= 12)) return null;
      if (parts.day && !(Number(parts.day) >= 1 && Number(parts.day) <= 31)) return null;
      return parts;
    };

    let m = raw.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);  // 2019-12-05
    if (m) return real({ year: m[1], month: m[2], day: m[3] ?? "" });

    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                // 12/05/2019
    if (m) return real({ month: m[1], day: m[2], year: m[3] });

    m = raw.match(/^(\d{1,2})\/(\d{4})$/);                           // 12/2019
    if (m) return real({ month: m[1], year: m[2], day: "" });

    m = raw.match(/^(\d{4})$/);                                      // 2019
    if (m) return real({ year: m[1], month: "", day: "" });

    /**
     * A bare number is not a date, and `new Date` must never see one.
     *
     * `new Date("12")` is 1 December **2001**. A Workday month box is filled
     * with "12" on its own, so the fallback below turned that into a whole
     * date, and writing it across the widget replaced the year the applicant
     * actually worked there with 2001. Anything this short is one segment's
     * own answer and is handled by `setSegmentedDate`, not here.
     *
     * Nor is anything else that does not read as a date. `new Date` takes
     * almost any text: "20000" is the year 20000, "120000" the year 120000,
     * "10%" is 1 October 2001 and "Marketing 2019" is March 2019. A bonus of
     * "20000" was taken for a date that way and typed over Available Start
     * Date as 01/01/0000 — shown by Workday as 01/01/2000. Beyond the formats
     * above, only a month written as a word with a year ("October 1, 2026",
     * "Dec 2019") is read as a date.
     */
    if (/^\d{1,3}$/.test(raw)) return null;
    if (raw.length > 32 || !MONTH_WORD_RE.test(raw) || !/\b(19|20)\d{2}\b/.test(raw)) return null;

    const parsed = new Date(raw.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
    if (!Number.isNaN(parsed.getTime())) {
      return real({
        year: String(parsed.getFullYear()),
        month: String(parsed.getMonth() + 1),
        day: String(parsed.getDate()),
      });
    }
    return null;
  }

  /**
   * How many characters this segment holds.
   *
   * `el.maxLength` is **-1** on an input with no `maxlength` attribute, and
   * Workday's date spinbuttons carry none. The old reader took that -1 as the
   * cap, so `cap === 4` was never true and every value was trimmed to its last
   * two characters: a year of 2021 was written as "21", and the widget then
   * reported an invalid date against a box the applicant could see was filled.
   */
  function segmentCap(node, kind) {
    const declared = maxLengthOf(node);
    if (declared > 0) return declared;
    return kind === "year" ? 4 : 2;
  }

  /** Is this number a plausible answer for a month / day / year box? */
  function fitsSegment(kind, digits) {
    const n = Number(digits);
    if (!Number.isFinite(n)) return false;
    if (kind === "month") return digits.length <= 2 && n >= 1 && n <= 12;
    if (kind === "day") return digits.length <= 2 && n >= 1 && n <= 31;
    return digits.length === 4 || digits.length === 2;   // year, four- or two-digit
  }

  /**
   * Type one number into one segment.
   *
   * `insertText` first, for the same reason `setTextValue` uses it: Workday
   * only records what its own editing pipeline saw. Assignment is the fallback
   * for widgets that refuse the command.
   */
  /**
   * One keystroke, as close to a person's as script can get.
   *
   * Workday's date segment keeps its own buffer and fills it from `keydown`.
   * Assigning `.value`, or inserting text without saying which key produced it,
   * updates what the applicant can see and nothing else — which is how a box
   * plainly reading 01/2017 still reported "The field From is required and must
   * have a value" when Save and Continue validated against that buffer.
   *
   * The digit is offered to the widget first. Only if its own handler declines
   * to write anything does this put the character in, so a widget that already
   * typed it does not end up with it twice.
   */
  function typeDigit(node, ch) {
    const codePoint = 48 + Number(ch);
    const keyInit = {
      key: ch, code: `Digit${ch}`, keyCode: codePoint, which: codePoint,
      bubbles: true, cancelable: true,
    };

    const before = String(node.value ?? "");
    const unchanged = () => String(node.value ?? "") === before;
    /**
     * The whole of a keystroke, not just its first and last events.
     *
     * A key press reaches a page as keydown, keypress, beforeinput, textInput,
     * and only then the text itself (and input). Inserting the text directly
     * produces the input event alone, and React builds its onBeforeInput from
     * textInput — so a box that reads typed digits there, or on keypress,
     * never saw a single one of them. Each event is offered in the browser's
     * own order, and the first one the page takes (cancels) ends the keystroke
     * there, as it would for a person's.
     */
    let proceed = node.dispatchEvent(new KeyboardEvent("keydown", keyInit));
    if (proceed && unchanged()) {
      proceed = node.dispatchEvent(new KeyboardEvent("keypress", { ...keyInit, charCode: codePoint }));
    }
    if (proceed && unchanged()) {
      try {
        proceed = node.dispatchEvent(new InputEvent("beforeinput", { data: ch, inputType: "insertText", bubbles: true, cancelable: true }));
      } catch {}
    }
    if (proceed && unchanged()) {
      try {
        const textInput = document.createEvent("TextEvent");
        textInput.initTextEvent("textInput", true, true, window, ch);
        proceed = node.dispatchEvent(textInput);
      } catch {}
    }

    if (proceed && unchanged()) {
      let inserted = false;
      // A date widget moves the caret on by itself once a segment is full, so
      // the caret is confirmed to still be in this box before typing — the
      // command would otherwise put the digit into the next segment.
      if (!node.readOnly && takeFocus(node)) {
        try {
          inserted = Boolean(document.execCommand && document.execCommand("insertText", false, ch)) &&
            String(node.value ?? "") !== before;
        } catch {}
      }
      if (!inserted && !node.readOnly) {
        try {
          const writer = nativeSetter(node);
          const next = before + ch;
          if (writer) writer.call(node, next); else node.value = next;
          node.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
        } catch {}
      }
    }

    node.dispatchEvent(new KeyboardEvent("keyup", keyInit));
  }

  /** Empty a segment the way Backspace would, buffer included. */
  function clearSegment(node) {
    if (!String(node.value ?? "")) return;
    const keyInit = { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true, cancelable: true };

    for (let guard = 0; guard < 8 && String(node.value ?? ""); guard++) {
      const before = String(node.value ?? "");
      try { node.setSelectionRange?.(0, before.length); } catch {}
      const proceed = node.dispatchEvent(new KeyboardEvent("keydown", keyInit));
      if (proceed && String(node.value ?? "") === before && !node.readOnly) {
        let deleted = false;
        if (takeFocus(node)) {
          try { node.setSelectionRange?.(0, before.length); } catch {}
          try { deleted = Boolean(document.execCommand && document.execCommand("delete")); } catch {}
        }
        if (!deleted || String(node.value ?? "") === before) {
          try {
            const writer = nativeSetter(node);
            if (writer) writer.call(node, ""); else node.value = "";
          } catch {}
        }
        try { node.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true })); }
        catch { fire(node, "input"); }
      }
      node.dispatchEvent(new KeyboardEvent("keyup", keyInit));
      if (String(node.value ?? "") === before) break;   // nothing is shifting; stop
    }
  }

  function writeSegment(seg, digits) {
    const { node, kind } = seg;
    const cap = segmentCap(node, kind);
    const text = String(digits).replace(/\D+/g, "").padStart(kind === "year" ? 4 : 2, "0").slice(-cap);
    if (!text) return false;

    try {
      ensureVisible(node);
      node.focus?.({ preventScroll: true });
    } catch {}

    // A segment already holding "09" would otherwise end up with "0903" and
    // clamp back to something nobody asked for.
    clearSegment(node);
    for (const ch of text) typeDigit(node, ch);

    // Whatever the widget did with those keystrokes, the box must end up
    // showing the right thing.
    if (String(node.value ?? "") !== text && !node.readOnly) {
      try {
        const writer = nativeSetter(node);
        if (writer) writer.call(node, text); else node.value = text;
        fire(node, "input");
      } catch {}
    }

    // React drops a change event that agrees with the value it last recorded on
    // the node, so the record is made stale before the events go out.
    try {
      const tracker = node._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(text === "" ? "x" : "");
    } catch {}
    fire(node, "change");

    return String(node.value ?? "") === text;
  }

  function setSegmentedDate(el, value) {
    const segs = dateSegments(el);
    if (!segs) return false;

    const raw = String(value ?? "").trim();
    if (!raw) return false;

    /**
     * One number belongs to one box.
     *
     * Workday collects `From *` as two separate controls, so the scan plans the
     * month box and the year box independently and hands each its own number.
     * Spreading that number across the whole widget is what produced
     * "Invalid Date: /2021": the year write also blanked the month beside it,
     * and a month write would have overwritten the year with whatever
     * `new Date("12")` invented.
     */
    const mine = segs.find((s) => s.node === el);
    if (mine && /^\d{1,4}$/.test(raw)) {
      if (!fitsSegment(mine.kind, raw)) return false;
      const ok = writeSegment(mine, raw);
      // Only this segment is blurred. Blurring the whole widget here made
      // Workday validate a date that was still half-written. (With a focusout
      // when the browser sends none — see `takeFocusAnnounced`.)
      leaveLikeUser(el);
      return ok;
    }

    const parts = dateParts(raw);
    if (!parts || !parts.year) return false;

    // Month before year, matching the reading order. Workday advances focus
    // itself once a segment is full, so each write starts by taking focus back
    // rather than trusting where the caret ended up.
    const order = { month: 0, day: 1, year: 2 };
    const sorted = [...segs].sort((a, b) => order[a.kind] - order[b.kind]);

    let wrote = 0;
    for (const seg of sorted) {
      const part = parts[seg.kind];
      if (!part) continue;
      try { if (writeSegment(seg, part)) wrote++; } catch {}
    }

    const last = sorted[sorted.length - 1]?.node;
    const heard = last ? blurHeard(last) : true;
    for (const { node } of sorted) fire(node, "blur");
    if (last && !heard) fire(last, "focusout");
    return wrote > 0;
  }

  /**
   * The number a date box shows, however the widget shows it: its value, the
   * number it reports to screen readers, or the text drawn over it (Workday
   * paints "MM" / "01" in a `…-display` element beside the input). "" when it
   * shows nothing we can read.
   */
  function segmentShown(node) {
    const digits = (v) => String(v ?? "").replace(/\D+/g, "");
    const own = digits(node?.value);
    if (own) return own;
    const now = digits(node?.getAttribute?.("aria-valuenow"));
    if (now) return now;
    const said = node?.getAttribute?.("aria-valuetext") || "";
    if (/\d/.test(said)) return digits(said);
    try {
      const id = node?.getAttribute?.("data-automation-id") || "";
      if (id) {
        const display = node.parentElement?.querySelector?.(`[data-automation-id="${CSS.escape(id.replace(/-input$/i, "-display"))}"]`);
        const drawn = digits(display?.textContent);
        if (drawn) return drawn;
      }
    } catch {}
    return "";
  }

  /** What a MM / DD / YYYY widget shows, box by box ("" where nothing), or null. */
  function segmentedDateValue(el) {
    const segs = dateSegments(el);
    if (!segs) return null;
    const out = { month: "", day: "", year: "" };
    for (const seg of segs) out[seg.kind] = segmentShown(seg.node);
    return out;
  }

  /**
   * Does the widget show the date that was written?
   *
   * "match" when every box written reads back as its own number, "mismatch"
   * when any of them plainly reads something else (01/01/2000 instead of
   * 10/01/2026), and "unknown" when the widget shows nothing we can read.
   */
  function segmentedDateShows(el, parts) {
    const segs = dateSegments(el);
    if (!segs) return "unknown";
    let seen = 0;
    for (const seg of segs) {
      const want = String(parts[seg.kind] ?? "");
      if (!want) continue;
      const shown = segmentShown(seg.node);
      if (!shown) continue;
      seen++;
      if (Number(shown) !== Number(want)) return "mismatch";
    }
    return seen ? "match" : "unknown";
  }

  /**
   * Does this box show the number `want`, by any of the ways a widget shows
   * one: its value, aria-valuenow, aria-valuetext, or the `…-display` text
   * Workday draws over it? "yes"; "no" when it plainly shows another number;
   * "" when it shows nothing readable.
   */
  function segmentHolds(node, want) {
    const n = Number(String(want ?? "").replace(/\D+/g, ""));
    const digits = (v) => String(v ?? "").replace(/\D+/g, "");
    const seen = [digits(node?.value), digits(node?.getAttribute?.("aria-valuenow"))];
    const said = node?.getAttribute?.("aria-valuetext") || "";
    if (/\d/.test(said)) seen.push(digits(said));
    try {
      const id = node?.getAttribute?.("data-automation-id") || "";
      if (id) {
        const display = node.parentElement?.querySelector?.(`[data-automation-id="${CSS.escape(id.replace(/-input$/i, "-display"))}"]`);
        seen.push(digits(display?.textContent));
      }
    } catch {}
    const readable = seen.filter(Boolean);
    if (!readable.length) return "";
    return readable.some((d) => Number(d) === n) ? "yes" : "no";
  }

  /** The digits one box of the widget takes for `part`: "07", "2026". */
  function segmentText(seg, part) {
    const cap = segmentCap(seg.node, seg.kind);
    return String(part ?? "").replace(/\D+/g, "").padStart(seg.kind === "year" ? 4 : 2, "0").slice(-cap);
  }

  /* ------------------------------------------------------------------ */
  /*  A date widget's own calendar                                       */
  /* ------------------------------------------------------------------ */

  const CALENDAR_MONTHS = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];

  /** A click as a person's arrives: pointer and mouse down and up, then click. */
  function clickLikeUser(node) {
    try { node.scrollIntoView?.({ block: "nearest", inline: "nearest" }); } catch {}
    try { fire(node, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { node.click?.(); } catch {}
  }

  /** The button that opens a MM / DD / YYYY widget's calendar (Workday's `dateIcon`). */
  function calendarButtonFor(segs) {
    const nodes = segs.map((s) => s.node).filter(Boolean);
    if (!nodes.length) return null;
    let box = nodes[0].parentElement;
    while (box && !nodes.every((n) => box.contains(n))) box = box.parentElement;
    for (let d = 0; box && d < 3 && box !== document.body; d++, box = box.parentElement) {
      let icon = null;
      try {
        icon = box.querySelector('[data-automation-id="dateIcon"], [data-automation-id="dateTimeIcon"], ' +
          'button[aria-label*="calendar" i], [role="button"][aria-label*="calendar" i], ' +
          'button[aria-label*="date picker" i], button[aria-label*="choose date" i], button[aria-label*="select date" i]');
      } catch {}
      if (icon && isShowing(icon)) return icon;
    }
    return null;
  }

  const CALENDAR_SELECTOR =
    '[data-automation-id="datePickerSelectedToday"], [data-automation-id*="datePicker" i], [role="dialog"], ' +
    '[role="grid"], [class*="datepicker" i], [class*="date-picker" i], [class*="calendar" i]';

  /** Calendars already on screen, so the one a click opens can be told apart. */
  function calendarsShowing() {
    const out = new Set();
    try { for (const node of document.querySelectorAll(CALENDAR_SELECTOR)) if (isShowing(node)) out.add(node); } catch {}
    return out;
  }

  /**
   * The whole of the calendar `node` belongs to: its own container, never
   * a box that also holds the page's fields (a calendar drawn inside a dialog
   * that holds the application is the calendar, not the dialog).
   */
  function calendarRoot(node) {
    let best = node;
    for (let cur = node; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.matches?.('[data-automation-id="datePicker"]')) return cur;
      let holdsFields = false;
      try { holdsFields = Boolean(cur.querySelector('input:not([type="hidden"]):not([readonly]), textarea')); } catch {}
      if (holdsFields) break;
      best = cur;
      if (cur.matches?.('[role="dialog"], [class*="popup" i], [class*="popover" i], [class*="datepicker" i], [class*="date-picker" i]')) return cur;
    }
    return best;
  }

  /** The calendar that opened since `before`, or null. */
  function newCalendar(before) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(CALENDAR_SELECTOR)); } catch {}
    for (const node of nodes) {
      if (before.has(node) || !isShowing(node)) continue;
      const pop = calendarRoot(node);
      try { if (pop.querySelector('[role="gridcell"], td, button, [role="button"]')) return pop; } catch {}
    }
    return null;
  }

  /** The day of `pop` that is `date`, by what the day says it is ("Thursday, October 1, 2026"). */
  function calendarDay(pop, date) {
    const y = String(date.getFullYear());
    const m = date.getMonth();
    const d = date.getDate();
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const month = new RegExp(`\\b(${CALENDAR_MONTHS[m]}|${CALENDAR_MONTHS[m].slice(0, 3)})\\b`, "i");
    const day = new RegExp(`(^|\\D)0?${d}(\\D|$)`);
    let cells = [];
    try { cells = Array.from(pop.querySelectorAll('[role="gridcell"], [role="button"], button, td, [data-automation-id*="Day" i]')); } catch {}
    for (const cell of cells) {
      if (!isShowing(cell) || cell.disabled || cell.getAttribute("aria-disabled") === "true") continue;
      const said = [cell.getAttribute("aria-label"), cell.getAttribute("title"), cell.getAttribute("data-date"),
        cell.getAttribute("data-value"), cell.getAttribute("datetime")].filter(Boolean).join(" ");
      if (!said) continue;
      if (said.includes(iso)) return cell;
      if (said.includes(y) && month.test(said) && day.test(said.split(y).join(" "))) return cell;
    }
    return null;
  }

  /** The calendar's "next month" (or "previous month") button, or null. */
  function calendarTurn(pop, forward) {
    const word = forward ? /\bnext\b/i : /\b(prev|previous)\b/i;
    try {
      return Array.from(pop.querySelectorAll('button, [role="button"]')).find((b) =>
        isShowing(b) && word.test(`${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.getAttribute("data-automation-id") || ""}`.replace(/([a-z])([A-Z])/g, "$1 $2"))) || null;
    } catch { return null; }
  }

  const CALENDAR_MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december)";

  /**
   * The month the calendar shows, as year * 12 + month (0-based), or null.
   *
   * Read off its days first — each says which day it is ("Thursday, October
   * 1, 2026", or an ISO date), and the month most of them belong to is the one
   * shown (a grid also shows a few days of the months either side) — and off
   * its heading ("October 2026") when the days say nothing.
   */
  function calendarShows(pop) {
    if (!pop) return null;
    const dayRe = new RegExp(`\\b${CALENDAR_MONTH_RE}\\b\\D{0,3}(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})(?!\\d)`, "i");
    const dayFirstRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${CALENDAR_MONTH_RE}\\b,?\\s*(\\d{4})(?!\\d)`, "i");
    const counts = new Map();
    let cells = [];
    try { cells = Array.from(pop.querySelectorAll('[role="gridcell"], [role="button"], button, td')); } catch {}
    for (const cell of cells) {
      const said = [cell.getAttribute("aria-label"), cell.getAttribute("title"), cell.getAttribute("data-date"),
        cell.getAttribute("data-value")].filter(Boolean).join(" ");
      if (!said) continue;
      let at = null;
      let m = said.match(/\b(\d{4})-(\d{2})-\d{2}\b/);
      if (m) at = Number(m[1]) * 12 + Number(m[2]) - 1;
      else if ((m = said.match(dayRe))) at = Number(m[3]) * 12 + CALENDAR_MONTHS.indexOf(m[1].toLowerCase());
      else if ((m = said.match(dayFirstRe))) at = Number(m[3]) * 12 + CALENDAR_MONTHS.indexOf(m[2].toLowerCase());
      if (at != null && Number.isFinite(at)) counts.set(at, (counts.get(at) || 0) + 1);
    }
    let best = null;
    for (const [at, n] of counts) if (best == null || n > counts.get(best)) best = at;
    if (best != null) return best;
    const heading = String(pop.textContent || "").match(new RegExp(`${CALENDAR_MONTH_RE}\\s*(\\d{4})(?!\\d)`, "i"));
    return heading ? Number(heading[2]) * 12 + CALENDAR_MONTHS.indexOf(heading[1].toLowerCase()) : null;
  }

  /**
   * The calendar closed, if picking a day did not close it: Escape, and the
   * calendar button only if it is still open after a moment — a calendar
   * fading out is still on screen, and the button would open it again.
   */
  async function closeCalendar(pop, icon) {
    const open = () => Boolean(pop) && document.contains(pop) && isShowing(pop);
    if (!open()) return;
    const esc = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    try { (document.activeElement || pop).dispatchEvent(new KeyboardEvent("keydown", esc)); } catch {}
    try { if (open()) pop.dispatchEvent(new KeyboardEvent("keydown", esc)); } catch {}
    for (let t = 0; t < 12 && open(); t++) await wait(40);
    if (open() && icon) clickLikeUser(icon);
  }

  /**
   * The date picked from the widget's own calendar.
   *
   * Workday's Available Start Date and self-identification Date come with a
   * calendar button. Picking a day there is how the page itself sets the date,
   * so it lands in the page's model however the boxes treat typing — the boxes
   * showed 01/01/2000, and then nothing, when the date was typed into them.
   * Today is picked with the calendar's own today (`datePickerSelectedToday`);
   * any other day by turning to its month and picking it. If the calendar does
   * not open, or the day cannot be found, it is closed and nothing is chosen.
   */
  async function pickFromCalendar(segs, date) {
    const icon = calendarButtonFor(segs);
    if (!icon) return false;
    const before = calendarsShowing();
    clickLikeUser(icon);
    let pop = null;
    for (let t = 0; t < 20 && !pop; t++) {
      await wait(60);
      pop = newCalendar(before);
    }
    if (!pop) return false;

    const now = new Date();
    const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const todayCell = () => {
      if (!isToday) return null;
      let cell = null;
      try { cell = pop.querySelector('[data-automation-id="datePickerSelectedToday"]'); } catch {}
      return cell && isShowing(cell) ? cell : null;
    };
    const wanted = date.getFullYear() * 12 + date.getMonth();
    let target = null;
    /**
     * Turned to the date's month, the way the calendar's heading says to go.
     * A calendar opened on a date far away (01/01/2000, left in the boxes by
     * an earlier fill) is turned month by month until it gets there.
     */
    for (let turn = 0; turn < 480; turn++) {
      target = todayCell() || calendarDay(pop, date);
      if (target) break;
      // A month that cannot be read is not turned blindly.
      const at = calendarShows(pop);
      if (at == null || at === wanted) break;
      const button = calendarTurn(pop, at < wanted);
      if (!button) break;
      clickLikeUser(button);
      for (let w = 0; w < 16 && document.contains(pop) && calendarShows(pop) === at; w++) await wait(20);
      if (!document.contains(pop)) pop = newCalendar(before);
      if (!pop) return false;
      // The calendar did not move: its button does something else.
      if (calendarShows(pop) === at) break;
    }
    if (!target) {
      await closeCalendar(pop, icon);
      return false;
    }
    clickLikeUser(target);
    await wait(180);
    await closeCalendar(pop, icon);
    return true;
  }

  /** One box, typed a digit at a time, the page rendering between keystrokes. */
  async function typeSegmentSlowly(seg, digits) {
    const { node } = seg;
    const text = segmentText(seg, digits);
    if (!text) return false;
    try { ensureVisible(node); } catch {}
    try { fire(node, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    takeFocusAnnounced(node);
    clearSegment(node);
    await wait(20);
    for (const ch of text) {
      if (!holdsFocus(node)) takeFocusAnnounced(node);
      typeDigit(node, ch);
      await wait(35);
    }
    // A widget that took the keystrokes into a buffer of its own shows the
    // number already; anything else gets the number written in.
    if (segmentHolds(node, text) !== "yes" && String(node.value ?? "") !== text && !node.readOnly) {
      try {
        const writer = nativeSetter(node);
        if (writer) writer.call(node, text); else node.value = text;
        const tracker = node._valueTracker;
        if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
        fire(node, "input", "change");
      } catch {}
      await wait(20);
    }
    return true;
  }

  /** One box, its number set outright — the way other fillers do it. */
  async function setSegmentOutright(seg, digits) {
    const { node } = seg;
    const text = segmentText(seg, digits);
    if (!text || node.readOnly) return false;
    takeFocusAnnounced(node);
    try {
      const writer = nativeSetter(node);
      if (writer) writer.call(node, text); else node.value = text;
      const tracker = node._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
      node.dispatchEvent(new InputEvent("input", { data: text, inputType: "insertText", bubbles: true }));
    } catch {
      try { fire(node, "input"); } catch {}
    }
    fire(node, "change");
    leaveLikeUser(node);
    await wait(90);
    return true;
  }

  /**
   * A whole date written into a MM / DD / YYYY widget, and checked afterwards.
   *
   * 1. Picked from the widget's own calendar, when it has one
   *    (`pickFromCalendar`): today with the calendar's today, any other day
   *    from its month. That is the page setting its own date.
   * 2. Typed into each box as a person types: the box entered, each digit a
   *    whole keystroke with the page rendering in between, the box left for
   *    the next one, and the widget left at the end.
   * 3. Typed into each box in one go (how dates were written before).
   * 4. Set outright.
   *
   * Every box is read back after each step, and only boxes still wrong are
   * tried again. Nothing presses the arrow keys: from an empty box, Workday's
   * ArrowUp turns the box to its first value — 01, 01 and 2000 — which is the
   * 01/01/2000 that kept appearing. A widget that will not show the date is
   * reported as not filled, so it is outlined for the applicant.
   *
   * Returns true when every box shows its number.
   */
  async function setSegmentedDateAsync(el, value) {
    const raw = String(value ?? "").trim();
    if (!raw) return false;
    const segs = dateSegments(el);
    if (!segs) return false;
    if (/^\d{1,4}$/.test(raw)) return setSegmentedDate(el, raw);

    const parts = dateParts(raw);
    if (!parts || !parts.year) return false;
    const order = { month: 0, day: 1, year: 2 };
    const kinds = [...segs].sort((a, b) => order[a.kind] - order[b.kind]).map((s) => s.kind).filter((k) => parts[k]);
    // The widget may have drawn its boxes again since the last one.
    const current = () => (document.contains(el) ? dateSegments(el) : null) || segs;
    const segOf = (kind) => current().find((s) => s.kind === kind) || segs.find((s) => s.kind === kind);
    const holds = (kind) => {
      const seg = segOf(kind);
      return seg && document.contains(seg.node) ? segmentHolds(seg.node, parts[kind]) : "";
    };
    const pending = () => kinds.filter((k) => holds(k) !== "yes");
    /**
     * The caret leaves the widget — whichever box holds it, since the widget
     * moves it on by itself once a box is full — and then the boxes are read.
     * A widget checks, and may redraw, the date only once the caret has left.
     */
    const settled = async () => {
      await wait(30);
      const active = current().find((s) => holdsFocus(s.node))?.node;
      if (active) leaveLikeUser(active);
      for (let t = 0; t < 8; t++) {
        await wait(30);
        if (!pending().length) return true;
      }
      return !pending().length;
    };

    // 1. The widget's own calendar.
    if (parts.month && parts.day && calendarButtonFor(current())) {
      const date = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
      // A date of another month already in the boxes is taken out first, so the
      // calendar opens on this month rather than on that date's (01/01/2000 is
      // 321 months back). Where it cannot be taken out, the calendar is turned.
      const shownNow = Object.fromEntries(current().map((s) => [s.kind, segmentShown(s.node)]));
      const otherMonth = Object.values(shownNow).some(Boolean) &&
        !(Number(shownNow.month) === Number(parts.month) && Number(shownNow.year) === Number(parts.year));
      if (otherMonth) {
        for (const seg of current()) {
          try { takeFocusAnnounced(seg.node); clearSegment(seg.node); } catch {}
        }
        const last = current().find((s) => holdsFocus(s.node))?.node;
        if (last) leaveLikeUser(last);
        await wait(60);
      }
      let picked = false;
      try { picked = await pickFromCalendar(current(), date); } catch {}
      if (picked && await settled()) return true;
    }

    // 2. Typed as a person types.
    for (const kind of pending()) {
      const seg = segOf(kind);
      if (!seg || !document.contains(seg.node)) continue;
      try { await typeSegmentSlowly(seg, parts[kind]); } catch {}
      await wait(40);
    }
    if (await settled()) return true;

    // 3. Typed into each box in one go.
    try { setSegmentedDate(el, raw); } catch {}
    if (await settled()) return true;

    // 4. Set outright.
    for (const kind of pending()) {
      const seg = segOf(kind);
      if (!seg || !document.contains(seg.node)) continue;
      try { await setSegmentOutright(seg, parts[kind]); } catch {}
    }
    return settled();
  }

  function setTextValue(el, value, { keepFocus = false } = {}) {
    const text = String(value ?? "");
    if (!text) return false;

    // Only something that takes typing is typed into. See `isFormControl`:
    // "typing" at a container sent the text to whichever box had the caret.
    if (!acceptsText(el)) return false;

    // A date split across MM / DD / YYYY boxes is written segment by segment.
    if (setSegmentedDate(el, text)) return true;

    const cap = maxLengthOf(el);
    if (cap && text.length > cap) return false;

    ensureVisible(el);
    // With the popup open the page is told nothing; see `takeFocusAnnounced`.
    const focused = takeFocusAnnounced(el);

    let changed = false;
    const previous = String(el.value ?? "");
    const setter = nativeSetter(el);
    const isRichEditor = el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";

    /**
     * Type it, rather than assign it.
     *
     * `execCommand("insertText")` runs through the browser's own editing
     * pipeline, so the page receives the same native `beforeinput` and `input`
     * events a person's keystrokes produce. Assigning `.value` and dispatching
     * synthetic events does not: the text appears, but Workday's model never
     * records it, and pressing Next reports "The field First Name is required
     * and must have a value" under a box plainly containing a name.
     *
     * The giveaway was which fields failed. Every dropdown committed — State,
     * Phone Device Type — and every required *text* box did not. Dropdowns are
     * answered by clicking, which is already a real interaction. Text boxes were
     * the only things being written by assignment.
     *
     * This was already here as a fallback, reached only when assignment failed
     * to change the value. Assignment always succeeded, so it never ran.
     */
    // Only while this box holds the caret: the command types into whatever is
    // focused, and on a background tab or a control that cannot take focus
    // that is somebody else's field. The setter below needs no focus at all.
    if (!isRichEditor && focused) {
      try {
        const length = String(el.value ?? "").length;
        el.setSelectionRange?.(0, length);
        if (!length && typeof el.select === "function") el.select();
        if (holdsFocus(el) && document.execCommand && document.execCommand("insertText", false, text)) {
          changed = String(el.value ?? "") === text;
        }
      } catch {}
    }

    if (!changed) {
      try {
        if (isRichEditor) {
          el.textContent = text;
          changed = clean(el.textContent) === clean(text);
        } else if (setter) {
          setter.call(el, text);
          changed = String(el.value ?? "") === text;
        } else {
          el.value = text;
          changed = String(el.value ?? "") === text;
        }
      } catch {}
    }

    if (!changed && typeof el.setRangeText === "function") {
      try {
        const current = String(el.value ?? "");
        el.setSelectionRange?.(0, current.length);
        el.setRangeText(text, 0, current.length, "end");
        changed = String(el.value ?? "") === text;
      } catch {}
    }

    // React keeps the last value it knows about in a tracker on the node and
    // drops any change event that agrees with it. Normally writing through the
    // prototype setter is enough to leave that tracker stale — but if anything
    // has re-synced it, onChange never fires, the framework's model stays empty,
    // and the applicant sees the text on screen while the page insists the field
    // is required. Resetting it makes the change unmissable.
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(previous);
    } catch {}

    // Key events bracket the input for the same reason they do in
    // `retypeValue`: Workday will not consider a field answered until it has
    // seen keyboard activity on it, whatever the box contains.
    //
    // `change` is deliberately not in that list. `execCommand("insertText")`
    // leaves the control dirty in the browser's own bookkeeping, so blurring it
    // a moment later makes the *browser* fire `change` — and firing one here as
    // well committed every value twice. Identical values are harmless in a text
    // box, but a site that reacts to `change` by re-rendering or firing a
    // lookup did all of it twice per field. The synthetic one is kept as a
    // fallback for the case where nothing native arrives, which is what happens
    // when the control could not take focus.
    let committed = false;
    const noteCommit = () => { committed = true; };
    try { el.addEventListener("change", noteCommit, true); } catch {}

    fire(el, "keydown", "beforeinput", "input", "keyup");
    /**
     * A type-to-search box keeps the caret.
     *
     * Its suggestions are only shown — and on Oracle its text only kept — while
     * the box has focus: Oracle throws away text that was never picked from its
     * list the moment the box loses focus ("Select a value from the list"), and
     * a suggestion list closes on blur. Blurring straight after typing emptied
     * City before its list ever arrived, and left Lever's location box with
     * nothing to pick from. The caller blurs once it has picked.
     */
    if (keepFocus && holdsFocus(el)) {
      try { el.removeEventListener("change", noteCommit, true); } catch {}
      const kept = String(el.value ?? "");
      return kept === text || norm(kept) === norm(text);
    }
    // A blur is what commits the value on most ATS validators, but stealing
    // focus back afterwards is what made the page jitter. Blur once, silently.
    if (blurHeard(el)) {
      fire(el, "blur");
      if (!committed) fire(el, "change");
    } else {
      /**
       * The browser told the page nothing: the fill was started from the
       * popup, so the page does not have the focus (see `takeFocusAnnounced`).
       * The box is left the way a person leaves it — change, blur, focusout —
       * because focusout is the only one React reads as the box being left, and
       * leaving it is when Workday's name and address boxes, and Ashby's Name,
       * keep what was typed.
       */
      if (!committed) fire(el, "change");
      fire(el, "blur", "focusout");
    }
    try { el.removeEventListener("change", noteCommit, true); } catch {}

    const isRich = el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";
    const settled = isRich ? clean(el.textContent) : String(el.value ?? "");
    if (isRich ? settled === clean(text) : settled === text) return true;

    /**
     * The field ended up holding something other than what was written.
     *
     * On Oracle Recruiting this was not a failed write but an *appended* one:
     * the box kept its old contents and gained the new value on the end, over
     * and over, producing ".WashingtonWashingtonMy address is in Bellevue…" in
     * a Suffix box capped at 80 characters, and the street, ZIP, city and state
     * run together in Address Line 3. Whatever the page is doing to cause it —
     * a typeahead that re-inserts at the caret, a component that echoes its own
     * model back — the result is the same and the applicant then has to find and
     * clear every one of them by hand.
     *
     * So: one clean retry through an explicit empty transition, and if the field
     * still will not hold exactly the intended value it is emptied rather than
     * left holding a concatenation. An empty box is a box the applicant can see
     * is theirs to fill. A corrupted one looks answered.
     */
    const contaminated =
      settled.length > text.length && (settled.includes(text) || (previous && settled.includes(previous)));

    try {
      const writer = nativeSetter(el);
      const put = (v) => { if (isRich) el.textContent = v; else if (writer) writer.call(el, v); else el.value = v; };
      put("");
      fire(el, "input");
      put(text);
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
      fire(el, "beforeinput", "input", "change", "blur", "focusout");

      const after = isRich ? clean(el.textContent) : String(el.value ?? "");
      if (isRich ? after === clean(text) : after === text) return true;

      if (contaminated || after.length > text.length) {
        put("");
        fire(el, "input", "change", "blur");
      }
    } catch {}

    return false;
  }

  /**
   * Write a value a second time, through a transition the page cannot ignore.
   *
   * A framework that keeps a record of the last value it saw will drop a change
   * event that agrees with that record. Clearing the field first and writing
   * again produces two unmistakable transitions — something to empty, empty to
   * the value — so there is nothing for it to dedupe against. Used only where
   * the page has told us it is unhappy, because it costs an extra round of
   * events per field.
   */
  function retypeValue(el, value) {
    const text = String(value ?? "");
    if (!text) return false;
    if (!acceptsText(el)) return false;

    // A segmented date is rewritten segment by segment; retyping the whole
    // string at one segment is what produced "Invalid Date: /2019".
    if (setSegmentedDate(el, text)) return true;

    ensureVisible(el);
    const focused = takeFocusAnnounced(el);

    const setter = nativeSetter(el);
    const write = (next) => {
      try {
        if (setter) setter.call(el, next); else el.value = next;
        const tracker = el._valueTracker;
        if (tracker && typeof tracker.setValue === "function") {
          tracker.setValue(next === "" ? text : "");
        }
      } catch {}
    };

    // Same reasoning as `setTextValue`: type it through the editing pipeline
    // first, because that is what Workday's model actually listens to.
    let typed = false;
    if (focused) {
      try {
        el.setSelectionRange?.(0, String(el.value ?? "").length);
        if (holdsFocus(el) && document.execCommand && document.execCommand("insertText", false, text)) {
          typed = String(el.value ?? "") === text;
        }
      } catch {}
    }

    if (!typed) {
      write("");
      fire(el, "input");
      write(text);
    }
    /**
     * Key events either side of the input.
     *
     * Workday takes its value from `input` but only treats a field as *touched*
     * once it has seen keyboard activity, and an untouched field is reported
     * empty by its validator however much text is in the box. That is the
     * "Azure DevOps Engineer" sitting under "The field Job Title is required
     * and must have a value" — the text was there, the field had never been
     * typed in, and the model stayed empty.
     */
    fire(el, "keydown", "keypress", "beforeinput", "input", "keyup", "change");
    try { el.blur?.(); } catch {}
    fire(el, "blur", "focusout");
    return String(el.value ?? "") === text;
  }

  /** Has the page itself marked this control as unacceptable? */
  /**
   * Is the page complaining about this field?
   *
   * Only `aria-invalid` and `aria-describedby` were checked. Workday marks
   * neither: it renders the message as a sibling node inside the field's
   * wrapper, so "The field Job Title is required and must have a value" sat
   * under a box containing "Azure DevOps Engineer" and nothing here noticed.
   * The retype that would have committed the value therefore never ran.
   */
  /**
   * Does the page insist on an answer here?
   *
   * Checked three ways because portals mark it differently: the native
   * attribute, the ARIA one, and — Workday's way — an asterisk rendered next to
   * the label with no attribute at all.
   */
  function isRequired(el) {
    try {
      if (el.required === true) return true;
      if (el.getAttribute?.("aria-required") === "true") return true;
      // An ADP SDF component says it on the element; a box drawn inside one, on
      // the element around it.
      if (/^SDF-/.test(el.tagName || "") && el.hasAttribute?.("required")) return true;
      if (adpShadowHost(el)) {
        const host = pageHost(el);
        if (host && host !== el && isRequired(host)) return true;
      }
      // A row of choices says it on the row.
      if (el.closest?.('[role="listbox"], [role="radiogroup"], [role="group"]')?.getAttribute("aria-required") === "true") return true;
      const described = `${el.getAttribute?.("aria-labelledby") || ""} ${el.getAttribute?.("aria-describedby") || ""}`.trim();
      for (const id of described.split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (node && /\*|\brequired\b/i.test(node.textContent || "")) return true;
      }
      let node = el.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (node.querySelectorAll?.("input, select, textarea").length > 1) break;
        // ADP's components keep their boxes inside themselves: a block holding
        // two of them holds two questions, and its first label is not this one's.
        if (node.querySelectorAll?.(SDF_CONTROL_TAGS).length > 1) break;
        const label = node.querySelector?.("label, legend");
        if (label && /\*|\brequired\b/i.test(label.textContent || "")) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function flaggedInvalid(el) {
    try {
      if (el.getAttribute?.("aria-invalid") === "true") return true;
      /**
       * Only a message the applicant can see.
       *
       * Oracle keeps "This field is required." in the page under every box,
       * hidden until it applies. Read regardless of whether it showed, it made
       * every Oracle box look rejected — and the repair that follows retyped
       * Address Line 1 over the address suggestion just picked, opening the
       * suggestion list again over the form.
       */
      const shows = (node) => {
        if (!isShowing(node)) return false;
        const r = node.getBoundingClientRect?.();
        return Boolean(r && r.width > 0 && r.height > 0);
      };
      const described = el.getAttribute?.("aria-describedby");
      if (described) {
        for (const id of described.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node && shows(node) && /\brequired\b|\berror\b|\binvalid\b/i.test(node.textContent || "")) return true;
        }
      }

      // Workday, Oracle and iCIMS all render the message near the field rather
      // than linking it. Walk up a few levels and look for an error node that
      // belongs to this control and no other.
      let node = el.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if (node.querySelectorAll?.("input, select, textarea").length > 1) break;
        const errors = node.querySelectorAll?.(
          '[data-automation-id*="error" i], [id*="error" i], [class*="error" i], [role="alert"], [aria-live="assertive"]'
        );
        for (const err of errors ?? []) {
          const text = err.textContent || "";
          if (/\b(is required|must have a value|invalid|enter a (valid|maximum)|cannot be blank)\b/i.test(text) && shows(err)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Native <select>                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Is this choice a prompt rather than an answer?
   *
   * Portals decorate their prompts: iCIMS writes "— Make a Selection —" with em
   * dashes, and a dropdown that depends on another one reads "Please select a
   * country" until its parent is answered. A regex anchored on bare words
   * matched none of those, so an unanswered Country box looked filled — and
   * under the never-overwrite rule that meant it was skipped entirely.
   */
  function isPlaceholderChoice(text, hint = "") {
    const t = normalizeChoiceText(text)
      .replace(/[‒-―−]/g, "-")          // figure / en / em dash, minus sign
      .replace(/^[\s\-_*.·•>«]+|[\s\-_*.·•<»]+$/g, "")
      .replace(/\.{2,}$/, "")
      .trim();
    if (!t) return true;
    if (/^(?:month|year|day|mm|dd|yyyy)$/.test(t) && /\b(?:date|month|year|day|mm|dd|yyyy)\b/i.test(hint)) return true;
    if (/^(n\/a|n a|na|not applicable)$/.test(t) && /\b(?:enter|indicate|type|write|use|put|provide)\b[^|]{0,50}(?:n\s*\/\s*a|not applicable)\b/i.test(hint)) return false;
    if (/^(n\/a|na|none|nil)$/.test(t) && /\b(?:security\s*clearance|clearance\s*(?:level|status|type))\b/i.test(hint)) return false;
    if (/^(n\/a|na|none|null|nil|no\s+selection|not\s+selected)$/.test(t)) return true;
    if (/^(type\s+to\s+search|start\s+typing|search)$/.test(t)) return true;
    return /^(please\s+)?(select|specify|choose|pick|make\s+a\s+selection)\b/.test(t);
  }

  // Kept as a callable for older call sites that expect a regex-like `.test`.
  const PLACEHOLDER_RE = { test: (value) => isPlaceholderChoice(value) };

  /** Synonyms keyed by the exact answer, matched without regard to case. */
  /**
   * Score a value against a synonym ladder, respecting its order.
   *
   * tieredScore takes the best match across the whole list, so every synonym
   * that matched exactly scored the same and the winner came down to which
   * option the page happened to list first. A list offering both "Job Board"
   * and "Social Media" therefore answered LinkedIn with "Job Board".
   *
   * Position now costs a little, so a rule can state its preference: the
   * closest description of the real answer goes first.
   */
  function rankedSynonymScore(text, val, list, ladder) {
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const raw = tieredScore(text, val, [list[i]], ladder);
      if (!raw) continue;
      const adjusted = raw - Math.min(i, 12);
      if (adjusted > best) best = adjusted;
    }
    return best;
  }

  function synonymsFor(synonyms, value) {
    if (!synonyms || typeof synonyms !== "object") return [];
    const direct = synonyms[value] ?? synonyms[String(value)];
    if (Array.isArray(direct)) return direct;
    const want = norm(value);
    for (const key of Object.keys(synonyms)) {
      if (norm(key) === want && Array.isArray(synonyms[key])) return synonyms[key];
    }
    return [];
  }

  const isStudyQuestion = (hint) => /\b(?:major|field\s*of\s*study|discipline|concentration|area\s*of\s*study)\b/i.test(String(hint || "").split("|")[0]);
  function studyText(value) {
    let text = String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    text = text.replace(/^(?:bachelor|master)(?: s)?(?: of (?:science|arts|engineering))?(?: degree)?(?: in)?\s+/i, "")
      .replace(/^(?:b\s*tech|m\s*tech|bsc|msc|bs|ms|ba|ma)\s+(?:in\s+)?/i, "");
    const aliases = {cs:"computer science",cse:"computer science engineering",it:"information technology",ece:"electronics communication engineering",eee:"electrical electronics engineering",ee:"electrical engineering",mis:"management information systems",mba:"business administration",bba:"business administration"};
    return (aliases[text] || text).replace(/\bsciences\b/g,"science").replace(/\bcommunications\b/g,"communication").replace(/\bmathematics\b/g,"math").replace(/\band\b/g," ").replace(/\s+/g," ").trim();
  }
  const STUDY_FAMILIES = [
    ["Computer Science", /\bcomputer\s+(?:(?:and\s+)?information\s+)?science|\bcomputing\b/],
    ["Computer Engineering", /\bcomputer\s+engineering\b/],
    ["Information Technology", /\binformation\s+technolog/],
    ["Information Systems", /\binformation\s+systems?\b/],
    ["Electronics and Communication Engineering", /\belectronics?\s+(?:and\s+)?communication/],
    ["Electrical Engineering", /\belectrical\b/],
    ["Mechanical Engineering", /\bmechanical\b/],
    ["Civil Engineering", /\bcivil\b/],
    ["Chemical Engineering", /\bchemical\s+engineering\b/],
    ["Business Administration", /\bbusiness\s+(?:administration|management)\b/],
    ["Data Science", /\bdata\s+(?:science|analytics)\b/],
    ["Accounting", /\baccount(?:ing|ancy)\b/],
    ["Finance", /\bfinanc/], ["Nursing", /\bnurs/], ["Medicine", /\bmedicin|\bmedical\b/],
    ["Mathematics", /\bmath\b/], ["Physics", /\bphysics\b/], ["Biology", /\bbiolog/],
  ];
  function studyChoiceScore(option, profileValue) {
    const a=studyText(profileValue), b=studyText(option);
    if (!a || !b || /^(?:other|not listed|none|select.*|choose.*)$/.test(b)) return 0;
    if (a===b) return 140;
    const fa=STUDY_FAMILIES.filter(([,re])=>re.test(a)).map(([name])=>name);
    const fb=STUDY_FAMILIES.filter(([,re])=>re.test(b)).map(([name])=>name);
    const related = {
      "Computer Science":{"Computer Engineering":90,"Information Technology":85,"Information Systems":82,"Data Science":88},
      "Computer Engineering":{"Computer Science":90,"Electrical Engineering":85,"Information Technology":78},
      "Information Technology":{"Information Systems":94,"Computer Science":90,"Computer Engineering":78,"Data Science":83},
      "Information Systems":{"Information Technology":94,"Computer Science":86,"Business Administration":72},
      "Data Science":{"Computer Science":90,"Mathematics":88,"Information Technology":80},
      "Electronics and Communication Engineering":{"Electrical Engineering":94,"Computer Engineering":77},
      "Electrical Engineering":{"Electronics and Communication Engineering":94,"Computer Engineering":80},
    };
    if (fa.length && fb.length && !fa.some(name=>fb.includes(name))) return Math.max(0,...fa.flatMap(from=>fb.map(to=>related[from]?.[to] || 0)));
    const words=t=>new Set(t.split(/\s+/).filter(w=>! /^(?:and|of|in|the|degree|general|studies|engineering|science|technology|applied)$/.test(w)));
    const A=words(a), B=words(b);let shared=0;for(const w of A)if(B.has(w))shared++;
    const overlap=shared/Math.max(A.size,B.size,1);
    if (fa.some(name=>fb.includes(name))) return 105+Math.round(overlap*20)-Math.min(10,Math.abs(A.size-B.size));
    if (!shared || overlap<0.6) return 0;
    return 65+Math.round(overlap*25);
  }
  function studySearchTerms(value) {
    const text=studyText(value);
    const family=STUDY_FAMILIES.find(([,re])=>re.test(text));
    return [...new Set([family?.[0]?.split(" ")[0],family?.[0],text,String(value || "")].filter(Boolean))];
  }

  function setSelectValue(el, value, synonyms, hint, context = null) {
    if (value === undefined || value === null || String(value).trim() === "") return false;
    const options = Array.from(el.options ?? []);
    if (!options.length) return false;

    const want = normalizeChoiceText(value);
    const rawWant = norm(value);
    const accepted = synonymsFor(synonyms, value).map(normalizeChoiceText).filter(Boolean);
    const primary = [want, rawWant].filter(Boolean);
    const wantId = eeoId(value, hint);
    const place = context?.place ? wantedPlace(value, context.placeHint) : null;

    // A menu of states, or a Yes/No menu, is answered on meaning alone.
    const strict = place ? options.map((o) => placeScore(o.textContent || "", place)) : wantId ? null : strictChoiceScores(
      options.map((o) => o.textContent || ""), value, options.map((o) => o.value || "")
    );
    const strictScore = strict ? new Map(options.map((o, i) => [o, strict[i]])) : null;

    const score = (opt) => {
      const text = normalizeChoiceText(opt.textContent);
      const val = normalizeChoiceText(opt.value);
      if (!text && !val) return 0;
      if (opt.disabled || isPlaceholderChoice(text, hint)) return 0;
      if (isStudyQuestion(hint)) return studyChoiceScore(opt.textContent || opt.value, value);

      // Voluntary-disclosure answers must land on the same branch or nowhere,
      // and among options on the right branch the closest wording wins rather
      // than whichever the portal happened to list first.
      if (wantId) {
        const optId = eeoId(opt.textContent, hint) || eeoId(opt.value, hint);
        if (optId) return optId === wantId ? eeoBranchScore(opt.textContent || opt.value, value) : 0;
      }
      if (strictScore) return strictScore.get(opt) ?? 0;

      // The stored answer outranks anything it is merely a synonym of. A rule
      // may map "LinkedIn" onto the category "Job Board" for portals that only
      // offer categories — but where the list actually contains "LinkedIn",
      // that is the answer, and the category must not win the tie.
      return Math.max(
        tieredScore(text, val, primary, { exact: 130, prefix: 95, contains: 78, fuzzy: 70 }),
        rankedSynonymScore(text, val, accepted, { exact: 100, prefix: 74, contains: 70, fuzzy: 55 })
      );
    };

    let best = null, bestScore = 0;
    options.forEach((opt) => {
      const sc = score(opt);
      if (sc > bestScore) { bestScore = sc; best = opt; }
    });
    if (place && best && options.some((opt) => opt !== best && score(opt) === bestScore &&
        distinctPlaces(opt.textContent, best.textContent))) return false;
    if (!best || bestScore < 55) return false;
    if (isStudyQuestion(hint) && options.some(o=>o!==best && score(o)===bestScore && studyText(o.textContent)!==studyText(best.textContent))) return false;

    try { el.focus?.({ preventScroll: true }); } catch {}
    try {
      const setter = nativeSetter(el);
      if (setter) setter.call(el, best.value);
      else el.value = best.value;
      if (el.value !== best.value) el.selectedIndex = best.index;
    } catch { return false; }

    notifyWidget(el);
    // Several ATS validators only clear a "required" message on blur. Blur is
    // safe here because nothing takes focus back afterwards.
    try { el.blur?.(); } catch {}

    const selected = el.options?.[el.selectedIndex];
    return Boolean(selected) &&
      !isPlaceholderChoice(selected.textContent, hint) &&
      (normalizeChoiceText(selected.textContent) === normalizeChoiceText(best.textContent) ||
       normalizeChoiceText(selected.value) === normalizeChoiceText(best.value));
  }

  /* ------------------------------------------------------------------ */
  /*  Radio groups                                                       */
  /* ------------------------------------------------------------------ */

  /** Is this node a choice control in its own right, or does it wrap one? */
  function isChoiceControl(node) {
    if (!node || node.nodeType !== 1) return false;
    const role = node.getAttribute?.("role");
    const type = (node.type || "").toLowerCase();
    if (role === "radio" || role === "checkbox") return true;
    if (node.tagName === "INPUT" && (type === "radio" || type === "checkbox")) return true;
    try {
      return Boolean(node.querySelector?.('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
    } catch { return false; }
  }

  function radioOptionText(radio) {
    if (!radio) return "";
    // A segmented button carries its option text directly. Falling through to
    // the sibling scan below would pick up the *other* choice as well.
    if (isChoiceButton(radio)) {
      return clean(visibleText(radio) || radio.getAttribute("aria-label") || "");
    }

    /**
     * A control that carries its own label is answered from itself.
     *
     * `<div role="radio">Prefer not to say</div>` holds its option text
     * directly, but the scan below went straight to the siblings — which for an
     * ARIA radiogroup are *the other options* — and then took the shortest
     * candidate. So picking "Prefer not to say" was recorded as "No", because
     * "No" was the shortest text among its neighbours. An element's own text is
     * checked first and wins outright.
     */
    if (radio.tagName !== "INPUT") {
      const own = visibleText(radio);
      if (own && own.length <= 240) return own;
    }

    /**
     * An input drawn by its label (Oracle's 0 x 0 radios and boxes) is that
     * label, and only that. Its siblings are the other options' labels — and
     * taking the shortest candidate read the "Yes" radio as "No", so a No
     * answer ticked Yes. Only for an input the page does not show itself, and
     * only the choice's own label: a question whose `<label for>` names its
     * first choice is that choice's label too, and is not the choice.
     */
    const drawnBy = !isFillable(radio) ? choiceOwnLabel(radio) : null;
    if (drawnBy) {
      const own = visibleText(drawnBy);
      if (own && own.length <= 240) return own;
    }

    const candidates = [];
    const add = (node) => {
      if (!node) return;
      const t = visibleText(node);
      if (t && t.length <= 240 && !candidates.includes(t)) candidates.push(t);
    };

    if (radio.id) {
      try { document.querySelectorAll(`label[for="${CSS.escape(radio.id)}"]`).forEach(add); } catch {}
    }
    add(radio.closest("label"));
    const aria = radio.getAttribute("aria-label");
    if (aria) candidates.push(clean(aria));

    // Older ADP pages print the option directly after the input, without a
    // label element. Stop at the next choice or line break, before the racial
    // definition or neighbouring option can become this option's name.
    if (!candidates.length && radio.tagName === "INPUT") {
      const pieces = [];
      for (let node = radio.nextSibling; node; node = node.nextSibling) {
        if (node.nodeType === 1 && (isChoiceControl(node) || node.tagName === "BR" ||
            /^(?:DIV|P|TABLE|TR|TD|UL|LI)$/.test(node.tagName))) break;
        const text = clean(node.textContent);
        if (text) pieces.push(text);
        if (pieces.join(" ").length > 240) break;
      }
      const adjacent = clean(pieces.join(" "));
      if (adjacent && adjacent.length <= 240) return adjacent;
    }

    // Siblings are only a label source when they are not themselves options.
    // Without this guard a bare `<input>` sitting beside its peers collected
    // every other choice in the group as a candidate for its own text.
    const parent = radio.parentElement;
    if (parent) {
      Array.from(parent.children || [])
        .filter((n) => n !== radio && !isChoiceControl(n))
        .forEach((n) => {
          const t = visibleText(n);
          if (t && t.length <= 160) candidates.push(t);
        });
    }

    let sib = radio.nextElementSibling;
    for (let i = 0; sib && i < 2; i++, sib = sib.nextElementSibling) {
      if (isChoiceControl(sib)) break;
      const t = visibleText(sib);
      if (t && t.length <= 160) candidates.push(t);
    }

    return candidates.map(clean).filter(Boolean).sort((a, b) => a.length - b.length)[0] || "";
  }

  function choiceScore(optionText, optionValue, target, hint) {
    const label = norm(optionText);
    const val = norm(optionValue);
    const want = norm(target);
    if ((!label && !val) || !want) return 0;

    const wantId = eeoId(want, hint);
    if (wantId) {
      const optId = eeoId(label, hint) || eeoId(val, hint);
      if (optId) return optId === wantId ? eeoBranchScore(label || val, want) : 0;
    }

    if (label === want || val === want) return 115;
    // Whole words only: "no" is not in "None of the above" or "I do not know".
    if (label && containsAtWord(label, want)) return 75;
    if (val && containsAtWord(val, want)) return 70;

    const tokens = want.split(/\W+/).filter((x) => x.length > 2);
    if (!tokens.length) return 0;
    const hits = tokens.filter((t) => containsAtWord(label, t) || containsAtWord(val, t)).length;
    return hits === tokens.length ? 65 : 0;
  }

  /**
   * Runs a real click and only synthesises input/change if the click did not
   * already produce one.
   *
   * Clicking a <label for> checks its radio and the browser fires `change`
   * itself; firing another one afterwards ran the site's handler twice for a
   * single answer — a double write the user sees as the option blinking.
   */
  /**
   * Would clicking this open the operating system's file chooser?
   *
   * Choice controls are answered by clicking, and a `<label>` is clicked when
   * the input itself will not take one. If that label happens to be bound to a
   * file input — which on an application page means the résumé box — the click
   * opens a native file dialog over the form. The applicant did not ask to
   * upload anything; they asked for the form to be filled in.
   *
   * Nothing here ever needs to open that dialog: an attachment is set through
   * DataTransfer, never through a picker. So any click that would reach a file
   * input is refused outright.
   */
  function opensFilePicker(el) {
    try {
      if (!el) return false;
      if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "file") return true;
      if (el.querySelector?.('input[type="file" i]')) return true;
      const bound = el.getAttribute?.("for");
      if (bound) {
        const target = document.getElementById(bound);
        if (target?.tagName === "INPUT" && String(target.type).toLowerCase() === "file") return true;
      }
      if (el.tagName === "LABEL" && el.control?.type === "file") return true;
      return false;
    } catch {
      return false;
    }
  }

  function clickCommitting(el, action) {
    if (opensFilePicker(el)) return false;
    let sawChange = false;
    const onChange = () => { sawChange = true; };
    el.addEventListener("change", onChange, true);
    try { action(); } finally { el.removeEventListener("change", onChange, true); }
    if (!sawChange) fire(el, "input", "change");
    return sawChange;
  }

  /* ------------------------------------------------------------------ */
  /*  Segmented choice buttons (Yes | No)                                */
  /* ------------------------------------------------------------------ */

  /**
   * The sibling buttons of a segmented choice control, or null.
   *
   * A great many portals render a yes/no question as two plain <button>s rather
   * than radios. The engine only ever accepted a button when it opened a menu,
   * so these were not collected, not filled, and not even reported as needing an
   * answer — the applicant saw an unfilled question and a status pill that did
   * not mention it. This is what "did not answering other fields" refers to.
   *
   * Kept deliberately strict: a small set of siblings, each with short, distinct
   * text, none of them a form action, and none of them a dropdown trigger.
   */
  /**
   * Also the "pills" of Oracle Recruiting, which draws every list of ten or
   * fewer values — Title, and each Yes/No question — as a row of buttons, in
   * more than one shape: option buttons in a listbox, each in its own <li>;
   * plain buttons, each in its own wrapper; radio buttons beside a hidden
   * input. Only bare sibling buttons with nothing else beside them used to
   * count, so none of Oracle's questions was collected, answered or reported.
   */
  const CHOICE_ACTION_RE =
    /^(submit|next|back|previous|continue|save|cancel|close|upload|browse|add|remove|delete|edit|apply now|apply|sign in|sign up|log in|search|clear|reset|done|ok)\b/i;
  const CHOICE_MAX = 10;
  const INTERACTIVE_SELECTOR =
    'button, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="combobox"], [role="tab"], ' +
    'a[href], input:not([type="hidden"]), select, textarea, [contenteditable="true"]';

  /**
   * A listbox that is part of the form, not a drop-down's menu.
   *
   * Oracle's pills are a `role="listbox"` that is always on screen. A menu's
   * listbox is owned by the box that opened it, floats over the page, or is
   * long; none of those is a question's row of answers.
   */
  function inlineListbox(el) {
    const list = el?.closest?.('[role="listbox"]');
    if (!list) return null;
    if (list.getAttribute("aria-multiselectable") === "true") return null;
    try {
      if (list.id) {
        const id = CSS.escape(list.id);
        const owner = document.querySelector(`[aria-controls~="${id}"], [aria-owns~="${id}"]`);
        if (owner && !list.contains(owner)) return null;
      }
      let node = list;
      for (let d = 0; node && d < 4 && node !== document.body; d++, node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === "absolute" || position === "fixed") return null;
        if (node !== list && node.matches?.('[role="dialog"], [role="menu"], [class*="popover" i], [class*="dropdown-menu" i]')) return null;
      }
    } catch { return null; }
    const options = list.querySelectorAll('[role="option"]');
    if (options.length < 2 || options.length > CHOICE_MAX) return null;
    return list;
  }

  /** What a person would click for one option: the button inside it, when it has one. */
  function clickableOf(option) {
    if (!option) return null;
    if (option.tagName === "BUTTON") return option;
    const inner = option.querySelectorAll?.("button, [role='button']");
    return inner && inner.length === 1 ? inner[0] : option;
  }

  /** Could this element be one answer in a row of choice buttons? */
  function isChoiceCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    if (el.tagName === "BUTTON") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit" || type === "reset") return false;
    } else if (role !== "button" && role !== "option") {
      return false;
    }
    if (role === "tab" || role === "menuitem" || role === "checkbox" || role === "switch") return false;
    // A button that opens a listbox is a dropdown; that path already works.
    if (el.getAttribute("aria-haspopup") || el.getAttribute("aria-expanded") !== null) return false;
    return true;
  }

  function interactiveIn(node) {
    let found = [];
    try { found = Array.from(node.querySelectorAll(INTERACTIVE_SELECTOR)); } catch {}
    try { if (node.matches?.(INTERACTIVE_SELECTOR)) found.unshift(node); } catch {}
    return found;
  }

  /**
   * An input nobody can see or reach, kept beside a row of choice buttons.
   *
   * Ashby draws every Yes/No question as two buttons with a zero-size checkbox
   * next to them. The checkbox carries the question's id (the label points at
   * it) and follows whichever button is pressed; it is not a third answer. It
   * was counted as one, so the row read as "two buttons and some other
   * control" — not a choice row — and "Are you legally authorized…", "Will you
   * require sponsorship…" and "Have you been employed by…" were never
   * collected, filled or even outlined on any Ashby form.
   */
  function isHiddenMirror(node) {
    if (!node || node.tagName !== "INPUT") return false;
    const type = String(node.type || "").toLowerCase();
    if (type === "hidden") return true;
    if (type === "file" || type === "submit" || type === "button" || type === "image" || type === "reset") return false;
    try {
      if (node.getAttribute("aria-hidden") === "true") return true;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return true;
      const r = node.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return true;
      // Invisible and taken out of the tab order: a value store, not a control.
      if (Number(style.opacity) === 0 && node.tabIndex < 0) return true;
    } catch {}
    return false;
  }

  /** The controls in `node` a person could actually use. */
  function usableControlsIn(node) {
    return interactiveIn(node).filter((n) => !isHiddenMirror(n));
  }

  /** A child of a choice row that is not itself an answer: a hidden input, an icon, a caption. */
  function inertChild(node) {
    if (node.tagName === "INPUT" && String(node.type).toLowerCase() === "hidden") return true;
    if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName)) return true;
    return usableControlsIn(node).length === 0;
  }

  /** The members of a row of choice buttons that `el` belongs to, or null. */
  function choiceRowMembers(el) {
    // Options of a listbox that is part of the form: the listbox is the row.
    if (el.closest?.('[role="listbox"]')) {
      const list = inlineListbox(el);
      if (!list) return null;
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      const members = options.map(clickableOf);
      if (!members.includes(el) && !options.some((o) => o.contains(el))) return null;
      return members;
    }
    if (el.getAttribute?.("role") === "option") return null;

    // Buttons side by side, or each inside a wrapper of its own — up to three
    // wrappers deep — with the wrappers side by side.
    let item = el;
    for (let depth = 0; depth < 4 && item?.parentElement; depth++) {
      const row = item.parentElement;
      if (row === document.body || row === document.documentElement || row.tagName === "FORM") break;
      if (depth > 0 && usableControlsIn(item).length !== 1) break;
      const members = [];
      let fits = true;
      for (const child of row.children) {
        if (child === item) { members.push(el); continue; }
        if (inertChild(child)) continue;
        const inside = usableControlsIn(child);
        const button = inside.length === 1 ? inside[0] : null;
        // Every answer has the same shape as ours: a lone button at the same depth.
        if (!button || !isChoiceCandidate(button) || (depth === 0 && button !== child)) { fits = false; break; }
        members.push(button);
      }
      if (fits && members.length >= 2) return members;
      item = row;
    }
    return null;
  }

  function choiceButtonGroup(el) {
    if (!isChoiceCandidate(el)) return null;
    try { if (el.closest?.('[role="toolbar"], [role="tablist"], [role="menubar"], nav')) return null; } catch {}

    const members = choiceRowMembers(el);
    if (!members || members.length < 2 || members.length > CHOICE_MAX) return null;
    if (!members.every(isChoiceCandidate)) return null;

    const texts = members.map((b) => clean(visibleText(b) || b.getAttribute("aria-label") || ""));
    // Long enough for the CC-305 and veteran answers Oracle also draws as pills
    // ("I identify as one or more of the classifications of protected veteran").
    if (texts.some((t) => !t || t.length > 140)) return null;
    // Navigation and file pickers also come in rows of buttons.
    if (texts.some((t) => CHOICE_ACTION_RE.test(t))) return null;
    if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) return null;

    return members;
  }

  function isChoiceButton(el) {
    return Boolean(choiceButtonGroup(el));
  }

  /** The smallest element holding every member of a choice row. */
  function choiceGroupContainer(members) {
    if (!members?.length) return null;
    let node = members[0].parentElement;
    while (node && !members.every((m) => node.contains(m))) node = node.parentElement;
    return node || null;
  }

  /** Has this segmented button been chosen? Libraries signal it several ways. */
  function choiceButtonSelected(el) {
    if (!el) return false;
    // A button inside a listbox option: the option carries the state.
    const option = el.getAttribute?.("role") === "option" ? null : el.closest?.('[role="option"]');
    if (option && option !== el && choiceButtonSelected(option)) return true;
    if (el.getAttribute("aria-pressed") === "true") return true;
    if (el.getAttribute("aria-checked") === "true") return true;
    if (el.getAttribute("aria-selected") === "true") return true;
    if (el.getAttribute("data-state") === "checked" || el.getAttribute("data-state") === "on") return true;
    if (el.getAttribute("data-selected") === "true" || el.getAttribute("data-active") === "true") return true;
    const cls = el.getAttribute("class") || "";
    return /(^|[\s_-])(selected|active|checked|is-selected|is-active)([\s_-]|$)/i.test(cls);
  }

  function choiceButtonGroupValue(el) {
    const group = choiceButtonGroup(el);
    if (!group) return "";
    const picked = group.find(choiceButtonSelected);
    return picked ? clean(visibleText(picked) || picked.getAttribute("aria-label") || "") : "";
  }

  /**
   * Every control that answers the same question as this one.
   *
   * There used to be four of these, one per caller: radioGroup() here,
   * optionTextsFor() below, and readValue()/groupMembersOf() in the content
   * script. They disagreed, and the disagreement is what produced the mismatched
   * question/answer pairs in Saved Answers.
   *
   * The worst case was a native radio or checkbox group with no shared `name`
   * — which is how several portals render demographic questions. radioGroup()
   * fell back to the enclosing fieldset and found all three options, while
   * readValue() and optionTextsFor() fell back to `[el]` and found one. So the
   * option list said "Prefer not to say" while the value read said "No", each
   * control in the group was watched as a separate question, and the same click
   * was captured two or three times over.
   *
   * One resolver now answers the question for all of them.
   */
  function choiceGroup(el) {
    if (!el) return [];

    // Segmented buttons: a row of <button>s acting as one choice.
    const buttons = choiceButtonGroup(el);
    if (buttons) return buttons;

    const role = el.getAttribute?.("role");
    const type = (el.type || "").toLowerCase();
    const isRadio = role === "radio" || type === "radio";
    const isCheck = role === "checkbox" || type === "checkbox";
    if (!isRadio && !isCheck) return [el];

    // A selector matching every control of the same kind as this one.
    const kindSelector = role
      ? `[role="${role}"]`
      : `input[type="${type}"]`;

    // A group may never straddle two entries of a repeated section. See
    // `repeatedRowKey`: three "I currently work here" boxes are three
    // questions, and grouping them let one answer tick all three.
    const myRow = repeatedRowKey(el);
    const sameRow = (members) => {
      if (!myRow) return members;
      const kept = members.filter((m) => repeatedRowKey(m) === myRow);
      return kept.length > 1 ? kept : [el];
    };

    // 1. A shared `name` is the definitive grouping when the page provides one.
    const name = el.getAttribute("name");
    if (name) {
      try {
        const byName = Array.from(
          document.querySelectorAll(`${kindSelector}[name="${CSS.escape(name)}"]`)
        );
        if (byName.length > 1) {
          const scoped = sameRow(byName);
          if (scoped.length > 1) return scoped;
          if (myRow) return [el];
        }
      } catch {}
    }

    // 2. An explicit grouping container.
    const containerSelector = isRadio
      ? 'fieldset, [role="radiogroup"], [role="group"]'
      : 'fieldset, [role="group"]';
    try {
      const box = el.closest(containerSelector);
      if (box) {
        const members = Array.from(box.querySelectorAll(kindSelector));
        if (members.length > 1) {
          const scoped = sameRow(members);
          if (scoped.length > 1) return scoped;
          if (myRow) return [el];
        }
        /**
         * A fieldset holding this one box is a question of its own.
         *
         * Oracle asks "I am Hispanic or Latino." as the only box in its
         * fieldset, with the race boxes in the next one. The walk below went on
         * past the fieldset and joined the two questions, so the Hispanic box
         * was answered as a race and reported as failed.
         */
        if (members.length === 1 && members[0] === el && box.matches?.('fieldset, [role="radiogroup"]')) return [el];
      }
    } catch {}

    // 3. No name and no container — walk up until an ancestor holds more than
    //    one control of this kind and nothing else that would make it the whole
    //    form. This is the shape that broke: three <div><input><label></div>
    //    rows sitting loose inside a question block.
    try {
      let node = el.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (node.tagName === "FORM") break;
        const members = Array.from(node.querySelectorAll(kindSelector));
        /**
         * An Oracle Recruiting question row is the whole of its question.
         * "I am Hispanic or Latino." is the one box of its row, and the race
         * boxes and the veteran categories are rows of their own below it; the
         * walk went on past the row and made the three one question, so the
         * Hispanic box was answered as a race.
         */
        if (node.classList?.contains("input-row") && onOracleCandidateExperience()) {
          return members.length > 1 ? sameRow(members) : [el];
        }
        if (members.length > 1) {
          // Guard against scooping up a neighbouring question: a real group's
          // members share a parent chain of the same depth.
          if (members.length <= 25) {
            const scoped = sameRow(members);
            if (scoped.length > 1) return scoped;
            if (myRow) return [el];
            return members;
          }
          break;
        }
      }
    } catch {}

    return [el];
  }

  function radioGroup(el) {
    return choiceGroup(el);
  }

  function setRadioValue(el, value, synonyms, hint) {
    if (value === undefined || value === null || String(value).trim() === "") return false;
    const role = el.getAttribute("role");
    let group = radioGroup(el);
    if (!group.length) group = [el];

    const want = norm(value);
    const accepted = synonymsFor(synonyms, value).map(norm).filter(Boolean);
    const targets = [want, ...accepted];
    let best = null, bestScore = 0;

    const labels = group.map((radio) => radioOptionText(radio));
    // Yes/No groups and lists of states take only a matching answer.
    const strict = eeoId(value, hint) ? null : strictChoiceScores(
      labels, value, group.map((radio) => radio.getAttribute("value") || "")
    );

    group.forEach((radio, index) => {
      const label = labels[index];
      const option = radio.getAttribute("value") || "";
      let score = 0;
      if (strict) {
        score = strict[index] ?? 0;
      } else {
        for (let i = 0; i < targets.length; i++) {
          const raw = choiceScore(label, option, targets[i], hint);
          if (!raw) continue;
          // targets[0] is the answer itself; the rest are the rule's synonyms in
          // order of closeness. The penalty is small so it only breaks ties.
          const adjusted = i === 0 ? raw : raw - Math.min(i - 1, 8);
          if (adjusted > score) score = adjusted;
        }
      }
      if (score > bestScore) { bestScore = score; best = radio; }
    });

    // Never guess between radio options. A wrong answer is worse than leaving
    // the question unanswered for the user.
    if (!best || bestScore < 65) return false;

    ensureVisible(best);

    if (isChoiceButton(best)) {
      takeFocusAnnounced(best);
      clickLikeUser(best);
      leaveLikeUser(best);
      // Some segmented controls track selection only in framework state, with
      // nothing readable in the DOM. The click is the commit, so a group that
      // reports no selection at all is still treated as answered rather than
      // being clicked a second time.
      return choiceButtonSelected(best) || !group.some(choiceButtonSelected);
    }

    if (best.getAttribute("role") === "radio") {
      try { best.focus?.({ preventScroll: true }); } catch {}
      clickCommitting(best, () => {
        best.click?.();
        if (best.getAttribute("aria-checked") !== "true") {
          best.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
          best.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
        }
      });
    } else {
      const labelEl = best.id
        ? document.querySelector(`label[for="${CSS.escape(best.id)}"]`)
        : best.closest("label");
      clickCommitting(best, () => {
        const clickable = opensFilePicker(labelEl) ? best : (labelEl || best);
        if (!best.checked) clickable.click?.();
        if (!best.checked && !opensFilePicker(best)) best.click?.();
      });
    }

    return role === "radio" ? best.getAttribute("aria-checked") === "true" : best.checked === true;
  }

  /* ================================================================== */
  /*  MENU REGISTRY — one open dropdown at a time                        */
  /* ================================================================== */

  /**
   * Oracle Recruiting's refreshed list boxes draw their choices as a grid —
   * `div[role=row] > div[role=gridcell] > span.cx-select__list-item--content`
   * inside `#<box id>-listbox` — with no `role="option"` anywhere. None of the
   * selectors below matched, so Gender, Veteran Status, State, County and every
   * other list on the page opened and offered "nothing", and was left empty.
   * A grid cell counts as a choice only inside such a list (a calendar is a
   * grid too, and its days are not menu options), and only on Oracle's pages.
   */
  const GRID_OPTION_SELECTOR = '[role="row"] > [role="gridcell"]';
  const ORACLE_GRID_OPTIONS = `[id$="-listbox"] ${GRID_OPTION_SELECTOR}`;

  const OPTION_SELECTOR =
    '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"], ' +
    '[role="listbox"] li, [role="menu"] li, li[data-value], ' +
    '[data-automation-id*="promptOption"], [data-automation-id="promptLeafNode"], ' +
    '[class*="menu"] [class*="option"], [class*="dropdown"] li, [class*="select__option"], ' +
    '[class*="Dropdown"] li, ul[class*="option"] li, [class*="autocomplete"] li';

  const POPUP_SELECTOR =
    '[role="listbox"], [role="menu"], [role="tree"], [data-automation-id="menuList"], ' +
    '[data-automation-id="promptOptions"], [class*="popover"], [class*="Popover"], ' +
    '[class*="menuList"], [class*="dropdown-menu"], [class*="select__menu"], [class*="MuiPopper"]';

  const MAX_SCANNED_OPTIONS = 400;

  /** "No results.", "No matches found": a list's way of saying it has nothing. */
  const NO_RESULTS_RE = /^(?:no\s+(?:results?|matches|matching\s+(?:results|values|records)|suggestions|options|data|values|records)(?:\s+(?:were\s+)?found)?|nothing\s+found)\.?$/i;

  function optionNodesIn(root) {
    // Oracle Recruiting: a list the control itself names may draw its choices
    // as grid rows, and says "No results." in a row of its own. Every other
    // site's lists are read exactly as before.
    const oracle = onOracleCandidateExperience();
    const selector = !oracle ? OPTION_SELECTOR
      : Boolean(root) && root !== document ? `${OPTION_SELECTOR}, ${GRID_OPTION_SELECTOR}`
      : `${OPTION_SELECTOR}, ${ORACLE_GRID_OPTIONS}`;
    let nodes;
    try { nodes = Array.from((root || document).querySelectorAll(selector)); }
    catch { return []; }
    const out = [];
    for (const n of nodes) {
      if (out.length >= MAX_SCANNED_OPTIONS) break;
      if (n.getAttribute("aria-disabled") === "true" || n.hasAttribute("disabled")) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const s = getComputedStyle(n);
      if (s.visibility === "hidden" || s.display === "none") continue;
      if (oracle && NO_RESULTS_RE.test(clean(n.textContent))) continue;
      out.push(n);
    }
    return out;
  }

  /**
   * The list a combobox opens, by every name a page gives it: its own
   * aria-controls / aria-owns and — on Oracle's pages — its toggle button's
   * (`<id>-toggle-button`) and Oracle's `<id>-listbox`.
   */
  function controlledLists(el) {
    const out = [];
    const add = (node) => { if (node && !out.includes(node)) out.push(node); };
    try {
      for (const attr of ["aria-controls", "aria-owns"]) {
        for (const id of String(el.getAttribute?.(attr) || "").split(/\s+/).filter(Boolean)) add(document.getElementById(id));
      }
      if (el.id && onOracleCandidateExperience()) {
        const toggle = document.getElementById(`${el.id}-toggle-button`);
        for (const id of String(toggle?.getAttribute?.("aria-controls") || "").split(/\s+/).filter(Boolean)) add(document.getElementById(id));
        add(document.getElementById(`${el.id}-listbox`));
      }
    } catch {}
    return out;
  }

  /** Every option-shaped node currently on screen, anywhere in the document. */
  function visibleOptions() {
    return optionNodesIn(document);
  }

  /** The menu that belongs to this control, when the page says so explicitly. */
  function declaredPopup(el) {
    for (const node of controlledLists(el)) {
      if (optionNodesIn(node).length) return node;
    }
    const activeId = el.getAttribute("aria-activedescendant");
    if (activeId) {
      const active = document.getElementById(activeId);
      const popup = active?.closest(POPUP_SELECTOR);
      if (popup && optionNodesIn(popup).length) return popup;
    }
    return null;
  }

  /** The smallest popup container that holds all of `nodes`. */
  function popupAround(nodes) {
    if (!nodes.length) return null;
    let node = nodes[0];
    for (let d = 0; node && d < 12; d++, node = node.parentElement) {
      if (!node.matches?.(POPUP_SELECTOR)) continue;
      if (nodes.every((n) => node.contains(n))) return node;
    }
    return nodes[0].closest(POPUP_SELECTOR) || null;
  }

  /**
   * The single source of truth for "is a dropdown on screen right now".
   * The engine refuses to touch the next field until this is empty.
   */
  const MENU = { el: null, popup: null, baseline: new Set(), pageBaseline: new Set() };

  /**
   * Records what already looked option-shaped before the fill began.
   *
   * Plenty of sites ship permanently-visible markup that matches the option
   * selectors — a site header built from `.dropdown > li`, a styled list of
   * radio cards. Without this the engine would believe a menu was open for the
   * entire run, wait for it before every dropdown, and try to close somebody
   * else's navigation. Anything present at the start is the page's own and is
   * ignored from then on.
   */
  function beginFillSession() {
    MENU.pageBaseline = new Set(visibleOptions());
    MENU.el = null;
    MENU.popup = null;
    MENU.baseline = new Set();
  }

  function menusOpen() {
    const nodes = visibleOptions();
    if (!nodes.length) return false;
    for (const n of nodes) if (!MENU.pageBaseline.has(n)) return true;
    return false;
  }

  async function waitForMenusClosed(timeoutMs = 700) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!menusOpen()) return true;
      await wait(40);
    }
    return !menusOpen();
  }

  /**
   * Closes whatever is open, gently first.
   *
   * The old implementation called `document.body.click()`, a synthetic click
   * whose target is <body>. SPA forms treat that as a click-outside on every
   * open widget at once, which on SAP SuccessFactors reverted the value that
   * had just been committed — the "Master's Degree flips back to No Selection"
   * behaviour. Escape is tried first, then re-toggling the control itself, and
   * only as a last resort a pointerdown on the document (never a click).
   */
  async function closeOpenMenu() {
    const el = MENU.el;
    const popup = MENU.popup;
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true });

    if (!menusOpen()) { MENU.el = null; MENU.popup = null; return true; }
    // Something option-shaped is on screen that we did not open. It belongs to
    // the page, not to us, and closing it is not our business.
    if (!el) return false;

    try { el?.dispatchEvent(esc()); } catch {}
    try { popup?.dispatchEvent(esc()); } catch {}
    if (await waitForMenusClosed(220)) { MENU.el = null; MENU.popup = null; return true; }

    try { document.dispatchEvent(esc()); } catch {}
    if (await waitForMenusClosed(180)) { MENU.el = null; MENU.popup = null; return true; }

    // Re-toggle the owning control — the normal way a user closes a listbox.
    //
    // Only safe if `el` actually IS a dropdown trigger (haspopup, combobox role,
    // or is a button sitting next to a popup we know about). If `MENU.el` was
    // misidentified and is actually a submit/next button, clicking it advances
    // the form half-filled — a much worse failure than leaving a menu open.
    const isDropdownTrigger =
      el?.getAttribute?.("aria-haspopup") ||
      /^(combobox|listbox|button)$/i.test(el?.getAttribute?.("role") || "") ||
      el?.tagName === "BUTTON";
    if (isDropdownTrigger) {
      try { el?.click?.(); } catch {}
      if (await waitForMenusClosed(220)) { MENU.el = null; MENU.popup = null; return true; }
    }

    // Last resort: an outside pointerdown, without generating a click event.
    try {
      const target = document.documentElement;
      ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {
        try { fire(target, type); } catch {}
      });
    } catch {}
    const closed = await waitForMenusClosed(260);
    MENU.el = null;
    MENU.popup = null;
    return closed;
  }

  /**
   * Opens the menu for one control and returns only *its* options.
   *
   * `baseline` is the set of option nodes that were already on screen before we
   * touched anything. Anything in the baseline is somebody else's menu and is
   * excluded from scoring — this is what stops a neighbouring row's year list
   * being read as this field's choices.
   */
  async function openMenu(el, waitMs = 900, { keyboard = true } = {}) {
    await closeOpenMenu();

    const baseline = new Set([...MENU.pageBaseline, ...visibleOptions()]);
    // Inputs on screen before we opened anything: a search box that is not
    // in this set appeared because of us and belongs to this menu.
    MENU.baselineInputs = new Set(
      Array.from(document.querySelectorAll('input')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
    );
    MENU.el = el;
    MENU.popup = null;
    MENU.baseline = baseline;

    ensureVisible(el);
    try { el.focus?.({ preventScroll: true }); } catch {}
    try { fire(el, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { el.click?.(); } catch {}

    const collect = () => {
      const declared = declaredPopup(el);
      if (declared) {
        MENU.popup = declared;
        return optionNodesIn(declared);
      }
      const fresh = visibleOptions().filter((n) => !baseline.has(n));
      if (fresh.length) {
        MENU.popup = popupAround(fresh);
        return MENU.popup ? optionNodesIn(MENU.popup) : fresh;
      }
      return [];
    };

    const deadline = Date.now() + Math.max(300, waitMs);
    let options = collect();
    while (!options.length && Date.now() < deadline) {
      await wait(50);
      options = collect();
    }

    if (!options.length && keyboard) {
      // Workday and Oracle buttons only render the list on a keyboard opening.
      for (const key of [
        { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        { key: " ", code: "Space", keyCode: 32 },
        { key: "Enter", code: "Enter", keyCode: 13 },
      ]) {
        try {
          el.dispatchEvent(new KeyboardEvent("keydown", { ...key, which: key.keyCode, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { ...key, which: key.keyCode, bubbles: true, cancelable: true }));
        } catch {}
        const until = Date.now() + 250;
        while (!options.length && Date.now() < until) {
          await wait(50);
          options = collect();
        }
        if (options.length) break;
      }
    }

    // Remembered on the control: its choices are otherwise unreadable once the
    // menu closes, and capture stores them beside the applicant's answer.
    if (options.length) {
      try {
        el.__applifillMenuOptions = options
          .map((o) => clean(o.textContent || o.getAttribute?.("aria-label") || ""))
          .filter(Boolean).slice(0, 60);
      } catch {}
    }
    return { options, popup: MENU.popup, baseline };
  }

  /** Re-reads this menu's options after typing changed the filtered list. */
  function menuOptions(session) {
    if (!session) return [];
    if (MENU.popup && document.contains(MENU.popup)) return optionNodesIn(MENU.popup);
    const declared = declaredPopup(session.el || MENU.el || document.body);
    if (declared) { MENU.popup = declared; return optionNodesIn(declared); }
    return visibleOptions().filter((n) => !session.baseline.has(n));
  }

  /**
   * Waits for this control's options. Kept for callers that only need a
   * yes/no on "did anything open", but scoped to the current menu session.
   */
  async function waitForOptions(timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = visibleOptions();
      if (found.length) return found;
      await wait(60);
    }
    return visibleOptions();
  }

  /**
   * The real `<select>` hiding behind a custom dropdown.
   *
   * Select2, Chosen, jQuery UI and iCIMS's own "— Make a Selection —" control
   * are all decoration over an ordinary `<select>` that still holds the value
   * the form submits. Setting that select is instant, cannot pick the wrong
   * row of a 250-country list, and never opens a menu — so it is tried before
   * any clicking. Only an unambiguous match counts: if a wrapper holds two
   * selects we do not guess which one belongs to this widget.
   */
  function backingSelect(el) {
    if (!el) return null;
    if (el.tagName === "SELECT") return el;
    // Only a dropdown can have one. Asking on behalf of a text box would walk
    // up and adopt whatever unrelated select happens to share its section.
    if (fieldKind(el) !== "select") return null;

    const usable = (s) =>
      s && s.tagName === "SELECT" && !s.disabled && (s.options?.length ?? 0) > 1;
    // A select the user can see and use is a field in its own right, never
    // somebody else's hidden value store.
    const replaced = (s) => usable(s) && !isFillable(s);

    for (const attr of ["aria-controls", "aria-owns", "data-select-id", "data-for", "for"]) {
      const raw = el.getAttribute?.(attr);
      if (!raw) continue;
      for (const id of raw.split(/\s+/)) {
        const found = document.getElementById(id);
        if (usable(found)) return found;
      }
    }

    // Widget-id conventions: "<id>_chosen", "s2id_<id>", "<id>-container".
    const id = el.id || "";
    for (const guess of [
      id.replace(/_chosen$/, ""),
      id.replace(/^s2id_/, ""),
      id.replace(/^select2-/, "").replace(/-container$/, ""),
      id.replace(/[-_]container$/, ""),
      id.replace(/[-_]widget$/, ""),
      id.replace(/[-_]display$/, ""),
    ]) {
      if (!guess || guess === id) continue;
      const found = document.getElementById(guess);
      if (usable(found)) return found;
    }

    let node = el;
    for (let d = 0; node && d < 4; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      let selects;
      try { selects = Array.from(node.querySelectorAll("select")).filter(replaced); } catch { break; }
      if (selects.length === 1) return selects[0];
      if (selects.length > 1) break;
    }
    return null;
  }

  /**
   * Tells a widget library that its underlying select changed.
   *
   * Content scripts run in an isolated world, so the page's jQuery is out of
   * reach — but jQuery binds real listeners, so dispatching these event names
   * natively still reaches handlers registered with `.on(...)`.
   */
  function notifyWidget(select) {
    fire(select, "input", "change");
    for (const type of ["chosen:updated", "select2:select", "liszt:updated"]) {
      try { select.dispatchEvent(new CustomEvent(type, { bubbles: true })); } catch {}
    }
  }

  /** Does this choice control have any real answer to offer yet? */
  function hasRealOptions(el) {
    const select = backingSelect(el);
    if (!select) return true;   // custom widget with no select — can't tell without opening
    return Array.from(select.options || [])
      .some((o) => o.value && !isPlaceholderChoice(o.textContent));
  }

  /**
   * The search box a portal shows once a dropdown is open.
   *
   * iCIMS floats it above the list rather than inside it, so looking only
   * inside the popup found nothing and a 250-row country list was never
   * filtered. Anything that appeared since the menu opened counts.
   */
  function findSearchInput(el, popup, baselineInputs) {
    const SEARCH_SELECTOR =
      'input[type="text"], input[type="search"], input:not([type]), input[role="combobox"], ' +
      '[data-automation-id="searchBox"] input, input[class*="search" i]';

    const usable = (input) => {
      if (!input || input.disabled || input.readOnly) return false;
      const r = input.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    if (popup) {
      for (const input of popup.querySelectorAll(SEARCH_SELECTOR)) if (usable(input)) return input;
    }

    // Newly visible inputs — the floating "— Type to Search —" box.
    if (baselineInputs) {
      for (const input of document.querySelectorAll(SEARCH_SELECTOR)) {
        if (baselineInputs.has(input) || !usable(input)) continue;
        if (input === el) continue;
        return input;
      }
    }

    // A search box the widget keeps mounted, sitting next to the control.
    let node = el;
    for (let d = 0; node && d < 4; d++, node = node.parentElement) {
      if (node === document.body) break;
      for (const input of node.querySelectorAll(SEARCH_SELECTOR)) {
        if (!usable(input) || input === el) continue;
        const hint = `${input.getAttribute("placeholder") || ""} ${input.getAttribute("aria-label") || ""} ${input.className || ""}`;
        if (/search|type to/i.test(hint)) return input;
      }
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return el;
    return null;
  }

  /** Back-compat wrapper for the popup-only lookup. */
  function popupSearchInput(popup) {
    return findSearchInput(popup || document.body, popup, null);
  }

  function setComboboxText(el, text) {
    const value = String(text ?? "");
    try {
      const setter = nativeSetter(el);
      if (el.isContentEditable && el.tagName !== "INPUT") el.textContent = value;
      else if (setter) setter.call(el, value);
      else el.value = value;
    } catch {
      try { el.value = value; } catch {}
    }
    fire(el, "input");
  }

  /* ---------------- nested menus ---------------- */

  const CATEGORY_HINTS = [
    [/linkedin/i, ["social media", "job board", "online", "internet", "website", "professional network"]],
    [/indeed|glassdoor|monster|dice|ziprecruiter|naukri|seek/i, ["job board", "online", "internet", "job site"]],
    [/referr?al|employee|friend|colleague/i, ["referral", "employee referral", "word of mouth", "personal"]],
    [/company\s*(web)?site|our\s*web\s*site|careers?\s*(page|site)/i, ["our web site", "company website", "website", "online"]],
    [/recruiter|agency|head\s*hunter/i, ["recruiter", "agency", "direct sourcing", "search firm"]],
    [/career\s*fair|job\s*fair|campus|university|college/i, ["career fair", "event", "campus", "university"]],
    [/twitter|facebook|instagram|x\.com|social/i, ["social media", "online", "internet"]],
    [/conference|meetup|event|webinar/i, ["event", "conference", "professional associations"]],
    [/newspaper|magazine|print|radio|tv/i, ["advertisement", "print", "media", "other"]],
  ];

  function categoryHintsFor(value) {
    const v = String(value ?? "");
    const hints = [];
    for (const [pattern, list] of CATEGORY_HINTS) if (pattern.test(v)) hints.push(...list);
    hints.push("other");
    return hints;
  }

  function isParentOption(option) {
    if (!option) return false;
    if (option.getAttribute("aria-haspopup")) return true;
    if (option.getAttribute("aria-expanded") !== null) return true;
    if (/submenu|has-children|expandable|parent/i.test(option.className || "")) return true;
    if (option.querySelector('[class*="chevron"], [class*="arrow"], [class*="caret"], svg')) return true;
    if (/[›»>❯]\s*$/.test(clean(option.textContent))) return true;
    return false;
  }

  function optionScoreForTarget(option, targets, hint, primaryCount) {
    const rawText = option.textContent || option.getAttribute("aria-label") || option.getAttribute("data-value") || "";
    if (isStudyQuestion(hint)) return studyChoiceScore(rawText, targets[0]);
    const text = normalizeChoiceText(rawText);
    const value = normalizeChoiceText(option.getAttribute("value") || option.getAttribute("data-value") || "");
    if (!text && !value) return 0;
    if (/^(select|choose|please select|please choose|no results found|loading|select one|no selection|not selected)$/i.test(text)) return 0;

    // Same hard branch rule as the radio path: a voluntary-disclosure answer
    // matches its own branch or nothing at all.
    for (const target of targets) {
      const wantId = eeoId(target, hint);
      if (!wantId) continue;
      const optId = eeoId(rawText, hint) || eeoId(option.getAttribute("value") || "", hint);
      if (optId) return optId === wantId ? eeoBranchScore(rawText, target) : 0;
    }

    // `primaryCount` marks how many of the targets are the answer itself
    // rather than a synonym of it; the rest score on a lower ladder.
    const split = Number.isInteger(primaryCount) ? primaryCount : targets.length;
    return Math.max(
      tieredScore(text, value, targets.slice(0, split), { exact: 130, prefix: 100, contains: 82, fuzzy: 72 }),
      // Ranked, so a rule's ordering of its synonyms decides which category
      // wins when a list offers several that all match.
      rankedSynonymScore(text, value, targets.slice(split), { exact: 104, prefix: 78, contains: 72, fuzzy: 58 })
    );
  }

  async function drillForOption(session, topOptions, targets, rawValue, waitMs, hint, depth = 0) {
    if (depth > 1) return null;

    const hints = categoryHintsFor(rawValue);
    const parents = topOptions
      .filter(isParentOption)
      .map((option) => ({ option, rank: optionScoreForTarget(option, hints, hint) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 4);

    for (const { option } of parents) {
      if (!document.contains(option)) continue;
      const parentText = normalizeChoiceText(option.textContent || "");
      const beforeCount = menuOptions(session).length;

      try { option.scrollIntoView?.({ block: "nearest" }); } catch {}
      try { option.click?.(); } catch {}
      await wait(120);

      let children = menuOptions(session);
      if (children.length === beforeCount) {
        try {
          option.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        } catch {}
        await wait(200);
        children = menuOptions(session);
      }

      const leaves = children.filter((child) => normalizeChoiceText(child.textContent || "") !== parentText);

      let bestChild = null, bestChildScore = 0;
      for (const child of leaves) {
        const score = optionScoreForTarget(child, targets, hint);
        if (score > bestChildScore) { bestChildScore = score; bestChild = child; }
      }
      if (bestChild && bestChildScore >= 55) return { option: bestChild, score: bestChildScore };

      const deeper = await drillForOption(session, leaves, targets, rawValue, waitMs, hint, depth + 1);
      if (deeper) return deeper;
    }

    return null;
  }

  /* ---------------- the combobox writer ---------------- */

  /**
   * Custom dropdowns — react-select, Workday, Oracle, SAP, MUI, Ashby.
   *
   * One open, one pick, one close, verified. The control is never opened twice
   * for the same value and the function does not return until the menu is off
   * the screen, so the next field always starts from a clean page.
   */
  /**
   * The options a menu shows once the search text has been typed.
   *
   * A list filtered in the page changes at once; a list searched on the server
   * (nothing listed before typing) arrives when the server answers. Either way
   * the read is taken once the list has stopped changing, not at a fixed time.
   */
  async function awaitTypedOptions(session, { serverSide = false, waitMs = 900 } = {}) {
    const started = Date.now();
    const limit = serverSide ? 3200 : Math.min(700, Math.max(280, waitMs / 2));
    let signature = null;
    let stableSince = Date.now();
    await wait(serverSide ? 100 : 50);
    while (Date.now() - started < limit) {
      const options = menuOptions(session);
      const next = options.map((o) => clean(o.textContent)).join("\n");
      if (next !== signature) {
        signature = next;
        stableSince = Date.now();
      } else if (options.length && Date.now() - stableSince >= 160) {
        break;
      }
      await wait(60);
    }
    return menuOptions(session);
  }

  async function setComboboxValue(el, value, waitMs = 900, synonyms, hint, context = null) {
    if (value === undefined || value === null || String(value).trim() === "") return false;

    // Already correct — opening it again would only make the page flicker.
    if (!context?.force && valuesEquivalent(el, value, hint)) return true;

    const want = norm(value);
    const place = context?.place ? wantedPlace(value, context.placeHint) : null;
    const before = comboboxDisplayValue(el);
    // "NC" is typed into a searchable state menu as "North Carolina".
    const wantRegion = place ? null : regionId(value, { loose: true });
    const searchText = (wantRegion && regionName(wantRegion)) || String(value);
    const eeoAnswer = Boolean(eeoId(value, hint));

    // A widget backed by a real select is answered without touching the menu.
    // This is the whole of iCIMS's "— Make a Selection —" country picker: a
    // 250-row list that has to be searched to be reachable, over a plain
    // <select> that takes the value directly.
    const backing = backingSelect(el);
    if (backing && backing !== el) {
      if (setSelectValue(backing, value, synonyms, hint, context)) {
        await wait(90);
        el.__applifillNoMatch = false;
        return true;
      }
      // The select exists but holds nothing usable yet — a dependent dropdown
      // waiting on its parent. Say so rather than opening an empty menu.
      if (!hasRealOptions(backing)) return false;
    }

    const session = { el };
    /**
     * A box you type into to search lists nothing until something is typed.
     *
     * Oracle's ZIP Code and City are lists of values searched on the server:
     * a click shows nothing, and after typing the list arrives most of a second
     * later. The keyboard openings below were spent on them for nothing, and the
     * third of a second allowed after typing was over before the list came —
     * so the text was cleared again and the box left empty and required.
     */
    const typeToSearch = looksLikeTypeahead(el);
    const opened = await openMenu(el, typeToSearch ? Math.min(waitMs, 350) : waitMs, { keyboard: !typeToSearch });
    session.baseline = opened.baseline;
    let options = opened.options;

    const accepted = synonymsFor(synonyms, value);
    const targets = [String(value), want, ...accepted].filter(Boolean);
    const primaryCount = [String(value), want].filter(Boolean).length;

    const optionLabel = (opt) =>
      opt.textContent || opt.getAttribute?.("aria-label") || opt.getAttribute?.("data-value") || "";

    const pick = (list) => {
      // A menu of states, or a Yes/No menu, only takes the matching answer.
      const strict = place ? list.map((opt) => placeScore(optionLabel(opt), place)) : eeoAnswer ? null : strictChoiceScores(
        list.map(optionLabel), value, list.map((o) => o.getAttribute?.("value") || "")
      );
      let best = null, bestScore = 0;
      list.forEach((opt, i) => {
        const score = strict ? strict[i] ?? 0 : optionScoreForTarget(opt, targets, hint, primaryCount);
        if (score > bestScore) { bestScore = score; best = opt; }
      });
      if (place && best && list.some((opt, i) => opt !== best && strict[i] === bestScore &&
          distinctPlaces(optionLabel(opt), optionLabel(best)))) { best = null; bestScore = 0; }
      if (isStudyQuestion(hint) && best && list.some(opt=>opt!==best && studyChoiceScore(optionLabel(opt),value)===bestScore && studyText(optionLabel(opt))!==studyText(optionLabel(best)))) {best=null;bestScore=0;}
      return { best, bestScore, strict: Boolean(strict) };
    };

    let { best, bestScore } = pick(options);

    // Long lists (country, state, school) are virtualised — only the first
    // rows exist in the DOM. Typing is the only way to reach the rest.
    if (!best || bestScore < 100) {
      const search = findSearchInput(el, MENU.popup, MENU.baselineInputs);
      if (search) {
        const listedBefore = options.length;
        setComboboxText(search, "");
        await wait(40);
        setComboboxText(search, searchText);
        if (typeToSearch && search === el) fire(el, "keyup");
        const filtered = await awaitTypedOptions(session, { serverSide: !listedBefore, waitMs });
        if (filtered.length) {
          const retry = pick(filtered);
          if (retry.best && retry.bestScore >= bestScore) {
            best = retry.best;
            bestScore = retry.bestScore;
            options = filtered;
          }
        }
        // A filter that matched nothing must be cleared, or the control is
        // left holding junk text after we close it.
        if (!best || bestScore < 55) {
          setComboboxText(search, "");
          await wait(180);
          options = menuOptions(session);
          const cleared = pick(options);
          best = cleared.best; bestScore = cleared.bestScore;
        }
      }
    }

    if ((!best || bestScore < 55) && !place) {
      const drilled = await drillForOption(session, options, targets, value, waitMs, hint);
      if (drilled) { best = drilled.option; bestScore = drilled.score; }
    }

    if (!best || bestScore < 55) {
      // The menu opened and none of its choices fit. Reopening it later cannot
      // change that, so flag the control: the reconcile pass skips it and sends
      // it straight to the user instead of opening the same list a second time.
      //
      // Unless it barely offered anything — a dependent dropdown that is still
      // waiting on its parent looks identical to a dead end at this point, and
      // that one does deserve a second try once the parent is answered.
      const realOptions = options.filter((o) => !isPlaceholderChoice(o.textContent || ""));
      el.__applifillNoMatch = realOptions.length >= 3;
      await closeOpenMenu();
      return false;
    }
    el.__applifillNoMatch = false;

    try { best.scrollIntoView?.({ block: "nearest" }); } catch {}
    try { fire(best, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { best.click?.(); } catch {}

    /**
     * Wait for the widget to take the answer, not for a clock.
     *
     * A fixed pause after every pick, an Enter keypress whenever the menu had
     * not vanished yet, and then up to four escalating attempts to close it —
     * on Workday, whose listbox animates out, that cost close to a second per
     * dropdown and was most of what made a fill feel slow. The pick is done the
     * moment the control shows a new value or its menu has gone.
     */
    const beforeNorm = normalizeChoiceText(before);
    const takenUp = () => {
      const now = normalizeChoiceText(comboboxDisplayValue(el));
      return Boolean(now) && now !== beforeNorm;
    };
    const popupGone = () => {
      const popup = MENU.popup;
      if (!popup) return !menusOpen();
      if (!document.contains(popup)) return true;
      const r = popup.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return true;
      return optionNodesIn(popup).length === 0;
    };
    const settleBy = Date.now() + 420;
    await wait(20);
    while (Date.now() < settleBy && !takenUp() && !popupGone()) await wait(30);

    // Some listboxes commit on Enter rather than click, but only try that while
    // the menu is genuinely still open — pressing Enter on a closed Workday
    // control submits the page.
    if (!takenUp() && menusOpen() && document.contains(best)) {
      try {
        best.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        best.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      } catch {}
      await wait(90);
    }

    const bestText = normalizeChoiceText(best.textContent || best.getAttribute("aria-label") || "");
    const chosenInPopup = (MENU.popup || document).querySelector?.('[aria-selected="true"], [aria-checked="true"]');
    const chosenText = normalizeChoiceText(chosenInPopup?.textContent || "");

    await closeOpenMenu();

    // Tell the page the value moved — but carefully. On a search-style combobox
    // (react-select and everything that copies it, which is most of the web)
    // the control IS a text input, and an `input` event there means "the user
    // is typing": it reopens the menu we just closed, leaves it hanging over
    // the next field, and can wipe the answer that was just committed. `change`
    // carries the same news to jQuery-era widgets without saying that.
    const isTextEntry = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    // Buttons/divs only open the list. Their empty `value` is not the selected
    // answer; a synthetic change there can erase what the option just saved.
    if (isTextEntry) fire(el, "change");
    else if (el.tagName === "SELECT") fire(el, "input", "change");

    // A widget that reopens on any interaction at all gets one more quiet
    // close, so the next field never starts with a menu on top of it.
    if (menusOpen()) {
      MENU.el = MENU.el || el;
      await closeOpenMenu();
    }

    const shown = normalizeChoiceText(comboboxDisplayValue(el));
    const wantNorm = normalizeChoiceText(want);

    return Boolean(
      (shown && shown !== beforeNorm &&
        (shown.includes(bestText) || bestText.includes(shown) || shown.includes(wantNorm))) ||
      (shown && (shown === bestText || shown === wantNorm)) ||
      (shown && valuesEquivalent(el, value, hint)) ||
      (chosenText && (chosenText === bestText || chosenText.includes(bestText)))
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Type-to-search boxes (Lever's location, Google Places)             */
  /* ------------------------------------------------------------------ */

  /**
   * A plain text box whose answer only counts once a suggestion is picked.
   *
   * Lever's "Current location" is an ordinary <input>: typing asks the server
   * for places and lists them underneath, and only clicking one fills the
   * hidden `selectedLocation` the form actually submits. Typing alone left the
   * applicant looking at "City of Jacksonville, FL, USA" in an open list under
   * a box the page still counted as empty. Google Places boxes behave the same
   * way. Nothing here applies to a box that shows no list of its own.
   */
  const SUGGESTION_ROW_SELECTOR =
    '[role="option"], .dropdown-location, .dropdown-results > li, .dropdown-results > div, ' +
    '[class*="location-result" i], .pac-item, li[class*="suggestion" i], ' +
    'div[class*="suggestion-item" i], [class*="autocomplete" i] li, [class*="typeahead" i] li';

  /**
   * A Google Places box (`.pac-target-input`). It suggests whole addresses as
   * you type, but it is an ordinary box: what is typed into it stays — unlike
   * Oracle's address list, which keeps only an address picked from it.
   */
  function isPlacesBox(el) {
    return el?.tagName === "INPUT" && /\bpac-target-input\b/.test(typeof el.className === "string" ? el.className : "");
  }

  function looksLikeTypeahead(el) {
    if (!acceptsText(el) || el.tagName === "TEXTAREA") return false;
    const autocomplete = String(el.getAttribute("aria-autocomplete") || "").toLowerCase();
    if (autocomplete === "list" || autocomplete === "both") return true;
    if (el.getAttribute("aria-controls") || el.getAttribute("aria-owns")) return true;
    const own = `${el.className || ""} ${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("data-qa") || ""}`;
    if (/pac-target-input|typeahead|autocomplete|autosuggest|places/i.test(own)) return true;
    // A suggestion list kept beside the box, as Lever does — inside a wrapper
    // that holds this box alone, so a neighbouring dropdown's list is never
    // mistaken for this box's suggestions.
    let node = el.parentElement;
    for (let d = 0; node && d < 3; d++, node = node.parentElement) {
      if (node === document.body || !ownsOnlyThisField(node, el)) break;
      try {
        if (node.querySelector('.dropdown-results, .dropdown-location, [class*="location-dropdown" i], [class*="suggestion" i], [class*="typeahead" i], [class*="autocomplete" i], [role="listbox"]')) {
          return true;
        }
      } catch {}
    }
    return false;
  }

  function suggestionRowsFor(el) {
    const rows = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node) || !isShowing(node)) return;
      const r = node.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return;
      const text = clean(node.textContent);
      if (!text || text.length > 160) return;
      seen.add(node);
      rows.push(node);
    };
    try {
      for (const attr of ["aria-controls", "aria-owns"]) {
        for (const id of String(el.getAttribute(attr) || "").split(/\s+/).filter(Boolean)) {
          document.getElementById(id)?.querySelectorAll(SUGGESTION_ROW_SELECTOR).forEach(add);
        }
      }
      let node = el.parentElement;
      for (let d = 0; node && d < 3 && !rows.length; d++, node = node.parentElement) {
        if (node === document.body || !ownsOnlyThisField(node, el)) break;
        node.querySelectorAll(SUGGESTION_ROW_SELECTOR).forEach(add);
      }
      // Lists drawn at the end of <body>: Google Places, and Lever's own rows.
      if (!rows.length) document.querySelectorAll(".pac-container .pac-item, .dropdown-location").forEach(add);
      // A listbox portalled elsewhere with no aria link back to the box (Ashby):
      // taken only while the box has the caret, and only a list drawn right
      // beneath it, so another question's menu is never read as this one's.
      if (!rows.length && holdsFocus(el)) {
        const box = el.getBoundingClientRect();
        document.querySelectorAll('[role="listbox"]').forEach((list) => {
          const r = list.getBoundingClientRect?.();
          if (!r || r.height <= 0 || !isShowing(list)) return;
          const below = r.top >= box.top && r.top - box.bottom < 80;
          const above = r.bottom <= box.bottom && box.top - r.bottom < 80;
          const overlaps = r.left < box.right && r.right > box.left;
          if ((below || above) && overlaps) list.querySelectorAll(SUGGESTION_ROW_SELECTOR).forEach(add);
        });
      }
    } catch {}
    return rows.slice(0, 40);
  }

  /** "City of Jacksonville, FL, USA" → { city, region, country }. */
  function placeSuggestionText(row) {
    const query = row?.querySelector?.('.pac-item-query');
    if (!query) return clean(row?.textContent);
    // Google renders city and qualifiers in adjacent spans with no text-node
    // separator. textContent alone reads "StanleyNorth Carolina, USA".
    const rest = [];
    for (let node = query.nextSibling; node; node = node.nextSibling) {
      const text = clean(node.textContent);
      if (text) rest.push(text);
    }
    return [clean(query.textContent), ...rest].filter(Boolean).join(', ');
  }
  const COUNTRY_US_RE = /^(us|usa|u s|u s a|united states|united states of america|america)$/;
  function parsePlace(text) {
    const parts = String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const city = regionKey(parts[0]).replace(/^(city|town|village|township|borough|municipality|county)\s+of\s+/, "").trim();
    let region = null;
    let country = null;
    for (const part of parts.slice(1)) {
      const key = regionKey(part);
      if (!region) {
        const id = regionId(part);
        if (id) { region = id; continue; }
      }
      if (COUNTRY_US_RE.test(key)) country = "US";
      else if (/^(canada|ca|can)$/.test(key)) country = "CA";
      else if (/^(india|in|ind)$/.test(key)) country = "IN";
      else if (/^(australia|au|aus)$/.test(key)) country = "AU";
      else if (key && !country) country = key;
    }
    if (!country && region) country = region.split("-")[0];
    return { city, region, country, exactCity: regionKey(parts[0]) === city };
  }

  /**
   * How well a suggestion names the applicant's place. 0 is a refusal.
   *
   * The city has to be the same city — "Jacksonville Beach" is a different
   * place from Jacksonville, and "Jacksonville, NC" a different Jacksonville.
   * A state or country that disagrees rules a row out; one that is simply not
   * shown does not.
   */
  function placeScore(rowText, want) {
    const row = parsePlace(rowText);
    if (!row || !want?.city || row.city !== want.city) return 0;
    if (want.region && row.region && row.region !== want.region) return 0;
    if (want.country && row.country && row.country !== want.country) return 0;
    let score = 100;
    if (!row.exactCity) score -= 4;                  // "City of …"
    if (want.region && row.region === want.region) score += 20;
    if (want.country && row.country === want.country) score += 5;
    return score;
  }

  function wantedPlace(value, hint) {
    const want = parsePlace(value);
    if (!want?.city) return null;
    const hinted = hint && parsePlace([hint.city, hint.state, hint.country].filter(Boolean).join(', '));
    if (hinted?.city === want.city) {
      if (!want.region) want.region = hinted.region;
      if (!want.country) want.country = hinted.country;
    }
    return want;
  }

  function distinctPlaces(a, b) {
    const first = parsePlace(a), second = parsePlace(b);
    return first?.region !== second?.region || first?.country !== second?.country;
  }

  /** The country a whole suggestion names: "United States", "USA", "India". */
  function countryOfText(text) {
    const key = regionKey(text);
    if (!key) return null;
    if (COUNTRY_US_RE.test(key)) return "US";
    if (/^(canada|can)$/.test(key)) return "CA";
    if (/^(india|ind)$/.test(key)) return "IN";
    if (/^(australia|aus)$/.test(key)) return "AU";
    return key;
  }

  /**
   * A suggestion that names the applicant's state or country, not their city.
   *
   * Some location boxes only list states or countries — typing "uni" offers
   * United States, United Kingdom, United Arab Emirates… — so no suggestion
   * could ever name the applicant's city and the box was left empty. When the
   * city searches find nothing, the state and then the country are searched,
   * and only the row that *is* that state or country is taken: "United
   * States", never "United States Minor Outlying Islands" or "US Virgin
   * Islands".
   */
  function areaScore(rowText, want, level) {
    const parts = String(rowText ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return 0;
    if (level === "region") {
      if (!want.region || regionId(parts[0]) !== want.region) return 0;
      // "Florida, United States" — anything after the state must agree with it.
      for (const rest of parts.slice(1)) {
        const country = countryOfText(rest);
        if (country && want.country && country !== want.country && !regionId(rest)) return 0;
      }
      return 80;
    }
    if (level === "country") {
      if (!want.country || parts.length !== 1) return 0;
      return countryOfText(parts[0]) === want.country ? 60 : 0;
    }
    return 0;
  }

  /** Where a box's own search shows its state: its wrapper, and the list it names. */
  function searchScopes(el) {
    const scopes = [];
    let node = el.parentElement;
    for (let d = 0; node && d < 3; d++, node = node.parentElement) {
      if (node === document.body || !ownsOnlyThisField(node, el)) break;
      scopes.push(node);
    }
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of String(el.getAttribute?.(attr) || "").split(/\s+/).filter(Boolean)) {
        const found = document.getElementById(id);
        if (found) scopes.push(found);
      }
    }
    return scopes;
  }

  /** A search still running: "Loading…", a spinner, `aria-busy`. */
  const SEARCHING_SELECTOR =
    '[class*="loading" i], [class*="spinner" i], [class*="searching" i], [aria-busy="true"], [role="progressbar"]';
  function searchInProgress(el) {
    if (el.getAttribute?.("aria-busy") === "true") return true;
    for (const scope of searchScopes(el)) {
      let notes = [];
      try { notes = scope.querySelectorAll(SEARCHING_SELECTOR); } catch {}
      for (const note of notes) {
        if (note === el || note.contains(el)) continue;
        const r = note.getBoundingClientRect?.();
        if (isShowing(note) && r && r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  /** A suggestion's words as a person reads them: "1200 Harbor View Dr, Jacksonville, FL 32205". */
  function rowText(node) {
    let text = "";
    try { text = node.innerText; } catch {}
    if (!text) text = node?.textContent || "";
    // Parts drawn side by side in spans ("8451 Gate Pkwy W" + "Jacksonville,
    // FL, USA" in a Google Places row) run together; they are read as parts.
    if (!/\n/.test(String(text).trim())) {
      try {
        const parts = Array.from(node.children || []).map((c) => clean(c.textContent)).filter(Boolean);
        const loose = Array.from(node.childNodes || []).some((n) => n.nodeType === 3 && clean(n.textContent));
        if (parts.length >= 2 && !loose) text = parts.join("\n");
      } catch {}
    }
    return clean(String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean).join(", "));
  }

  /* ------------------------------------------------------------------ */
  /*  Street address suggestions                                         */
  /* ------------------------------------------------------------------ */

  const STREET_WORDS = {
    N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST", NE: "NORTHEAST", NW: "NORTHWEST", SE: "SOUTHEAST", SW: "SOUTHWEST",
    ST: "STREET", STR: "STREET", AVE: "AVENUE", AV: "AVENUE", RD: "ROAD", DR: "DRIVE", BLVD: "BOULEVARD",
    LN: "LANE", CT: "COURT", PL: "PLACE", PKWY: "PARKWAY", PKY: "PARKWAY", HWY: "HIGHWAY", TER: "TERRACE",
    TERR: "TERRACE", CIR: "CIRCLE", TRL: "TRAIL", WAY: "WAY", SQ: "SQUARE", PT: "POINT", CV: "COVE",
    XING: "CROSSING", EXPY: "EXPRESSWAY", FWY: "FREEWAY", LOOP: "LOOP", RUN: "RUN", PASS: "PASS", PIKE: "PIKE",
    MT: "MOUNT", FT: "FORT",
  };
  const UNIT_RE = /(?:^|[\s,])((?:APT|APARTMENT|UNIT|STE|SUITE|BLDG|BUILDING|FL|FLOOR|RM|ROOM|LOT|SPC|SPACE|TRLR|#)\.?\s*#?\s*[A-Z0-9][A-Z0-9-]*)\s*$/i;

  /** "1200 Harbor View Dr Apt 305" → { number: "1200", words: ["HARBOR","VIEW","DRIVE"], unit: "Apt 305" }. */
  function parseStreet(text) {
    let line = clean(String(text ?? "").split(",")[0]);
    let unit = null;
    const m = line.match(UNIT_RE);
    if (m && m.index > 0) {
      unit = clean(m[1]);
      line = clean(line.slice(0, m.index));
    }
    const tokens = line.toUpperCase().replace(/[.#]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || !/^\d+[A-Z]?(-\d+)?$/.test(tokens[0])) return null;
    return { number: tokens[0], words: tokens.slice(1).map((w) => STREET_WORDS[w] || w), unit };
  }

  /**
   * How surely a suggestion is the applicant's street address. 0 is a refusal.
   *
   * The house number and every word of the street must agree — "Harbor View
   * Rd" is not "Harbor View Dr" — and a ZIP or city the suggestion shows must
   * be the applicant's. Abbreviations are read either way ("Pkwy W" is
   * "Parkway West").
   */
  function addressScore(text, want, { zip, city } = {}) {
    const parts = String(text ?? "").split(",").map((s) => clean(s)).filter(Boolean);
    if (!parts.length) return 0;
    const row = parseStreet(parts[0]);
    if (!row || row.number !== want.number) return 0;
    const mine = want.words.join(" ");
    const theirs = row.words.join(" ");
    if (mine !== theirs && !(theirs.startsWith(`${mine} `) && row.words.length - want.words.length <= 1)) return 0;
    const rest = parts.slice(1).join(" ").toUpperCase();
    let score = 100;
    const shownZip = rest.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
    const wantZip = String(zip ?? "").match(/\d{5}/)?.[0];
    if (shownZip && wantZip) {
      if (shownZip !== wantZip) return 0;
      score += 10;
    }
    const wantCity = clean(city).toUpperCase();
    if (wantCity && rest) {
      if (new RegExp(`(^|\\W)${wantCity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`).test(rest)) score += 5;
      else if (!shownZip) return 0;
    }
    return score;
  }

  function dismissSuggestions(el) {
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true });
    try { el.dispatchEvent(esc()); } catch {}
  }

  /**
   * Address Line 1, finished from the box's own suggestions.
   *
   * Oracle offers addresses as Address Line 1 is typed, and picking one is also
   * what fills ZIP Code, City, State and County. The list used to be left open
   * over the form with nothing picked. The suggestion that is the applicant's
   * own address is picked; none is picked on a guess, and the list is closed.
   *
   * Returns the picked suggestion's text, false when suggestions came and none
   * was the address, and null when the box offered none.
   */
  async function completeAddressSuggestion(el, value, { zip, city, waitMs = 2200, stale = null } = {}) {
    const text = String(value ?? "").trim();
    if (!text || !looksLikeTypeahead(el)) return null;
    const want = parseStreet(text);
    if (!want) return null;
    // Suggestions still on screen from an earlier search are not this one's.
    const fresh = () => suggestionRowsFor(el).filter((row) => !stale?.has(rowText(row)));

    const started = Date.now();
    let rows = [];
    let noteSince = 0;
    while (Date.now() - started < waitMs || (Date.now() - started < 3500 && searchInProgress(el))) {
      rows = fresh();
      if (rows.length) break;
      if (!searchInProgress(el) && noSuggestionsShown(el)) {
        if (!noteSince) noteSince = Date.now();
        if (Date.now() - started > 900 && Date.now() - noteSince > 450) break;
      } else {
        noteSince = 0;
      }
      await wait(60);
    }
    if (!rows.length) {
      dismissSuggestions(el);
      return null;
    }
    // A list that is still arriving is given a moment to finish.
    await wait(80);
    rows = fresh();

    let best = null, bestScore = 0;
    for (const row of rows) {
      const score = addressScore(rowText(row), want, { zip, city });
      if (score > bestScore) { best = row; bestScore = score; }
    }
    if (!best) {
      dismissSuggestions(el);
      return false;
    }
    if (!bestScore) return false;
    const chosen = rowText(best);
    const before = clean(el.value ?? "");
    try { best.scrollIntoView?.({ block: "nearest" }); } catch {}
    try { fire(best, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { best.click?.(); } catch {}
    const until = Date.now() + 600;
    while (Date.now() < until && document.contains(best) && isShowing(best) && clean(el.value ?? "") === before) {
      await wait(30);
    }
    try { el.blur?.(); } catch {}
    return chosen;
  }

  /** "No location found" — the search answered, with nothing in it. */
  function noSuggestionsShown(el) {
    let node = el.parentElement;
    for (let d = 0; node && d < 3; d++, node = node.parentElement) {
      if (node === document.body || !ownsOnlyThisField(node, el)) break;
      let notes = [];
      try { notes = node.querySelectorAll('[class*="no-result" i], [class*="noresult" i], [class*="no-match" i], [class*="empty-state" i], [class*="no-options" i], [class*="noOptions" i]'); } catch {}
      for (const note of notes) {
        const r = note.getBoundingClientRect?.();
        if (isShowing(note) && r && r.height > 0 && clean(note.textContent)) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Oracle Recruiting's lists                                          */
  /* ------------------------------------------------------------------ */

  /**
   * The list boxes of Oracle Recruiting's application pages.
   *
   * Two kinds are in use. Candidate Experience's own list box: an
   * `<input class="cx-select-input" role="combobox">` you type into, opened by
   * ArrowDown or by the `#<id>-toggle-button` beside it, its choices the rows
   * of a grid in `#<id>-listbox` (`div[role=row] > div[role=gridcell] >
   * span.cx-select__list-item--content`). And Oracle JET's `<oj-select-single>`:
   * a click hides its box and hands the caret to a search box of its own, and
   * the choices are rows of a grid in a layer at the end of the page
   * (`#lovDropdown_<id>`). Either way the choices come from Oracle's server a
   * moment after the list opens or the search changes, there is no
   * `role="option"` anywhere, and only a choice picked from the list is kept:
   * text typed into the box is thrown away when the box is left.
   *
   * The generic drop-down code read the typed search text back as the answer,
   * so Gender, Veteran Status, ZIP Code, City, State and County were reported
   * as chosen while nothing was — and Oracle emptied them when the caret moved.
   */
  const ORACLE_SELECT_INPUT = "input.cx-select-input, input.oj-searchselect-input, input.oj-combobox-input";
  const JET_SELECT_HOST = "oj-select-single, oj-c-select-single, oj-select-one, oj-combobox-one, oj-c-combobox-one";

  function isOracleSelect(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if (/^(?:tel|tel-national|tel-local)$/i.test(el.getAttribute("autocomplete") || "") ||
        (/^(?:tel|numeric)$/i.test(el.getAttribute("inputmode") || "") && el.getAttribute("role") !== "combobox")) return false;
    try { return el.matches(ORACLE_SELECT_INPUT) || Boolean(el.closest(JET_SELECT_HOST)); } catch { return false; }
  }

  function jetSelectHost(el) {
    try { return el?.closest?.(JET_SELECT_HOST) || null; } catch { return null; }
  }

  /** The button beside a list box that opens its list (`#<id>-toggle-button`). */
  function oracleToggle(el) {
    if (!el) return null;
    try {
      if (el.id) {
        const byId = document.getElementById(`${el.id}-toggle-button`);
        if (byId) return byId;
      }
      const box = el.closest(".cx-select-container, .input-row__control-container") || el.parentElement;
      const buttons = Array.from(box?.querySelectorAll?.("button, [role='button']") || []);
      return buttons.find((b) => /\b(open|show|toggle)\b[^|]*\b(list|options|drop-?down)\b/i.test(
        `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`)) ||
        buttons.find((b) => /toggle/i.test(`${b.id || ""} ${typeof b.className === "string" ? b.className : ""}`)) || null;
    } catch { return null; }
  }

  /** Is the box's list open, by what the box and its button say? */
  function oracleExpanded(el) {
    return el?.getAttribute?.("aria-expanded") === "true" || oracleToggle(el)?.getAttribute?.("aria-expanded") === "true";
  }

  /** The box that takes the typing: JET's own search box once its list is open, else the box itself. */
  function oracleTypingBox(el) {
    const host = jetSelectHost(el);
    if (!host) return el;
    // JET hides its own box while its list is open; closed, the box is the box.
    let hidden = false;
    try { hidden = getComputedStyle(el).visibility === "hidden"; } catch {}
    const active = document.activeElement;
    if (active && active !== el && active.tagName === "INPUT" && host.contains(active)) return active;
    if (!hidden) return el;
    try {
      const filter = host.querySelector("input.oj-searchselect-filter-input, .oj-searchselect-filter input");
      if (filter && filter !== el) return filter;
    } catch {}
    return el;
  }

  /** The element the box shows its choices in, or null. */
  function oracleListOf(el, typing = null) {
    const host = jetSelectHost(el);
    const ids = [];
    for (const node of [typing, el, oracleToggle(el)]) {
      for (const attr of ["aria-controls", "aria-owns"]) {
        const v = node?.getAttribute?.(attr);
        if (v) ids.push(...String(v).split(/\s+/));
      }
    }
    if (el?.id) ids.push(`${el.id}-listbox`);
    if (host?.id) ids.push(`lovDropdown_${host.id}`, `oj-listbox-results-${host.id}`);
    for (const id of ids) {
      if (!id) continue;
      const node = document.getElementById(id);
      if (node) return node;
    }
    return null;
  }

  const oracleNoResults = (text) => NO_RESULTS_RE.test(text) || /^no\s+(results|matches)\b/i.test(text);

  /** The choices a list shows — `{ row, cell, text }` — "No results" left out. */
  function oracleRows(list) {
    if (!list || !document.contains(list)) return [];
    let cells = [];
    try { cells = Array.from(list.querySelectorAll('[role="gridcell"], [role="option"]')); } catch {}
    const out = [];
    const seen = new Set();
    for (const cell of cells) {
      const row = cell.closest?.('[role="row"]') || cell;
      if (seen.has(row)) continue;
      const r = cell.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0 || !isShowing(cell)) continue;
      const content = cell.querySelector?.(".cx-select__list-item--content") || cell;
      const text = clean(content.textContent);
      if (!text || oracleNoResults(text)) continue;
      seen.add(row);
      out.push({ row, cell, text });
    }
    return out;
  }

  /** Still fetching from the server: `aria-busy`, or a loading line on show. */
  function oracleListBusy(list) {
    if (!list) return false;
    try {
      if (list.getAttribute("aria-busy") === "true" || list.querySelector('[aria-busy="true"]')) return true;
      for (const note of list.querySelectorAll(".oj-listview-status-message, [class*='loading' i], [class*='spinner' i]")) {
        const r = note.getBoundingClientRect?.();
        if (r && r.height > 0 && isShowing(note)) return true;
      }
    } catch {}
    return false;
  }

  /** The list answered, with nothing in it ("No results found."). */
  function oracleListSaysNothing(list) {
    if (!list) return false;
    try {
      return Array.from(list.querySelectorAll('[role="gridcell"], [role="option"], [class*="no-result" i], li, p, div'))
        .some((n) => n.children.length <= 2 && isShowing(n) && oracleNoResults(clean(n.textContent)));
    } catch { return false; }
  }

  function oracleKey(el, key) {
    const codes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 };
    const init = { key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true };
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
    } catch {}
  }

  /** Text written into the box the way Oracle's search reads it: the value, then an input event. */
  function oracleType(box, text) {
    try { if (!holdsFocus(box)) takeFocusAnnounced(box); } catch {}
    try {
      const writer = nativeSetter(box);
      if (writer) writer.call(box, text); else box.value = text;
      const tracker = box._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
    } catch { try { box.value = text; } catch {} }
    try {
      box.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: text ? "insertText" : "deleteContentBackward" }));
    } catch { fire(box, "input"); }
    fire(box, "keyup");
  }

  /** The list opened, by ArrowDown, the button beside it, or a click — whichever the box answers. */
  async function openOracleList(el) {
    const host = jetSelectHost(el);
    const open = () => oracleExpanded(el) || oracleTypingBox(el) !== el || oracleRows(oracleListOf(el, oracleTypingBox(el))).length > 0;
    try { ensureVisible(el); } catch {}
    if (host) {
      clickLikeUser(el);
      for (let t = 0; t < 12 && !open(); t++) await wait(40);
      if (!open()) { takeFocusAnnounced(el); oracleKey(el, "ArrowDown"); await wait(150); }
    } else {
      takeFocusAnnounced(el);
      if (!open()) { oracleKey(el, "ArrowDown"); await wait(120); }
      const toggle = oracleToggle(el);
      if (!open() && toggle) { clickLikeUser(toggle); await wait(150); }
      if (!open()) { clickLikeUser(el); await wait(120); }
    }
    return oracleTypingBox(el);
  }

  /**
   * The rows the list settles on: waited for while Oracle is fetching, and —
   * after a search — until they are no longer the rows shown before it.
   */
  async function oracleWaitRows(el, typing, { waitMs = 6000, previous = null, settleMs = 220 } = {}) {
    const started = Date.now();
    let rows = [];
    let lastSig = null;
    let stableSince = 0;
    let nothingSince = 0;
    // "No results" is believed only once the server has had time to answer:
    // the list keeps saying it about the last search while this one is out.
    const patience = Math.min(waitMs, 2400);
    while (Date.now() - started < waitMs) {
      const list = oracleListOf(el, typing);
      rows = oracleRows(list);
      const sig = rows.map((r) => r.text).join("|");
      const busy = oracleListBusy(list);
      if (rows.length && !busy) {
        nothingSince = 0;
        // Rows left from the last search are not this one's answer — unless
        // nothing else turns up for a good while.
        const stale = previous !== null && sig === previous && Date.now() - started < 1600;
        if (!stale) {
          if (sig === lastSig) {
            if (Date.now() - stableSince >= settleMs) return rows;
          } else {
            lastSig = sig;
            stableSince = Date.now();
          }
        }
      } else if (!busy && !rows.length && oracleListSaysNothing(list)) {
        if (!nothingSince) nothingSince = Date.now();
        if (Date.now() - started > patience && Date.now() - nothingSince > 600) return [];
      } else {
        nothingSince = 0;
      }
      await wait(70);
    }
    return rows;
  }

  /** The row that is the answer, with its score, or null. */
  function oracleBestRow(rows, value, { synonyms, hint, scorer } = {}) {
    if (!rows.length) return null;
    if (scorer) {
      let best = null, bestScore = 0;
      for (const r of rows) {
        const s = Number(scorer(r.text, rows)) || 0;
        if (s > bestScore) { best = r; bestScore = s; }
      }
      return best ? { ...best, score: bestScore } : null;
    }
    const answer = String(value ?? "");
    const texts = rows.map((r) => r.text);
    const strict = eeoId(answer, hint) ? null : strictChoiceScores(texts, answer, []);
    const targets = [answer, norm(answer), ...synonymsFor(synonyms, answer)].filter(Boolean);
    const primary = [answer, norm(answer)].filter(Boolean).length;
    let best = null, bestScore = 0;
    rows.forEach((r, i) => {
      const s = strict ? (strict[i] ?? 0) : optionScoreForTarget(r.cell, targets, hint, primary);
      if (s > bestScore) { best = r; bestScore = s; }
    });
    return best && bestScore >= 55 ? { ...best, score: bestScore } : null;
  }

  function oracleInvalid(el) {
    try {
      return el.classList?.contains("cx-select-input--invalid") || el.getAttribute("aria-invalid") === "true" ||
        Boolean(el.closest?.(".input-row")?.classList?.contains("input-row--invalid")) ||
        Boolean(jetSelectHost(el)?.classList?.contains("oj-invalid"));
    } catch { return false; }
  }

  /**
   * Did the list keep the choice? The box shows it (or, for an address, the
   * street it names), its list has closed, nothing is flagged — and what the
   * box shows is not merely the search that was typed.
   */
  function oracleTookNow(el, chosen, typed, hostBefore, accept) {
    const shown = clean(el.value ?? "");
    if (!shown || oracleInvalid(el)) return false;
    // JET keeps the chosen row's key as the drop-down's own value.
    const host = jetSelectHost(el);
    if (host && hostBefore !== undefined) {
      let now;
      try { now = host.value; } catch {}
      if (now !== undefined && now !== null && now !== "" && now !== hostBefore) return true;
    }
    if (oracleExpanded(el) || oracleTypingBox(el) !== el) return false;
    if (accept) return Boolean(accept(shown, chosen.text));
    if (typed && norm(shown) === norm(typed) && norm(chosen.text) !== norm(typed)) return false;
    const a = normalizeChoiceText(shown);
    const b = normalizeChoiceText(chosen.text);
    return a === b || b.startsWith(a) || a.startsWith(b) || canonicalAgreement(shown, chosen.text) === true;
  }

  async function oracleWaitTook(el, chosen, typed, hostBefore, accept, ms = 1200) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (oracleTookNow(el, chosen, typed, hostBefore, accept)) return true;
      await wait(60);
    }
    return oracleTookNow(el, chosen, typed, hostBefore, accept);
  }

  /** The row, walked to with the arrow keys and taken with Enter — how Oracle's lists are built to be used. */
  async function oracleChooseByKeys(el, typing, chosen) {
    const box = typing || el;
    try { if (!holdsFocus(box)) takeFocusAnnounced(box); } catch {}
    const current = () => {
      const row = oracleRows(oracleListOf(el, typing)).find((r) => r.text === chosen.text) || chosen;
      const ad = box.getAttribute("aria-activedescendant") || el.getAttribute("aria-activedescendant");
      if (ad) {
        const node = document.getElementById(ad);
        if (node && (node === row.row || node === row.cell || row.row.contains(node) || node.contains(row.row))) return true;
      }
      const cls = `${typeof row.row.className === "string" ? row.row.className : ""} ${typeof row.cell.className === "string" ? row.cell.className : ""}`;
      return /(^|\s)(oj-listview-current-item|oj-focus-highlight|[\w-]+--(active|focused|highlighted|current))(\s|$)/.test(cls);
    };
    for (let i = 0; i < 80 && !current(); i++) {
      oracleKey(box, "ArrowDown");
      await wait(35);
    }
    if (!current()) return false;
    oracleKey(box, "Enter");
    await wait(150);
    return true;
  }

  async function closeOracleList(el, typing) {
    if (!oracleExpanded(el) && oracleTypingBox(el) === el) return;
    oracleKey(typing || el, "Escape");
    await wait(90);
    if (oracleExpanded(el)) {
      const toggle = oracleToggle(el);
      if (toggle && toggle.getAttribute("aria-expanded") === "true") { clickLikeUser(toggle); await wait(90); }
    }
  }

  /**
   * An answer chosen in one of Oracle's list boxes, as a person chooses it:
   * the list opened, the answer looked for among its rows (and searched for in
   * the box when it is not there), the row clicked — or, when a click does not
   * take, walked to with the arrow keys and taken with Enter — and the box read
   * back. True only when the box keeps the choice.
   *
   * `search` (and `alternates`) is the text to search for; `scorer(rowText)`
   * replaces the usual matching (a ZIP Code, a city, an address); with
   * `onlyChoice` and no answer, a list offering exactly one row is answered
   * with it. `budgetMs` caps the time all the searches together may take.
   */
  const oracleTrace = (...args) => { try { if (window.__APPLI_FILL_TRACE_ORACLE) console.log("[oracle]", ...args); } catch {} };

  async function setOracleSelectValue(el, value, { synonyms, hint, search = null, alternates = [], scorer = null, accept = null, onlyChoice = false, force = false, waitMs = 6500, budgetMs = 0 } = {}) {
    if (!isOracleSelect(el)) return false;
    const answer = String(value ?? "").trim();
    if (!answer && !onlyChoice) return false;
    if (!force && answer && !scorer && !search && valuesEquivalent(el, answer, hint) && !oracleInvalid(el) && !oracleExpanded(el)) return true;
    const host = jetSelectHost(el);
    let hostBefore;
    try { hostBefore = host ? host.value : undefined; } catch {}

    let typing = await openOracleList(el);
    oracleTrace("opened", el.id, "typing:", typing?.id, "expanded:", oracleExpanded(el), "list:", oracleListOf(el, typing)?.id);
    const pickFrom = (rows) => {
      if (!answer) return onlyChoice && rows.length === 1 ? { ...rows[0], score: 100 } : null;
      return oracleBestRow(rows, answer, { synonyms, hint, scorer });
    };

    // What the list offers before anything is typed — a short list of answers
    // (Gender, Veteran Status) is chosen from as it is.
    let rows = await oracleWaitRows(el, typing, { waitMs: search ? 700 : 2600 });
    let best = search ? null : pickFrom(rows);
    let typed = "";
    const regionText = answer ? regionName(regionId(answer, { loose: true }) || "") : "";
    const searches = Array.from(new Set([search, regionText || answer, ...alternates]
      .map((s) => String(s ?? "").trim()).filter(Boolean)));
    const searchStarted = Date.now();
    for (const text of searches) {
      if (best || !answer) break;
      // A search that has had its time: the rest are not tried.
      const left = budgetMs ? budgetMs - (Date.now() - searchStarted) : waitMs;
      if (left < 800) break;
      const previous = rows.map((r) => r.text).join("|");
      typing = oracleTypingBox(el);
      oracleType(typing, text);
      typed = text;
      await wait(120);
      rows = await oracleWaitRows(el, typing, { waitMs: Math.min(waitMs, left), previous: previous || null });
      best = pickFrom(rows);
      oracleTrace("searched", JSON.stringify(text), "typing:", typing?.id, "rows:", rows.map((r) => r.text), "best:", best?.text, best?.score);
    }

    if (!best) {
      // Nothing fits: the search is taken back out, so the box is not left
      // holding text Oracle will reject, and the list is closed.
      if (typed) { oracleType(oracleTypingBox(el), ""); await wait(60); }
      await closeOracleList(el, typing);
      el.__applifillNoMatch = rows.length >= 3 && Boolean(answer);
      return false;
    }

    const fresh = () => oracleRows(oracleListOf(el, typing)).find((r) => r.text === best.text) || best;
    const stillOpen = () => oracleExpanded(el) || oracleTypingBox(el) !== el;
    // A click on the row; then the arrow keys and Enter, which is how these
    // lists are built to be used (a list that ignores a click that is not a
    // person's still takes the keyboard); then a person's whole click.
    let took = false;
    {
      const r = fresh();
      try { r.cell.scrollIntoView?.({ block: "nearest" }); } catch {}
      try { r.cell.click?.(); } catch {}
      took = await oracleWaitTook(el, best, typed, hostBefore, accept, 800);
    }
    if (!took && stillOpen()) {
      if (await oracleChooseByKeys(el, oracleTypingBox(el), best)) took = await oracleWaitTook(el, best, typed, hostBefore, accept, 1000);
    }
    if (!took && stillOpen() && document.contains(fresh().cell)) {
      clickLikeUser(fresh().cell);
      took = await oracleWaitTook(el, best, typed, hostBefore, accept, 800);
    }
    await closeOracleList(el, oracleTypingBox(el));
    // Leave the box, as a person moving on does, and read it once more: Oracle
    // empties a box whose text was only typed, never picked, when it is left.
    if (took) {
      try { if (holdsFocus(el)) leaveLikeUser(el); } catch {}
      await wait(260);
      took = oracleTookNow(el, best, typed, hostBefore, accept);
    }
    el.__applifillNoMatch = false;
    return took;
  }

  /**
   * How surely one of Oracle's address suggestions is the applicant's street.
   * 0 is a refusal.
   *
   * Read word by word, so a suggestion with or without commas reads the same
   * ("8451 GATE PKWY W JACKSONVILLE FL 32216", "8451 Gate Pkwy W, Jacksonville,
   * FL 32216"): the house number and every word of the street must agree, in
   * order, abbreviations read either way. A ZIP Code shown must be theirs — or,
   * if Oracle knows the street under another ZIP Code, the city must be.
   */
  function streetRowScore(text, want, { zip, city } = {}) {
    const tokens = String(text ?? "").toUpperCase().replace(/[.#]/g, " ").split(/[\s,]+/).filter(Boolean)
      .map((w) => STREET_WORDS[w] || w);
    if (!want || tokens[0] !== want.number) return 0;
    for (let i = 0; i < want.words.length; i++) if (tokens[1 + i] !== want.words[i]) return 0;
    const rest = tokens.slice(1 + want.words.length).join(" ");
    const shownZip = rest.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
    const wantZip = String(zip ?? "").match(/\d{5}/)?.[0];
    const cityKey = clean(city).toUpperCase().replace(/[.#,]/g, " ").split(/\s+/).filter(Boolean)
      .map((w) => STREET_WORDS[w] || w).join(" ");
    const cityShown = Boolean(cityKey) && new RegExp(`(^|\\W)${cityKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`).test(rest);
    if (shownZip && wantZip && shownZip !== wantZip) return cityShown ? 60 : 0;
    let score = 100;
    if (shownZip && wantZip) score += 10;
    if (cityKey && rest) {
      if (cityShown) score += 5;
      else if (!shownZip) return 0;
    }
    return score;
  }

  /** "8451 Gate Pkwy W Apt 128" → "8451 Gate Pkwy W": the street as written, its unit left off. */
  function streetWithoutUnit(text) {
    const line = clean(String(text ?? "").split(",")[0]);
    const m = line.match(UNIT_RE);
    return m && m.index > 0 ? clean(line.slice(0, m.index)) : line;
  }

  /**
   * Address Line 1 on Oracle's application, picked from Oracle's own address
   * search.
   *
   * The street is searched with the city and state ("8451 Gate Pkwy W,
   * Jacksonville, Florida" — how Oracle's search finds one place), then alone,
   * then with its unit; the apartment is never part of the search, as the
   * search does not know it. The suggestion that is the applicant's address —
   * same house number, same street, and their ZIP Code or city — is picked;
   * picking it is what fills ZIP Code, City, State and County.
   *
   * Returns the picked suggestion's text, or null when none was picked.
   */
  async function pickOracleAddress(el, street, { city, state, zip } = {}) {
    const want = parseStreet(street);
    if (!want || !isOracleSelect(el)) return null;
    const bare = streetWithoutUnit(street);
    const region = regionId(state, { loose: true });
    const stateName = regionName(region || "") || clean(state);
    const stateCode = region ? regionCode(region) : null;
    const withPlace = [bare, clean(city), stateName].filter(Boolean).join(", ");
    const withCode = stateCode ? [bare, clean(city), stateCode].filter(Boolean).join(", ") : "";
    const searches = Array.from(new Set([withPlace, withCode, bare, clean(String(street).split(",")[0])].filter(Boolean)));
    const scorer = (text) => streetRowScore(text, want, { zip, city });
    let chosen = null;
    const accept = (shown) => {
      const got = parseStreet(shown);
      return Boolean(got && got.number === want.number);
    };
    const ok = await setOracleSelectValue(el, bare, {
      search: searches[0], alternates: searches.slice(1), accept,
      scorer: (text, rows) => { const s = scorer(text, rows); if (s && (!chosen || s > chosen.s)) chosen = { text, s }; return s; },
      // Oracle's address search answers within a few seconds or not at all:
      // all the searches together are given 15 seconds, not 7 each.
      waitMs: 7000,
      budgetMs: 15000,
    });
    return ok ? (chosen?.text || clean(el.value)) : null;
  }

  /**
   * A radio button or check box drawn by its label.
   *
   * Oracle Recruiting draws every Yes / No question and every box of its
   * diversity questions this way: the `<input>` is 0 x 0 and see-through
   * (`.input-row__hidden-control`) and the `<label for>` beside it shows the
   * choice — "Yes", "No", "Asian". The input was refused as invisible, so not
   * one of those questions was ever answered. The input is still the control
   * the page reads, and a click on its label is how a person sets it.
   * Returns the label that shows it, or null.
   */
  function labelDrawnChoice(el) {
    if (!el || el.tagName !== "INPUT" || !/^(radio|checkbox)$/i.test(el.type || "")) return null;
    // Oracle's way of drawing them. Elsewhere an input the page hides is left
    // alone, as it always was.
    if (!onOracleCandidateExperience()) return null;
    if (el.disabled || el.getAttribute("aria-hidden") === "true" || el.tabIndex < 0) return null;
    try {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return null;
      for (const label of Array.from(el.labels || [])) {
        const r = label.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && isShowing(label) && clean(label.textContent)) return label;
      }
    } catch {}
    return null;
  }

  /**
   * The label that is a label-drawn choice's own ("Yes", "Asian") — not the
   * question's (`label.input-row__label`), even when the question's
   * `<label for>` names this choice. Null unless there is exactly one.
   */
  function choiceOwnLabel(el) {
    if (!labelDrawnChoice(el)) return null;
    try {
      const own = Array.from(el.labels || []).filter((label) => {
        if (label.classList?.contains("input-row__label")) return false;
        const r = label.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && isShowing(label) && Boolean(clean(label.textContent));
      });
      return own.length === 1 ? own[0] : null;
    } catch { return null; }
  }

  /* ------------------------------------------------------------------ */
  /*  ADP's SDF components                                               */
  /* ------------------------------------------------------------------ */

  /**
   * ADP's application pages are built from `sdf-*` web components.
   *
   * ADP Recruiting Management (myjobs.adp.com) draws every question as an
   * `adp-form-group` whose label is `label.form-control-label` and whose
   * control is an SDF element: the box you type into sits inside that
   * element's shadow root, where no label reaches it, and the lists, radio
   * groups and check boxes are elements that draw their own choices. Workforce
   * Now (workforcenow.adp.com) uses the same radio groups and lists for its
   * questions. None of it was answered: the boxes read as "off | input", the
   * lists as their placeholder "Select", and every write was refused because
   * a box inside a shadow root is not `document.contains`'d.
   *
   * The questions are now read off the group (or the component's own label,
   * or the row above it), the boxes are typed into as before, and the lists,
   * radio groups and check boxes are answered the way a person does: the list
   * opened and the choice clicked (searched for first in a long list), the
   * radio button or the box clicked, and each read back from the component.
   */
  function onAdp() {
    try { return /(^|\.)adp\.com$/i.test(location.hostname); } catch { return false; }
  }

  /** The element whose shadow root holds `node`, or null. */
  function shadowHost(node) {
    try {
      const root = node?.getRootNode?.();
      return root && root !== document && root.host ? root.host : null;
    } catch { return null; }
  }

  /**
   * On ADP's pages, the element whose shadow root holds `node`; elsewhere null.
   * Everything that places a box drawn inside a component by the component
   * itself (its section, its row, its label, whether it is required) is for
   * ADP's components only: a site that draws its whole form inside one shadow
   * root is left exactly as it was.
   */
  function adpShadowHost(node) {
    return onAdp() ? shadowHost(node) : null;
  }

  /** The element in the page itself — outside every shadow root — that `node` is drawn in. */
  function pageHost(node) {
    let at = node;
    for (let i = 0; at && i < 10; i++) {
      const host = shadowHost(at);
      if (!host) return at;
      at = host;
    }
    return at;
  }

  /** `querySelectorAll` that also looks inside the open shadow roots under `root`. */
  function deepQueryAll(root, selector, limit = 600) {
    const out = [];
    if (!root) return out;
    const seen = new Set();
    const queue = [root];
    while (queue.length && out.length < limit) {
      const scope = queue.shift();
      let nodes = [];
      try { nodes = scope.querySelectorAll(selector); } catch {}
      for (const n of nodes) {
        if (!seen.has(n)) { seen.add(n); out.push(n); }
      }
      if (scope.shadowRoot) queue.push(scope.shadowRoot);
      let all = [];
      try { all = scope.querySelectorAll("*"); } catch {}
      for (const el of all) if (el.shadowRoot) queue.push(el.shadowRoot);
    }
    return out;
  }

  function deepQuery(root, selector) {
    return deepQueryAll(root, selector, 1)[0] || null;
  }

  const isSdfSelect = (el) => el?.tagName === "SDF-SELECT-SIMPLE";
  const isSdfRadioGroup = (el) => el?.tagName === "SDF-RADIO-GROUP";
  const isSdfCheckbox = (el) => el?.tagName === "SDF-CHECKBOX";
  /** A component answered as a whole: a list, a radio group, a check box. */
  const isSdfField = (el) => isSdfSelect(el) || isSdfRadioGroup(el) || isSdfCheckbox(el);
  const SDF_FIELD_SELECTOR = "sdf-select-simple, sdf-radio-group, sdf-checkbox";
  const SDF_CONTROL_TAGS = "sdf-input, sdf-textarea, sdf-select-simple, sdf-radio-group, sdf-checkbox, sdf-date-picker, sdf-phone-number-input";

  /** Components whose insides belong to them: never fields of their own. */
  const SDF_SELF_DRAWN = new Set([
    "SDF-SELECT-SIMPLE", "SDF-RADIO-GROUP", "SDF-RADIO-BUTTON", "SDF-CHECKBOX", "SDF-BUTTON",
    "SDF-ICON", "SDF-FLOATING-PANE", "SDF-SELECT-ITEM", "SDF-ICON-BUTTON",
  ]);

  /**
   * Part of an SDF component that is answered as a whole — the frame, list and
   * choices of an `sdf-select-simple`, the radio inside an `sdf-radio-button`,
   * a date picker's calendar button — rather than a field of its own. The box
   * of an `sdf-input`, `sdf-textarea`, `sdf-date-picker` or phone number is a
   * field, and is not one of these.
   */
  function sdfInnerPart(el) {
    if (!el) return false;
    let host = shadowHost(el);
    for (let i = 0; host && i < 10; i++, host = shadowHost(host)) {
      if (SDF_SELF_DRAWN.has(host.tagName)) return true;
      if (host.tagName === "SDF-DATE-PICKER" && el.tagName !== "INPUT") return true;
    }
    try { return !isSdfField(el) && Boolean(el.closest?.(SDF_FIELD_SELECTOR)); } catch { return false; }
  }

  const capLabel = (t) => (t.length > 300 ? `${t.slice(0, 300)}…` : t);
  const meaningful = (t) => Boolean(t) && t.length > 1 && !/^(error|required|\*|select|-+)$/i.test(t);

  /** An SDF component's own name for itself: aria, its `label`, a `<label for>`, the label it draws. */
  function sdfOwnLabel(host) {
    const root = host.getRootNode?.() || document;
    const byId = (id) => {
      try { return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id); } catch { return null; }
    };
    const aria = clean(host.getAttribute?.("aria-label") || "");
    if (meaningful(aria)) return aria;
    const named = clean(host.getAttribute?.("label") || "");
    if (meaningful(named)) return named;
    for (const id of String(host.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
      const node = byId(id);
      const t = node && node !== host && !node.contains?.(host) ? visibleText(node) : "";
      if (meaningful(t)) return t;
    }
    if (host.id) {
      try {
        const sel = `label[for="${CSS.escape(host.id)}"]`;
        const label = root.querySelector?.(sel) || document.querySelector(sel);
        const t = label ? visibleText(label) : "";
        if (meaningful(t)) return t;
      } catch {}
    }
    try {
      const drawn = host.querySelector?.(".sdf-form-control-wrapper--label") ||
        host.shadowRoot?.querySelector?.(".sdf-form-control-wrapper--label, label[part='label'], [part='label']");
      const t = drawn ? visibleText(drawn) : "";
      if (meaningful(t)) return t;
    } catch {}
    return "";
  }

  /**
   * The question printed in the row above an SDF control — how ADP's
   * prescreening questions (`#prescreeningForm`) are laid out: the question in
   * one `.section-row`, its radio group, list or box in the next.
   */
  function sectionRowQuestion(host) {
    const row = host.closest?.(".section-row");
    if (!row) return "";
    const holdsControl = (node) => {
      try { return Boolean(node.matches?.(SDF_CONTROL_TAGS) || node.querySelector?.(`${SDF_CONTROL_TAGS}, input, select, textarea`)); } catch { return false; }
    };
    const scan = (start) => {
      for (let prev = start, i = 0; prev && i < 2; prev = prev.previousElementSibling, i++) {
        if (holdsControl(prev)) return "";
        const t = visibleText(prev);
        if (meaningful(t) && t.length > 2) return t;
      }
      return "";
    };
    const above = scan(row.previousElementSibling) || scan(row.parentElement?.previousElementSibling);
    if (above) return above;
    try {
      const own = Array.from(row.querySelectorAll("label, .form-control-label, [class*='question' i], [class*='label' i]"))
        .find((n) => !n.contains(host) && !host.contains(n) && !holdsControl(n));
      const t = own ? visibleText(own) : "";
      return meaningful(t) ? t : "";
    } catch { return ""; }
  }

  /**
   * The words an ADP list shows before anything is chosen — "Select currency
   * type" — when they say more than "Select". Empty for anything else.
   */
  function sdfPlaceholder(el) {
    if (!el || !onAdp() || !isSdfSelect(el)) return "";
    try {
      const own = clean(el.getAttribute?.("placeholder") || "");
      const drawn = own ? "" : clean(el.shadowRoot?.querySelector?.(".placeholder, [part='placeholder']")?.textContent || "");
      const text = own || drawn;
      if (!text || /^(?:please\s+)?(?:select|choose)(?:\s+(?:one|an?\s+option|option))?\s*\.{0,3}$/i.test(text) || /^-+$/.test(text)) return "";
      return text.length <= 80 ? text : "";
    } catch {
      return "";
    }
  }

  /**
   * The question an ADP control answers — for an SDF component, or a box drawn
   * inside one. Empty for anything else, which keeps its usual label.
   */
  function adpQuestion(el) {
    if (!el || !onAdp()) return "";
    try {
      // The phone row's country picker is a question of its own.
      if (isSdfSelect(el) && /phone/i.test(el.getAttribute("embedded-context") || "")) return "Phone country code";
      const outer = pageHost(el);
      if (outer?.tagName === "INPUT" && /^(radio|checkbox)$/i.test(outer.type || "")) {
        const members = choiceGroup(outer);
        const first = members[0] || outer;
        let box = first.parentElement;
        while (box && box !== document.body && !members.every((node) => box.contains(node))) box = box.parentElement;
        if (box && box !== document.body) {
          const headings = Array.from(box.querySelectorAll("label, legend, h1, h2, h3, h4, h5, h6, p, b, strong, span"))
            .filter((node) => !node.contains(first) &&
              (node.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) &&
              !node.querySelector("input, select, textarea") &&
              !members.some((member) => member.id && node.getAttribute("for") === member.id))
            .map((node) => ({ node, text: clean(node.textContent) }))
            .filter(({ node, text }) => text && text.length <= 600 &&
              (/^(?:H[1-6]|LEGEND)$/.test(node.tagName) || /[?:]\s*[*]?\s*$/.test(text)));
          const question = headings.at(-1)?.text;
          if (question) return capLabel(question);
        }
      }
      const group = outer.closest?.("adp-form-group");
      if (group) {
        const label = group.querySelector(".form-control-label .valid-label") ||
          group.querySelector("label.form-control-label, .form-control-label");
        const text = label ? visibleText(label) : "";
        if (text) return capLabel(text);
      }
      // The component the control is, or is drawn in — inside its shadow root,
      // or in its own light DOM where a component draws there.
      const sdf = /^SDF-/.test(outer.tagName || "") ? outer : outer.closest?.(SDF_CONTROL_TAGS);
      if (!sdf) return "";
      const own = sdfOwnLabel(sdf) || sectionRowQuestion(sdf);
      if (own) return capLabel(own);
      // Workforce Now: the question printed over its block of controls
      // ("What is your desired salary?" over its Annually / Hourly choices).
      const block = sdf.closest?.(".additional-question, .qMainDiv");
      const question = block?.querySelector?.(".qLabel, .question-label-container");
      const text = question && !question.contains(sdf) ? visibleText(question) : "";
      return meaningful(text) ? capLabel(text) : "";
    } catch {
      return "";
    }
  }

  /** The text of one choice of a radio group or list. */
  function sdfOptionText(node) {
    if (!node) return "";
    const label = clean(node.getAttribute?.("label") || "");
    if (label) return label;
    const aria = clean(node.getAttribute?.("aria-label") || "");
    if (aria) return aria;
    const own = clean(node.textContent);
    if (own) return own;
    try {
      const drawn = node.shadowRoot?.querySelector("[part='label'], label, .label");
      const t = clean(drawn?.textContent || node.shadowRoot?.textContent || "");
      if (t) return t;
    } catch {}
    return clean(node.getAttribute?.("value") || "");
  }

  const SDF_CHOICE_INSIDE = "[role='radio'], [role='checkbox'], input[type='radio'], input[type='checkbox']";

  /** Is this radio button or check box on? Read off the element, or the control drawn inside it. */
  function sdfChecked(node) {
    if (!node) return false;
    if (node.getAttribute?.("aria-checked") === "true") return true;
    // Some draw it only inside, and the element's own attribute then lags.
    const inner = deepQuery(node, SDF_CHOICE_INSIDE);
    const innerOn = Boolean(inner && (inner.getAttribute("aria-checked") === "true" || inner.checked === true));
    if (node.getAttribute?.("aria-checked") === "false") return innerOn;
    if (node.checked === true) return true;
    if (node.hasAttribute?.("checked") && node.getAttribute("checked") !== "false") return true;
    return innerOn;
  }

  function sdfRadioButtons(group) {
    let buttons = [];
    try { buttons = Array.from(group.querySelectorAll("sdf-radio-button")); } catch {}
    if (!buttons.length) buttons = deepQueryAll(group, "sdf-radio-button");
    return buttons.filter((b) => !b.hasAttribute("disabled") && b.getAttribute("aria-disabled") !== "true");
  }

  /** The frame of an `sdf-select-simple` — what a person clicks to open it. */
  function sdfSelectFrame(host) {
    return deepQuery(host,
      ".trigger-button[role='button'], [part='frame'][role='button'], [role='button'][aria-expanded], [role='combobox'], [part='input-container'], .select-input") ||
      deepQuery(host, "[class*='__control']");
  }

  /** The element around `node`, across shadow-root boundaries. */
  function composedParent(node) {
    return node?.parentElement || shadowHost(node);
  }

  /**
   * The open list an `sdf-select-simple` has drawn elsewhere on the page — a
   * floating pane moved to the end of the document — when it has drawn none
   * inside itself. Never a pane that belongs to another list.
   */
  function sdfPortalPanes(host) {
    // The pane that appeared when this list was opened is this list's.
    const mine = host?.__applifillSdfPane;
    if (mine && paneShowing(mine)) return [mine];
    return deepQueryAll(document, "sdf-floating-pane").filter((pane) => {
      if (!paneShowing(pane)) return false;
      for (let at = composedParent(pane), i = 0; at && i < 40; at = composedParent(at), i++) {
        if (at === host) return false;   // its own: already read
        if (at.tagName === "SDF-SELECT-SIMPLE") return false;   // another list's
      }
      return true;
    });
  }

  /** The choices of an `sdf-select-simple`: its own items and the rows it has drawn. */
  function sdfSelectRows(host, { portal = false } = {}) {
    const rows = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")) return;
      const text = sdfOptionText(node);
      if (!text || text === "-" || NO_RESULTS_RE.test(text) || isPlaceholderChoice(text)) return;
      const value = node.getAttribute("value") || "";
      // Scored on the text the row shows, whichever way the row carries it.
      const cell = {
        textContent: text,
        getAttribute: (name) => (name === "aria-label" ? text : name === "value" ? value : node.getAttribute(name)),
      };
      rows.push({ node, cell, text, value });
    };
    deepQueryAll(host, "sdf-select-item, [role='option']").forEach(add);
    if (portal && !rows.some((r) => rowShowing(r.node))) {
      for (const pane of sdfPortalPanes(host)) deepQueryAll(pane, "sdf-select-item, [role='option']").forEach(add);
    }
    return rows;
  }

  function rowShowing(node) {
    if (!node || node.hidden || !isShowing(node)) return false;
    const r = node.getBoundingClientRect?.();
    return Boolean(r && r.width > 0 && r.height > 0);
  }

  function paneShowing(pane) {
    return Boolean(pane?.isConnected) && !pane.classList.contains("floating-pane-hidden") && rowShowing(pane);
  }

  /** What an `sdf-select-simple` shows as chosen, or "". */
  function sdfSelectShown(host) {
    try {
      const label = host.shadowRoot?.querySelector("#selected-label, [part='selected-label']");
      if (label) {
        const clone = label.cloneNode(true);
        clone.querySelectorAll?.("[class*='placeholder' i]").forEach((n) => n.remove());
        const t = clean(clone.textContent);
        if (t && !isPlaceholderChoice(t)) return t;
      }
      const picked = host.querySelector('sdf-select-item[aria-selected="true"], sdf-select-item[selected]');
      if (picked) return clean(picked.getAttribute("aria-label") || picked.textContent);
      const single = host.querySelector("[class*='single-value' i], [class*='singleValue' i]");
      if (single && isShowing(single) && clean(single.textContent)) return clean(single.textContent);
      const v = typeof host.value === "string" ? host.value.trim() : "";
      if (v) {
        const item = sdfSelectRows(host).find((r) => r.value === v);
        return item ? item.text : v;
      }
    } catch {}
    return "";
  }

  function sdfSelectOpen(host) {
    try {
      if (host.classList?.contains("open")) return true;
      if (sdfSelectFrame(host)?.getAttribute("aria-expanded") === "true") return true;
      const pane = deepQuery(host, "sdf-floating-pane, [role='listbox']");
      if (pane && !pane.classList.contains("floating-pane-hidden") && rowShowing(pane)) return true;
      // Drawn at the end of the page when it was opened.
      if (host.__applifillSdfPane && paneShowing(host.__applifillSdfPane)) return true;
      return sdfSelectRows(host).some((r) => rowShowing(r.node));
    } catch { return false; }
  }

  async function openSdfSelect(host) {
    host.__applifillSdfPane = null;
    if (sdfSelectOpen(host)) return true;
    const frame = sdfSelectFrame(host);
    const icon = deepQuery(host, "sdf-icon.expansion-control, [part='expansion-trigger-control']");
    // Panes already showing before the click are not this list's.
    const before = new Set(sdfPortalPanes(host));
    const opened = () => {
      if (sdfSelectOpen(host)) return true;
      const fresh = sdfPortalPanes(host).find((pane) => !before.has(pane));
      if (fresh) { host.__applifillSdfPane = fresh; return true; }
      // The frame says it is open: a further click would only close it.
      return frame?.getAttribute?.("aria-expanded") === "true";
    };
    for (const target of [frame, icon, host].filter(Boolean)) {
      try { target.focus?.({ preventScroll: true }); } catch {}
      clickLikeUser(target);
      for (let i = 0; i < 12; i++) {
        await wait(40);
        if (opened()) return true;
      }
    }
    return opened();
  }

  async function closeSdfSelect(host) {
    if (!sdfSelectOpen(host)) return;
    const frame = sdfSelectFrame(host);
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true, composed: true });
    try { (deepQuery(host, "input:focus") || frame || host).dispatchEvent(esc()); } catch {}
    await wait(60);
    if (sdfSelectOpen(host) && frame) {
      try { frame.dispatchEvent(esc()); } catch {}
      await wait(60);
    }
    if (!sdfSelectOpen(host)) host.__applifillSdfPane = null;
  }

  const SDF_FILTER_SELECTOR =
    'input[part="filter-input"], input#select-filter-input, input.filter, input[aria-label*="filter" i], input[placeholder*="filter" i], input[placeholder*="search" i]';

  /** The search box of a long list, when it has one and it is showing. */
  function sdfFilterBox(host) {
    const usable = (box) => Boolean(box) && rowShowing(box) && acceptsText(box);
    const own = deepQueryAll(host, SDF_FILTER_SELECTOR).find(usable);
    if (own) return own;
    for (const pane of sdfPortalPanes(host)) {
      const box = deepQueryAll(pane, SDF_FILTER_SELECTOR).find(usable);
      if (box) return box;
    }
    return null;
  }

  /** The scrolling list of an open `sdf-select-simple`, its own or drawn elsewhere. */
  function sdfListbox(host) {
    const own = deepQueryAll(host, "#listbox, [role='listbox']").find(rowShowing);
    if (own) return own;
    for (const pane of sdfPortalPanes(host)) {
      const list = deepQueryAll(pane, "#listbox, [role='listbox']").find(rowShowing);
      if (list) return list;
    }
    return null;
  }

  function typeIntoFilter(box, text) {
    try { box.focus?.({ preventScroll: true }); } catch {}
    try {
      const setter = nativeSetter(box);
      if (setter) setter.call(box, text); else box.value = text;
    } catch {}
    try { box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" })); }
    catch { fire(box, "input"); }
    fire(box, "keyup");
  }

  /** Rows that have stopped changing (a filter or a lazy list redraws). */
  async function settledSdfRows(host, ms = 600) {
    const started = Date.now();
    let signature = null;
    let since = Date.now();
    let rows = sdfSelectRows(host, { portal: true });
    while (Date.now() - started < ms) {
      await wait(50);
      rows = sdfSelectRows(host, { portal: true });
      const next = rows.filter((r) => rowShowing(r.node)).map((r) => r.text).join("\n");
      if (next !== signature) { signature = next; since = Date.now(); }
      else if (Date.now() - since >= 150) break;
    }
    return rows;
  }

  /** Does the list now show this choice? */
  function sdfShows(host, chosenText, answer, hint) {
    const shown = sdfSelectShown(host);
    if (!shown) return false;
    const a = normalizeChoiceText(shown);
    if (chosenText) {
      const b = normalizeChoiceText(chosenText);
      // Whole words only: "No" is not shown by "Not Hispanic or Latino".
      if (a === b || (b.length >= 3 && (containsAtWord(a, b) || containsAtWord(b, a)))) return true;
    }
    if (answer) {
      const wantId = eeoId(answer, hint);
      if (wantId) {
        const shownId = eeoId(shown, hint);
        if (shownId) return shownId === wantId;
      }
      const canonical = canonicalAgreement(shown, answer);
      if (canonical !== null) return canonical;
      const t = normalizeChoiceText(answer);
      return a === t || containsAtWord(a, t) || (a.length >= 3 && containsAtWord(t, a));
    }
    return false;
  }

  /**
   * Choose `value` in an `sdf-select-simple`.
   *
   * The choice is decided first from the list's own items when it has them,
   * so a list with no matching choice is never opened. A long list is searched
   * through its filter box (the state's full name for "FL"), and a list that
   * draws its rows a few at a time is scrolled until the row is there. The row
   * is clicked as a person clicks it, and the list read back: only a choice
   * the list then shows counts.
   */
  async function setSdfSelectValue(host, value, { synonyms, hint, force = false, waitMs = 2500 } = {}) {
    const answer = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
    if (!answer || !host?.isConnected || host.hasAttribute("disabled")) return false;
    if (!force && sdfShows(host, "", answer, hint)) return true;

    let rows = sdfSelectRows(host);
    let target = rows.length ? oracleBestRow(rows, answer, { synonyms, hint }) : null;
    const knownUpFront = rows.length > 0 && Array.from(host.querySelectorAll?.("sdf-select-item") || []).length > 0;
    if (knownUpFront && !target) return false;

    if (!(await openSdfSelect(host))) return false;
    rows = await settledSdfRows(host, 400);
    target = oracleBestRow(rows, answer, { synonyms, hint }) || target;

    // A long list: searched for through its own filter box.
    const filter = sdfFilterBox(host);
    if (filter && (!target || !rowShowing(target.node))) {
      // A state's full name for its code ("TX" → "Texas"): the list is
      // searched by what it shows.
      const regionKey = regionId(answer, { loose: true });
      const region = regionKey ? regionName(regionKey) : null;
      const queries = [target?.text, region, answer].filter(Boolean).filter((q, i, a) => a.indexOf(q) === i);
      let searched = false;
      for (const q of queries) {
        typeIntoFilter(filter, q);
        searched = true;
        rows = await settledSdfRows(host, 700);
        const found = oracleBestRow(rows.filter((r) => rowShowing(r.node)), answer, { synonyms, hint });
        if (found) { target = found; searched = false; break; }
      }
      // Nothing found: the search box is emptied again, as a person would
      // leave it, so the list shows all its choices the next time it opens.
      if (searched && filter.isConnected) {
        typeIntoFilter(filter, "");
        rows = await settledSdfRows(host, 400);
        target = oracleBestRow(rows.filter((r) => rowShowing(r.node)), answer, { synonyms, hint }) || null;
      }
    }

    // Rows drawn a few at a time: scrolled until the one wanted is drawn.
    if (!target || !rowShowing(target.node)) {
      const list = sdfListbox(host);
      let last = "";
      for (let i = 0; list && i < 40; i++) {
        const showing = sdfSelectRows(host, { portal: true }).filter((r) => rowShowing(r.node) || list.contains(r.node));
        const found = oracleBestRow(showing, answer, { synonyms, hint });
        if (found && (rowShowing(found.node) || list.contains(found.node))) { target = found; break; }
        const sig = `${showing.length}:${showing.slice(-2).map((r) => r.text).join("|")}`;
        if (sig === last && i > 2) break;
        last = sig;
        try {
          list.scrollTop = list.scrollHeight;
          list.dispatchEvent(new Event("scroll", { bubbles: true }));
        } catch {}
        await wait(80);
      }
    }

    if (!target) {
      await closeSdfSelect(host);
      return false;
    }

    const node = target.node;
    try { node.scrollIntoView?.({ block: "nearest" }); } catch {}
    const label = node.querySelector?.(":scope > span") || node;
    clickLikeUser(label);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !sdfShows(host, target.text, answer, hint)) await wait(50);
    if (!sdfShows(host, target.text, answer, hint) && label !== node && node.isConnected) {
      clickLikeUser(node);
      const again = Date.now() + 1200;
      while (Date.now() < again && !sdfShows(host, target.text, answer, hint)) await wait(50);
    }
    await closeSdfSelect(host);
    const ok = sdfShows(host, target.text, answer, hint);
    // Left as a person leaves it, so the form marks it touched.
    try { const frame = sdfSelectFrame(host); if (frame) leaveLikeUser(frame); } catch {}
    return ok;
  }

  /** Choose `value` in an `sdf-radio-group` by clicking its radio button. */
  async function setSdfRadioValue(group, value, { synonyms, hint } = {}) {
    const answer = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
    if (!answer) return false;
    const buttons = sdfRadioButtons(group);
    if (!buttons.length) return false;
    const labels = buttons.map(sdfOptionText);
    const values = buttons.map((b) => b.getAttribute("value") || "");
    // The same decision a native radio group gets (`setRadioValue`).
    const strict = eeoId(answer, hint) ? null : strictChoiceScores(labels, answer, values);
    const targets = [norm(answer), ...synonymsFor(synonyms, answer).map(norm).filter(Boolean)];
    let best = -1, bestScore = 0;
    buttons.forEach((b, i) => {
      let score = 0;
      if (strict) score = strict[i] ?? 0;
      else {
        for (let t = 0; t < targets.length; t++) {
          const raw = choiceScore(labels[i], values[i], targets[t], hint);
          if (!raw) continue;
          const adjusted = t === 0 ? raw : raw - Math.min(t - 1, 8);
          if (adjusted > score) score = adjusted;
        }
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0 || bestScore < 65) return false;
    const button = buttons[best];
    if (sdfChecked(button)) return true;
    const inner = deepQuery(button, "[role='radio'], input[type='radio'], button");
    for (const target of [inner, button].filter(Boolean)) {
      try { target.focus?.({ preventScroll: true }); } catch {}
      clickLikeUser(target);
      for (let i = 0; i < 15 && !sdfChecked(button); i++) await wait(40);
      if (sdfChecked(button)) break;
    }
    if (!sdfChecked(button) && inner) {
      try {
        inner.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true, composed: true }));
        inner.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true, composed: true }));
      } catch {}
      for (let i = 0; i < 10 && !sdfChecked(button); i++) await wait(40);
    }
    return sdfChecked(button);
  }

  /** Tick or clear an `sdf-checkbox`: only on a plain yes or no. */
  async function setSdfCheckbox(host, value) {
    const raw = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
    const affirmative = /^(yes|y|true|checked|selected|agree|consent|accept|1|enabled|on)$/i.test(raw);
    const negative = /^(no|n|false|unchecked|not selected|0|none|disabled|off|decline|opt[\s-]?out)$/i.test(raw);
    if (!affirmative && !negative) return false;
    if (sdfChecked(host) === affirmative) return true;
    const inner = deepQuery(host, "[role='checkbox'], input[type='checkbox']");
    for (const target of [inner, host].filter(Boolean)) {
      const before = sdfChecked(host);
      try { target.focus?.({ preventScroll: true }); } catch {}
      clickLikeUser(target);
      for (let i = 0; i < 15 && sdfChecked(host) === before; i++) await wait(40);
      // It changed: one click is one answer, never a second that undoes it.
      if (sdfChecked(host) !== before) break;
    }
    return sdfChecked(host) === affirmative;
  }

  /** Has an SDF list, radio group or check box been answered? */
  function sdfHasValue(el) {
    if (isSdfSelect(el)) return Boolean(sdfSelectShown(el));
    if (isSdfRadioGroup(el)) return sdfRadioButtons(el).some(sdfChecked);
    if (isSdfCheckbox(el)) return sdfChecked(el);
    return false;
  }

  /** What an SDF list, radio group or check box holds, as words. */
  function sdfValueText(el) {
    if (isSdfSelect(el)) return sdfSelectShown(el);
    if (isSdfRadioGroup(el)) {
      const on = sdfRadioButtons(el).find(sdfChecked);
      return on ? sdfOptionText(on) : "";
    }
    if (isSdfCheckbox(el)) return sdfChecked(el) ? "Yes" : "No";
    return "";
  }

  /** The choices an SDF list or radio group offers, as far as they can be read without opening it. */
  function sdfOptionTexts(el) {
    if (isSdfRadioGroup(el)) return sdfRadioButtons(el).map(sdfOptionText).filter(Boolean);
    if (isSdfSelect(el)) return sdfSelectRows(el).map((r) => r.text).slice(0, 60);
    if (isSdfCheckbox(el)) return [sdfOptionText(el)].filter(Boolean);
    return [];
  }

  /** The choices of an SDF list, opening it to read them when it draws them only then. */
  async function readSdfSelectOptions(host) {
    let texts = sdfOptionTexts(host);
    if (texts.length || !isSdfSelect(host)) return texts;
    if (await openSdfSelect(host)) {
      texts = (await settledSdfRows(host, 500)).map((r) => r.text).slice(0, 60);
      await closeSdfSelect(host);
    }
    return texts;
  }

  /** Does an SDF component hold this answer? */
  function sdfEquivalent(el, expected, hint) {
    if (isSdfSelect(el)) return sdfShows(el, "", String(expected ?? ""), hint);
    if (isSdfRadioGroup(el)) {
      const on = sdfRadioButtons(el).find(sdfChecked);
      if (!on) return false;
      const text = sdfOptionText(on);
      const canonical = eeoId(expected, hint) ? null : canonicalAgreement(text, expected);
      if (canonical !== null) return canonical;
      return choiceScore(text, on.getAttribute("value") || "", expected, hint) >= 65;
    }
    if (isSdfCheckbox(el)) {
      const raw = String(expected ?? "").trim();
      if (/^(no|n|false|unchecked|not selected|0|none|off)$/i.test(raw)) return !sdfChecked(el);
      return sdfChecked(el);
    }
    return false;
  }

  /**
   * Lever's hidden `selectedLocation` beside a location box, or null.
   *
   * Lever's "Current location" only counts a place picked from its own list:
   * the click writes that place into this hidden input, and the form submits
   * it. Text in the visible box with this input empty is not an answer —
   * Lever refuses the application however the box reads.
   */
  function leverLocationStore(el) {
    if (!el || el.tagName !== "INPUT") return null;
    // Lever's box itself: `name="location"`, `#location-input`, `.location-input`.
    const name = String(el.getAttribute?.("name") || "");
    const own = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`;
    if (!/^location$/i.test(name) && !/\blocation-input\b/i.test(own)) return null;
    const STORE = 'input[name="selectedLocation"], input#selected-location, input[name="selected-location"]';
    try {
      let node = el.parentElement;
      for (let d = 0; node && d < 4; d++, node = node.parentElement) {
        if (node === document.body) break;
        const found = node.querySelector?.(STORE);
        if (found) return found;
        if (node.tagName === "FORM") break;
      }
    } catch {}
    return null;
  }

  /** Has a place actually been picked into this Lever box? Null for any other box. */
  function leverLocationPicked(el) {
    const store = leverLocationStore(el);
    if (!store) return null;
    const shown = clean(el.value ?? "");
    if (!shown) return false;
    return Boolean(String(store.value ?? "").trim()) || el.__applifillPickedPlace === shown;
  }

  /**
   * Type-to-search, finished: pick the suggestion that is the applicant's place.
   *
   * Returns true when one was picked, false when the box answered with
   * suggestions but none was the applicant's place, and null when the box
   * never behaved like a search at all — in which case it is left exactly as
   * typed and nothing more is tried on it.
   */
  async function completeTypeahead(el, value, { waitMs = 1600, retypeFirst = false, abort = null, placeHint = null, cityOnly = false } = {}) {
    const text = String(value ?? "").trim();
    if (!text || !looksLikeTypeahead(el)) return null;
    const want = wantedPlace(text, placeHint);
    if (!want?.city) return null;
    // Lever's box: the place it submits is the hidden `selectedLocation`.
    const store = leverLocationStore(el);

    // What to type if the full answer finds nothing: "Jacksonville, FL", the
    // city on its own — and, for a box that only lists states or countries,
    // "Florida" and then "United States".
    const code = want.region ? REGIONS.codeOf.get(want.region) : null;
    const parts = text.split(",").map((x) => clean(x)).filter(Boolean);
    const cityWords = parts[0];
    const regionName = want.region ? (regionName_(want.region) || parts[1] || null) : null;
    const countryName = parts.length >= 2 ? parts[parts.length - 1] : null;
    const plan = [
      { query: null, level: "city" },
      { query: code ? `${cityWords}, ${code}` : null, level: "city" },
      { query: cityWords, level: "city" },
      ...(!cityOnly ? [
        { query: regionName, level: "region" },
        { query: countryName && countryName !== regionName ? countryName : null, level: "country" },
      ] : []),
    ].filter((step, i, all) =>
      i === 0 || (step.query && norm(step.query) !== norm(text) &&
        all.findIndex((other) => other.query && norm(other.query) === norm(step.query)) === i));

    const pickFrom = (rows, level) => {
      let best = null, bestScore = 0;
      let ambiguous = false;
      for (const row of rows) {
        const rowText = placeSuggestionText(row);
        // A row naming the city always wins, whatever was searched.
        const score = Math.max(placeScore(rowText, want), level === "city" ? 0 : areaScore(rowText, want, level));
        if (score > bestScore) { best = row; bestScore = score; ambiguous = false; }
        else if (score && score === bestScore && best) {
          const a = parsePlace(rowText), b = parsePlace(placeSuggestionText(best));
          if (a?.region !== b?.region || a?.country !== b?.country) ambiguous = true;
        }
      }
      return ambiguous ? null : best;
    };

    const signatureOf = (rows) => rows.map(placeSuggestionText).join("\n");
    let lastSignature = "";
    let answered = false;      // the box has shown suggestions, or said it has none
    let retyped = false;

    /**
     * Patient, because the answer comes from a server.
     *
     * Lever asks its own server for places and the list can take a couple of
     * seconds. The old budgets (1.6s, then 0.7s per retry) ran out before the
     * list arrived; each retry cancelled the search in flight; and a "No
     * location found" left on screen from the previous search was read as this
     * search's answer. A spinner or "Loading…" beside the box now keeps the
     * wait going, and "no results" is believed only once it has stood.
     */
    /**
     * Lever's place search is slower still. Its lookup is guarded by hCaptcha,
     * and the first search of a page can wait on that check before the server
     * is even asked — so the list arrived after the 2.2s / 3.5s allowed here,
     * nothing was picked, and the box was left holding text Lever does not
     * count: the "location is filled but the application will not submit".
     * A Lever box is given 4s, and up to 8s while it shows "Loading".
     */
    const firstBudget = store ? Math.max(waitMs, 4000) : Math.max(waitMs, 2200);
    const ceiling = store ? 8000 : 3500;
    // Someone else has the box now (the applicant started typing).
    const stopped = () => { try { return Boolean(abort?.()); } catch { return false; } };
    for (const [index, step] of plan.entries()) {
      if (stopped()) return null;
      if (index > 0 || retypeFirst) {
        if (!document.contains(el)) break;
        takeFocus(el);
        if (index === 0) setComboboxText(el, "");
        setComboboxText(el, index === 0 ? text : step.query);
        fire(el, "keyup");
        retyped = index > 0;
      }
      const started = Date.now();
      // A box that has never answered gets less time on each further search:
      // it is either slow, or showing nothing for these words.
      const budget = index === 0 ? firstBudget : answered ? 2200 : 900;
      let deadline = started + budget;
      // A search the page shows as still running is given longer.
      const extend = () => {
        if (Date.now() >= deadline && Date.now() < started + ceiling && searchInProgress(el)) deadline = Date.now() + 120;
      };
      let nudged = false;
      let rows = suggestionRowsFor(el);
      let signature = signatureOf(rows);
      let noteSince = 0;
      // Wait for this search's own answer. After a retype the previous list
      // is still on screen for a moment, so an unchanged list is not trusted
      // until the page has had time to replace it.
      const stillWaiting = () => {
        if (!rows.length) {
          if (searchInProgress(el)) { noteSince = 0; return true; }
          if (noSuggestionsShown(el)) {
            if (!noteSince) noteSince = Date.now();
            return Date.now() - started < 900 || Date.now() - noteSince < 450;
          }
          noteSince = 0;
          return true;
        }
        return retyped && signature === lastSignature && Date.now() - started < 900;
      };
      let sawActivity = rows.length > 0;
      while (stillWaiting() && (extend(), Date.now() < deadline)) {
        await wait(60);
        rows = suggestionRowsFor(el);
        signature = signatureOf(rows);
        if (rows.length || searchInProgress(el) || noSuggestionsShown(el)) sawActivity = true;
        /**
         * Nothing happened at all — no list, no "Loading", no "No location
         * found". On Lever the first keystrokes can arrive before the page is
         * ready to search (its check has not finished); the search is asked
         * for once more rather than waited on in silence.
         */
        if (store && index === 0 && !nudged && !sawActivity && Date.now() - started > 1600 &&
            document.contains(el) && !stopped()) {
          nudged = true;
          takeFocus(el);
          setComboboxText(el, "");
          setComboboxText(el, text);
          fire(el, "keyup");
        }
      }
      lastSignature = signature;
      if (rows.length || noSuggestionsShown(el)) answered = true;
      if (!rows.length) continue;
      // A list that is still arriving is given a moment to finish.
      await wait(60);
      const best = pickFrom(suggestionRowsFor(el), step.level);
      if (!best) continue;
      if (stopped()) return null;

      const chosen = placeSuggestionText(best);
      const beforeClick = clean(el.value ?? "");
      try { best.scrollIntoView?.({ block: "nearest" }); } catch {}
      try { fire(best, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
      try { best.click?.(); } catch {}
      await wait(40);
      const shown = clean(el.value ?? "");
      const listGone = !document.contains(best) || !isShowing(best);
      // Taken: the box now shows the suggestion, or it took something else of
      // the widget's choosing and closed its list.
      const sameCity = cityOnly && parsePlace(shown)?.city === want.city;
      if (shown === chosen || (listGone && shown && (shown !== beforeClick || sameCity)) || (listGone && widgetShowsChoice(el, chosen))) {
        // Remembered: some Lever boards fill `selectedLocation` a moment late,
        // and a place picked here is an answer even before they do.
        el.__applifillPickedPlace = clean(el.value ?? "") || chosen;
        if (store) {
          for (let i = 0; i < 12 && !String(store.value ?? "").trim(); i++) await wait(50);
        }
        try { el.blur?.(); } catch {}
        return true;
      }
    }
    // Nothing fitted. The box keeps the applicant's full answer, not the last
    // shortened search, and the list is left for them to choose from.
    if (stopped()) return null;
    if (retyped && document.contains(el) && clean(el.value ?? "") !== clean(text)) {
      setComboboxText(el, text);
      fire(el, "keyup", "change");
    }
    return answered ? false : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Workday prompts: type, search, pick (School or University)         */
  /* ------------------------------------------------------------------ */

  /**
   * Workday's "prompt" — a search box whose answer is a pill picked from a
   * server-side list.
   *
   * Many tenants draw "School or University" this way: typing puts text in the
   * search box and nothing else; Enter searches the tenant's list of schools;
   * only clicking one of the results makes it the answer (a pill beside the
   * box). The box was treated as ordinary text, so it was typed into and left —
   * and Save and Continue said "The field School or University is required and
   * must have a value" under a box plainly reading the school's name.
   */
  const PROMPT_CONTAINER_SELECTOR =
    '[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"], ' +
    '[data-automation-id*="multiSelect"], [data-automation-id*="multiselect"], [data-automation-id="selectinputContainer"]';
  const PROMPT_PILL_SELECTOR = '[data-automation-id="selectedItem"]';
  const PROMPT_OPTION_SELECTOR =
    '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [data-automation-id="menuItem"], [role="option"]';

  function isWorkdayPrompt(el) {
    if (!el || el.tagName !== "INPUT" || !acceptsText(el)) return false;
    try {
      if (el.matches('[data-automation-id="searchBox"], [data-uxi-widget-type="selectinput"]')) return true;
      if (el.closest('[data-automation-id="searchBox"]')) return true;
      if (el.closest(PROMPT_CONTAINER_SELECTOR)) return true;
      const box = widgetContainer(el);
      return Boolean(box?.querySelector?.('[data-automation-id="promptIcon"], [data-automation-id="promptSearchButton"]'));
    } catch {
      return false;
    }
  }

  /** Where this prompt keeps its pills. */
  function promptScopes(el) {
    const scopes = [];
    const add = (node) => { if (node && !scopes.includes(node)) scopes.push(node); };
    try {
      add(el.closest(PROMPT_CONTAINER_SELECTOR));
      add(widgetContainer(el));
      add(el.closest('[data-automation-id^="formField"]'));
    } catch {}
    return scopes;
  }

  /** The words of a pill or a result, without the delete charm or a count. */
  function promptItemText(node) {
    if (!node) return "";
    const labelled = node.matches?.("[data-automation-label]") ? node : node.querySelector?.("[data-automation-label]");
    const text = labelled?.getAttribute("data-automation-label") || node.getAttribute?.("title") || visibleText(node) || node.textContent;
    return clean(String(text || "").replace(/[×✕✖]/g, " "));
  }

  /** The answer the prompt holds — its pills — or "". The search text is never the answer. */
  function promptSelectedText(el) {
    for (const scope of promptScopes(el)) {
      let pills = [];
      try { pills = Array.from(scope.querySelectorAll(PROMPT_PILL_SELECTOR)); } catch {}
      // Workday's pill list is itself a `role="listbox"`, so being inside one
      // says nothing; only a pill inside the open results popup is not an answer.
      const texts = pills.filter((p) => isShowing(p) && !p.closest('[data-automation-id="activeListContainer"]'))
        .map(promptItemText).filter(Boolean);
      if (texts.length) return Array.from(new Set(texts)).join(", ");
    }
    return "";
  }

  /* ---------------- matching one school name to another ---------------- */

  const SCHOOL_STOP = new Set(["of", "the", "at", "and", "in", "for", "a", "an", "de", "la", "del"]);
  const SCHOOL_GENERIC = new Set([
    "university", "college", "institute", "school", "academy", "polytechnic", "technology", "technological",
    "state", "community", "national", "campus", "center", "centre", "faculty", "department",
  ]);

  function schoolText(raw) {
    return String(raw ?? "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\buniv\b\.?/g, "university")
      .replace(/\bu\.\s*of\b/g, "university of")
      .replace(/\binst\b\.?/g, "institute")
      .replace(/\bcoll\b\.?/g, "college")
      .replace(/\bst\.\s+/g, "saint ")
      .replace(/\bmt\.\s+/g, "mount ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/^the\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const schoolTokens = (raw) => schoolText(raw).split(" ").filter((w) => w && !SCHOOL_STOP.has(w));

  /** The name before a campus or a place: "Northwestern University, Evanston, IL" → "Northwestern University". */
  function schoolHead(raw) {
    const text = clean(String(raw ?? "").replace(/\([^)]*\)/g, " "));
    return clean(text.split(/\s*,\s*|\s+[-–—]\s+/)[0] || text);
  }

  const initialsOfSchool = (raw) => schoolText(raw).split(" ").filter((w) => w && !SCHOOL_STOP.has(w)).map((w) => w[0]).join("");

  /**
   * How surely a listed school is the applicant's. 0 is a refusal.
   *
   * The same school, whatever the punctuation, word order or "The": yes.
   * The same name with a campus after it ("Northwestern University - Evanston"):
   * yes. "MIT" for Massachusetts Institute of Technology: yes. A different
   * school that merely shares words — "Northwestern Polytechnic University"
   * for Northwestern University, "University of Illinois at Chicago" for
   * University of Illinois — never.
   */
  function schoolScore(optionText, wanted) {
    const opt = schoolText(optionText);
    const want = schoolText(wanted);
    if (!opt || !want) return 0;
    if (opt === want) return 100;

    const a = schoolTokens(wanted);
    const b = schoolTokens(optionText);
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size && setA.size === setB.size && [...setA].every((w) => setB.has(w))) return 96;

    // A campus or a place after the name, on either side.
    const optHead = schoolText(schoolHead(optionText));
    const wantHead = schoolText(schoolHead(wanted));
    if (optHead && wantHead && optHead === wantHead) return 92;

    // "MIT", "UCLA", "NYU".
    const bare = String(wanted ?? "").replace(/[.\s]/g, "");
    if (/^[A-Z]{2,6}$/.test(bare) && initialsOfSchool(optionText) === bare.toLowerCase()) return 90;
    const bareOpt = String(optionText ?? "").replace(/[.\s]/g, "");
    if (/^[A-Z]{2,6}$/.test(bareOpt) && initialsOfSchool(wanted) === bareOpt.toLowerCase()) return 88;
    return 0;
  }

  const OTHER_SCHOOL_RE = /^(other|others)\b|\bnot\s+(listed|found|in\s+(the\s+)?list)\b|\bunlisted\b|^school\s+not\b/i;

  /** Type into a box as a person would, leaving the caret there. */
  function typeIntoSearch(el, text) {
    takeFocus(el);
    const before = String(el.value ?? "");
    let typed = false;
    try {
      el.setSelectionRange?.(0, before.length);
      if (!before.length && typeof el.select === "function") el.select();
      if (holdsFocus(el) && document.execCommand) {
        if (!text) typed = document.execCommand("delete") || String(el.value ?? "") === "";
        else typed = document.execCommand("insertText", false, text) && String(el.value ?? "") === text;
      }
    } catch {}
    if (!typed) {
      setComboboxText(el, text);
      try { el.dispatchEvent(new InputEvent("input", { data: text, inputType: "insertText", bubbles: true })); } catch {}
    }
    fire(el, "keyup");
  }

  function pressKey(el, key, code, keyCode) {
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
    } catch {}
  }

  /** The results showing for this search, one per row: `{ node, text, click }`. */
  function promptResults(el, baseline) {
    const scopes = promptScopes(el);
    const rows = [];
    const seen = new Set();
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(PROMPT_OPTION_SELECTOR)); } catch {}
    for (const node of nodes) {
      if (baseline.has(node)) continue;
      // Pills are answers already given, not results.
      if (node.closest(PROMPT_PILL_SELECTOR) || node.querySelector?.(PROMPT_PILL_SELECTOR)) continue;
      if (scopes.some((s) => s.querySelector?.('[data-automation-id="selectedItemList"]')?.contains(node))) continue;
      if (!isShowing(node)) continue;
      const r = node.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const row = node.closest('[role="option"], [data-automation-id="menuItem"]') || node;
      if (seen.has(row)) continue;
      const text = promptItemText(row.matches?.('[data-automation-id="promptOption"]') ? row : (row.querySelector?.('[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]') || row));
      if (!text || text.length > 200) continue;
      seen.add(row);
      const click = row.querySelector?.('[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]') || row;
      rows.push({ node: row, text, click });
    }
    return rows;
  }

  /** "No Items." — the search answered with nothing. */
  function promptSaysNothing(baseline) {
    try {
      for (const node of document.querySelectorAll('[data-automation-id*="empty" i], [data-automation-id*="noResult" i], [role="listbox"] div, [role="listbox"] p, [data-automation-id="activeListContainer"] *')) {
        if (baseline.has(node) || !isShowing(node)) continue;
        const t = clean(node.textContent);
        if (/^no\s+(items|results|matches|match)\b/i.test(t) && t.length < 60) return true;
      }
    } catch {}
    return false;
  }

  /** Option-shaped nodes on screen right now: the page's own, before a search. */
  function visiblePromptNodes() {
    const out = new Set();
    try {
      for (const node of document.querySelectorAll(PROMPT_OPTION_SELECTOR)) {
        if (!isShowing(node)) continue;
        const r = node.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) out.add(node);
      }
    } catch {}
    return out;
  }

  /** Search the prompt for `query` and wait for the results to settle. */
  async function searchPrompt(el, query, { waitMs = 3500, accept = null } = {}) {
    // The previous search's results are closed first, so a result the two
    // searches share is not mistaken for part of the page.
    if (promptResults(el, new Set()).length) {
      await closePrompt(el);
      for (let i = 0; i < 8 && promptResults(el, new Set()).length; i++) await wait(50);
    }
    const baseline = visiblePromptNodes();
    typeIntoSearch(el, "");
    await wait(30);
    typeIntoSearch(el, query);
    await wait(40);
    // Workday searches its list when Enter is pressed; typing alone only filters.
    pressKey(el, "Enter", "Enter", 13);

    const started = Date.now();
    let signature = null;
    let stableSince = Date.now();
    let emptySince = 0;
    while (Date.now() - started < waitMs) {
      await wait(90);
      const rows = promptResults(el, baseline);
      // An exact selectable leaf is ready; do not wait a second time for an
      // unchanged result list after the server has already answered.
      if (accept && rows.some(accept)) return rows;
      const next = rows.map((r) => r.text).join("\n");
      if (next !== signature) { signature = next; stableSince = Date.now(); }
      if (rows.length && Date.now() - stableSince >= 260) return rows;
      if (!rows.length && promptSaysNothing(baseline)) {
        if (!emptySince) emptySince = Date.now();
        if (Date.now() - emptySince >= 350) return [];
      } else {
        emptySince = 0;
      }
    }
    return promptResults(el, baseline);
  }

  async function closePrompt(el) {
    pressKey(el, "Escape", "Escape", 27);
    await wait(60);
  }

  function commitPrompt(el) {
    // Native blur already emits blur/focusout. Dispatching another blur here
    // made tenants validate the same selected source twice.
    if (!blurHeard(el)) fire(el, "blur", "focusout");
  }

  /** Click a result and wait for its pill. */
  async function pickPromptResult(el, row) {
    const before = promptSelectedText(el);
    try { row.click.scrollIntoView?.({ block: "nearest" }); } catch {}
    try { fire(row.click, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { row.click.click?.(); } catch {}
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      const now = promptSelectedText(el);
      if (now && now !== before) return true;
      await wait(50);
    }
    // A result wrapped in a row that takes the click itself.
    if (row.node !== row.click && document.contains(row.node)) {
      try { fire(row.node, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
      try { row.node.click?.(); } catch {}
      const again = Date.now() + 1000;
      while (Date.now() < again) {
        const now = promptSelectedText(el);
        if (now && now !== before) return true;
        await wait(50);
      }
    }
    return false;
  }

  /**
   * Answer a Workday prompt by searching it and picking the matching result.
   *
   * The school is searched as the profile has it, then without a campus or
   * place after it, then by its distinctive words ("Northwestern") — and the
   * result that *is* the applicant's school is picked, never one that only
   * shares words with it. A school the tenant's list does not carry is
   * answered "Other" where the list offers it (returned as "other", to be
   * shown as a draft), and otherwise left for the applicant.
   *
   * Returns true when picked, "other" when Other was picked, false otherwise.
   */
  async function setPromptValue(el, value, { allowOther = false } = {}) {
    const wanted = clean(String(value ?? ""));
    if (!wanted) return false;

    // Already answered with this school: nothing to do.
    const current = promptSelectedText(el);
    if (current && schoolScore(current, wanted) >= 88) return true;

    const head = schoolHead(wanted);
    const distinctive = schoolTokens(head).filter((w) => !SCHOOL_GENERIC.has(w));
    const queries = [];
    const addQuery = (q) => {
      const text = clean(q);
      if (text.length >= 2 && !queries.some((x) => norm(x) === norm(text))) queries.push(text);
    };
    addQuery(wanted);
    addQuery(head);
    addQuery(head.replace(/^the\s+/i, ""));
    if (/&/.test(head)) addQuery(head.replace(/&/g, "and"));
    if (distinctive.length) addQuery(distinctive.slice(0, 2).join(" "));
    if (distinctive.length > 1) addQuery(distinctive[0]);

    // A result that shares the school's own words means the list may well hold
    // it under another spelling; "Other" is then the wrong answer to give.
    let sawRelated = false;
    const related = (text) => {
      const words = new Set(schoolTokens(text));
      return distinctive.length > 0 && distinctive.every((w) => words.has(w));
    };

    for (const query of queries.slice(0, 4)) {
      if (!document.contains(el)) return false;
      const rows = await searchPrompt(el, query);
      if (!rows.length) continue;
      if (rows.some((row) => related(row.text))) sawRelated = true;
      const scored = rows.map((row) => ({ row, score: schoolScore(row.text, wanted) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score);
      if (!scored.length) continue;
      // Two different schools that fit equally well: not ours to choose.
      if (scored.length > 1 && scored[1].score === scored[0].score &&
          schoolText(scored[1].row.text) !== schoolText(scored[0].row.text)) continue;
      if (await pickPromptResult(el, scored[0].row)) {
        await closePrompt(el);
        commitPrompt(el);
        return true;
      }
    }

    if (allowOther && !sawRelated && document.contains(el)) {
      const rows = await searchPrompt(el, "Other");
      const other = rows.find((r) => OTHER_SCHOOL_RE.test(r.text));
      if (other && await pickPromptResult(el, other)) {
        await closePrompt(el);
        commitPrompt(el);
        return "other";
      }
    }

    // Nothing fitted. The search box is emptied — text that was never picked
    // is not an answer, and would read like one.
    await closePrompt(el);
    if (document.contains(el)) typeIntoSearch(el, "");
    try { el.blur?.(); } catch {}
    return false;
  }

  /* ---------------- a prompt answered from a list of choices ---------------- */

  /**
   * Does this result open a list of its own ("Job Board ›") rather than answer?
   *
   * Workday draws a category with a chevron and says so to screen readers; a
   * leaf is just its name. A bare icon proves nothing — a leaf may carry one —
   * so only what names a submenu counts.
   */
  function isPromptCategory(row) {
    for (const node of [row?.node, row?.click]) {
      if (!node) continue;
      try {
        if (node.getAttribute?.("aria-haspopup") && node.getAttribute("aria-haspopup") !== "false") return true;
        if (node.getAttribute?.("aria-expanded") !== null && node.getAttribute?.("aria-expanded") !== undefined) return true;
        const said = `${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("title") || ""}`;
        if (/sub\s*-?\s*menu|has\s+sub[-\s]?options|press\s+right\s+arrow/i.test(said)) return true;
        if (node.querySelector?.('[data-automation-id*="chevron" i], [class*="chevron" i], [data-icon*="chevron" i], [data-automation-id*="submenu" i]')) return true;
        if (/[›»❯]\s*$/.test(clean(node.textContent))) return true;
      } catch {}
    }
    return false;
  }

  /** The rows a prompt shows right now, the page's own nodes left out. */
  async function settledPromptRows(el, baseline, { waitMs = 2000 } = {}) {
    const started = Date.now();
    let signature = null;
    let stableSince = Date.now();
    let rows = [];
    while (Date.now() - started < waitMs) {
      await wait(70);
      rows = promptResults(el, baseline);
      const next = rows.map((r) => r.text).join("\n");
      if (next !== signature) { signature = next; stableSince = Date.now(); }
      if (rows.length && Date.now() - stableSince >= 220) return rows;
      if (!rows.length && promptSaysNothing(baseline) && Date.now() - started > 400) return [];
    }
    return rows;
  }

  /** Open the prompt's own list, from the top: Workday opens it on a click. */
  async function openPromptList(el) {
    await closePrompt(el);
    if (String(el.value ?? "")) typeIntoSearch(el, "");
    for (let i = 0; i < 8 && promptResults(el, new Set()).length; i++) await wait(50);
    const baseline = visiblePromptNodes();
    takeFocus(el);
    try { fire(el, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { el.click?.(); } catch {}
    let rows = await settledPromptRows(el, baseline, { waitMs: 1200 });
    if (!rows.length) {
      // Some tenants open it from the list icon beside the box.
      const icon = widgetContainer(el)?.querySelector?.('[data-automation-id="promptIcon"], [data-automation-id="promptSearchButton"]');
      if (icon) {
        try { fire(icon, "pointerdown", "mousedown", "pointerup", "mouseup"); icon.click?.(); } catch {}
        rows = await settledPromptRows(el, baseline, { waitMs: 1200 });
      }
    }
    return { rows, baseline };
  }

  /**
   * Click one row of an open prompt: it is either picked (a pill appears) or
   * it opens a list of its own, whose rows are returned.
   */
  async function clickPromptRow(el, row, baseline) {
    const pillBefore = promptSelectedText(el);
    const before = new Set(promptResults(el, baseline).map((r) => r.node));
    const beforeText = promptResults(el, baseline).map((r) => r.text).join("\n");
    try { row.click.scrollIntoView?.({ block: "nearest" }); } catch {}
    try { fire(row.click, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { row.click.click?.(); } catch {}
    const started = Date.now();
    while (Date.now() - started < 1800) {
      await wait(60);
      const pill = promptSelectedText(el);
      if (pill && pill !== pillBefore) return { picked: true, rows: null };
      const now = promptResults(el, baseline);
      if (now.length && (now.map((r) => r.text).join("\n") !== beforeText ||
          (now.some((r) => !before.has(r.node)) && !now.some((r) => r.node === row.node)))) {
        const inside = await settledPromptRows(el, baseline, { waitMs: 900 });
        return { picked: false, rows: inside.filter((r) => normalizeChoiceText(r.text) !== normalizeChoiceText(row.text)) };
      }
    }
    return { picked: false, rows: null };
  }

  /**
   * Answer a Workday prompt from a list of choices: "How Did You Hear About
   * Us?".
   *
   * The profile's answer is searched and the result that is that answer is
   * picked — "LinkedIn", never a neighbour that only resembles it. Where the
   * search finds nothing (some lists are only browsed), the list is opened and
   * the answer looked for at the top, then inside the categories it most
   * likely sits under ("Social Media ›", "Job Board ›" for LinkedIn). Only when
   * no list holds the answer itself does a close description of it count — a
   * "Social Media" entry with nothing under it, as the menus without
   * categories are answered. A pill must appear: text in the search box is not
   * an answer, and Workday refuses it on Save and Continue.
   */
  async function setPromptChoice(el, value, { synonyms = null } = {}) {
    const wanted = clean(String(value ?? ""));
    if (!wanted) return false;
    const key = normalizeChoiceText(wanted);
    const accepted = synonymsFor(synonyms, wanted).filter((s) => normalizeChoiceText(s) !== key);
    const LADDER = { exact: 100, prefix: 74, contains: 70, fuzzy: 0 };
    const primaryScore = (text) => {
      const t = normalizeChoiceText(text);
      if (!t || isPlaceholderChoice(t)) return 0;
      return tieredScore(t, "", [key], { exact: 130, prefix: 95, contains: 78, fuzzy: 0 });
    };
    // Where the answer would be filed, or what describes it: the rule's own
    // synonyms first ("Social Media" for LinkedIn), then the usual categories.
    const hints = [...accepted, ...categoryHintsFor(wanted).filter((h) => h !== "other")];
    const closeScore = (text) => {
      const t = normalizeChoiceText(text);
      if (!t || isPlaceholderChoice(t) || /^others?$/.test(t)) return 0;
      return rankedSynonymScore(t, "", hints, LADDER);
    };
    const best = (rows, score, min) => {
      let top = null;
      for (const row of rows || []) {
        const s = score(row.text);
        if (s >= min && (!top || s > top.s)) top = { row, s };
      }
      return top?.row ?? null;
    };
    const ranked = (rows, score, min) => (rows || [])
      .map((row) => ({ row, s: score(row.text) }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.row);
    const done = async () => {
      await closePrompt(el);
      commitPrompt(el);
      return true;
    };
    const same = (a, b) => normalizeChoiceText(a) === normalizeChoiceText(b);

    // Already answered with this.
    const current = promptSelectedText(el);
    if (current && primaryScore(current) >= 95) return true;

    // 1. Search for it.
    const found = await searchPrompt(el, wanted, {
      accept: (row) => !isPromptCategory(row) && primaryScore(row.text) >= 95,
    });
    // A category opens another list; it cannot produce a selected pill.
    // Waiting for a pill here used to spend 2.5s before browsing the same tree.
    const hit = best(found.filter((row) => !isPromptCategory(row)), primaryScore, 78);
    if (hit && await pickPromptResult(el, hit)) return done();
    if (!document.contains(el)) return false;

    // 2. Look for it in the list itself, from the top.
    let { rows: top, baseline } = await openPromptList(el);
    let atTop = true;
    const backToTop = async () => {
      if (atTop) return top;
      ({ rows: top, baseline } = await openPromptList(el));
      atTop = true;
      return top;
    };
    const tryRow = async (row, { accept }) => {
      const list = await backToTop();
      const target = list.find((r) => same(r.text, row.text));
      if (!target) return false;
      const clicked = await clickPromptRow(el, target, baseline);
      atTop = false;
      if (clicked.picked) return accept;
      const inner = best(clicked.rows, primaryScore, 78);
      return Boolean(inner && await pickPromptResult(el, inner));
    };

    // The answer itself at the top.
    const topHit = best(top, primaryScore, 78);
    if (topHit && await tryRow(topHit, { accept: true })) return done();

    // Inside the categories it would be filed under, marked ones first.
    const categories = ranked(top.filter(isPromptCategory), closeScore, 60).slice(0, 3);
    for (const row of categories) {
      if (await tryRow(row, { accept: true })) return done();
    }

    // 3. No list holds the answer itself: a close description of it — which
    // may still turn out to be a category holding the answer.
    const described = ranked(top.filter((r) => !isPromptCategory(r)), closeScore, 60).slice(0, 3);
    for (const row of described) {
      if (await tryRow(row, { accept: true })) return done();
    }

    await closePrompt(el);
    if (document.contains(el) && String(el.value ?? "")) typeIntoSearch(el, "");
    try { el.blur?.(); } catch {}
    return false;
  }

  /** The state's own name for an id: "US-FL" → "Florida". */
  function regionName_(id) {
    try { return REGIONS.nameOf?.get(id) || regionName(id) || null; } catch { return null; }
  }

  /** A widget that paints the picked place beside the box instead of into it. */
  function widgetShowsChoice(el, chosen) {
    try {
      const container = widgetContainer(el);
      if (!container) return false;
      const painted = container.querySelector(CHOICE_VALUE_SELECTOR);
      return Boolean(painted && clean(painted.textContent) === chosen);
    } catch { return false; }
  }

  /* ------------------------------------------------------------------ */
  /*  Reading a decorated dropdown's answer                              */
  /* ------------------------------------------------------------------ */

  /**
   * The markup a dropdown library renders its *chosen* answer into.
   *
   * This matters far more than it looks. On react-select — which is what
   * Greenhouse, Ashby, Lever and a long tail of custom portals use — the
   * control itself is an `<input>` whose `value` is the *search text*, so it is
   * empty whenever the menu is closed. The answer is painted into a sibling
   * node instead. A reader that only inspects the control therefore sees an
   * answered question as blank, and everything downstream goes wrong at once:
   * the field is planned again, written again, fails to verify, gets retried,
   * and is finally handed to the AI pass — which is exactly the "autofill goes
   * back to completed fields and edits them" report.
   */
  const CHOICE_VALUE_SELECTOR = [
    '[class*="singleValue" i]',               // react-select (emotion class names)
    '[class*="single-value" i]',              // react-select with a classNamePrefix
    '[class*="multiValue__label" i]',
    '[class*="multi-value__label" i]',
    '[class*="selectedValue" i]',
    '[class*="selected-value" i]',
    '[class*="selection-item" i]',            // Ant Design
    '[class*="selection__rendered" i]',       // Select2 v4
    '[class*="select2-chosen" i]',            // Select2 v3
    '[class*="chosen-single" i] span',        // Chosen
    '[class*="vs__selected" i]',              // vue-select
    '[class*="MuiSelect-select" i]',          // MUI
    '[class*="v-select__selection" i]',       // Vuetify
    '[class*="ss-single" i]',                 // slim-select
    '[class*="filter-option-inner-inner" i]', // bootstrap-select
    '[data-automation-id="selectedItem"]',    // Workday
    '[data-testid*="selectedValue" i]',
  ].join(", ");

  const IN_MENU = '[role="listbox"], [role="menu"], [role="tree"], [role="dialog"]';

  /** Is this node actually on the page (not a hidden or collapsed leftover)? */
  function isShowing(node) {
    if (!node || node.hidden) return false;
    try {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    } catch { return false; }
    return true;
  }

  /**
   * The wrapper a decorated dropdown renders itself into.
   *
   * Walks up only while the ancestor still belongs to this one control, so a
   * section holding several questions is never mistaken for one widget — that
   * would let a neighbouring question's answer be read as this one's.
   */
  function widgetContainer(el) {
    let node = el?.parentElement;
    let found = null;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (!ownsOnlyThisField(node, el)) break;
      found = node;
    }
    return found;
  }

  /** Is the widget still showing its "Select…" placeholder rather than an answer? */
  function showsPlaceholder(el) {
    const container = widgetContainer(el);
    if (!container) return false;
    let nodes;
    try { nodes = container.querySelectorAll('[class*="placeholder" i]'); } catch { return false; }
    for (const node of nodes) {
      if (node === el || node.contains?.(el)) continue;
      if (node.closest?.(IN_MENU)) continue;
      if (!isShowing(node)) continue;
      if (clean(node.textContent)) return true;
    }
    return false;
  }

  /** The answer the widget has painted, read from the control or its wrapper. */
  function renderedChoiceText(el) {
    const scopes = [];
    if (el?.querySelectorAll) scopes.push(el);
    const container = widgetContainer(el);
    if (container) scopes.push(container);

    for (const scope of scopes) {
      let nodes;
      try { nodes = scope.querySelectorAll(CHOICE_VALUE_SELECTOR); } catch { continue; }
      const texts = [];
      for (const node of nodes) {
        if (node === el || node.contains?.(el)) continue;
        // An option sitting in an open menu is a candidate, not a committed
        // answer, and the menu is often rendered inside the same wrapper.
        if (node.closest?.(IN_MENU)) continue;
        if (/placeholder/i.test(node.className || "")) continue;
        if (!isShowing(node)) continue;
        const text = clean(node.textContent);
        if (!text || isPlaceholderChoice(text, deriveLabel(el))) continue;
        if (!texts.includes(text)) texts.push(text);
      }
      if (texts.length) return texts.join(", ");
    }
    return "";
  }

  /**
   * Where a decorated dropdown keeps the value it will actually submit.
   *
   * Usually a real `<select>`. When there isn't one, react-select and friends
   * post a hidden `<input>` instead — and Greenhouse puts an internal option id
   * in it, not the label. So this answers "is this question answered?", never
   * "what does it say".
   */
  function backingValueHolder(el) {
    const select = backingSelect(el);
    if (select && select !== el) return select;
    if (!el || fieldKind(el) !== "select") return null;

    const container = widgetContainer(el);
    if (!container) return null;
    let hidden;
    try { hidden = Array.from(container.querySelectorAll('input[type="hidden"]')); } catch { return null; }
    const candidates = hidden.filter(
      (input) => input !== el && !/csrf|token|authenticity|utf8|_method|nonce/i.test(`${input.name || ""} ${input.id || ""}`)
    );
    // Two hidden inputs in one wrapper is ambiguous; guessing would be worse
    // than reporting nothing.
    return candidates.length === 1 ? candidates[0] : null;
  }

  /** Does the widget's own value store hold a real answer? */
  function backingHasValue(el) {
    const holder = backingValueHolder(el);
    if (!holder) return false;
    if (holder.tagName === "SELECT") {
      const opt = holder.options?.[holder.selectedIndex];
      return Boolean(opt?.value) && !isPlaceholderChoice(opt.textContent, deriveLabel(el));
    }
    const raw = String(holder.value ?? "").trim();
    if (!raw || isPlaceholderChoice(raw, deriveLabel(el))) return false;
    // The "nothing chosen" sentinels widgets post before anyone touches them.
    if (/^(-1|0|null|undefined|false)$/i.test(raw)) return false;
    // And whatever the hidden field holds, a control still showing "Select…"
    // has not been answered. Believing otherwise would skip a blank question.
    return !showsPlaceholder(el);
  }

  /**
   * What a custom dropdown is currently showing.
   *
   * Deliberately does not fall back to the button's whole text: on Workday the
   * button label includes the question ("Country United States"), which made
   * an *unset* control look filled.
   */
  function comboboxDisplayValue(el) {
    if (!el) return "";

    // The select underneath is the value the form will actually submit, and it
    // updates before the decoration does.
    const backing = backingSelect(el);
    if (backing && backing !== el) {
      const opt = backing.options?.[backing.selectedIndex];
      const text = clean(opt?.textContent || "");
      if (opt?.value && text && !isPlaceholderChoice(text, deriveLabel(el))) return text;
      return "";
    }

    // What the widget has painted as the answer. Checked before the control's
    // own value because on a search-style combobox that value is the filter
    // text, not the answer.
    const rendered = renderedChoiceText(el);
    if (rendered) return rendered;

    // A widget still showing "Select…" is unanswered, whatever half-typed
    // search text happens to be sitting in its input.
    if (showsPlaceholder(el)) return "";

    const semantic =
      el.getAttribute("aria-valuetext") ||
      el.getAttribute("data-value") ||
      el.getAttribute("data-uxi-widget-value") ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : "");
    if (semantic && String(semantic).trim() && !isPlaceholderChoice(semantic, deriveLabel(el))) return String(semantic).trim();

    const selected = el.querySelector?.('[aria-selected="true"]');
    if (selected && !selected.closest?.(IN_MENU)) {
      const t = clean(selected.textContent);
      if (t && !isPlaceholderChoice(t, deriveLabel(el))) return t;
    }

    const activeId = el.getAttribute("aria-activedescendant");
    if (activeId) {
      const active = document.getElementById(activeId);
      if (active) {
        const t = clean(active.textContent);
        if (t) return t;
      }
    }

    // A button whose text is short and not a placeholder is the value itself —
    // unless it is just repeating the question. Workday renders an unset
    // dropdown as a button reading "Country", and treating that as a filled
    // value means the field is skipped and never answered.
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "combobox") {
      const t = clean(el.textContent);
      if (!t || t.length > 80) return "";
      if (isPlaceholderChoice(t, deriveLabel(el)) || /\b(select|choose)\b/i.test(t)) return "";
      return norm(t) === norm(accessibleName(el)) ? "" : t;
    }
    return "";
  }

  /** The control's own question text, as a screen reader would read it. */
  function accessibleName(el) {
    const direct = el.getAttribute("aria-label");
    if (direct) return clean(direct);
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) {
      return clean(ids.map((id) => document.getElementById(id)?.textContent || "").join(" "));
    }
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return visibleText(label);
      } catch {}
    }
    return "";
  }

  /* ------------------------------------------------------------------ */
  /*  Checkboxes                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The boxes that answer one question together.
   *
   * A native checkbox was only ever grouped by a shared `name`; without one it
   * was a group of one. Workday's CC-305 draws its three disability boxes with
   * nothing but generated ids, so the stored answer ("No, I don't have a
   * disability") was offered to a single box as if it were an "I agree" — it is
   * neither yes nor no, nothing was ticked, and the question was left blank on
   * every self-identification page. Boxes with no name are now grouped when
   * the page groups them (a fieldset or `role="group"`) or when they are the
   * options of one voluntary-disclosure question. Loose consent boxes that
   * merely sit near each other stay separate, as before.
   */
  function checkboxGroup(el, hint = "") {
    if (!el?.getAttribute) return [el];
    const isCustom = el.getAttribute("role") === "checkbox";
    const name = el.getAttribute("name");
    try {
      if (name) {
        const byName = Array.from(document.querySelectorAll(
          isCustom
            ? `[role="checkbox"][name="${CSS.escape(name)}"]`
            : `input[type="checkbox"][name="${CSS.escape(name)}"]`
        ));
        if (byName.length > 1) return byName;
      }
      const container = el.closest?.("fieldset, [role='group']");
      if (isCustom) {
        const members = Array.from(container?.querySelectorAll('[role="checkbox"]') || []);
        return members.length > 1 ? members : [el];
      }
      const shared = choiceGroup(el);
      if (shared.length > 1) {
        if (container && shared.every((m) => container.contains(m))) return shared;
        // The boxes of one Oracle question row ("Select the races you identify with.").
        const oracleRow = onOracleCandidateExperience() ? el.closest?.(".input-row") : null;
        if (oracleRow && shared.every((m) => oracleRow.contains(m))) return shared;
        const ids = shared.map((m) => eeoId(radioOptionText(m), hint)).filter(Boolean);
        if (ids.length >= 2) return shared;
      }
    } catch {}
    return [el];
  }

  /**
   * The voluntary-disclosure branch a stored answer stands for.
   *
   * A profile may hold the long wording ("No, I don't have a disability") or a
   * bare "No". The long one reduces on its own; the bare one is read through
   * the rule's synonyms, and failing that as the yes/no branch of the one
   * question this group asks — never across questions, and never for a
   * question whose answers are not simply yes and no (veteran status).
   */
  function disclosureAnswerId(raw, hint, synonyms, optionIds = []) {
    const direct = eeoId(raw, hint);
    if (direct) return direct;
    for (const synonym of synonymsFor(synonyms, raw)) {
      const id = eeoId(synonym, hint);
      if (id) return id;
    }
    const yn = yesNoId(raw);
    if (yn === "decline") return "decline";
    if (yn === "yes" || yn === "no") {
      const domains = new Set(
        optionIds.filter((id) => id && id !== "decline").map((id) => id.split(":")[0])
      );
      if (domains.size === 1) {
        const candidate = `${[...domains][0]}:${yn}`;
        if (optionIds.includes(candidate)) return candidate;
      }
    }
    return null;
  }

  function setCheckboxValue(el, answer, synonyms, hint) {
    if (answer === undefined || answer === null || answer === "") return false;

    const group = checkboxGroup(el, hint);

    let wants;
    if (Array.isArray(answer)) {
      wants = answer.map(norm).filter(Boolean);
    } else {
      const raw = String(answer).trim();
      if (/^(yes|true|checked|selected|1)$/i.test(raw)) wants = ["yes"];
      else if (/^(no|false|unchecked|not selected|0|none)$/i.test(raw)) wants = [];
      else wants = raw.split(/\s*(?:,|;|\n|\|)\s*/).map(norm).filter(Boolean);
    }

    const checked = (cb) =>
      cb.getAttribute("role") === "checkbox" ? cb.getAttribute("aria-checked") === "true" : Boolean(cb.checked);

    const setChecked = (cb, shouldCheck) => {
      if (checked(cb) === shouldCheck) return;   // already right — leave it alone
      clickCommitting(cb, () => {
        cb.click?.();
        if (cb.getAttribute("role") === "checkbox") cb.setAttribute("aria-checked", String(shouldCheck));
      });
    };

    if (group.length === 1) {
      // Single checkbox: only check on an explicit affirmative. A non-"no"
      // string used to count as "yes" — a checkbox labelled "Subscribe to
      // marketing emails" would be ticked whenever the saved answer was the
      // question's own text. Now we require a real yes/agree/consent/true/1,
      // otherwise the box stays as the applicant left it.
      const rawAnswer = String(answer ?? "").trim();
      const affirmative = /^(yes|y|true|checked|selected|agree|consent|accept|1|enabled|on)$/i.test(rawAnswer);
      const negative = /^(no|n|false|unchecked|not selected|0|none|disabled|off|decline|opt[\s-]?out)$/i.test(rawAnswer);
      // If the answer is neither clearly yes nor clearly no, do nothing — the
      // applicant's intent is ambiguous and writing a value would either tick
      // a box they did not mean to tick or uncheck one they did mean to keep.
      if (!affirmative && !negative) return false;
      const shouldCheck = affirmative;
      setChecked(el, shouldCheck);
      return checked(el) === shouldCheck;
    }

    /**
     * A group of boxes where exactly one is the answer — the CC-305 disability
     * question is three of them — is a radio group wearing a checkbox costume,
     * and it must be answered the same way.
     *
     * It was not. `wants` reduced a stored "Yes" to the bare token "yes", and
     * every box whose text contained the word "yes" was then ticked. On the
     * CC-305 that is "Yes, I have a disability, or have had one in the past" —
     * a declaration under a federal form, ticked on a word match. The mirror
     * case was just as bad: a stored "No" produced an empty `wants`, so the
     * "No, I do not have a disability…" box could never be ticked at all.
     *
     * Voluntary-disclosure groups now resolve through the same branch rule as
     * every other EEO control: right branch or nothing.
     */
    const groupLabels = group.map((cb) =>
      clean(`${radioOptionText(cb)} ${cb.getAttribute("aria-label") || ""} ${cb.value || ""}`)
    );
    const rawAnswer = String(Array.isArray(answer) ? answer.join(", ") : answer).trim();

    /**
     * Every box in this group says the same thing.
     *
     * Then the label cannot pick one out, and this is not one question with
     * several options — it is one question repeated once per row, which is what
     * "I currently work here" is on a form with three jobs. Writing the answer
     * across the whole group ticked it against every job the applicant had ever
     * held. Answer the box that was actually asked about and leave the rest.
     */
    if (new Set(groupLabels.map(norm).filter(Boolean)).size <= 1) {
      const shouldCheck = !/^(no|false|unchecked|not selected|0|none)$/i.test(rawAnswer);
      setChecked(el, shouldCheck);
      return checked(el) === shouldCheck;
    }

    const optionIds = groupLabels.map((t) => eeoId(t, hint));
    const isDisclosureGroup = optionIds.filter(Boolean).length >= 2;

    if (isDisclosureGroup) {
      const answerId = disclosureAnswerId(rawAnswer, hint, synonyms, optionIds);
      if (!answerId) return false;   // no canonical answer — leave it for the user
      let best = -1, bestScore = 0;
      optionIds.forEach((id, i) => {
        if (id !== answerId) return;
        const sc = eeoBranchScore(groupLabels[i], rawAnswer);
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best === -1) return false;
      group.forEach((cb, i) => setChecked(cb, i === best));
      return checked(group[best]);
    }

    let matched = 0;
    for (const cb of group) {
      const label = norm(`${radioOptionText(cb)} ${cb.getAttribute("aria-label") || ""} ${cb.value || ""}`);
      const shouldCheck = wants.some((w) => {
        if (w === "yes") return /\byes\b|\bagree\b|\baccept\b/i.test(label);
        const accepted = synonyms?.[w]?.map(norm) ?? [w];
        return accepted.some((x) => x && (label === x || label.includes(x) || x.includes(label)));
      });
      if (shouldCheck) matched++;
      setChecked(cb, shouldCheck);
    }
    return matched > 0 && group.some(checked);
  }

  /* ------------------------------------------------------------------ */
  /*  Files                                                              */
  /* ------------------------------------------------------------------ */

  function fileFromDataUrl(doc) {
    const [meta, b64] = doc.dataUrl.split(",");
    const mime = /:(.*?);/.exec(meta)?.[1] || doc.mimeType || "application/pdf";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], doc.name || "resume.pdf", { type: mime });
  }

  function setFileValue(el, doc) {
    if (!doc?.dataUrl) return false;

    let file;
    try { file = fileFromDataUrl(doc); }
    catch (err) { console.warn("[Appli-Fill] couldn't rebuild the resume file:", err); return false; }

    const dt = (() => {
      try { const t = new DataTransfer(); t.items.add(file); return t; } catch { return null; }
    })();
    if (!dt) return false;

    try {
      el.files = dt.files;
      if (el.files?.length) { fire(el, "input", "change"); return true; }
    } catch {}

    try {
      Object.defineProperty(el, "files", { value: dt.files, configurable: true });
      fire(el, "input", "change");
      if (el.files?.length) return true;
    } catch {}

    try {
      const zone =
        el.closest('[class*="dropzone"], [class*="drop-zone"], [class*="upload"], [data-testid*="upload"]') ||
        el.parentElement || el;
      ["dragenter", "dragover", "drop"].forEach((type) => {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      return true;
    } catch (err) {
      console.warn("[Appli-Fill] file attach failed:", err);
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Saved-answer matching (shared with the server)                     */
  /* ------------------------------------------------------------------ */

  const STOPWORDS =
    /\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g;

  /** Must stay in sync with normalizeQuestion() in src/models/SavedResponse.ts */
  function normalizeQuestion(q) {
    return (q || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(STOPWORDS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  // Unlike the legacy storage key, this key retains qualifications in
  // parentheses, conjunctions, numbers and modal verbs. Those words can
  // completely change the answer to a binary question.
  function savedQuestionKey(q) {
    return String(q ?? "").toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/\b(can't|cannot)\b/g, "can not")
      .replace(/\bwon't\b/g, "will not")
      .replace(/n't\b/g, " not")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(please|kindly)\b/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  const savedIndexes = new WeakMap();
  function savedAnswerIndex(responses) {
    const cached = savedIndexes.get(responses);
    if (cached && cached.length === responses.length) return cached;
    const exact = new Map();
    const legacy = new Map();
    const rows = [];
    const add = (map, key, row) => {
      if (!key) return;
      const entries = map.get(key) || [];
      entries.push(row);
      map.set(key, entries);
    };
    for (const record of responses) {
      if (!record?.answer) continue;
      const questions = [record.question, ...(record.aliases || [])].filter(Boolean);
      const keys = [...new Set([record.normalizedKey, ...questions.map(normalizeQuestion)].filter(Boolean))];
      const row = { record, keys, binary: Boolean(yesNoId(record.answer)), questions };
      rows.push(row);
      for (const question of questions) add(exact, savedQuestionKey(question), { ...row, matchedQuestion: question });
      for (const key of keys) add(legacy, key, row);
    }
    const index = { exact, legacy, rows, length: responses.length };
    savedIndexes.set(responses, index);
    return index;
  }

  function stem(word) {
    return word
      .replace(/(ations?|ation)$/, "ate")
      .replace(/(ings?)$/, "")
      .replace(/(ed)$/, "")
      .replace(/(ies)$/, "y")
      .replace(/(es)$/, "")
      .replace(/s$/, "")
      .replace(/e$/, "");
  }

  // A saved-answer lookup runs for every field against every saved answer, so
  // the same few hundred strings were tokenized thousands of times per fill.
  const tokenCache = new Map();
  function tokenize(normalized) {
    const cached = tokenCache.get(normalized);
    if (cached) return cached;
    const tokens = new Set(
      normalized.split(" ").filter((w) => w.length > 2).map(stem).filter((w) => w.length > 1)
    );
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(normalized, tokens);
    return tokens;
  }

  function similarity(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach((w) => { if (B.has(w)) shared++; });
    // Symmetric overlap only.
    //
    // Scoring containment as well looks appealing — it rescues "Work
    // authorization" against "Are you legally authorized to work in the United
    // States?" — but it also means every token of a short saved question being
    // present anywhere in a long one counts as a full match. A saved "Full
    // name" then answers "Confidentiality Agreement Designee full legal name".
    // Reusing an answer on the wrong question is worse than not reusing it, so
    // a genuine reword is handled by storing an alias, not by loosening this.
    return shared / Math.max(A.size, B.size);
  }

  /**
   * Picks the best saved answer for a question, or null.
   * The threshold stays high: filling the wrong answer into a real application
   * is far worse than leaving a field for the user.
   */
  function findSavedAnswer(question, responses, threshold = 0.62) {
    if (!responses?.length) return null;
    const key = normalizeQuestion(question);
    if (!key) return null;

    const index = savedAnswerIndex(responses);
    const strict = index.exact.get(savedQuestionKey(question)) || [];
    if (strict.length) {
      // Conflicting imported/aliased answers require review, not array-order
      // selection. Duplicate copies of the same answer remain usable.
      const answers = new Set(strict.map(({ record }) => yesNoId(record.answer) || norm(record.answer)));
      if (answers.size > 1) return null;
      return { ...strict[0].record, confidence: 1, matchedQuestion: strict[0].matchedQuestion };
    }

    // Old normalized keys discarded parenthesized conditions. Never use such
    // a collision, or token similarity, to replay a Yes/No declaration.
    const exact = (index.legacy.get(key) || []).find((row) => !row.binary);
    if (exact) return { ...exact.record, confidence: 1 };
    if (threshold >= 1) return null;

    let best = null;
    let bestScore = threshold;
    index.rows.forEach((row) => {
      if (row.binary) return;
      const score = Math.max(...row.keys.map((a) => similarity(key, a)), 0);
      if (score > bestScore) { bestScore = score; best = row.record; }
    });
    return best ? { ...best, confidence: bestScore } : null;
  }

  /* ------------------------------------------------------------------ */
  /*  State reading                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Is this something a person types into, picks from or ticks?
   *
   * The field scan also looks at anything carrying `data-qa` or `data-testid`,
   * because a few portals put those on the control and nothing else. Lever puts
   * them on the *containers* too — the <li> around each question, the <div>
   * around each input — and every one of those was collected as a text box of
   * its own. A <div> cannot be typed into, so the text went to whatever did
   * have the caret: the Phone box the applicant had just clicked into came back
   * holding "516-205-8456Jacksonville, Florida, United States…". And an <li>
   * has a `value` property — its list number — so each question's wrapper was
   * then offered in Pending Saved Answers as an answer of "0".
   */
  const CONTROL_ROLES = new Set([
    "textbox", "searchbox", "combobox", "spinbutton", "listbox",
    "checkbox", "radio", "switch", "button", "menuitemcheckbox", "menuitemradio",
  ]);

  function isFormControl(el) {
    if (!el?.tagName) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return true;
    const role = String(el.getAttribute?.("role") || "").toLowerCase().trim();
    if (role && CONTROL_ROLES.has(role)) return true;
    // The editing host of a rich-text box — not every paragraph inside it.
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    const popup = el.getAttribute?.("aria-haspopup");
    return Boolean(popup && popup !== "false");
  }

  /** Can text actually be typed into this element? */
  const NOT_TYPED_INPUT_TYPES = new Set([
    "checkbox", "radio", "file", "submit", "reset", "button", "image", "hidden", "range", "color",
  ]);

  function acceptsText(el) {
    if (!el?.tagName || el.disabled) return false;
    if (el.tagName === "TEXTAREA") return !el.readOnly;
    if (el.tagName === "INPUT") {
      return !el.readOnly && !NOT_TYPED_INPUT_TYPES.has(String(el.type || "text").toLowerCase());
    }
    return el.isContentEditable === true;
  }

  /**
   * Does this element hold the caret right now?
   *
   * `execCommand("insertText")` types into whatever is focused, not into the
   * element it was meant for. `focus()` does nothing on an element that cannot
   * take focus — or while the page moves focus somewhere else in a handler — so
   * the command is only ever issued once focus is confirmed to be here.
   * Checked through shadow roots, where `document.activeElement` is the host.
   */
  function holdsFocus(el) {
    try {
      const root = el.getRootNode?.();
      const active = root && root !== document && "activeElement" in root
        ? root.activeElement
        : document.activeElement;
      return active === el;
    } catch {
      return false;
    }
  }

  /** Put the caret in `el`, and say whether it actually went there. */
  function takeFocus(el) {
    if (holdsFocus(el)) return true;
    try { el.focus?.({ preventScroll: true }); } catch { try { el.focus?.(); } catch {} }
    return holdsFocus(el);
  }

  /**
   * Put the caret in `el` and make sure the page hears about it.
   *
   * A fill is started from the extension's popup, and while the popup is open
   * the page does not have the focus. Chrome then moves the caret without
   * telling anyone: `focus()` and `blur()` dispatch no focus, focusin, blur or
   * focusout events. React (17 and later) learns about focus only through
   * focusin and focusout. So a box Appli-Fill typed into was never entered or left
   * as far as the page could tell. A box that keeps its text only once it is
   * left (Workday's name and address boxes, which validate on blur) stayed
   * empty in the page's own model. Save and Continue then reported "The field
   * First Name is required and must have a value" under a box plainly holding
   * the name.
   *
   * When the browser stays silent, the events are sent here instead. When it
   * does send them (the page has the focus), nothing is added.
   */
  function takeFocusAnnounced(el) {
    if (holdsFocus(el)) return true;
    let prev = null;
    try { prev = document.activeElement; } catch {}
    if (prev === document.body || prev === document.documentElement) prev = null;
    let heard = false;
    const hear = () => { heard = true; };
    try { el.addEventListener("focusin", hear, true); } catch {}
    const focused = takeFocus(el);
    try { el.removeEventListener("focusin", hear, true); } catch {}
    if (focused && !heard) {
      try {
        // The box the caret left hears that it was left — for the box it went
        // to, as when a person tabs from one box to the next.
        if (prev && prev !== el && document.contains(prev)) {
          prev.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: el }));
          prev.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: el }));
        }
        el.dispatchEvent(new FocusEvent("focus", { bubbles: false, relatedTarget: prev }));
        el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: prev }));
      } catch {}
    }
    return focused;
  }

  /**
   * `el.blur()`, and whether the browser told the page (a `focusout` arrived).
   * See `takeFocusAnnounced`: with the popup open it does not.
   */
  function blurHeard(el) {
    let heard = false;
    const hear = () => { heard = true; };
    try { el.addEventListener("focusout", hear, true); } catch {}
    try { el.blur?.(); } catch {}
    try { el.removeEventListener("focusout", hear, true); } catch {}
    return heard;
  }

  /**
   * Leave `el`: blur it, send the blur event that was always sent, and send a
   * focusout too when the browser sent none — the event React reads as the box
   * being left.
   */
  function leaveLikeUser(el) {
    const heard = blurHeard(el);
    fire(el, "blur");
    if (!heard) fire(el, "focusout");
    return heard;
  }

  /**
   * A read-only box that is really a drop-down.
   *
   * Oracle Recruiting draws State, County, Tax District, Veteran Status and
   * most of its other lists as `<input readonly role="combobox">`: the box
   * cannot be typed in, a click opens the list. Every read-only input was
   * refused as unfillable, so none of those was ever collected and State sat
   * empty under "This field is required". A box that says it opens a list is
   * answered from the list; a read-only box that does not stays untouched.
   */
  function opensList(el) {
    const role = String(el?.getAttribute?.("role") || "").toLowerCase();
    if (role === "combobox" || role === "listbox") return true;
    const popup = String(el?.getAttribute?.("aria-haspopup") || "").toLowerCase();
    return popup === "listbox" || popup === "menu" || popup === "true" || popup === "tree";
  }

  function isFillable(el) {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (el.readOnly && !opensList(el)) return false;
    if (el.type === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.type !== "file") return false;
    return true;
  }

  /**
   * Whether a shown value and an intended one mean the same thing, when both
   * can be read canonically — a state, or a yes/no. Null when they can't, so
   * the caller falls back to comparing the words.
   */
  function canonicalAgreement(shown, expected) {
    const wantRegion = regionId(expected, { loose: true });
    const shownRegion = wantRegion ? regionId(shown) : null;
    if (wantRegion && shownRegion) return wantRegion === shownRegion;
    const wantYn = yesNoId(expected);
    const shownYn = wantYn ? yesNoId(shown) : null;
    if (wantYn && shownYn) return wantYn === shownYn;
    return null;
  }

  function valuesEquivalent(el, expected, hint) {
    if (expected === undefined || expected === null || String(expected).trim() === "") return false;
    if (isSdfField(el)) return sdfEquivalent(el, expected, hint);
    const kind = fieldKind(el);
    const target = norm(expected);
    if (kind === "radio") {
      const role = el.getAttribute("role");
      if (choiceButtonGroup(el)) {
        const picked = choiceButtonGroupValue(el);
        if (!picked) return false;
        const canonical = canonicalAgreement(picked, expected);
        if (canonical !== null) return canonical;
        return choiceScore(normalizeChoiceText(picked), "", target, hint) >= 65;
      }
      return radioGroup(el).some((r) => {
        const selected = role === "radio" ? r.getAttribute("aria-checked") === "true" : r.checked;
        if (!selected) return false;
        const text = radioOptionText(r);
        const canonical = eeoId(expected, hint) ? null : canonicalAgreement(text, expected);
        if (canonical !== null) return canonical;
        return choiceScore(text, r.getAttribute("value") || "", expected, hint) >= 65;
      });
    }
    if (kind === "checkbox") return verifyCheckboxEquivalent(el, expected, hint);
    if (kind === "select") {
      if (el.tagName === "SELECT") {
        const opt = el.options?.[el.selectedIndex];
        if (!opt) return false;
        if (isPlaceholderChoice(opt.textContent, hint)) return false;
        const canonical = eeoId(expected, hint) ? null : canonicalAgreement(opt.textContent || opt.value || "", expected);
        if (canonical !== null) return canonical;
        return choiceScore(opt.textContent || "", opt.value || "", expected, hint) >= 65;
      }
      const shown = normalizeChoiceText(comboboxDisplayValue(el));
      if (!shown) return false;
      const wantId = eeoId(expected, hint);
      if (wantId) {
        const shownId = eeoId(shown, hint);
        if (shownId) return shownId === wantId;
      }
      // "NC" and "North Carolina" are the same answer; "Virginia" and "West
      // Virginia" are not, although one contains the other.
      const canonical = canonicalAgreement(shown, expected);
      if (canonical !== null) return canonical;
      const t = normalizeChoiceText(target);
      return shown === t || containsAtWord(shown, t) || (shown.length >= 3 && containsAtWord(t, shown));
    }
    return norm(el.value ?? el.textContent ?? "") === target;
  }

  function verifyCheckboxEquivalent(el, expected, hint = "") {
    const role = el.getAttribute("role");
    const group = checkboxGroup(el, hint);
    const isChecked = (c) => (role === "checkbox" ? c.getAttribute("aria-checked") === "true" : c.checked);
    const raw = String(expected).trim();

    // A disclosure group is right when the ticked box is on the answer's
    // branch — "No" and "No, I do not have a disability and have not had one
    // in the past" are the same answer, and "I do not want to answer" is not
    // "No" merely because it contains the letters.
    if (group.length > 1) {
      const optionIds = group.map((c) => eeoId(radioOptionText(c), hint));
      if (optionIds.filter(Boolean).length >= 2) {
        const want = disclosureAnswerId(raw, hint, null, optionIds);
        if (want) return group.some((c, i) => isChecked(c) && optionIds[i] === want);
      }
    }

    const wantNone = /^(no|false|unchecked|not selected|0|none)$/i.test(raw);
    if (wantNone) return !group.some(isChecked);
    const target = norm(raw);
    return group.some((c) => {
      if (!isChecked(c)) return false;
      const label = norm(radioOptionText(c));
      return target === "yes" || label === target || label.includes(target) || target.includes(label);
    });
  }

  function hasValue(el) {
    if (isSdfField(el)) return sdfHasValue(el);
    const role = el.getAttribute("role");
    const type = (el.type || "").toLowerCase();
    if (role === "checkbox" || type === "checkbox") {
      const group = checkboxGroup(el);
      return group.some((x) => role === "checkbox" ? x.getAttribute("aria-checked") === "true" : x.checked);
    }
    if (role === "radio" || type === "radio") {
      return radioGroup(el).some((x) => {
        const checked = x.getAttribute("role") === "radio" ? x.getAttribute("aria-checked") === "true" : x.checked;
        // SuccessFactors preselects a real radio labelled "No Selection".
        // That is still an unanswered question, just like a select prompt.
        return checked && !/^\s*(?:no\s+selection|not\s+selected|[-–—]*\s*(?:please\s+)?select(?:\s+an?\s+option)?\s*[-–—]*)\s*$/i.test(radioOptionText(x));
      });
    }
    if (type === "file") return el.files?.length > 0;
    if (choiceButtonGroup(el)) return radioGroup(el).some(choiceButtonSelected);
    // A Workday prompt is answered by its pill. Text left in its search box —
    // typed and never picked — is not an answer, and Workday rejects it.
    if (isWorkdayPrompt(el)) return Boolean(promptSelectedText(el));
    // Lever's location: only a place picked from its list is an answer.
    const leverPicked = leverLocationPicked(el);
    if (leverPicked !== null) return leverPicked;
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return Boolean(opt?.value) && !isPlaceholderChoice(opt.textContent, deriveLabel(el));
    }
    if (el.tagName === "BUTTON" || role === "button" || role === "combobox" || el.getAttribute("aria-haspopup")) {
      // Read what the widget shows first, then what it would actually submit.
      // A react-select posts a hidden input holding an internal option id, so
      // the second check is the only proof some questions are answered at all.
      return Boolean(comboboxDisplayValue(el)) || backingHasValue(el);
    }
    return Boolean(String(el.value ?? "").trim());
  }

  function optionTextsFor(el) {
    if (!el) return [];
    if (isSdfField(el)) return sdfOptionTexts(el);
    const segmented = choiceButtonGroup(el);
    if (segmented) return segmented.map((b) => radioOptionText(b)).filter(Boolean);
    if (el.tagName === "SELECT") {
      return Array.from(el.options || [])
        .map((o) => (o.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (el.type === "radio" || el.type === "checkbox" ||
        el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
      // One resolver, so the option list can never disagree with the value read
      // back from the same group. Previously a nameless group reported a single
      // "option" — its own label — which is what let an option's text be stored
      // as the question.
      return choiceGroup(el)
        .map(radioOptionText)
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 50);
    }
    /**
     * A closed custom dropdown's choices are the ones seen when it was open.
     *
     * This used to return every option-shaped node visible anywhere on the page
     * — with the menu closed, that is the site's navigation or nothing — and
     * that list was stored beside captured answers and used to decide whether a
     * question was a plain Yes/No.
     */
    if (el.getAttribute?.("aria-expanded") === "true") {
      const open = visibleOptions().map((x) => clean(x.textContent || "")).filter(Boolean).slice(0, 50);
      if (open.length) return open;
    }
    return Array.isArray(el.__applifillMenuOptions) ? el.__applifillMenuOptions.slice(0, 50) : [];
  }

  /**
   * Reads a custom dropdown's choices without leaving the menu open.
   * Used when asking the model to answer a question we couldn't map.
   */
  async function readComboboxOptions(el, waitMs = 800) {
    const opened = await openMenu(el, waitMs);
    const texts = opened.options
      .map((x) => {
        const text = clean(x.textContent || x.getAttribute?.("aria-label") || "").replace(/[›»>❯]\s*$/, "").trim();
        if (!text) return "";
        return isParentOption(x) ? `${text} (category, has sub-options)` : text;
      })
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 60);
    await closeOpenMenu();
    return texts;
  }

  global.APPLI_FILL_MATCHER = {
    retypeValue, flaggedInvalid, isRequired, opensFilePicker,
    choiceButtonGroup, isChoiceButton, choiceButtonSelected, choiceButtonGroupValue,
    deriveLabel,
    groupLabel,
    sectionContext,
    repeatedRowKey,
    headingIndex,
    rowsFromAnchors,
    isParentOption,
    humanize,
    fieldKind,
    matchRule,
    setTextValue,
    setSelectValue,
    setRadioValue,
    setCheckboxValue,
    setComboboxValue,
    comboboxDisplayValue,
    readComboboxOptions,
    visibleOptions,
    backingSelect,
    backingValueHolder,
    backingHasValue,
    widgetContainer,
    renderedChoiceText,
    hasRealOptions,
    isPlaceholderChoice,
    findSearchInput,
    menusOpen,
    beginFillSession,
    waitForMenusClosed,
    closeOpenMenu,
    openMenu,
    waitForOptions,
    optionTextsFor,
    radioOptionText,
    choiceGroup,
    setFileValue,
    isFillable,
    ensureVisible,
    onScreen,
    hasValue,
    valuesEquivalent,
    visibleText,
    norm,
    clean,
    eeoId,
    canonicalChoice,
    regionId,
    regionName,
    regionCode,
    yesNoId,
    isYesNoList,
    strictChoiceScores,
    canonicalAgreement,
    containsAtWord,
    normalizeChoiceText,
    normalizeQuestion,
    similarity,
    tokenize,
    findSavedAnswer,
    savedQuestionKey,
    isFormControl,
    acceptsText,
    holdsFocus,
    looksLikeTypeahead,
    studyChoiceScore, studySearchTerms, isPhoneCodeControl,
    suggestionTexts: (el) => { try { return suggestionRowsFor(el).map(rowText); } catch { return []; } },
    isOracleSelect,
    isJetSelect: (el) => Boolean(jetSelectHost(el)),
    oracleFieldInvalid: oracleInvalid,
    onOracleCandidateExperience,
    setOracleSelectValue,
    pickOracleAddress,
    streetWithoutUnit,
    labelDrawnChoice,
    completeTypeahead,
    completeAddressSuggestion,
    parseStreet,
    addressScore,
    searchInProgress,
    choiceGroupContainer,
    inlineListbox,
    opensList,
    menuOptions,
    takeFocus,
    placeScore,
    checkboxGroup,
    disclosureAnswerId,
    inSelfIdBlock,
    dateParts,
    oracleDateControls, dateSegmentNodes,
    setSegmentedDateAsync,
    segmentShown,
    segmentedDateShows,
    segmentedDateValue,
    isHiddenMirror,
    isWorkdayPrompt,
    promptSelectedText,
    setPromptValue,
    setPromptChoice,
    isPromptCategory,
    schoolScore,
    leverLocationStore,
    leverLocationPicked,
    suggestionRowsFor,
    isPlacesBox,
    onAdp,
    shadowHost,
    pageHost,
    deepQuery,
    deepQueryAll,
    isSdfField,
    isSdfSelect,
    isSdfRadioGroup,
    isSdfCheckbox,
    SDF_FIELD_SELECTOR,
    sdfInnerPart,
    adpQuestion,
    setSdfSelectValue,
    setSdfRadioValue,
    setSdfCheckbox,
    sdfValueText,
    sdfOptionTexts,
    readSdfSelectOptions,
  };
})(typeof window !== "undefined" ? window : globalThis);
