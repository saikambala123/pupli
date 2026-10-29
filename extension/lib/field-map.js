/**
 * APPLI_FILL FIELD MAP
 * ----------------
 * The table that turns a form field's label into a value from the user's profile.
 *
 * Each rule has:
 *   key      unique id, used for logging and for the "skipped" report
 *   match    regexes tested against the field's derived label (label text,
 *            aria-label, placeholder, name, id — see matcher.js)
 *   deny     regexes that disqualify a match even if `match` hit. This is how
 *            "First name" is kept from stealing "First name of your reference".
 *   type     which input types this rule is allowed to fill
 *   value    (profile) => string | null
 *   options  for select/radio: how to pick among the available choices
 *   weight   tie-breaker when two rules match; higher wins
 *
 * Order matters only as a tie-break of last resort — scoring in matcher.js
 * decides, so put specific rules above general ones for readability.
 */

(function (global) {
  const P = (p) => p?.personal ?? {};
  const W = (p) => p?.workAuth ?? {};
  const C = (p) => p?.compensation ?? {};
  const E = (p) => p?.eeo ?? {};
  const onIcimsPage = () => {
    if (/(^|\.)icims\.com$/i.test(global.location?.hostname || "") || global.document?.querySelector?.(".iCIMS_MainWrapper")) return true;
    if (!/^about:(?:blank|srcdoc)/.test(global.location?.href || "")) return false;
    try {
      let parent = global.parent;
      for (let depth = 0; parent && depth < 8; depth++) {
        if (/(^|\.)icims\.com$/i.test(parent.location?.hostname || "")) return true;
        if (parent === parent.parent) break;
        parent = parent.parent;
      }
    } catch {}
    try { return /(^|\.)icims\.com$/i.test(new URL(global.document?.referrer || "").hostname); }
    catch { return false; }
  };
  /**
   * The matcher, looked up when a rule runs — not when this file loads.
   *
   * The comment here used to say the manifest loads the matcher first. It
   * loads this file first, so the matcher was captured as `{}` and every rule
   * that leaned on it quietly fell back: a Work Experience Location with no
   * location in the profile never got its "." placeholder, and a two-letter
   * State box never got the postal code. A live lookup works in any order.
   */
  const M = new Proxy({}, {
    get: (_target, key) => {
      const live = (typeof window !== "undefined" && window.APPLI_FILL_MATCHER) || global?.APPLI_FILL_MATCHER || {};
      return live[key];
    },
  });


  /**
   * Words that mean the question is about somebody else.
   *
   * "Confidentiality Agreement Designee full legal name" is not the applicant's
   * name, and "Designee email" is not the applicant's email — but both matched
   * the identity rules, so the form came back filled with the wrong person's
   * details. Any rule that answers with the applicant's own identity carries
   * this guard; a question about a reference, a designee or an emergency
   * contact is left for the applicant to answer.
   */
  const THIRD_PARTY =
    /\b(reference|referee|referrer|emergency|supervisor|manager|colleague|co-?worker|designee|designated?|witness|guardian|next\s*of\s*kin|beneficiar(?:y|ies)|attorney|counsel|notary|spouse|parent|contact\s*person|recruiter|representative|third\s*part(?:y|ies)|relative|dependent)\b/i;

  /** "I am Hispanic or Latino." — the Hispanic question asked as one box to tick. */
  const HISPANIC_STATEMENT_RE = /\bi\s+am\s+(not\s+)?(of\s+)?hispanic\s*(or|\/|and)?\s*(latin[oax]|latina\/o)?\b/i;

  /**
   * The link the profile keeps for a network — found by its type, or by where
   * the address points.
   *
   * Only the type was read, so a LinkedIn address saved as "Other", "Portfolio"
   * or "Personal website" (which is what a résumé import or a forgotten type
   * menu leaves behind) was never offered to Workday's "Social Network URLs",
   * and the LinkedIn box stayed empty on a profile that plainly had one.
   */
  const SITE_HOSTS = {
    linkedin: /(^|\.)linkedin\.com$/i,
    github: /(^|\.)github\.(com|io)$/i,
    twitter: /(^|\.)(twitter\.com|x\.com)$/i,
    x: /(^|\.)(twitter\.com|x\.com)$/i,
    facebook: /(^|\.)(facebook\.com|fb\.com)$/i,
  };
  const hostOf = (url) => {
    const raw = String(url ?? "").trim();
    if (!raw) return "";
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); }
    catch { return ""; }
  };
  const site = (p, ...labels) => {
    const list = (p?.websites ?? []).filter((w) => String(w?.url ?? "").trim());
    for (const label of labels) {
      // "x" is a letter, not a word: only "Twitter/X" or a bare "X" is that label.
      const byLabel = label === "x"
        ? list.find((w) => /^(x|twitter\s*\/\s*x|x\s*\/\s*twitter)$/i.test(String(w.label || "").trim()))
        : list.find((w) => (w.label || "").toLowerCase().includes(label));
      if (byLabel?.url) return byLabel.url;
      const host = SITE_HOSTS[label];
      const byUrl = host ? list.find((w) => host.test(hostOf(w.url))) : null;
      if (byUrl?.url) return byUrl.url;
    }
    return null;
  };

  /**
   * The nth saved role / school, or null.
   *
   * The old version fell back to entry #0 for any index past the end, so a form
   * with three Work Experience blocks and a profile with one job copied that
   * same job into all three rows. An out-of-range row now returns nothing and
   * is left for the applicant instead of being filled with the wrong employer.
   */
  const jobAt = (p, index = 0) => {
    const list = p?.experience ?? [];
    const i = Math.max(0, Number(index) || 0);
    return list[i] ?? (i === 0 ? list[0] ?? null : null);
  };
  const schoolAt = (p, index = 0) => {
    const list = p?.education ?? [];
    const i = Math.max(0, Number(index) || 0);
    return list[i] ?? (i === 0 ? list[0] ?? null : null);
  };

  // Kept for callers/rules that only ever want the first entry's shape.
  const latestJob = (p, index = 0) => jobAt(p, index) ?? {};
  const latestSchool = (p, index = 0) => schoolAt(p, index) ?? {};

  /**
   * Which row, if any, may say "I currently work here". Exactly one.
   *
   * The box used to be answered from each job's own `current` flag, so a
   * profile carrying that flag on more than one role ticked it on every one —
   * telling the employer the applicant works three jobs at once, and, because
   * Workday drops the To date for a role marked current, wiping the end date
   * of their entire employment history in the process. A resume parser
   * produces exactly that whenever "Present" or "Till Date" appears against
   * more than one entry, which overlapping and contract roles routinely do.
   *
   * The list is newest first, so the first flagged role is the one to tick.
   */
  const currentJobIndex = (p) => {
    const list = p?.experience ?? [];
    const flagged = list.findIndex((job) => job?.current);
    if (flagged >= 0) return flagged;

    /**
     * Nothing is flagged, but the most recent role has a start date and no end
     * date. That role is ongoing, and it is *already* being treated that way —
     * the To box for a job with no end date is deliberately left blank. Not
     * ticking the box as well left a required field empty with nothing on the
     * form to explain why, which is a validation error the applicant cannot
     * clear without working out what Appli-Fill meant.
     *
     * Only the newest role is read this way. An older job missing its end date
     * is missing data, not a job the applicant still holds.
     */
    const newest = list[0];
    return newest?.startDate && !newest?.endDate ? 0 : -1;
  };

  const isCurrentJobRow = (p, index) => currentJobIndex(p) === (Number(index) || 0);

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  /**
   * Month pickers disagree on wording: "April", "Apr", "04", "4".
   * One synonym table covers every variant so a select/listbox in any of those
   * styles resolves to the same month.
   */
  const MONTH_SYNONYMS = MONTH_NAMES.reduce((acc, name, i) => {
    const n = i + 1;
    acc[name] = [name, name.slice(0, 3), String(n).padStart(2, "0"), String(n)];
    return acc;
  }, {});

  /** Parse supported profile date representations deterministically. */
  const parseProfileDate = (raw) => {
    const value = String(raw ?? "").replace(/\u00a0/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (!value) return null;

    let m = value.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:T.*)?$/);
    if (m) {
      const year = Number(m[1]), month = Number(m[2]), day = m[3] ? Number(m[3]) : null;
      if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && (!day || (day >= 1 && day <= 31)))
        return { year: String(year), month: String(month).padStart(2, "0"), day: day ? String(day).padStart(2, "0") : null };
      return null;
    }

    m = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) {
      const month = Number(m[1]), day = Number(m[2]), year = Number(m[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2200)
        return { year: String(year), month: String(month).padStart(2, "0"), day: String(day).padStart(2, "0") };
      return null;
    }

    m = value.match(/^(\d{1,2})[/-](\d{4})$/);
    if (m) {
      const month = Number(m[1]), year = Number(m[2]);
      if (month >= 1 && month <= 12 && year >= 1900 && year <= 2200)
        return { year: String(year), month: String(month).padStart(2, "0"), day: null };
      return null;
    }

    m = value.match(/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})$/i);
    if (m) {
      const aliases = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9, oct:10, october:10, nov:11, november:11, dec:12, december:12 };
      const month = aliases[m[1].toLowerCase()], year = Number(m[2]);
      if (month && year >= 1900 && year <= 2200) return { year: String(year), month: String(month).padStart(2, "0"), day: null };
    }

    m = value.match(/^(\d{4})$/);
    if (m && Number(m[1]) >= 1900 && Number(m[1]) <= 2200) return { year: m[1], month: null, day: null };
    return null;
  };

  const datePart = (raw, part) => {
    const parsed = parseProfileDate(raw);
    if (!parsed) return null;
    if (part === "year") return parsed.year;
    if (part === "month") return parsed.month;
    if (part === "day") return parsed.day || "1";
    if (part === "monthName") return parsed.month ? MONTH_NAMES[Number(parsed.month) - 1] || null : null;
    return null;
  };

  /* ------------------------------------------------------------------ */
  /*  Split date controls                                                */
  /* ------------------------------------------------------------------ */

  /**
   * iCIMS, Oracle and several Workday questionnaires split one date into three
   * controls labelled only "Month", "Day" and "Year", grouped under a heading
   * that says "Start Date (Month / Day / Year)".
   *
   * Without this, the Year box matched the generic experience-date rule and was
   * handed the whole stored value — which is why a start year read "2025-04" —
   * and the Month box could pick up the *other* date's heading entirely.
   */
  const PART_WORDS = {
    month: /^(mm|month|month\s*of\s*\w+)$/i,
    year: /^(yy|yyyy|year)$/i,
    day: /^(dd|day)$/i,
  };

  const dateSlot = (label, el) => {
    const segments = String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);

    const partOf = (text) => {
      const t = String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      if (!t) return null;
      for (const [part, re] of Object.entries(PART_WORDS)) if (re.test(t)) return part;
      return null;
    };

    // The most specific label sources come first, so a standalone "Year"
    // segment beats the group heading that lists all three parts.
    let part = null;
    for (const segment of segments) {
      part = partOf(segment);
      if (part) break;
    }
    if (!part) {
      const machine = `${el?.getAttribute?.("name") || ""} ${el?.id || ""} ${el?.getAttribute?.("placeholder") || ""}`;
      part = partOf(machine.replace(/[_\-.]+/g, " "));
    }
    if (!part) {
      // The element's own attributes count as a label source. Workday names its
      // segments `dateSectionMonth-input` and `dateSectionYear-input`, which no
      // whole-word test matches but which say plainly which box this is.
      const own = [
        el?.getAttribute?.("data-automation-id"), el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("aria-valuetext"), el?.getAttribute?.("placeholder"),
      ].filter(Boolean).join(" ");
      const joined = `${segments.join(" ")} ${own}`.toLowerCase();
      const hasMonth = /\bmonth\b|\bmm\b|datesectionmonth/.test(joined);
      const hasYear = /\byear\b|\byyyy\b|datesectionyear/.test(joined);
      const hasDay = /\bday\b|\bdd\b|datesectionday/.test(joined);
      if (hasMonth && !hasYear && !hasDay) part = "month";
      else if (hasYear && !hasMonth && !hasDay) part = "year";
      else if (hasDay && !hasMonth && !hasYear) part = "day";
    }

    // Which of the two dates this control belongs to. The first label source
    // that says so wins, so the field's own group heading beats the section.
    let which = null;
    for (const segment of segments) {
      const s = segment.toLowerCase();
      if (/\b(end|to|thru|through|until|left|completion|graduat|acquired|awarded|conferred|earned|expected)\b/.test(s)) { which = "end"; break; }
      if (/\b(start|from|begin|began|joined|joining|hire[d]?)\b/.test(s)) { which = "start"; break; }
    }

    if (!which) which = dateWhichFromDom(el);

    return { part, which };
  };

  /**
   * Start or end, read from the markup around the box.
   *
   * A Workday date segment is labelled only "Month" or "Year"; the word that
   * distinguishes the two dates — `From` and `To` — lives on the group that
   * wraps them, reached through `aria-labelledby`, or in the wrapper's own
   * `data-automation-id` (`formField-startDate`). Without this the To boxes
   * fell back to the start date and every job appeared to end in the month it
   * began.
   */
  const DATE_START_RE = /\b(start|from|begin|began|joined|joining|hire[d]?)\b|startdate|fromdate/i;
  const DATE_END_RE = /\b(end|to|thru|through|until|left|completion|graduat|acquired|awarded|conferred|earned|expected)\b|enddate|todate/i;

  const dateWhichFromDom = (el) => {
    if (!el || typeof el.getAttribute !== "function") return null;

    const spokenName = (node) => {
      let text = "";
      try {
        const ids = String(node.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
        for (const id of ids) text += " " + (document.getElementById(id)?.textContent || "");
        text += " " + (node.getAttribute?.("aria-label") || "");
      } catch {}
      return text;
    };

    let node = el;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const machine = `${node.getAttribute?.("data-automation-id") || ""} ${node.id || ""} ${node.getAttribute?.("name") || ""}`
        .replace(/[_\-.]+/g, " ");
      const text = `${machine} ${spokenName(node)}`;
      const start = DATE_START_RE.test(text);
      const end = DATE_END_RE.test(text);
      // Only an unambiguous ancestor decides it. A wrapper mentioning both
      // dates says nothing about which one this box belongs to.
      if (end && !start) return "end";
      if (start && !end) return "start";
    }
    return null;
  };

  /**
   * Does this box want the month as a number rather than as a word?
   *
   * Workday draws `From *` as two spinbuttons, `MM` and `YYYY`, each holding a
   * couple of characters. They are `<input type="text">`, so the old test —
   * number input or a select listing numbers — said no and the month was
   * written as "March". The box refused it, the month stayed empty, and the
   * page reported "Invalid Date: /2022" beside a year that had landed
   * perfectly. Anything that announces itself as a two-character or
   * numerically-bounded date segment gets digits.
   */
  const wantsNumericDatePart = (el) => {
    if (!el || el.tagName === "SELECT") return false;
    const type = String(el.type || "").toLowerCase();
    if (type === "number") return true;
    if (el.getAttribute?.("role") === "spinbutton") return true;

    const cap = Number(el.getAttribute?.("maxlength") ?? 0);
    if (cap > 0 && cap <= 2) return true;

    const max = Number(el.getAttribute?.("aria-valuemax") ?? 0);
    if (max > 0 && max <= 31) return true;

    const hint = [
      el.getAttribute?.("data-automation-id"), el.getAttribute?.("placeholder"),
      el.getAttribute?.("aria-valuetext"), el.getAttribute?.("aria-label"),
    ].filter(Boolean).join(" ");
    return /datesection|\bmm\b|\bdd\b/i.test(hint);
  };

  const valueForSlot = (raw, part, el) => {
    if (!raw) return null;
    if (part === "year") return datePart(raw, "year");
    if (part === "day") return datePart(raw, "day");
    if (part === "month") {
      const type = (el?.type || "").toLowerCase();
      if (type === "number" || wantsNumericDatePart(el)) return datePart(raw, "month");
      if (el?.tagName === "SELECT") {
        // Pick the wording this particular select actually uses.
        const texts = Array.from(el.options || []).map((o) => (o.textContent || "").trim());
        const numeric = texts.filter(Boolean).every((t) => /^\d{1,2}$/.test(t));
        if (numeric) return datePart(raw, "month");
      }
      return datePart(raw, "monthName");
    }
    return null;
  };

  /**
   * Today, in the format the control actually accepts.
   *
   * A native <input type="date"> only takes YYYY-MM-DD; everything else on a
   * US application expects MM/DD/YYYY. Shared by `todayDate` and `selfIdDate`
   * so the two can never drift apart.
   */
  /**
   * Which part of a split date this box is, or null for a whole-date box.
   *
   * Workday draws "Date" as three boxes — MM, DD, YYYY — and each one is a
   * field of its own. Handing every one of them the whole "09/23/2026" made
   * each box rewrite all three, so a segment's own number is returned instead.
   */
  const dateSegmentKind = (el) => {
    const hint = [
      el?.getAttribute?.("data-automation-id"), el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("placeholder"), el?.getAttribute?.("name"), el?.id,
    ].filter(Boolean).join(" ");
    if (!hint) return null;
    // "MM/DD/YYYY" or "Month/Day/Year" describes one box holding a whole date.
    if (/\b(mm|dd|month|day)\s*[/.-]\s*(dd|mm|yy|yyyy|day|month|year)\b/i.test(hint)) return null;
    const month = /datesectionmonth|\bmonth\b|\bmm\b/i.test(hint);
    const day = /datesectionday|\bday\b|\bdd\b/i.test(hint);
    const year = /datesectionyear|\byear\b|\byyyy\b|\byy\b/i.test(hint);
    if (Number(month) + Number(day) + Number(year) !== 1) return null;
    return month ? "month" : day ? "day" : "year";
  };

  const todayFor = (el) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const type = (el?.getAttribute?.("type") || el?.type || "").toLowerCase();
    if (type === "date") return `${yyyy}-${mm}-${dd}`;
    if (type === "month") return `${yyyy}-${mm}`;
    // A MM / DD / YYYY widget gets the whole date, which is typed into it the
    // way a person types it and checked (`setSegmentedDateAsync`).
    let segmented = false;
    try { segmented = (M.dateSegmentNodes?.(el)?.length ?? 0) >= 2; } catch {}
    if (segmented) return `${mm}/${dd}/${yyyy}`;
    const segment = dateSegmentKind(el);
    if (segment === "month") return mm;
    if (segment === "day") return dd;
    if (segment === "year") return String(yyyy);
    return `${mm}/${dd}/${yyyy}`;
  };

  const dateForField = (raw, el) => {
    const parsed = parseProfileDate(raw);
    if (!parsed) return null;
    const type = String(el?.type || "").toLowerCase();
    if (type === "month") return parsed.month ? `${parsed.year}-${parsed.month}` : null;
    if (type === "date") return parsed.month ? `${parsed.year}-${parsed.month}-${parsed.day || "01"}` : null;

    const hint = [el?.getAttribute?.("placeholder"), el?.getAttribute?.("aria-label"), el?.getAttribute?.("data-automation-id"), el?.getAttribute?.("name"), el?.id].filter(Boolean).join(" ").toLowerCase();
    if (/\byear\b|yyyy|^yy$/.test(hint) && !/month|mm/.test(hint)) return parsed.year;
    if (/mm\s*[/-]\s*yyyy|month\s*\/?\s*year/.test(hint)) return parsed.month ? `${parsed.month}/${parsed.year}` : null;
    if (/yyyy\s*[-/]\s*mm|year\s*[-/]\s*month/.test(hint)) return parsed.month ? `${parsed.year}-${parsed.month}` : parsed.year;
    if (/mm\s*[/-]\s*dd\s*[/-]\s*yyyy|month.*day.*year/.test(hint)) {
      if (parsed.month && parsed.day) return `${parsed.month}/${parsed.day}/${parsed.year}`;
      // ADP's date picker takes a whole date even for a job's start and end; a
      // month with no day is written as its first.
      return parsed.month && (onAdpPage() || onSapPage()) ? `${parsed.month}/01/${parsed.year}` : null;
    }
    if (/date|from|to|start|end|employment|experience/.test(hint)) return parsed.month ? `${parsed.month}/${parsed.year}` : null;
    return parsed.month ? `${parsed.year}-${parsed.month}` : parsed.year;
  };

  const dateMonth = (raw) => datePart(raw, "monthName") || datePart(raw, "month");
  const dateYear = (raw) => datePart(raw, "year");

  /* ------------------------------------------------------------------ */
  /*  Available start date                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Wording that makes a date the applicant's availability, never a date from
   * their work or education history.
   */
  const AVAILABILITY_RE =
    /\b(available|availability|earliest|soonest|how\s+soon|when\s+(?:can|could|would|will)\s+you\s+(?:be\s+(?:able|ready)\s+to\s+)?(?:start|begin|join|commence|report)|(?:able|ready|free)\s+to\s+(?:start|begin|join|commence|report))\b/i;

  /** A history date's field is never the availability question. */
  const asksAvailability = (label) => AVAILABILITY_RE.test(String(label ?? ""));

  /** "Immediately", "ASAP", "Right away", "Available now"… */
  const IMMEDIATE_RE =
    /^\s*(?:immediate(?:ly)?|asap|a\.s\.a\.p\.?|as\s+soon\s+as\s+possible|right\s+(?:away|now)|now|today|at\s+once|any\s*time|currently\s+available|available\s+(?:now|immediately|today|right\s+away)|immediate\s+(?:start|joiner|joining|availability))\b/i;

  const START_WORD_NUMBERS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, thirty: 30, sixty: 60, ninety: 90,
  };

  /** "2 weeks", "Two weeks' notice", "30 days", "1 month" → that long from today. */
  const relativeStart = (text) => {
    const m = String(text ?? "").toLowerCase().match(
      /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|sixty|ninety)[\s-]*(day|week|month)s?\b/
    );
    if (!m) return null;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : START_WORD_NUMBERS[m[1]];
    if (!n || n > 365) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (m[2] === "day") d.setDate(d.getDate() + n);
    else if (m[2] === "week") d.setDate(d.getDate() + n * 7);
    else d.setMonth(d.getMonth() + n);
    return d;
  };

  /**
   * The calendar date the profile's "Available start date" stands for.
   *
   * The profile field is free text on purpose — "Immediately" is the commonest
   * answer — and only a written-out date was ever understood. "Immediately"
   * produced nothing, so Workday's Available Start Date was left to whatever
   * else claimed it. Immediately (and ASAP, now, right away) is today; a notice
   * period ("2 weeks") counts from today; a date already past is today too,
   * since a form will not take a start date in the past.
   */
  const availabilityDate = (raw) => {
    const text = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (IMMEDIATE_RE.test(text)) return today;

    let date = null;
    const parsed = parseProfileDate(text);
    if (parsed?.month) {
      date = new Date(Number(parsed.year), Number(parsed.month) - 1, Number(parsed.day || 1));
    } else if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?![a-z])/i.test(text) && /\b(19|20)\d{2}\b/.test(text)) {
      // "October 1, 2026" — written out, with a month and a year. (Without a
      // month the browser's parser guesses: "Summer 2027" became 1 January.)
      const d = new Date(text.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
      if (!Number.isNaN(d.getTime())) date = d;
    }
    if (!date) date = relativeStart(text);
    if (!date || Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date < today ? today : date;
  };

  /**
   * That date, written the way this box takes it.
   *
   * A MM / DD / YYYY widget gets the whole date: its boxes are written month,
   * day, year and read back, and a box that does not show its number is tried
   * again another way (`setSegmentedDateAsync`). A lone box that is only one
   * part of a date gets that part.
   */
  const formatDateFor = (date, el) => {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const type = String(el?.getAttribute?.("type") || el?.type || "").toLowerCase();
    if (type === "date") return `${yyyy}-${mm}-${dd}`;
    if (type === "month") return `${yyyy}-${mm}`;

    let segmented = false;
    try { segmented = (M.dateSegmentNodes?.(el)?.length ?? 0) >= 2; } catch {}
    if (segmented) return `${mm}/${dd}/${yyyy}`;
    // A lone box that is only one part of a date gets only that part.
    const part = dateSegmentKind(el);
    if (part === "month") return mm;
    if (part === "day") return dd;
    if (part === "year") return yyyy;

    const hint = [
      el?.getAttribute?.("placeholder"), el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-id"), el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/\bdd\s*[/.-]\s*mm\s*[/.-]\s*(yyyy|yy)\b/.test(hint)) return `${dd}/${mm}/${yyyy}`;
    if (/\byyyy\s*[/.-]\s*mm\s*[/.-]\s*dd\b/.test(hint)) return `${yyyy}-${mm}-${dd}`;
    if (/\bmm\s*[/.-]\s*yyyy\b|\bmonth\s*\/\s*year\b/.test(hint) && !/\bdd\b|\bday\b/.test(hint)) return `${mm}/${yyyy}`;
    return `${mm}/${dd}/${yyyy}`;
  };

  /** Is this box asking for a date, rather than for a few words? */
  const takesDate = (el, label) => {
    const type = String(el?.getAttribute?.("type") || el?.type || "").toLowerCase();
    if (type === "date" || type === "month") return true;
    try { if ((M.dateSegmentNodes?.(el)?.length ?? 0) >= 2) return true; } catch {}
    if (dateSegmentKind(el)) return true;
    const hint = [
      el?.getAttribute?.("placeholder"), el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-id"), el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ");
    if (/\b(mm|dd|yyyy)\b|datesection|date\s*picker|datepicker/i.test(hint)) return true;
    return /\bdate\b/i.test(String(label ?? ""));
  };

  /** Which part of a date this list is — "month", "day", "year" — or null. */
  const dateListPart = (el, label) => {
    if (el?.tagName !== "SELECT") return null;
    return dateSlot(label, el).part || dateSegmentKind(el);
  };

  /**
   * The option of a Month, Day or Year list that is `date`'s part, in the
   * list's own words ("October", "Oct" or "10"; "1" or "01"; "2026"), or null
   * when the list has no such option.
   *
   * Some applications ask for the available start date as three lists rather
   * than a box. They were left for the applicant: the start-date rule only
   * took boxes.
   */
  const dateListChoice = (date, el, label) => {
    const part = dateListPart(el, label);
    if (!part) return null;
    const want = part === "year" ? date.getFullYear() : part === "month" ? date.getMonth() + 1 : date.getDate();
    const monthWord = MONTH_NAMES[date.getMonth()].toLowerCase();
    for (const option of Array.from(el.options || [])) {
      const shown = String(option.textContent || "").replace(/\s+/g, " ").trim();
      if (!shown) continue;
      if (/^\d{1,4}$/.test(shown)) {
        if (Number(shown) === want) return shown;
        continue;
      }
      if (part === "year") continue;
      // "10 - October", "1st"
      const lead = shown.match(/^(\d{1,2})(?!\d)/);
      if (lead) {
        if (Number(lead[1]) === want) return shown;
        continue;
      }
      // "October", "Oct", "Sept."
      if (part === "month" && (shown.toLowerCase().match(/[a-z]{3,}/g) || []).some((w) => monthWord.startsWith(w))) return shown;
    }
    return null;
  };

  /**
   * "Available start date" / "When can you start?", from the profile.
   *
   * A date box gets the profile's date when it holds one, and today's date
   * otherwise — for "Immediately", and also when the profile says nothing or
   * says something no calendar can hold ("Negotiable"): a start date is asked
   * for on nearly every Workday application, and it was left empty and
   * required. A box that asks in words ("When can you start?") keeps the
   * applicant's own words when those are not a date ("Immediately", "Two
   * weeks"), and is left alone when the profile has none.
   */
  const availabilityValue = (raw, el, label, p = null) => {
    const text = String(raw ?? "").trim();
    const date = text ? availabilityDate(text) : null;
    if (el?.tagName === "SELECT" && dateListPart(el, label)) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return dateListChoice(date || today, el, label);
    }
    // Asked as how soon — "Immediately", "Within 2 weeks", "1-3 months" — in a
    // list or as radio buttons. These were left blank: only a date was written.
    // (A custom box that takes a date — a picker drawn as a combobox — still
    // gets the date.)
    let kind = "";
    try { kind = M.fieldKind?.(el) || ""; } catch {}
    if (el?.tagName === "SELECT" || kind === "radio" || (kind === "select" && !takesDate(el, label))) {
      return availabilityChoice(p, el, label);
    }
    if (takesDate(el, label)) {
      if (date) return formatDateFor(date, el);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return formatDateFor(today, el);
    }
    if (!text) return null;
    if (parseProfileDate(text)?.month && date) return formatDateFor(date, el);
    return text;
  };

  /**
   * The choice of a how-soon list that covers the applicant's start: six days
   * away is "Within 2 weeks" (or "1 week" where that is offered), today is
   * "Immediately". A Yes / No question that names the time ("Can you start
   * within two weeks?") is answered by whether the start falls inside it.
   * Nothing is chosen when the profile has neither a start date nor a notice
   * period.
   */
  const availabilityChoice = (p, el, label) => {
    const days = p ? availabilityDays(p) : null;
    if (days == null) return null;
    const texts = choiceTextsOf(el);
    if (texts.length) {
      let yesNoList = false;
      try { yesNoList = Boolean(M.isYesNoList?.(texts)); } catch {}
      if (yesNoList) {
        const span = choiceSpan(ownLabel(label) || label);
        return span && Number.isFinite(span.max) ? (days <= span.max ? "Yes" : "No") : null;
      }
      return durationChoice(days, texts);
    }
    // A list whose choices are drawn only once it opens: "Immediately" is found
    // among them by its synonyms; a later start needs the choices to be read.
    return days === 0 ? "Immediately" : null;
  };

  /** Is this page Oracle Recruiting's Candidate Experience (…/hcmUI/CandidateExperience/…)? */
  const onOracleCx = () => {
    try {
      return /\/hcmUI\/|CandidateExperience/i.test(location.pathname) || /\.oraclecloud\.com$/i.test(location.hostname);
    } catch { return false; }
  };

  /** Is this page one of ADP's (Recruiting Management, Workforce Now)? */
  const onAdpPage = () => {
    try { return /(^|\.)adp\.com$/i.test(location.hostname); } catch { return false; }
  };

  const onSapPage = () => {
    try { return /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu|cn))$/i.test(location.hostname); }
    catch { return false; }
  };

  /** Calling codes and country names for text-only phone-country menus. */
  const CALLING_COUNTRIES = {
    "1": ["United States", "United States of America", "US", "USA", "Canada", "CA"],
    "7": ["Russia", "Kazakhstan"], "20": ["Egypt"], "27": ["South Africa"],
    "30": ["Greece"], "31": ["Netherlands"], "32": ["Belgium"], "33": ["France"],
    "34": ["Spain"], "36": ["Hungary"], "39": ["Italy"], "40": ["Romania"],
    "41": ["Switzerland"], "43": ["Austria"], "44": ["United Kingdom", "UK", "GB", "Great Britain"],
    "45": ["Denmark"], "46": ["Sweden"], "47": ["Norway"], "48": ["Poland"], "49": ["Germany"],
    "51": ["Peru"], "52": ["Mexico"], "54": ["Argentina"], "55": ["Brazil"],
    "56": ["Chile"], "57": ["Colombia"], "58": ["Venezuela"], "60": ["Malaysia"],
    "61": ["Australia", "AU"], "62": ["Indonesia"], "63": ["Philippines"], "64": ["New Zealand"],
    "65": ["Singapore"], "66": ["Thailand"], "81": ["Japan"], "82": ["South Korea"],
    "84": ["Vietnam"], "86": ["China"], "90": ["Turkey", "Türkiye"], "91": ["India", "IN"],
    "92": ["Pakistan"], "93": ["Afghanistan"], "94": ["Sri Lanka"], "95": ["Myanmar"],
    "98": ["Iran"], "353": ["Ireland"], "358": ["Finland"], "880": ["Bangladesh"],
    "971": ["United Arab Emirates", "UAE"], "972": ["Israel"], "977": ["Nepal"],
  };
  const callingCodeIn = (value) => String(value ?? "").match(/(?:\+|\b00)\s*([1-9]\d{0,2})\b/)?.[1] || "";
  const phoneCodeForProfile = (p) => {
    const personal = P(p);
    const raw = String(personal.phone || personal.phoneNumber || personal.mobile || "").trim();
    const stored = String(personal.phoneCountryCode || "").trim().replace(/^00/, "").replace(/\D/g, "");
    const international = /^(?:\+|00)/.test(raw);
    const digits = raw.replace(/^00/, "").replace(/\D/g, "");
    if (international) {
      if (stored && digits.startsWith(stored) && digits.length - stored.length >= 6) return `+${stored}`;
      const separated = raw.match(/^(?:\+|00)([1-9]\d{0,2})[\s.\-]+/)?.[1];
      const prefix = separated || Object.keys(CALLING_COUNTRIES).find((code) => digits.startsWith(code) && digits.length - code.length >= 6);
      // A conflicting default code must not be paired with another country's
      // international number. An unrecognized prefix remains for review.
      return prefix ? `+${prefix}` : null;
    }
    if (/^[1-9]\d{0,2}$/.test(stored)) return `+${stored}`;
    const country = String(personal.country ?? "").trim().toLowerCase();
    const inferred = Object.entries(CALLING_COUNTRIES).find(([, names]) => names.some((name) => name.toLowerCase() === country));
    return inferred ? `+${inferred[0]}` : null;
  };
  const phoneCodeOptions = (p) => {
    const code = phoneCodeForProfile(p);
    if (!code) return {};
    const countries = CALLING_COUNTRIES[code.slice(1)] || [];
    const preferred = countries.find((name) => name.toLowerCase() === String(P(p).country ?? "").trim().toLowerCase());
    const names = preferred ? [preferred, ...countries.filter((name) => name !== preferred)] : countries;
    return { [code]: names.flatMap((name) => [`${name} (${code})`, `${name} ${code}`, name]) };
  };
  const phoneCodeOfControl = (el) => {
    const shown = el?.tagName === "SELECT" ? el.options?.[el.selectedIndex]?.textContent :
      M.comboboxDisplayValue?.(el) || el?.value || el?.textContent;
    const literal = callingCodeIn(shown) || callingCodeIn(el?.value);
    if (literal) return `+${literal}`;
    const country = String(shown ?? "").trim().toLowerCase();
    const byCountry = Object.entries(CALLING_COUNTRIES).find(([, names]) => names.some((name) => name.toLowerCase() === country));
    return byCountry ? `+${byCountry[0]}` : null;
  };
  /** The phone row's country-code picker beside this box, or null. */
  const phoneCodeBeside = (el) => {
    let node = el?.parentElement;
    for (let d = 0; node && d < 3 && node !== document.body; d++, node = node.parentElement) {
      let found = null;
      try {
        // ADP's phone row keeps its country list (`sdf-select-simple`) beside the box.
        found = Array.from(node.querySelectorAll("input, select, [role='combobox'], button[aria-haspopup], sdf-select-simple"))
          .find((c) => c !== el && M.isPhoneCodeControl?.(c)) || null;
      } catch {}
      if (found) return found;
    }
    return null;
  };

  /** Adapt the saved number to the field's calling-code picker, limits and mask. */
  const phoneForBox = (raw, el, storedCode = "") => {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const picker = phoneCodeBeside(el);
    const selected = picker?.tagName === "SELECT" ? picker.options?.[picker.selectedIndex]?.textContent : "";
    const pickerCode = String(selected || picker?.value || picker?.textContent || "").match(/\+\s*(\d{1,3})\b/)?.[1] || "";
    let code = String(storedCode || "").replace(/\D/g, "") ||
      pickerCode ||
      text.match(/^(?:\+|00)([1-9]\d{0,2})[\s.\-]+/)?.[1] ||
      text.match(/^(?:\+|00)([17])(?=\d)/)?.[1] || "";
    const international = /^(?:\+|00)/.test(text);
    const digits = text.replace(/^00/, international ? "" : "00").replace(/\D/g, "");
    if (international && picker && code && !digits.startsWith(code)) {
      if (pickerCode && digits.startsWith(pickerCode)) code = pickerCode;
      else return null; // never combine another country's prefix with this number
    }
    if (picker?.__applifillUserEdited && code) {
      const selectedCode = phoneCodeOfControl(picker);
      if (selectedCode && selectedCode !== `+${code}`) return null;
    }
    let national = digits;
    // Strip only a known calling code, never arbitrary leading digits.
    if (code && digits.startsWith(code) && (international || (code === "1" && digits.length === 11))) {
      national = digits.slice(code.length);
    }
    const cap = Number(el?.getAttribute?.("maxlength") ?? 0);
    const minimum = Number(el?.getAttribute?.("minlength") ?? 0);
    const pattern = el?.getAttribute?.("pattern");
    let re = null;
    try { if (pattern) re = new RegExp(`^(?:${pattern})$`, "v"); } catch {}
    const fits = (value) => value && (cap <= 0 || value.length <= cap) && (minimum <= 0 || value.length >= minimum) &&
      (!re || re.test(value)) && (el?.type !== "number" || /^\d+$/.test(value));
    const useNational = picker && (storedCode || pickerCode || onOracleCx() || onAdpPage());
    const candidates = useNational ? [national, text, digits] : [text, digits, national];
    // Common masks sometimes require their punctuation in the submitted value.
    if (national.length === 10) {
      const a = national.slice(0, 3), b = national.slice(3, 6), c = national.slice(6);
      candidates.push(`(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`);
    }
    return candidates.find(fits) || null;
  };

  /** The title that goes with the gender the applicant gave, or null. */
  const titleForGender = (p) => {
    if (E(p).declineToSelfIdentify) return null;
    const g = String(E(p).gender ?? "").trim().toLowerCase();
    if (/^(male|man|i identify as male)$/.test(g)) return "Mr.";
    if (/^(female|woman|i identify as female)$/.test(g)) return "Ms.";
    if (/^(non-?\s?binary|genderqueer)$/.test(g)) return "Mx.";
    return null;
  };

  const fullName = (p) =>
    [P(p).firstName, P(p).lastName].filter(Boolean).join(" ") || null;

  /**
   * Street plus any second line — but only when the second line adds something.
   *
   * Résumé parsing sometimes copies the street into both, and joining those
   * produced "4685 Old Oaks Dr, 4685 Old Oaks Dr" in Address Line 1 and the
   * street again in Address Line 2.
   */
  const fullAddress = (p) => {
    const line1 = P(p).address;
    const line2 = P(p).addressLine2;
    const same = (a, b) =>
      String(a ?? "").trim().toLowerCase().replace(/[.,]/g, "") ===
      String(b ?? "").trim().toLowerCase().replace(/[.,]/g, "");
    return [line1, same(line1, line2) ? null : line2].filter(Boolean).join(", ") || null;
  };

  /**
   * A street-address box wants the street, not the whole postal address.
   *
   * Résumé parsing usually stores one flat line ("4685 Old Oaks Dr, Lisle, IL,
   * 60532"), and dropping that into a form that also has its own City, State
   * and Zip boxes produced the duplicated address seen on iCIMS. Trailing
   * postal parts are peeled off; the street itself is never touched.
   */
  /**
   * A part that is a form-field name rather than an address.
   *
   * Résumé parsing sometimes writes the label where the value should be, so a
   * stored address reads "8451 GATE PKWY W APT 128, City, Jacksonville,
   * Florida, 32216". "City" there is not a place; it is the word "City".
   */
  const PLACEHOLDER_PART =
    /^(city|town|state|province|county|zip|postal(\s*code)?|post\s*code|country|address(\s*line\s*\d)?|street|n\.?\/?a\.?|none|null|undefined|-+|\.+)$/i;

  /**
   * Does this form have its own box for the second address line?
   *
   * It decides whether the apartment/suite belongs in Line 1. A form with both
   * boxes was getting "1703 High Point Terrace, Apt 4B" in Line 1 *and*
   * "Apt 4B" in Line 2, because the street value was always composed from both
   * lines. Every portal with a two-line address — iCIMS, Workday, Oracle,
   * SuccessFactors, most in-house forms — sent the apartment twice.
   */
  const ADDRESS_LINE2_RE = /\b(address\s*(line\s*)?2|addr(ess)?2|apt|apartment|suite|unit\s*(number|no|#)?)\b/i;

  const hasAddressLine2Box = (el) => {
    const root = el?.closest?.("form") || (typeof document !== "undefined" ? document : null);
    if (!root) return false;
    try {
      if (
        root.querySelector?.(
          '[name*="address2" i], [name*="addressline2" i], [name*="addr2" i], [id*="address2" i], ' +
            '[id*="addressline2" i], [id*="addr2" i], [data-automation-id*="addressLine2" i], ' +
            '[autocomplete="address-line2"]'
        )
      ) {
        return true;
      }
    } catch {}
    try {
      for (const node of root.querySelectorAll("label, legend") || []) {
        if (ADDRESS_LINE2_RE.test(node.textContent || "")) return true;
      }
    } catch {}
    try {
      for (const node of root.querySelectorAll("input[placeholder], input[aria-label]") || []) {
        const hint = `${node.getAttribute("placeholder") || ""} ${node.getAttribute("aria-label") || ""}`;
        if (ADDRESS_LINE2_RE.test(hint)) return true;
      }
    } catch {}
    if (onIcimsPage()) {
      try {
        const root = el?.closest?.("form") || document;
        if (Array.from(root.querySelectorAll("input")).some((input) => input !== el && ADDRESS_LINE2_RE.test(String(M.deriveLabel(input)).split("|")[0]))) return true;
      } catch {}
    }
    return false;
  };

  const streetOnly = (p, { includeLine2 = true } = {}) => {
    const raw = includeLine2 ? fullAddress(p) : P(p).address || null;
    if (!raw) return null;
    const parts = raw
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      // A label sitting where a value belongs is dropped wherever it appears,
      // not just from the tail.
      .filter((part) => !PLACEHOLDER_PART.test(part));
    if (parts.length < 2) return parts.join(", ") || raw;

    const lower = (s) => String(s ?? "").toLowerCase().trim();
    const city = lower(P(p).city);
    const state = lower(P(p).state);
    const zip = lower(P(p).zip);

    let removed = 0;
    let sawPostcode = false;
    while (parts.length > 1 && removed < 6) {
      const tail = lower(parts[parts.length - 1]);
      const isZip = /^\d{5}(-\d{4})?$/.test(tail) || /^[a-z]\d[a-z]\s*\d[a-z]\d$/.test(tail) || (zip && tail === zip);
      const isState = (state && tail === state) || /^[a-z]{2}$/.test(tail);
      const isCity = city && tail === city;
      // Only strip a plain place name once a postcode has already been seen —
      // that is what tells us this line is "street, city, ST zip" and not a
      // street name that happens to contain a comma.
      const isTrailingPlace = sawPostcode && /^[a-z][a-z .'-]{1,28}$/.test(tail);

      if (!(isZip || isState || isCity || isTrailingPlace)) break;
      if (isZip || isState) sawPostcode = true;
      parts.pop();
      removed++;
    }
    return parts.join(", ") || raw;
  };

  /** The calendar months a set of roles covers, each month counted once. */
  const monthsCovered = (roles) => {
    const months = new Set();
    const now = new Date();
    for (const r of roles) {
      const start = String(r?.startDate ?? "").match(/(\d{4})(?:-(\d{1,2}))?/);
      if (!start) continue;
      const end = r?.current || !r?.endDate ? null : String(r.endDate).match(/(\d{4})(?:-(\d{1,2}))?/);
      let y = Number(start[1]);
      let m = Number(start[2] || 1);
      const endY = end ? Number(end[1]) : now.getFullYear();
      const endM = end ? Number(end[2] || 12) : now.getMonth() + 1;
      for (let guard = 0; guard < 720 && (y < endY || (y === endY && m <= endM)); guard++) {
        months.add(y * 12 + m);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    }
    return months.size;
  };

  const yearsFromMonths = (months) => (months ? String(Math.max(1, Math.round(months / 12))) : null);

  const TOPIC_FILLER = new Set([
    "of", "the", "a", "an", "and", "or", "in", "on", "with", "using", "as", "at", "for", "to", "your", "you",
    "do", "did", "have", "has", "had", "total", "overall", "professional", "work", "working", "industry",
    "full", "time", "fulltime", "paid", "hands", "practical", "prior", "previous", "post", "graduate",
    "postgraduate", "experience", "years", "year", "how", "many", "much", "any", "including", "etc",
  ]);
  /** "engineering" and "engineer", "management" and "manager", end up the same. */
  const topicStem = (word) => {
    let w = word;
    for (let i = 0; i < 2; i++) if (w.length > 5) w = w.replace(/(ments?|ings?|ers?|ors?|ed|ations?|ies|es|s)$/, "");
    if (w.length > 4) w = w.replace(/e$/, "");
    if (w.length > 3 && w.length <= 5) w = w.replace(/s$/, "");
    return w;
  };
  const topicTokens = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/[\s/-]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w.length >= 2 && !TOPIC_FILLER.has(w)).map(topicStem);

  /**
   * "How many years of <topic> experience do you have?"
   *
   * A plain question — no topic, or "professional"/"total" — is the whole
   * career, each month counted once however many roles overlapped. A topic —
   * "DevOps", "cloud engineering", "with Python" — counts only the roles whose
   * title or description names it; the whole career is the wrong number for a
   * slice of it, and was being given. With no role naming the topic, or a
   * question that needs judgement ("relevant", "similar"), there is no answer
   * here and the question goes to the saved answers and the answer model.
   */
  const experienceYears = (p, label) => {
    const question = ownLabel(label);
    if (/\b(relevant|related|similar|comparable|direct|specific|applicable|equivalent)\b/i.test(question)) return null;
    const roles = (p?.experience ?? []).filter((r) => r?.startDate);
    if (!roles.length) return null;

    let topic = "";
    const before = question.match(/\byears?\s+of\s+(.{1,60}?)\s*experience\b/i);
    if (before) topic += ` ${before[1]}`;
    const after = question.match(
      /\bexperience\b(?:\s+(?:do|did|have|would)\s+you\s+(?:have|had|bring|gained))?\s+(?:with|in|using|on|as\s+an?|as|doing|managing|leading|developing|building|supporting|working\s+(?:with|on|in))\s+([^?.,;|]{1,60})/i
    );
    if (after) topic += ` ${after[1]}`;
    const wanted = topicTokens(topic);
    if (!wanted.length) return yearsFromMonths(monthsCovered(roles));

    // A role counts when its title names the topic, or when its description
    // does and the topic is one of the applicant's listed skills. A passing
    // "managed the servers" in a description is not management experience.
    const skills = new Set(topicTokens((p?.skills ?? []).join(" ")));
    const isSkill = wanted.every((w) => skills.has(w));
    const matching = roles.filter((r) => {
      const title = new Set(topicTokens(r.title));
      if (wanted.every((w) => title.has(w))) return true;
      if (!isSkill) return false;
      const described = new Set(topicTokens(r.description));
      return wanted.every((w) => described.has(w));
    });
    return matching.length ? yearsFromMonths(monthsCovered(matching)) : null;
  };

  // Authorization and sponsorship are explicit applicant declarations.
  // A citizenship or visa label alone does not answer a country-specific question.
  const authorizedFor = (p) => {
    const stored = W(p).authorizedToWork;
    return binaryProfileAnswer(stored);
  };

  const sponsorshipFor = (p) => {
    const stored = W(p).requireSponsorship;
    return binaryProfileAnswer(stored);
  };

  const binaryProfileAnswer = (value) => {
    if (value === true) return "Yes";
    if (value === false) return "No";
    const key = M.yesNoId?.(value);
    return key === "yes" ? "Yes" : key === "no" ? "No" : null;
  };
  const inverseBinary = (value) => value === "Yes" ? "No" : value === "No" ? "Yes" : null;

  const SPONSORSHIP_INVERTED =
    /\bwithout\s+(?:the\s+need\s+for\s+)?(?:any\s+)?(?:a\s+)?(?:visa\s+|employment\s+|work\s+|immigration\s+)?sponsor|\bwithout\b[^?|]{0,40}\bsponsor(?:ing|ship)?\b|\b(?:not|never|no\s+longer)\s+(?:now\s+or\s+in\s+the\s+future\s+)?(?:require|need)\w*\b[^?|]{0,50}\bsponsor/i;

  /**
   * The voluntary self-identification block — CC-305 and its equivalents.
   *
   * Three fields inside it look generic and are not: a bare "Name" is the
   * applicant's legal name, a bare "Date" is today, and "Employee ID" does not
   * apply to someone who is not yet an employee. Outside this block those same
   * labels mean other things, so the rules that answer them are gated on this
   * pattern rather than on the label alone.
   */
  /**
   * The field's own label, without its surroundings.
   *
   * `deriveLabel` joins the field's own text with the section heading and the
   * labels of nearby fields, and denials are tested against that whole string.
   * For most rules that is right — a disqualifying word anywhere should
   * disqualify. For the contact block it is not: Workday renders "Country Phone
   * Code" and "Phone Device Type" beside "Phone Number", so the `phone` rule's
   * deny on /country|type/ fired on the phone box itself. The rule was skipped,
   * the box fell through to saved answers, and it came back holding the email
   * address while the number went into the country-code box.
   */
  /**
   * A widget's name for itself is not a label.
   *
   * SAP SuccessFactors gives every control `aria-label="Dropdown"` or "Text
   * field" and prints the real label in an `aria-describedby` node, so the
   * first description was always the generic one. It is skipped here, so the
   * printed "Country/Region" or "Phone Number" is what a rule judges.
   */
  const GENERIC_WIDGET_NAME =
    /^(drop\s*-?\s*down|text\s*(field|box|input|area)?|select(\s+one)?|combo\s*box|input|field|button|list\s*box|menu|picker|date(\s*picker)?|edit(able)?|required|optional|single\s*select|multi\s*select)$/i;

  const ownLabel = (label) => {
    const parts = String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    return parts.find((part) => !GENERIC_WIDGET_NAME.test(part)) ?? parts[0] ?? "";
  };

  /** Deny only when the field's *own* label says so. */
  const denyOwn = (re) => (label) => re.test(ownLabel(label));

  /**
   * "Country/Region" — one box, asking for a country.
   *
   * SAP SuccessFactors, Oracle HCM and several Workday tenants label the
   * country box this way, and the `state` rule's `region` pattern claimed it.
   * The applicant's state was then offered to a menu of countries, matched
   * nothing, and the country was left blank on every one of those portals.
   * Matched as a unit so a plain "Region" box is still a state box.
   */
  const COUNTRY_REGION_RE =
    /\b(country\s*(\/|\bor\b|&|-|\s)\s*region|region\s*(\/|\bor\b|&|-|\s)\s*country)\b/i;

  /**
   * Is this box's own, printed label a Country/Region box?
   *
   * The denial used to run over the whole derived label, and that label ends
   * with the humanized `name` and `id`. Workday's State menu is
   * `id="address--countryRegion"`, `name="countryRegion"` — Workday's own word
   * for a state is "country region" — so "State" was denied the state rule on
   * every Workday tenant. The country rule took it instead and offered the
   * applicant's *country* to a menu of states, where "United States" is the
   * start of "United States Minor Outlying Islands": that is what was being
   * selected as the applicant's State. Only what the page prints decides now.
   */
  const labelsCountryRegion = (label) => {
    const own = ownLabel(label);
    return COUNTRY_REGION_RE.test(own) && !/\b(state|province|territory)\b/i.test(own);
  };

  /** A box printed as "State", "Province", "State/Province", "Territory". */
  const labelsStateBox = (label) => {
    const own = ownLabel(label);
    return /\b(state|province|territory)\b/i.test(own) && !/\bcountry\b/i.test(own.replace(/\bunited\s+states\b/gi, ""));
  };

  /**
   * "State" the verb, and states that are not the applicant's address.
   *
   * "Please state your desired salary", "state the reason you are leaving",
   * "willing to travel out of state", "state-issued license" — every one of
   * these matched the state rule and received the applicant's home state; the
   * salary box on a Workday questionnaire came back holding "NC". A manual
   * correction to any of them was then refused as a "profile field", which is
   * why those edits never reached the pending list either.
   */
  const STATE_NOT_ADDRESS_RE =
    /\b(please\s+state|kindly\s+state|briefly\s+state|state\s+(your|the|why|how|whether|if|any|all|which|what|reason|reasons|below|here|clearly|briefly|in\s+detail)|out[\s-]+of[\s-]+state|state[\s-]+of[\s-]+the[\s-]+art|state[\s-]+(law|laws|government|agency|agencies|university|college|license|licensure|board|bar|employee|employees|funded|issued|certification|certified|tax|taxes|program|of\s+(mind|health|employment))|(across|between|other|another|multiple|different|which|what|all|several|any)\s+states\b|(another|other|different|a\s+different)\s+state\b|interstate|statewide)\b/i;

  /**
   * The CC-305 block, however the portal names it. Workday's own field ids
   * say "selfIdentifiedDisabilityData", which is often the only mention of the
   * form on the control itself; the matcher also finds the block's printed
   * markers above the fields (see `context: "selfId"` below).
   */
  const SELF_ID_RE =
    /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|self[-\s]?identified\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number\s*1250|voluntary\s+disclosure)/i;

  /* ------------------------------------------------------------------ */
  /*  Security clearance and citizenship                                 */
  /* ------------------------------------------------------------------ */

  const CLEARANCE_RANK = [
    [/\bts\s*\/?\s*sci\b|\bsci\b/i, 5],
    [/\btop\s*secret\b|\bts\b/i, 4],
    [/\bsecret\b/i, 3],
    [/\bpublic\s*trust\b/i, 2],
    [/\bconfidential\b/i, 1],
  ];
  const clearanceRank = (text) => {
    const t = String(text ?? "");
    for (const [re, rank] of CLEARANCE_RANK) if (re.test(t)) return rank;
    return 0;
  };

  /**
   * A clearance question, answered in the shape it asks for.
   *
   *   "Do you hold an active clearance?"          yes / no, from the level held
   *   "Do you hold a Top Secret clearance?"       yes only if the level reaches it
   *   "Are you able to obtain a clearance?"       yes when one is already held;
   *                                               otherwise left to the applicant
   *   "Security clearance" / "Clearance level"    the level itself
   */
  const clearanceAnswer = (stored, label, profile = null) => {
    const level = String(stored ?? "").trim();
    const none = !level || /^(none|no|n\/?a|not\s+applicable|no\s+clearance|never|nil|not\s+cleared)$/i.test(level);
    const held = none ? 0 : Math.max(clearanceRank(level), 1);
    const question = ownLabel(label);

    /**
     * "Are you able to obtain a clearance?" — a question about eligibility,
     * and a U.S. security clearance is only granted to U.S. citizens. So a
     * citizen without one is able to (Yes), a non-citizen is not (No), and
     * without a recorded status it stays with the applicant. It used to be
     * left blank for every applicant who did not already hold one.
     */
    if (/\b(able|willing|eligible|obtain\w*|acquired|awarded|conferred|earnede|get|apply|sponsor\w*|would\s+you|can\s+you|capable|qualif\w*|clearable)\b/i.test(question)) {
      if (held) return "Yes";
      const citizen = profile ? citizenAnswer(profile, "Are you a U.S. citizen?") : null;
      if (citizen === "Yes") return "Yes";
      if (citizen === "No" && !/\bwilling\b/i.test(question)) return "No";
      return null;
    }
    if (!level) return null;
    const asksLevel = /\b(what|which|level|type)\b/i.test(question);
    const asksYesNo = !asksLevel && (
      /^\s*(do|does|are|have|has|is|did|were|was)\b/i.test(question) ||
      /\b(do|does|are|have|has)\s+you\b/i.test(question) ||
      /\?\s*$/.test(question)
    );
    if (asksYesNo) {
      if (!held) return "No";
      return held >= clearanceRank(question) ? "Yes" : "No";
    }
    return level;
  };

  /**
   * "Are you a U.S. citizen?" from the work-authorization type the applicant
   * chose — and only when that type settles it.
   */
  const citizenAnswer = (p, label) => {
    const status = [W(p).workAuthType, W(p).visaStatus, W(p).citizenship, P(p).citizenship]
      .filter(Boolean).join(" ");
    if (!status.trim()) return null;
    const citizen =
      /\b(u\.?\s?s\.?a?\.?\s*citizen|united\s+states\s+citizen|american\s+citizen|citizen\s+of\s+the\s+(u\.?\s?s|united\s+states))\b/i.test(status) ||
      /^\s*citizen\s*$/i.test(String(W(p).workAuthType ?? ""));
    const resident = /\b(green\s*card|permanent\s*resident|lawful\s+permanent|lpr)\b/i.test(status);
    const protectedPerson = /\b(asyl\w*|refugee)\b/i.test(status);
    const visa = /\b(h-?1b|h-?4|f-?1|opt|cpt|tn|l-?1|l-?2|e-?[123]|j-?1|o-?1|ead|visa|daca|tps)\b/i.test(status);
    const question = ownLabel(label);
    const coversResidents = /\b(permanent\s+resident|green\s*card|lawful\s+permanent|u\.?\s?s\.?\s+person|refugee|asylee|protected\s+individual)\b/i.test(question);

    if (citizen) return "Yes";
    if (resident) return coversResidents ? "Yes" : "No";
    if (protectedPerson) return /\b(u\.?\s?s\.?\s+person|refugee|asylee|protected\s+individual)\b/i.test(question) ? "Yes" : "No";
    if (visa) return "No";
    return null;
  };

  /* ------------------------------------------------------------------ */
  /*  The hiring company, and the applicant's own employers              */
  /* ------------------------------------------------------------------ */

  /** A company's legal form and filler, which are not part of its name. */
  const EMPLOYER_FORM_RE =
    /\b(incorporated|inc|corp|corporation|co|company|companies|llc|llp|lp|ltd|limited|plc|gmbh|ag|sa|nv|bv|pvt|private|pte|group|holdings?|international|intl|the)\b/g;

  /** Too common to identify an employer by containment alone. */
  const GENERIC_EMPLOYER_WORDS = new Set([
    "services", "service", "solutions", "systems", "technologies", "technology", "tech",
    "consulting", "partners", "global", "national", "american", "united", "general",
    "digital", "software", "data", "health", "healthcare", "financial", "bank", "labs",
    "federal", "government", "business", "enterprises", "industries", "associates",
  ]);

  const employerKey = (name) => String(name ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’]s\b/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(EMPLOYER_FORM_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  /** The name, plus any short form printed in brackets: "… Technology (GDIT)". */
  const employerNames = (name) => {
    const raw = String(name ?? "");
    const out = [employerKey(raw)];
    for (const m of raw.matchAll(/\(([^)]{2,60})\)/g)) out.push(employerKey(m[1]));
    return out.filter(Boolean);
  };

  const initialsOf = (key) =>
    key.split(" ").filter((w) => w && !/^(and|of|for)$/.test(w)).map((w) => w[0]).join("");

  const sameEmployerKey = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const ca = a.replace(/ /g, "");
    const cb = b.replace(/ /g, "");
    if (ca === cb) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    // "Amazon" in "Amazon Web Services": the whole shorter name, word for word.
    if (short.length >= 3 && !GENERIC_EMPLOYER_WORDS.has(short) && ` ${long} `.includes(` ${short} `)) return true;
    if (short.includes(" ")) return false;
    const cShort = short;
    // "GDIT" for "General Dynamics Information Technology".
    if (/^[a-z]{3,6}$/.test(cShort) && initialsOf(long) === cShort) return true;
    // A Workday tenant is the name with its spaces taken out: "boozallen".
    if (cShort.length >= 4) {
      let joined = "";
      for (const word of long.split(" ")) {
        joined += word;
        if (joined === cShort) return true;
        if (joined.length >= cShort.length) break;
      }
    }
    return false;
  };

  /**
   * Are these two names the same employer?
   *
   * Conservative on purpose: "Leidos" and "Leidos, Inc.", "Amazon" and
   * "Amazon Web Services", "GDIT" and "General Dynamics Information
   * Technology" are; "Apple" and "Pineapple Labs" are not.
   */
  const sameEmployer = (a, b) =>
    employerNames(a).some((x) => employerNames(b).some((y) => sameEmployerKey(x, y)));

  /** The employer a question names: "…employed by Leidos or any of its subsidiaries?" */
  // "!" belongs to a few names — "Yum! Brands", "Yahoo!" — and cut them short.
  const COMPANY_NAME =
    "((?:[A-Z0-9][\\w&'’.!-]*|[a-z]+[A-Z][\\w&'’.!-]*)(?:(?:,?\\s+|\\s*&\\s*)(?:[A-Z0-9][\\w&'’.!-]*|&|and|of))*(?:\\s*\\([^)]{2,40}\\))?)";
  // "Employed with Accenture" names an employer; "worked with Kubernetes" does not.
  const EMPLOYED_BY_RE = new RegExp(
    `\\b(?:employed|employee|employment|intern(?:ed)?|contractor|consultant)\\b[^?|]{0,40}?\\b(?:by|for|with|at|of)\\s+${COMPANY_NAME}`
  );
  const WORKED_FOR_RE = new RegExp(`\\b(?:worked|working|work)\\b[^?|]{0,40}?\\b(?:for|at|by)\\s+${COMPANY_NAME}`);

  const employerNamedIn = (question) => {
    const text = String(question ?? "");
    const m = text.match(EMPLOYED_BY_RE) || text.match(WORKED_FOR_RE);
    if (!m) return null;
    const name = m[1].replace(/[\s,.]+$/, "").trim();
    // "the U.S. Federal Government" never reaches here ("the" is lower case),
    // but a bare "U.S." or "Federal" would.
    if (!name || /^(u\.?\s?s\.?|united\s+states|federal|state|government|military)\b/i.test(name)) return null;
    return name;
  };

  /**
   * The company this application is for, from the address bar.
   *
   * Workday puts it in the tenant — `leidos.wd5.myworkdayjobs.com` — and the
   * common job boards put it in the first path segment.
   */
  const hiringCompanyHints = ({ page = true } = {}) => {
    const hints = [];
    /**
     * The company the page itself names (the posting's company, read by the
     * content script at the start of a fill — see `hiringEmployers`). ADP's
     * addresses name nobody (`workforcenow.adp.com/…?cid=…`), so without this
     * "Have you worked here before?" could not be checked against the work
     * history on an ADP application.
     */
    const named = [];
    if (page) {
      try {
        const extra = global?.__applifillPageEmployers;
        if (Array.isArray(extra)) named.push(...extra.map((n) => String(n ?? "").trim()).filter((n) => n.length >= 2 && n.length <= 80));
      } catch {}
    }
    try {
      const host = String(global.location?.hostname || "").toLowerCase();
      const path = String(global.location?.pathname || "");
      const first = host.split(".")[0];
      if (/myworkdayjobs\.com$/.test(host) && first && !/^(www|wd\d+)$/.test(first)) hints.push(first);
      const site = path.match(/\/recruiting\/([^/]+)\//i);
      if (/myworkdaysite\.com$/.test(host) && site) hints.push(site[1]);
      const slug = path.match(/^\/([^/?#]+)/)?.[1];
      if (/(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|breezy\.hr|recruitee\.com|jobvite\.com)$/.test(host) &&
          slug && !/^(jobs?|embed|v\d+|careers?|en|en-us|o|p|j|apply)$/i.test(slug)) hints.push(slug);
      const icims = host.match(/^(?:careers|jobs)-([a-z0-9-]+)\.icims\.com$/);
      if (icims) hints.push(icims[1]);
      // ADP Recruiting Management: myjobs.adp.com/<employer>careers/cx/…
      if (/(^|\.)myjobs\.adp\.com$/.test(host) && slug && !/^(cx|apply|public|careers?|jobs?)$/i.test(slug)) {
        const name = slug.replace(/[-_]?(external)?[-_]?(career[-_]?site|careers?|jobs?)$/i, "");
        if (name.length >= 3) hints.push(name);
      }
    } catch {}
    const decoded = hints.map((h) => {
      try { return decodeURIComponent(h); } catch { return h; }
    }).map((h) => h.replace(/[-_]+/g, " ").trim()).filter(Boolean);
    return Array.from(new Set([...decoded, ...named]));
  };

  /**
   * Does the question point at an employer — a named one, this company, "us"?
   *
   * "Have you ever worked with Kubernetes?" matched the prior-employment rule
   * on "ever worked", and was answered with the stored "have you worked here"
   * answer: a flat "No" to a question about a skill the applicant lists.
   */
  const referencesEmployer = (label) => {
    const own = ownLabel(label);
    if (employerNamedIn(own)) return true;
    if (/\b(us|here|this\s+(company|organi[sz]ation|employer|firm|business|corporation|agency|bank|credit\s+union|institution|hospital)|our\s+(company|organi[sz]ation|firm|business|bank|credit\s+union)|the\s+(company|organi[sz]ation|employer|bank|credit\s+union|firm|agency|institution|hospital)|(former|current)\s+employee|rehire|re-?employ\w*)\b/i.test(own)) return true;
    // "Are you a former Acme employee?" — the name between the words, capitalised.
    if (/\b(?:current|former|past|previous|ex)[\s-]+(?:or\s+(?:current|former|past|previous)\s+)?(?:[A-Z0-9][\w&'’.!-]*\s+){1,4}(?:employee|team\s*member|associate)s?\b/.test(own)) return true;
    return hiringCompanyHints().some((hint) => {
      const pattern = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      return new RegExp(`\\b${pattern}\\b`, "i").test(own);
    });
  };

  /** "…in the last 12 months", "…within the past two years": the window, in months. */
  const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, twenty: 20, "twenty-four": 24, thirty: 30, "thirty-six": 36 };
  const windowMonths = (question) => {
    const m = String(question ?? "").toLowerCase().match(
      /\b(?:in|within|during)\s+the\s+(?:last|past|previous|preceding)\s+(\d+|[a-z-]+)?\s*(months?|years?)\b/
    );
    if (!m) return null;
    const n = m[1] ? (Number(m[1]) || WORD_NUMBERS[m[1]] || null) : 1;
    if (!n) return null;
    return /^year/.test(m[2]) ? n * 12 : n;
  };

  const monthsSince = (raw) => {
    const m = String(raw ?? "").match(/(\d{4})(?:-(\d{1,2}))?/);
    if (!m) return null;
    const now = new Date();
    return (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2] || 12));
  };

  /** Did this job still run inside the window? No window means "ever". */
  const heldWithin = (job, months) => {
    if (months == null) return true;
    if (job?.current || !job?.endDate) return Boolean(job?.current || job?.startDate);
    const since = monthsSince(job.endDate);
    return since != null && since <= months;
  };

  /**
   * "Have you previously been employed by Leidos?" — from the applicant's own
   * work history, when the question's employer is one of theirs.
   *
   * The profile's single "previously employed here" answer cannot be right for
   * every employer: it was "No" on the application of a company the applicant
   * had spent three years at. A match in their experience is the fact; a miss
   * says nothing the stored answer doesn't, so it falls back to that.
   */
  const employerHistory = (p, label) => {
    const question = ownLabel(label);
    const jobs = (p?.experience ?? []).filter((j) => String(j?.company ?? "").trim());
    if (!jobs.length) return null;
    const named = employerNamedIn(question);
    const targets = named ? [named] : hiringCompanyHints();
    if (!targets.length) return null;

    const currentOnly =
      /\b(current(ly)?|presently|now)\b/i.test(question) &&
      !/\b(former(ly)?|previous(ly)?|ever|before|past|prior|in\s+the\s+last)\b/i.test(question);
    const months = windowMonths(question);
    const currentIndex = currentJobIndex(p);
    const all = p?.experience ?? [];

    for (let i = 0; i < all.length; i++) {
      const job = all[i];
      if (!String(job?.company ?? "").trim()) continue;
      const isCurrent = i === currentIndex;
      if (currentOnly && !isCurrent) continue;
      if (!heldWithin(job, months)) continue;
      if (targets.some((t) => sameEmployer(job.company, t))) {
        return isCurrent ? "Yes, current employee" : "Yes, former employee";
      }
    }
    return null;
  };

  /** A stored Yes / No answer, read loosely ("Yes", "y", "NO"); null for anything else. */
  const yesNo = (raw) => {
    const s = String(raw ?? "").trim();
    if (/^(y|yes|true)$/i.test(s) || /^yes\b/i.test(s)) return "Yes";
    if (/^(n|no|false)$/i.test(s) || /^no\b/i.test(s)) return "No";
    return null;
  };

  /** Asked about now only: "Are you currently employed by Acme?" */
  const asksCurrentOnly = (question) =>
    /\b(current(ly)?|presently|now)\b/i.test(question) &&
    !/\b(former(ly)?|previous(ly)?|ever|before|past|prior|in\s+the\s+last)\b/i.test(question);

  /**
   * "Have you worked for Acme before?" — the work history first, then the
   * profile's answer ("Previously employed at this company?"), for whichever
   * company asks.
   *
   * Having worked somewhere once says nothing about working there now, so a
   * stored "Yes" does not answer "Are you currently employed by Acme?"; the
   * work history does, and otherwise the question is left for the applicant.
   */
  const previousEmploymentAnswer = (p, label) => {
    const fromHistory = employerHistory(p, label);
    if (fromHistory) return fromHistory;
    const stored = String(W(p).previouslyEmployedHere ?? "").trim();
    if (!stored) return null;
    if (asksCurrentOnly(ownLabel(label)) && yesNo(stored) === "Yes") return null;
    return stored;
  };

  /* ------------------------------------------------------------------ */
  /*  Relatives, referrals and age                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The answer a box asks for when the answer is no: "If no, enter NA." → "NA".
   * Written as the page spells it, since a validator may compare it exactly.
   */
  const IF_NO_ENTER_RE =
    /\bif\s+(?:no|not|none|not\s+applicable|n\/a)\b[^.?!|]{0,24}?\b(?:enter|type|write|put|input|respond\s+with|answer\s+with|answer|indicate|state|mark)\s+["'“”‘’]?(n\/a|na|none|no|not\s+applicable|0)(?=["'“”‘’]?(?:[\s.,;:!?)]|$))/i;
  const ifNoInstruction = (label) => String(label ?? "").match(IF_NO_ENTER_RE)?.[1] ?? null;

  /** A box the applicant types into, rather than a list, a radio group or a check box. */
  const typedBox = (el) => {
    let kind = "";
    try { kind = M.fieldKind?.(el) || ""; } catch {}
    return kind === "text" || kind === "textarea";
  };

  /**
   * "Do you have any relatives employed by Acme?" and its rewordings: "Are you
   * related to anyone currently employed by …", "Is anyone in your family
   * employed by …", "Does Acme employ any of your relatives?".
   *
   * Never a question about officials, competitors, clients or an industry —
   * those are conflict-of-interest questions of their own — nor an emergency
   * contact or a dependant.
   */
  const RELATIVE_WORDS =
    "relatives?|family(?:\\s+members?)?|members?\\s+of\\s+your\\s+(?:immediate\\s+)?family|immediate\\s+family|household\\s+members?|in-?laws?|spouse|domestic\\s+partner";
  const RELATIVES_MATCH = [
    new RegExp(`\\b(?:${RELATIVE_WORDS})\\b[^?|]{0,80}?\\b(?:employ\\w*|work(?:s|ing|ed)?|staff|on\\s+(?:the\\s+)?payroll)\\b`, "i"),
    /\b(?:employ\w*|work(?:s|ing)?)\b[^?|]{0,60}?\b(?:relatives?|family\s+members?|related\s+to\s+you)\b/i,
    /\b(?:are|is|were)\s+you\s+related\s+(?:by\s+(?:blood|marriage)\s+|in\s+any\s+way\s+)?to\b/i,
  ];
  const RELATIVES_DENY =
    /\b(government|federal|state\s+agenc\w*|public\s+(official|office|servant)|elected|officials?|politically\s+exposed|pep|regulators?|regulatory|examiners?|competitors?|clients?|customers?|vendors?|suppliers?|auditors?|industry|sector|profession|emergency|contact\s+person|next\s+of\s+kin|beneficiar\w*|dependents?|dependants?|insurance|benefits?|medical|health\s+plan|coverage)\b/i;

  /**
   * The profile's "Do you have any relatives employed by this company?", for
   * whichever company asks. A friend is not a relative, so "…relatives or
   * friends…" is answered only by a yes. A box that asks for names is the
   * applicant's to fill when the answer is yes; when it is no, the box gets
   * what the page says to enter ("If no, enter NA"), "No" for a question asked
   * in so many words, and "N/A" otherwise.
   */
  const relativesAnswer = (p, el, label) => {
    const stored = yesNo(W(p).relativesEmployedHere);
    if (!stored) return null;
    const question = ownLabel(label) || String(label ?? "");
    if (stored === "No" &&
        /\b(friends?|acquaintances?|know\s+(?:anyone|someone|any\s+one|any\s+(?:current\s+)?employees?)|personal\s+relationships?|romantic|dating)\b/i.test(question)) {
      return null;
    }
    if (!typedBox(el)) return stored;
    if (stored === "Yes") return null;
    const instructed = ifNoInstruction(label);
    if (instructed) return instructed;
    return /^\s*(do|does|are|is|have|has|were|was)\b/i.test(question) ? "No" : "N/A";
  };

  /** "Referred by: ." — a placeholder, not a person. */
  const NO_VALUE_RE = /^\s*(?:\.+|-+|n\/?a|none|nil|nobody|no\s*one|not\s+applicable|null)\s*$/i;
  const referrerOf = (p) => {
    const name = String(W(p).referredBy ?? "").trim();
    return name && !NO_VALUE_RE.test(name) ? name : "";
  };

  /**
   * "Did any of our current employees inform you about this position?" /
   * "Were you referred by a current employee?" — from the profile's "Referred
   * by" and "How did you hear about us?". A referrer on file is a yes; a source
   * that is not a referral (LinkedIn, Indeed, the company's website) is a no;
   * a referral with nobody named, or no source at all, is left unanswered.
   */
  const referralNamePart = (p, index) => {
    const name = referrerOf(p);
    if (!name || /[@/:\d]/.test(name)) return null;
    const parts = name.trim().split(/\s+/);
    return parts.length === 2 ? parts[index] : null;
  };

  const referralAnswer = (p) => {
    if (referrerOf(p) || [W(p).referrerFirstName, W(p).referrerLastName, W(p).referrerEmployeeId].some((v) => String(v || "").trim())) return "Yes";
    const source = String(W(p).howDidYouHear ?? "").trim();
    if (!source || NO_VALUE_RE.test(source)) return null;
    if (/\bemployee\s+referr?al\b|\breferred\s+by\s+(?:an?\s+)?(?:current\s+)?employee\b/i.test(source)) return "Yes";
    if (/\b(referr?al|referred|employee|friend|word\s+of\s+mouth|colleague|personal\s+(?:contact|network)|other)\b/i.test(source)) return null;
    return "No";
  };

  /**
   * The age a question asks about: "at least 18", "18 or older", "over the
   * age of 21", "of legal working age" (18). Null when it names none.
   */
  const AGE_WORDS = {
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, "twenty-one": 21, "twenty one": 21,
  };
  const AGE_NUM = "(1[4-9]|2[0-5]|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\\s-]one|twenty)";
  const AGE_AT_LEAST_RE = new RegExp(
    `\\b(?:at\\s+least|over|older\\s+than|above|minimum(?:\\s+age)?\\s+of|aged?)\\s+(?:the\\s+age\\s+of\\s+)?${AGE_NUM}(?:\\s*\\(\\d{2}\\))?\\b`, "i");
  const AGE_OR_OLDER_RE = new RegExp(
    `\\b${AGE_NUM}(?:\\s*\\(\\d{2}\\))?\\s*(?:years?\\s*)?(?:of\\s*age\\s*|old\\s*)?(?:or\\s+(?:older|over|above|more)|and\\s+(?:older|over|above)|\\+)`, "i");
  const ageNumber = (raw) => {
    const v = String(raw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    return Number(v) || AGE_WORDS[v] || AGE_WORDS[v.replace(" ", "-")] || null;
  };
  const ageThreshold = (label) => {
    const text = ownLabel(label) || String(label ?? "");
    const m = text.match(AGE_AT_LEAST_RE) || text.match(AGE_OR_OLDER_RE);
    if (m) return ageNumber(m[1]);
    if (/\blegal\s*(working\s*)?age\b|\bof\s+legal\s+age\b/i.test(text)) return 18;
    if (/^\s*(are\s+you\s+)?(18|eighteen)(\s+years(\s+(of\s+age|old))?)?\s*\??\s*$/i.test(text)) return 18;
    return null;
  };

  /** Whole years since a date of birth on the profile, or null. */
  const ageFromBirth = (raw) => {
    const parsed = parseProfileDate(raw);
    if (!parsed?.month || !parsed.day) return null;
    const now = new Date();
    let age = now.getFullYear() - Number(parsed.year);
    const month = now.getMonth() + 1;
    if (month < Number(parsed.month) || (month === Number(parsed.month) && now.getDate() < Number(parsed.day))) age--;
    return age >= 0 && age < 120 ? age : null;
  };

  /**
   * "Are you at least 18?" from the profile's "Are you over 18?"; a lower age
   * (16) from a yes, a higher one (21) from a no; and any age from a date of
   * birth on the profile when the answer above does not settle it.
   */
  const ageAnswer = (p, label) => {
    const threshold = ageThreshold(label) ?? 18;
    const over18 = yesNo(W(p).over18);
    if (threshold === 18 && over18) return over18;
    const age = ageFromBirth(P(p).dateOfBirth);
    if (age != null) return age >= threshold ? "Yes" : "No";
    if (!over18) return null;
    if (threshold < 18) return over18 === "Yes" ? "Yes" : null;
    return over18 === "No" ? "No" : null;
  };

  /* ------------------------------------------------------------------ */
  /*  How soon: availability and notice asked as a list of choices        */
  /* ------------------------------------------------------------------ */

  const SPAN_UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const SPAN_NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, fifteen: 15, thirty: 30, sixty: 60, ninety: 90,
  };
  const SPAN_NUM = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|sixty|ninety)";
  const SPAN_UNIT = "(day|week|month|year)s?";
  const spanNumber = (s) => (/^\d+$/.test(s) ? Number(s) : SPAN_NUMBER_WORDS[s] ?? null);

  /**
   * The stretch of time one choice stands for, in days from today:
   * "Immediately" 0–0, "Within 2 weeks" 0–14, "1-3 months" 30–90, "More than
   * 3 months" 91–∞, "2 weeks" 0–14. Null for a choice that is not a time
   * ("Negotiable", "Other").
   */
  const choiceSpan = (text) => {
    const t = String(text ?? "").toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/\b(immediate(ly)?|asap|as soon as possible|right away|right now|at once|available now|currently available|no notice|serving notice)\b|^(now|today|0 days?|none|zero)$/.test(t)) {
      return { min: 0, max: 0 };
    }
    let m = t.match(new RegExp(`${SPAN_NUM}\\s*(?:-|–|—|to|and)\\s*${SPAN_NUM}\\s*${SPAN_UNIT}`));
    if (m) {
      const a = spanNumber(m[1]), b = spanNumber(m[2]), u = SPAN_UNIT_DAYS[m[3]];
      if (a != null && b != null) return { min: a * u, max: b * u };
    }
    m = t.match(new RegExp(`(?:more\\s+than|over|greater\\s+than|longer\\s+than|beyond|after)\\s+${SPAN_NUM}\\s*${SPAN_UNIT}`));
    if (m) {
      const n = spanNumber(m[1]);
      if (n != null) return { min: n * SPAN_UNIT_DAYS[m[2]] + 1, max: Infinity };
    }
    m = t.match(new RegExp(`${SPAN_NUM}\\s*${SPAN_UNIT}\\s*(?:\\+|or\\s+(?:more|longer|later|above))|${SPAN_NUM}\\s*\\+\\s*${SPAN_UNIT}`));
    if (m) {
      const n = spanNumber(m[1] ?? m[3]);
      const unit = m[2] ?? m[4];
      if (n != null) return { min: n * SPAN_UNIT_DAYS[unit], max: Infinity };
    }
    m = t.match(new RegExp(`${SPAN_NUM}\\s*${SPAN_UNIT}`));
    if (m) {
      const n = spanNumber(m[1]);
      if (n == null) return null;
      const days = n * SPAN_UNIT_DAYS[m[2]];
      return { min: 0, max: /\b(less\s+than|under|fewer\s+than|before)\b/.test(t) ? days - 1 : days };
    }
    return null;
  };

  /**
   * The choice that covers starting `days` from now: the shortest stretch that
   * reaches it ("Within 2 weeks" for six days, "Immediately" for none), or the
   * longest on offer when none does. Null when no choice is a stretch of time.
   */
  const durationChoice = (days, texts) => {
    let best = null;
    let bestMax = Infinity;
    let longest = null;
    let longestMax = -1;
    for (const raw of texts || []) {
      const text = String(raw ?? "").trim();
      if (!text) continue;
      try { if (M.isPlaceholderChoice?.(text)) continue; } catch {}
      const span = choiceSpan(text);
      if (!span) continue;
      if (span.max >= days && span.max < bestMax) { best = text; bestMax = span.max; }
      if (span.max > longestMax) { longest = text; longestMax = span.max; }
    }
    return best ?? longest;
  };

  /** The choices a list or radio group offers, as far as they can be read before it is opened. */
  const choiceTextsOf = (el) => {
    try {
      if (el?.tagName === "SELECT") return Array.from(el.options || []).map((o) => String(o.textContent || "").trim()).filter(Boolean);
      return (M.optionTextsFor?.(el) || []).map((o) => String(o ?? "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  };

  /** A notice period in days: "0" and "Immediately" are none, "2 weeks" fourteen. */
  const noticeDays = (raw) => {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    if (/^0+(\s*(days?|weeks?|months?))?$/i.test(text) || IMMEDIATE_RE.test(text) || /^(none|no\s+notice|nil|n\/?a)$/i.test(text)) return 0;
    const span = choiceSpan(/^\d+$/.test(text) ? `${text} days` : text);
    return span && Number.isFinite(span.max) ? span.max : null;
  };

  /**
   * Days from today until the applicant can start: the profile's Available
   * Start Date ("Immediately" is today), or else its notice period. Null when
   * the profile says neither.
   */
  const availabilityDays = (p) => {
    const date = availabilityDate(W(p).availableStartDate);
    if (date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return Math.max(0, Math.round((date.getTime() - today.getTime()) / 86400000));
    }
    return noticeDays(W(p).noticePeriod);
  };

  /** A list or radio group (not a box), as the matcher reads the control. */
  const choiceControl = (el) => {
    let kind = "";
    try { kind = M.fieldKind?.(el) || ""; } catch {}
    return kind === "select" || kind === "radio";
  };

  /* ------------------------------------------------------------------ */
  /*  Salary currency                                                    */
  /* ------------------------------------------------------------------ */

  /** Ways a list writes each currency the profile offers, and a few more. */
  const CURRENCY_SYNONYMS = {
    USD: ["usd", "us dollar", "us dollars", "u.s. dollar", "u.s. dollars", "united states dollar", "united states dollars", "american dollar", "dollars (usd)", "$ (usd)", "usd ($)", "$ usd", "$"],
    EUR: ["eur", "euro", "euros", "eur (€)", "€"],
    GBP: ["gbp", "british pound", "british pounds", "pound sterling", "pounds sterling", "uk pound", "gbp (£)", "£"],
    INR: ["inr", "indian rupee", "indian rupees", "rupee", "rupees", "inr (₹)", "₹"],
    CAD: ["cad", "canadian dollar", "canadian dollars", "cad ($)", "c$"],
    AUD: ["aud", "australian dollar", "australian dollars", "aud ($)", "a$"],
    NZD: ["nzd", "new zealand dollar", "new zealand dollars"],
    SGD: ["sgd", "singapore dollar", "singapore dollars"],
    JPY: ["jpy", "japanese yen", "yen", "¥"],
    CHF: ["chf", "swiss franc", "swiss francs"],
    MXN: ["mxn", "mexican peso", "mexican pesos"],
    AED: ["aed", "uae dirham", "emirati dirham", "dirham"],
  };

  /** The profile's currency as a code ("USD"), however it was saved ("US Dollar", "$"). */
  const currencyCode = (raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    if (/^[a-z]{3}$/i.test(s)) return s.toUpperCase();
    const want = s.toLowerCase();
    for (const [code, names] of Object.entries(CURRENCY_SYNONYMS)) {
      if (names.includes(want)) return code;
    }
    return s;
  };

  /* ------------------------------------------------------------------ */
  /*  Government and military service, from the work history             */
  /* ------------------------------------------------------------------ */

  const MILITARY_EMPLOYER_RE =
    /\b(?:u\.?\s?s\.?\s+|united\s+states\s+)?(?:army|navy|air\s+force|marine\s+corps|marines|coast\s+guard|space\s+force|national\s+guard|armed\s+forces|army\s+reserves?|navy\s+reserves?)\b/i;
  const NOT_MILITARY_RE =
    /\b(salvation\s+army|old\s+navy|navy\s+federal|army\s+navy\s+(store|club)|credit\s+union|armed\s+forces\s+(bank|insurance)|pentagon\s+federal)\b/i;
  const FEDERAL_EMPLOYER_RE = new RegExp(
    "\\b(?:" +
      "(?:u\\.?\\s?s\\.?|united\\s+states)\\s+(?:government|department|dept|postal\\s+service|patent|census|mint|marshals?|secret\\s+service|courts?|senate|house\\s+of\\s+representatives|congress|agency)|" +
      "federal\\s+(?:government|bureau|aviation|emergency|trade\\s+commission|communications\\s+commission|election|highway|railroad|transit|deposit\\s+insurance|agency|service)|" +
      "department\\s+of\\s+(?:defen[cs]e|the\\s+(?:army|navy|air\\s+force|interior|treasury)|state|energy|justice|homeland\\s+security|veterans\\s+affairs|health\\s+and\\s+human\\s+services|agriculture|commerce|labor|transportation|education|housing)|" +
      "internal\\s+revenue\\s+service|social\\s+security\\s+administration|veterans\\s+(?:affairs|health\\s+administration|administration)|" +
      "national\\s+(?:aeronautics|institutes?\\s+of\\s+health|security\\s+agency|park\\s+service|oceanic|geospatial|reconnaissance|science\\s+foundation|labor\\s+relations)|" +
      "central\\s+intelligence\\s+agency|defen[cs]e\\s+(?:intelligence|logistics|information\\s+systems|contract\\s+management|health)\\s+agency|" +
      "environmental\\s+protection\\s+agency|general\\s+services\\s+administration|small\\s+business\\s+administration|" +
      "office\\s+of\\s+personnel\\s+management|government\\s+accountability\\s+office|library\\s+of\\s+congress|" +
      "centers\\s+for\\s+disease\\s+control|food\\s+and\\s+drug\\s+administration|customs\\s+and\\s+border|immigration\\s+and\\s+customs|" +
      "transportation\\s+security\\s+administration|citizenship\\s+and\\s+immigration\\s+services" +
    ")\\b",
    "i"
  );
  // Case-sensitive, so "Ice" and "Doe" are not agencies.
  const FEDERAL_ACRONYM_RE =
    /\b(DoD|DOD|DHS|DOE|DOJ|HHS|USDA|NASA|NIH|CDC|FDA|FBI|CIA|NSA|DIA|NGA|NRO|DISA|DLA|DCMA|DHA|IRS|SSA|EPA|GSA|OPM|USPS|FAA|FEMA|NOAA|NIST|USCIS|CBP|TSA|USAF|USN|USMC|USCG|DARPA|DTRA|HUD|FTC|FCC|FDIC|GAO|USPTO|VHA)\b/;
  const STATE_LOCAL_EMPLOYER_RE =
    /\b((state|commonwealth)\s+of\s+[a-z]|(county|city|town|village|borough|township|municipality)\s+of\b|[a-z]+\s+county\b|public\s+schools?\b|school\s+district\b|municipal\b|port\s+authority\b|transit\s+authority\b)/i;

  /** Military service the applicant declared on a self-identification form. */
  const declaredVeteran = (p) => {
    const status = String(E(p).veteranStatus ?? "");
    return /identify\s+as\s+(one\s+or\s+more|a\s+veteran)|\bam\s+a\s+(protected\s+)?veteran\b|\bveteran[,\s]+(but|just)\s+not\b|\bprotected\s+veteran\b(?![^.]*\bnot\b)/i.test(status) &&
      !/^\s*(i\s+am\s+)?not\s+a\s+(protected\s+)?veteran/i.test(status);
  };

  /**
   * "Have you ever been employed by the U.S. Federal Government (military or
   * civilian)?" — read from the employers on the applicant's history.
   *
   * Military service only counts where the question says it does: plenty of
   * these ask about civilian federal employment, and a veteran is not a former
   * federal employee for that purpose. When that is the only evidence and the
   * question does not settle it, the question is left for the applicant.
   */
  const governmentHistory = (p, label) => {
    const question = ownLabel(label);
    const includesMilitary = /\b(military|armed\s+forces|uniformed|active\s+duty|service\s*member|veteran)\b/i.test(question);
    const anyLevel = /\b(state|local|municipal|county|city|tribal|public\s+sector|any\s+government)\b/i.test(question);
    const months = windowMonths(question);
    const jobs = (p?.experience ?? []).filter((j) => String(j?.company ?? j?.title ?? "").trim());

    let military = false;
    for (const job of jobs) {
      if (!heldWithin(job, months)) continue;
      const company = String(job.company ?? "");
      const title = String(job.title ?? "");
      if (MILITARY_EMPLOYER_RE.test(company) && !NOT_MILITARY_RE.test(company)) { military = true; continue; }
      if (FEDERAL_EMPLOYER_RE.test(company) || FEDERAL_ACRONYM_RE.test(company) || /\bGS-?\d{1,4}(-\d{1,2})?\b/.test(title)) return "Yes";
      if (anyLevel && STATE_LOCAL_EMPLOYER_RE.test(company)) return "Yes";
    }
    if ((military || (months == null && declaredVeteran(p))) && includesMilitary) return "Yes";
    if (military || (months == null && declaredVeteran(p))) return null;
    return jobs.length ? "No" : null;
  };

  /* ------------------------------------------------------------------ */
  /*  Highest level of education                                         */
  /* ------------------------------------------------------------------ */

  const DEGREE_LEVELS = [
    [5, "Doctorate", /\b(ph\.?\s?d|doctor(ate|al)?|d\.?\s?phil|ed\.?\s?d|d\.?\s?sc|pharm\.?\s?d|psy\.?\s?d|m\.d\.|j\.d\.|md|jd|dds|dmd|dvm)\b/i],
    [4, "Master's Degree", /\b(master|masters|m\.?\s?s\.?c?|m\.?\s?sc|m\.a\.|ma|mba|m\.?\s?eng|m\.?\s?tech|mca|m\.?\s?com|mph|mfa|llm|mpa|m\.?\s?ed|msw|mfin|mim)\b/i],
    [3, "Bachelor's Degree", /\b(bachelor|bachelors|b\.?\s?s\.?c?|b\.?\s?sc|b\.a\.|ba|b\.?\s?eng|b\.?\s?tech|bca|b\.?\s?com|bba|bfa|b\.?\s?arch|llb|b\.e\.|undergraduate\s+degree)\b|\bbe\b(?=\s*(in\b|\(|,|$))/i],
    [2, "Associate's Degree", /\b(associate|associates|a\.a\.|a\.s\.|aas)\b/i],
    [1, "High School Diploma", /\b(high\s+school|ged|secondary\s+school|hsc|ssc)\b/i],
  ];

  const degreeLevel = (degree) => {
    const text = String(degree ?? "").trim();
    if (!text) return null;
    for (const [rank, label, re] of DEGREE_LEVELS) if (re.test(text)) return { rank, label };
    return null;
  };

  const DEGREE_OPTIONS = {
    Doctorate: ["doctorate", "doctoral degree", "phd", "ph.d.", "doctor of philosophy"],
    "Master's Degree": ["master's degree", "master's", "masters", "postgraduate", "post graduation", "graduate degree"],
    "Bachelor's Degree": ["bachelor's degree", "bachelor's", "bachelors", "undergraduate", "graduation"],
    "Associate's Degree": ["associate's degree", "associate degree", "associate's", "associates", "2-year degree"],
    "High School Diploma": ["high school diploma", "high school", "secondary school", "secondary", "ged"],
  };

  // History locations belong to that school/job, never the current home address.
  const historyPlace = (row, part, el) => {
    if (!row) return null;
    const pieces = String(row.location || "").split(/\s*,\s*/).filter(Boolean);
    const region = pieces.slice(1).map((v) => M.regionId?.(v)).find(Boolean);
    let value = row[part];
    if (!value && part === "city" && pieces.length >= 2) value = pieces[0];
    if (!value && part === "state") value = region ? M.regionName?.(region) : pieces.length >= 3 ? pieces[pieces.length - 2] : null;
    if (!value && part === "country") {
      const last = pieces[pieces.length - 1];
      if (pieces.length >= 2 && !M.regionId?.(last)) value = last;
      if (!value && region) value = { US: "United States", CA: "Canada", IN: "India", AU: "Australia" }[region.split("-")[0]];
    }
    if (value && part === "state" && Number(el?.getAttribute?.("maxlength")) === 2) return M.regionCode?.(M.regionId?.(value)) || value;
    return value || null;
  };

  /** The highest degree on the profile — only finished ones when the question says "completed". */
  const highestEducation = (p, label) => {
    const completedOnly = /\b(completed|obtained|earned|attained|received|achieved|finished|hold)\b/i.test(ownLabel(label));
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let best = null;
    for (const school of p?.education ?? []) {
      if (completedOnly) {
        if (school?.current) continue;
        const end = String(school?.endDate ?? "").slice(0, 7);
        if (end && end > thisMonth) continue;
      }
      const level = degreeLevel(school?.degree);
      if (level && (!best || level.rank > best.rank)) best = level;
    }
    return best?.label ?? null;
  };

  const RULES = [
    /* ---------------- Voluntary self-identification (CC-305) ----------------
     *
     * These three sit above every generic rule because the block they belong to
     * is the one place on an application where "Name", "Date" and "Employee ID"
     * are unambiguous — and the one place a wrong answer is a false statement on
     * a federal form.
     *
     * All three were previously unmatched, which handed them to the AI pass:
     * it answered "Name" with "Yes" (it had read the disability question sitting
     * directly above) and answered "Employee ID" with the applicant's name.
     */
    {
      key: "selfIdName",
      // Above fullName (6) and signature (8) so the section-aware rule wins.
      weight: 19,
      require: SELF_ID_RE,
      // …or a field below the form's printed markers (Workday's Self Identify
      // step has no heading that names the form).
      context: "selfId",
      match: [/^name$/i, /\byour\s*name\b/i, /\b(full|legal)\s*name\b/i, /\bname\b/i],
      deny: [
        THIRD_PARTY,
        /\bemployee\s*(id|number|#)/i,
        /first|last|middle|preferred|company|school|university|employer|file|user|login/i,
      ],
      identity: true,
      type: ["text"],
      value: (p) => E(p).disabilitySignatureName || fullName(p),
    },
    {
      /**
       * The date beside a self-identification signature is today's date, every
       * time, on every application. The generic `todayDate` rule deliberately
       * refuses a bare "Date" because elsewhere on a form it is just as likely
       * to be a graduation or employment date — but inside this block there is
       * nothing else it can mean, so it is answered here instead.
       */
      key: "selfIdDate",
      weight: 19,
      require: SELF_ID_RE,
      context: "selfId",
      match: [/^date$/i, /\bdate\b/i],
      deny: [
        THIRD_PARTY,
        /\b(start|end|from|to|birth|dob|graduation|grad|hire|termination|expiry|expiration|issued|available|availability|joining|last\s*working)\b/i,
      ],
      identity: true,
      // "number" too: some tenants draw the MM / DD / YYYY segments as numeric
      // spin boxes. Each segment receives its own part of today's date.
      type: ["text", "date", "number"],
      value: (p, el) => todayFor(el),
    },
    {
      /**
       * "Employee ID (if applicable)" is not applicable to an applicant. It has
       * no profile value and must not acquire one: left to the generic passes it
       * collected the applicant's name from the AI, and once that was captured
       * it came back on every later application from Saved Answers.
       *
       * `blank` tells the planner to leave the field alone entirely rather than
       * fall through to saved answers or the model.
       */
      key: "employeeId",
      weight: 19,
      match: [
        /\bemployee\s*(id|no\.?|number|#)\b/i,
        /\bassociate\s*(id|number)\b/i,
        /\bpersonnel\s*(id|number)\b/i,
        /\bworker\s*id\b/i,
      ],
      deny: [/\bapplicant\b|\bcandidate\b|\brequisition\b/i],
      identity: true,
      blank: true,
      type: ["text", "number"],
      value: () => null,
    },

    /* ---------------- Name ---------------- */
    {
      key: "firstName",
      identity: true,
      weight: 10,
      match: [/\b(first|given|fore)\s*name\b/i, /^fname$/i, /\bfirst_?name\b/i],
      deny: [THIRD_PARTY, /reference|emergency|supervisor|manager|contact\s*person|spouse|parent/i],
      type: ["text"],
      value: (p) => P(p).firstName,
    },
    {
      key: "lastName",
      identity: true,
      weight: 10,
      match: [/\b(last|family|sur)\s*name\b/i, /^lname$/i, /\blast_?name\b/i],
      // "Second Last Name" is a different family name, not this one repeated.
      deny: [THIRD_PARTY, /reference|emergency|supervisor|manager|contact\s*person|spouse|parent/i, /\bsecond\s*(last\s*name|surname)\b|\bapellido\s*materno\b|\bmother'?s\s*(last\s*name|surname)\b/i],
      type: ["text"],
      value: (p) => P(p).lastName,
    },
    {
      key: "middleName",
      identity: true,
      // Left empty, not flagged, when the applicant has none and the form does
      // not insist — see `optional` in the planner.
      optional: true,
      weight: 10,
      match: [/\bmiddle\s*(name|initial)\b/i, /^middle$/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      value: (p) => P(p).middleName,
    },
    {
      key: "preferredName",
      identity: true,
      weight: 12,
      match: [/\b(preferred|nick)\s*(?:first\s*)?name\b/i, /\bwhat.*(call|go by)\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      value: (p) => P(p).preferredName || P(p).firstName,
    },
    {
      /**
       * "I have a preferred or chosen name" as a box to tick (Workforce Now).
       * Ticked only for a preferred name the profile holds that is not simply
       * the first name; otherwise it is left clear, which is the answer.
       */
      key: "hasPreferredName",
      weight: 10,
      match: [
        /\b(have|use|go\s+by)\b[^?|]{0,30}\b(preferred|chosen)\s+(or\s+(preferred|chosen)\s+)?name\b/i,
        /\bpreferred\s+or\s+chosen\s+name\b/i,
      ],
      // Workforce Now's box; every other site is left as it was.
      deny: [THIRD_PARTY, () => !onAdpPage()],
      type: ["checkbox"],
      value: (p) => {
        const preferred = String(P(p).preferredName ?? "").trim();
        const first = String(P(p).firstName ?? "").trim();
        return preferred && preferred.toLowerCase() !== first.toLowerCase() ? "Yes" : "No";
      },
    },
    {
      key: "fullName",
      identity: true,
      weight: 6,
      match: [/\b(full|legal|your)\s*name\b/i, /^name$/i, /\bcandidate\s*name\b/i, /\bapplicant\s*name\b/i],
      deny: [THIRD_PARTY, /first|last|middle|company|school|university|employer|reference|file|user/i],
      type: ["text"],
      value: fullName,
    },
    {
      key: "applicantSignatureConsent",
      identity: true,
      profileOnly: true,
      weight: 18,
      match: [/^\s*signature\s+of\s+(?:the\s+)?applicant\s*[:*]?\s*(?:\||$)/i],
      deny: [() => !onIcimsPage()],
      type: ["checkbox"],
      value: () => "Yes",
    },
    {
      key: "addressType",
      weight: 12,
      match: [/^\s*address\s*type\s*(?:\||$)/i],
      type: ["select"],
      value: () => "Home",
      options: {Home: ["home", "residential", "permanent", "personal"]},
    },
    {
      key: "referrerFirstName",
      identity: true,
      profileOnly: true,
      weight: 18,
      match: [/\breferrer['’]?s?\s+first\s+name\b/i],
      type: ["text"],
      value: (p) => W(p).referrerFirstName || referralNamePart(p, 0),
    },
    {
      key: "referrerLastName",
      identity: true,
      profileOnly: true,
      weight: 18,
      match: [/\breferrer['’]?s?\s+last\s+name\b/i],
      type: ["text"],
      value: (p) => W(p).referrerLastName || referralNamePart(p, 1),
    },
    {
      key: "referrerEmployeeId",
      identity: true,
      profileOnly: true,
      weight: 20,
      match: [/\breferrer['’]?s?\s+employee\s*(?:id|number)\b/i],
      type: ["text"],
      value: (p) => W(p).referrerEmployeeId || null,
    },
    {
      key: "signature",
      identity: true,
      weight: 8,
      match: [/\b(e-?)?signature\b/i, /\btyp(?:e|ing)\s*your\s*(full\s*)?name\b/i, /\bsign\s*(here|below)\b/i],
      // "Signature Date" is a date, not a place to type a name.
      deny: [THIRD_PARTY, /\bdate\b/i],
      type: ["text"],
      value: (p) => E(p).disabilitySignatureName || (onIcimsPage()
        ? [P(p).firstName, P(p).middleName, P(p).lastName].filter(Boolean).join(" ") || null : fullName(p)),
    },
    {
      key: "pronouns",
      weight: 9,
      match: [/\bpronouns?\b/i],
      type: ["text", "select", "radio"],
      value: (p) => P(p).pronouns,
    },
    {
      key: "dateOfBirth",
      identity: true,
      weight: 11,
      match: [/\b(date\s*of\s*birth|birth\s*date|dob)\b/i],
      deny: [THIRD_PARTY, /graduat|start|end|employment/i],
      type: ["text", "date", "month"],
      value: (p, el) => dateForField(P(p).dateOfBirth, el),
    },
    {
      key: "nationality",
      identity: true,
      weight: 10,
      match: [/\b(nationality|citizenship|citizen(ship)?\s*status)\b/i],
      deny: [THIRD_PARTY, /work\s*authorization|sponsor|visa/i],
      type: ["text", "select"],
      value: (p) => P(p).nationality || P(p).citizenship,
    },

    /* ---------------- Contact ---------------- */
    {
      key: "email",
      identity: true,
      weight: 10,
      match: [/\be-?mail\b/i],
      deny: [THIRD_PARTY, /reference|emergency/i,
             denyOwn(/confirm|verify|re-?enter|alternate/i),
             denyOwn(/\bextension\b|\bext\.?\s*$|area\s*code|country\s*code/i)],
      type: ["text", "email"],
      value: (p) => P(p).email,
    },
    {
      key: "emailConfirm",
      identity: true,
      weight: 11,
      match: [/(confirm|verify|re-?enter|repeat).*e-?mail/i, /e-?mail.*(confirm|again)/i],
      deny: [THIRD_PARTY],
      type: ["text", "email"],
      value: (p) => P(p).email,
    },
    {
      key: "phoneCountryCode",
      identity: true,
      weight: 11,
      match: [/\b(?:country|international)\s*(?:(?:calling|dial(?:l?ing)?)\s*)?code\b/i, /\b(dial(?:l?ing)?|calling|isd)\s*code\b/i, /\bphone.*code\b/i],
      // Must be the code box itself, not the number box standing next to it.
      deny: [THIRD_PARTY, (label) => !/code/i.test(ownLabel(label))],
      type: ["text", "select", "tel"],
      value: (p) => phoneCodeForProfile(p),
    },
    {
      key: "phone",
      identity: true,
      weight: 9,
      /**
       * Legacy portals rarely use the word "phone".
       *
       * Taleo labels the box "Primary Number", Oracle "Contact Number",
       * SuccessFactors "Day Time Number"; iCIMS ships "Home Phone" and "Mobile
       * Phone" side by side. None but the last matched, so the applicant's
       * number was simply missing from the application on those systems.
       */
      match: [
        /\b(phone|mobile|cell|telephone|contact\s*number)\b/i,
        /\b(primary|day\s*time|daytime|evening|home|work|business|personal|main)\s*(tele)?(phone\s*)?(number|no\.?|#)\b/i,
        /\bnumber\s*\(\s*(primary|mobile|cell|home)\s*\)/i,
      ],
      // Judged on its own label: the neighbouring "Country Phone Code" and
      // "Phone Device Type" boxes must not disqualify the number box.
      deny: [THIRD_PARTY, /emergency|reference/i,
             denyOwn(/country|area\s*code|extension|\bdevice\b|\btype\b|text\s*messag|\bsms\b/i)],
      type: ["text", "tel"],
      value: (p, el) => phoneForBox(P(p).phone || P(p).phoneNumber || P(p).mobile, el, phoneCodeForProfile(p) || P(p).phoneCountryCode),
    },
    {
      // Claims the field so nothing else can. "Phone Extension" matched no rule
      // before, which left it open to whatever came next — a saved answer or a
      // drafted one — and it was being filled with the email address. It is
      // answered from the profile when there is an extension to give, and left
      // alone otherwise.
      key: "phoneExtension",
      weight: 12,
      match: [/\b(phone|telephone|mobile)?\s*extension\b/i, /\bext\.?\s*(number|no)?\s*$/i],
      deny: [THIRD_PARTY, (label) => !/ext/i.test(ownLabel(label))],
      type: ["text", "tel", "number"],
      /**
       * Most people do not have one, and a wrong extension is worse than none —
       * it is a number an employer will dial. Marked profile-only so a null
       * stays a blank box instead of falling through to a saved answer from
       * another form or to a drafted one.
       */
      profileOnly: true,
      identity: true,
      value: (p) => P(p).phoneExtension || P(p).phoneExt || null,
    },
    {
      key: "phoneType",
      weight: 10,
      match: [/\bphone\s*(type|device)\b/i],
      deny: [THIRD_PARTY],
      type: ["select", "radio", "text"],
      value: (p) => P(p).phoneType || "Mobile",
      options: {
        Mobile: ["mobile", "mobile phone", "cell", "cell phone", "cellular"],
        Home: ["home", "home phone", "residential"],
        Work: ["work", "work phone", "business", "office"],
        Other: ["other", "personal"],
      },
    },

    /* ---------------- Address ---------------- */
    /**
     * Boxes an applicant leaves empty, claimed explicitly so nothing else fills
     * them.
     *
     * Oracle Recruiting's contact section has Title, Suffix, Second Last Name,
     * Address Line 3, Address Line 4 and Tax District. None has a profile value,
     * so all six were unmatched — and an unmatched labelled field went to the
     * answer model, which wrote "My address is in Bellevue, Washington, United
     * States." into Suffix and the full formatted address into Tax District.
     *
     * `blank: true` stops the planner before saved answers and before the model,
     * so these stay empty unless the applicant types in them.
     */
    {
      key: "addressLineExtra",
      weight: 12,
      match: [/\b(address\s*)?line\s*([3-9]|\d{2,})\b/i, /\baddress\s*([3-9]|\d{2,})\b/i],
      deny: [THIRD_PARTY],
      blank: true,
      type: ["text"],
      value: () => null,
    },
    {
      key: "taxDistrict",
      weight: 12,
      match: [/\b(tax|school|voting|sales)\s*district\b/i, /\btax\s*(locality|jurisdiction|area)\b/i],
      deny: [THIRD_PARTY],
      blank: true,
      // A drop-down that, for the address given, offers a single district.
      onlyChoice: true,
      type: ["text", "select"],
      value: () => null,
    },
    {
      key: "nameSuffix",
      weight: 12,
      // Jr./Sr./III — a profile value if there is one, never anything else.
      match: [/^suffix$/i, /\bname\s*suffix\b/i, /\bsuffix\s*(name)?\b/i],
      deny: [THIRD_PARTY, /file|address|district|email/i],
      identity: true,
      optional: true,
      type: ["text", "select"],
      value: (p) => P(p).nameSuffix || null,
    },
    {
      key: "namePrefix",
      weight: 12,
      optional: true,
      /**
       * Mr./Ms./Dr. — the profile's own title, or the one that goes with the
       * gender the applicant gave: Mr. for a man, Ms. for a woman, Mx. for
       * non-binary. With neither, it is left alone rather than guessed.
       */
      match: [/^title$/i, /\bname\s*(title|prefix)\b/i, /^(prefix|salutation|honorific)$/i],
      // A bare "Title" box inside an employment block is a job title, never
      // Mr./Ms. iCIMS labels it exactly "Title" and puts "Professional
      // Experience (1)" in the heading, and matching the field's own label
      // outscores currentTitle matching the two together — so the applicant's
      // job title was dropped and an honorific was offered instead.
      deny: [THIRD_PARTY, /job|position|role|current|desired|work|employment|experience|employer|company|organi[sz]ation|degree|study/i],
      identity: true,
      type: ["text", "select", "radio"],
      value: (p, _el, label) => {
        if (P(p).namePrefix) return P(p).namePrefix;
        // The title that goes with the applicant's gender: on Oracle's pages
        // only, and never for a box that names a licence, certificate,
        // course, publication or the like ("Licenses and Certifications |
        // Title").
        if (!onOracleCx()) return null;
        if (/\b(certifi\w*|licen[cs]\w*|education|degree|school|universit\w*|course\w*|training|publication\w*|patents?|awards?|projects?|accomplishments?)\b/i.test(String(label ?? ""))) return null;
        return titleForGender(p);
      },
      options: { "Mr.": ["mr", "mr."], "Ms.": ["ms", "ms."], "Mx.": ["mx", "mx."] },
    },
    {
      key: "secondLastName",
      weight: 12,
      /**
       * The Spanish/Portuguese second surname. It is not the applicant's last
       * name repeated — copying `lastName` here, which is what the generic
       * last-name rule did, states a family name they do not have.
       */
      match: [/\bsecond\s*(last\s*name|surname|apellido)\b/i, /\bapellido\s*materno\b/i, /\bmother'?s\s*(last\s*name|surname)\b/i],
      deny: [THIRD_PARTY],
      identity: true,
      blank: true,
      type: ["text"],
      value: (p) => P(p).secondLastName || null,
    },
    {
      key: "addressLine2",
      weight: 11,
      optional: true,
      match: [/\b(address\s*(line\s*)?2|apt|apartment|suite|unit)\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      // Résumé parsing sometimes copies the street into both lines. Repeating
      // it is never what the applicant meant, so line 2 gives way when it only
      // echoes line 1.
      value: (p) => {
        const line2 = P(p).addressLine2;
        if (!line2) return null;
        const norm = (x) => String(x ?? "").trim().toLowerCase().replace(/[.,]/g, "");
        if (norm(line2) === norm(P(p).address)) return null;

        /**
         * Line 2 is an apartment or suite, never the rest of the postal
         * address. A badly parsed profile stored "City, Jacksonville, Florida,
         * 32216" here and it was written out verbatim, repeating the city,
         * state and postcode that the form has its own boxes for.
         */
        const kept = String(line2)
          .split(/\s*,\s*/)
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((part) => !PLACEHOLDER_PART.test(part))
          .filter((part) => {
            const t = part.toLowerCase();
            if (t === norm(P(p).city) || t === norm(P(p).state) || t === norm(P(p).zip)) return false;
            if (/^\d{5}(-\d{4})?$/.test(t)) return false;
            return true;
          });
        return kept.join(", ") || null;
      },
    },
    {
      key: "address",
      weight: 8,
      /**
       * Line 1 only.
       *
       * `address\s*(line\s*)?1?` made the digit optional, so "address line"
       * matched whatever number followed it. Only line 2 was denied, which left
       * "Address Line 3" and "Address Line 4" collecting the street as well —
       * Oracle Recruiting shows all four, so the street landed in three boxes.
       * The number is now matched explicitly and anything above 1 is refused.
       */
      match: [
        /\bstreet\b/i,
        /\baddress\s*(line\s*)?1\b/i,
        /^address$/i,
        /\bmailing\s*address\b/i,
        /\bhome\s*address\b/i,
        /\bresidential\s*address\b/i,
      ],
      deny: [
        THIRD_PARTY,
        /e-?mail|city|state|zip|postal|country|apt|suite/i,
        // Any address line other than the first, however it is numbered.
        /\b(address\s*)?line\s*([2-9]|\d{2,})\b/i,
        /\baddress\s*([2-9]|\d{2,})\b/i,
        /\b(tax|school|voting|sales)\s*district\b/i,
      ],
      type: ["text"],
      /**
       * A list box this rule answers too: Oracle Recruiting's refreshed
       * Address Line 1, an `<input role="combobox">` that suggests whole
       * addresses as you type. As a "list" it matched no rule, so it was never
       * typed into and was left empty and required. Only that box, and only on
       * Oracle's Candidate Experience; a list anywhere else is not the street.
       */
      listBox: (el) => el?.tagName === "INPUT" && !el.readOnly && (
        (onOracleCx() && Boolean(M.looksLikeTypeahead?.(el) || M.isOracleSelect?.(el))) ||
        // A Google Places street box (Workforce Now's Address Line 1). Newer
        // Maps builds mark it a combobox; it is still the street, typed and,
        // where Google offers the applicant's own address, picked.
        (onAdpPage() && Boolean(M.isPlacesBox?.(el)))),
      // Only the street when the form has its own City/State/Zip boxes, which
      // is nearly always; a single free-text address box still gets the lot.
      value: (p, el) => {
        if (el?.tagName === "SELECT" || (el?.getAttribute?.("role") === "combobox" &&
            !(el.tagName === "INPUT" && !el.readOnly && (M.looksLikeTypeahead?.(el) || M.isOracleSelect?.(el))))) return null;
        const form = el?.closest?.("form") || document;
        // Attributes first — but a portal that ids its inputs with GUIDs has
        // none of these, and its Postal Code box was therefore invisible here.
        // The whole flattened address then went into Address Line 1, on exactly
        // the forms that already had a box for each part.
        let hasParts = Boolean(
          form.querySelector?.('[name*="zip" i], [name*="postal" i], [id*="zip" i], [id*="postal" i], [aria-label*="zip" i], [aria-label*="postal" i], [data-automation-id*="postal" i], [data-automation-id*="zip" i], [placeholder*="zip" i], [placeholder*="postal" i]')
        );
        if (!hasParts) {
          // Then what the applicant can actually read on the page.
          try {
            hasParts = Array.from(form.querySelectorAll("label, legend") || [])
              .some((node) => /\b(zip|postal|post\s*code|postcode)\b/i.test(node.textContent || ""));
          } catch {}
        }
        // The apartment/suite belongs in Line 1 only when the form has nowhere
        // else to put it. Otherwise `addressLine2` fills its own box and
        // repeating it here duplicates the apartment on the application.
        const includeLine2 = !hasAddressLine2Box(el);
        return hasParts ? streetOnly(p, { includeLine2 }) : includeLine2 ? fullAddress(p) : P(p).address || null;
      },
    },
    {
      key: "city",
      weight: 10,
      match: [/\bcity\b/i, /\btown\b/i, /\blocality\b/i],
      deny: [THIRD_PARTY, /school|university|employer|company|birth/i],
      type: ["text", "select"],
      value: (p) => P(p).city,
    },
    {
      key: "state",
      weight: 10,
      /**
       * "County" is not a state. It was in this rule's match list, so a form
       * with both boxes — Workday's US address block has them — put "Florida"
       * into County as well, and Workday rejected it.
       */
      match: [/\b(state|province|region|territory)\b/i, /countryregion/i],
      /**
       * "Country/Region" is a country box, not a state box.
       *
       * It is the standard label on SAP SuccessFactors, Oracle HCM and several
       * Workday tenants, and `region` claimed it — so the applicant's state was
       * offered to a menu of countries, matched nothing, and the country was
       * left blank on every one of those portals. The same applies to
       * "Country or Region" and "Region/Country". Judged on the printed label
       * only: see `labelsCountryRegion`.
       */
      deny: [THIRD_PARTY, /united\s*states\b.*country|veteran|marital|employment\s*status/i,
             denyOwn(/\bcounty\b/i),
             labelsCountryRegion,
             denyOwn(STATE_NOT_ADDRESS_RE)],
      type: ["text", "select"],
      /**
       * The profile's state, as the box wants it.
       *
       * Menus are matched on the state itself (see `regionId` in the matcher),
       * so "NC" and "North Carolina" both select North Carolina. A free-text
       * box capped at two or three characters wants the postal code.
       */
      value: (p, el) => {
        const raw = P(p).state;
        if (!raw) return null;
        try {
          const isMenu = el && (el.tagName === "SELECT" || M.fieldKind?.(el) === "select");
          const cap = Number(el?.getAttribute?.("maxlength") ?? 0);
          if (!isMenu && cap > 0 && cap <= 3) return M.regionCode?.(raw) || raw;
        } catch {}
        return raw;
      },
    },
    {
      /**
       * The administrative county. Only a handful of portals ask, nobody has it
       * in a résumé, and guessing it from the state produces a value the portal
       * rejects — so it comes from the profile or stays empty.
       */
      key: "county",
      weight: 11,
      match: [/\bcounty\b/i],
      deny: [THIRD_PARTY, /country/i],
      profileOnly: true,
      // Once ZIP Code, City and State are in, Oracle's County list offers the
      // one county that fits them — taken when it is the only choice.
      onlyChoice: true,
      type: ["text", "select"],
      value: (p) => P(p).county || null,
    },
    {
      key: "zip",
      weight: 10,
      match: [/\b(zip|postal)\s*code\b/i, /^zip$/i, /\bpostcode\b/i],
      deny: [THIRD_PARTY],
      // Oracle's ZIP Code is a list of values searched as you type.
      type: ["text", "select"],
      value: (p) => P(p).zip,
    },
    {
      key: "country",
      weight: 9,
      match: [/\bcountry\b/i],
      // A box printed "State" is never the country box, whatever its machine
      // name says — Workday's State menu is named `countryRegion`.
      deny: [THIRD_PARTY, /code|citizenship|origin/i, labelsStateBox],
      type: ["text", "select"],
      value: (p) => P(p).country,
    },
    {
      key: "location",
      weight: 6,
      match: [/\b(location|where are you (based|located))\b/i, /\bcurrent\s*location\b/i],
      /**
       * Only the box's own label can make it a job's or an office's location.
       *
       * The denial ran over everything around the box, and Ashby prints the
       * question's description with it: "…working four days a week from our
       * Flatiron office. A current NYC location or willingness to relocate is
       * required". "office" denied the applicant's own Location question, so it
       * was never filled.
       */
      deny: [denyOwn(THIRD_PARTY), denyOwn(/\b(job|role|position|office|offices|preferred\s*work|work\s*location\s*preference)\b/i)],
      // A search box drawn as a combobox (Ashby) as well as a plain text box.
      type: ["text", "select"],
      value: (p) => [P(p).city, P(p).state, P(p).country].filter(Boolean).join(", ") || null,
    },

    /* ---------------- Links ---------------- */
    {
      key: "linkedin",
      weight: 11,
      // "linked in" too: Workday's box is `name="linkedInAccount"`, which
      // reads "linked in account" once its machine name is split into words.
      match: [/\blinked-?in\b/i, /\blinked\s+in\s+(account|url|profile)\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "linkedin"),
    },
    {
      /**
       * Workday's "Social Network URLs" asks for Facebook beside LinkedIn and
       * Twitter. Filled only from a Facebook address on the profile.
       */
      key: "facebook",
      weight: 11,
      // Most applicants have none to give; an empty optional box is not outlined.
      optional: true,
      match: [/\bfacebook\b/i],
      // "How did you hear about us? — Facebook" is a source, not a link.
      deny: [/\bhow\s+did\s+you\s+(hear|find|learn)\b|\bsource\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "facebook"),
    },
    {
      key: "github",
      weight: 11,
      match: [/\bgit-?hub\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "github"),
    },
    {
      key: "portfolio",
      weight: 9,
      match: [/\b(portfolio|personal\s*(web)?site|website|your\s*url)\b/i],
      deny: [/company|employer|linkedin|github/i],
      type: ["text", "url"],
      value: (p) => site(p, "portfolio", "personal", "website") || site(p, "github"),
    },
    {
      key: "twitter",
      weight: 11,
      match: [/\b(twitter|x\.com)\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "twitter", "x"),
    },

    /* ---------------- Work history ---------------- */
    {
      key: "currentCompany",
      weight: 14,
      match: [
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(company|employer|organization)\b/i,
        /\b(current|present|most recent|latest)\s*(employer|company|organization)\b/i,
        /^company$/i,
        /\bemployer\b/i,
      ],
      /**
       * A question that only mentions an employer is not the employer's name.
       *
       * "Do you have any additional jobs in the financial services, banking or
       * credit union industry? If yes, … please list employer and type of work.
       * If no, enter NA." (a bank's conflict-of-interest question on ADP) took
       * the applicant's current employer — or, as a history row with no job
       * behind it, was left blank and closed to the answer the applicant had
       * saved for it. "May we contact your current employer?" is the same.
       */
      deny: [
        /previous|former|why|reason|reference/i,
        denyOwn(/\b(conflicts?\s+of\s+interest|additional\s+(jobs?|employment|employers?|positions?|work)|outside\s+(employment|jobs?|work|business|activit\w*|interests?)|other\s+(jobs?|employment|employers?)|second(ary)?\s+(jobs?|employment)|moonlight\w*|side\s+(jobs?|business|work)|if\s+(yes|no|so|not|none)\b|enter\s+n\/?a|type\s+of\s+work|may\s+we\s+contact|contact\s+your|notif\w*\s+your|relatives?|family)\b/i),
      ],
      type: ["text"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestJob(p, index).company,
    },
    {
      key: "currentTitle",
      weight: 14,
      match: [
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(job\s*)?title\b/i,
        // The same pairing in the other order: iCIMS labels the box "Title" and
        // puts "Professional Experience (1)" in the section heading, so the
        // section word lands *after* the field word in the derived label.
        /\b(job\s*)?title\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b/i,
        /\b(current|present|most recent|latest)\s*(job\s*)?title\b/i,
        /\byour\s*(job\s*)?title\b/i,
        /^job\s*title$/i,
        /\bposition\s*title\b/i,
        /\bjob\s*title\b/i,
      ],
      deny: [/desired|applying|role you|reference|degree|education|school|university/i],
      type: ["text"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestJob(p, index).title,
    },
    {
      key: "employmentType",
      weight: 12,
      match: [/\bemployment\s*(type|status)\b/i, /\bjob\s*(type|status)\b/i, /\bwork\s*(type|status)\b/i],
      deny: [/current|previous|eligibility|authorized/i],
      type: ["text", "select", "radio"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestJob(p, index).employmentType,
    },
    {
      key: "experienceLocation",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\blocation\b/i,
        /\blocation\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      type: ["text", "select"],
      /**
       * The location of a specific past job, or nothing.
       *
       * When a work-experience entry had no location in the profile this
       * returned null and the field fell through to the answer model, which
       * wrote "I am located in Jacksonville, Florida. I have 10 year" into the
       * Location box of a 2016 role at Quadrant Technologies. That is not the
       * applicant's answer and it is not even about the right thing — the model
       * was asked "Location" and answered about where they live now.
       *
       * `profileOnly` stops the fall-through: this box is either the location
       * recorded for that job or it is empty.
       */
      profileOnly: true,
      /**
       * The location recorded for that job — or, when the profile has none for
       * it, a single dot.
       *
       * The applicant cannot always say where a job from years ago was based,
       * and a Workday row with an empty Location is one more box to go back
       * to. A dot is a deliberate placeholder: it satisfies the field, it is
       * obviously not a real place, and it is trivial to spot and replace.
       *
       * It used to be written only where the box was *required* — and the
       * required check never ran in the extension (the matcher it relied on
       * loads after this file), so the dot was never written at all. It is now
       * written for every job the profile actually has; a row the profile has
       * no job for is still left alone.
       */
      value: (p, _el, _label, index) => {
        const job = jobAt(p, index);
        if (!job) return null;
        if (String(job.location ?? "").trim()) return job.location;
        return (String(job.company ?? "").trim() || String(job.title ?? "").trim()) ? "." : null;
      },
    },
    {
      key: "experienceLocationType",
      weight: 12,
      match: [
        /\b(work|job|employment|experience)\b.*\b(location|workplace)\s*(type|mode|arrangement)\b/i,
        /\b(remote|hybrid|on[- ]site)\b.*\b(work|employment|location)\b/i,
      ],
      type: ["text", "select", "radio"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestJob(p, index).locationType,
      options: {
        "On-site": ["on-site", "onsite", "office"],
        Remote: ["remote", "work from home", "wfh"],
        Hybrid: ["hybrid"],
      },
    },
    {
      key: "responsibilities",
      weight: 9,
      match: [
        /\b(responsibilit(?:y|ies)|what\s+you\s+did|duties|job\s+duties|accomplishments)\b/i,
        // A "Description" box inside a work-experience block is the role
        // summary. Anchored to the section so it can never swallow the job
        // posting's own description field.
        /\b(description|summary\s*of\s*(work|duties))\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b/i,
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(description|summary\s*of\s*(work|duties))\b/i,
      ],
      deny: [/reference|emergency|job\s*post|posting\s*description|cover\s*letter/i],
      type: ["text", "textarea"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestJob(p, index).description,
    },
    {
      key: "experienceStartDate",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\bstart\b/i,
        /\bstart\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      // "Available Start Date" is the applicant's availability, never a job's.
      deny: [asksAvailability],
      type: ["text", "date", "month"],
      profileOnly: true,
      value: (p, el, _label, index) => dateForField(latestJob(p, index).startDate, el),
    },
    {
      key: "experienceEndDate",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\bend\b/i,
        /\bend\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      deny: [asksAvailability],
      type: ["text", "date", "month"],
      profileOnly: true,
      value: (p, el, _label, index) => dateForField(latestJob(p, index).endDate, el),
    },
    /* Split Month / Day / Year controls inside a work-experience block.
       Highest weight in the family so a bare "Year" box can never fall through
       to the whole-date rule and receive "2025-04". */
    {
      key: "experienceDatePart",
      weight: 16,
      match: [
        /\b(month|year|day|mm|dd|yy(?:yy)?)\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b/i,
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b.*\b(month|year|day|mm|dd|yy(?:yy)?)\b/i,
      ],
      deny: [/education|school|college|university|degree|graduat|birth|dob|gpa/i, asksAvailability],
      type: ["select", "text", "number", "month", "date"],
      profileOnly: true,
      value: (p, el, label, index) => {
        const job = jobAt(p, index);
        if (!job) return null;
        const { part, which } = dateSlot(label, el);
        const raw = which === "end" ? job.endDate : job.startDate;
        // Blank only for the row that actually says "I currently work here",
        // and for a row whose end date the profile simply does not hold. Asking
        // `job.current` here disagreed with the checkbox as soon as a profile
        // flagged two roles current: the box was ticked on one row while the To
        // date was dropped from all of them, so a job with a perfectly good end
        // date on record reached the employer with the field empty.
        if (which === "end" && (isCurrentJobRow(p, index) || !job.endDate)) return null;
        if (!raw) return null;
        if (!part) return dateForField(raw, el);
        return valueForSlot(raw, part, el);
      },
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceStartMonth",
      weight: 13,
      match: [/\bstart\s*date\s*month\b/i, /\bstart\s*month\b/i],
      deny: [/education|school|college|university/i, asksAvailability],
      type: ["select", "text"],
      profileOnly: true,
      value: (p, _el, _label, index) => dateMonth(latestJob(p, index).startDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceStartYear",
      weight: 13,
      match: [/\bstart\s*date\s*year\b/i, /\bstart\s*year\b/i],
      deny: [/education|school|college|university/i, asksAvailability],
      type: ["select", "text"],
      profileOnly: true,
      value: (p, _el, _label, index) => dateYear(latestJob(p, index).startDate),
    },
    {
      key: "experienceEndMonth",
      weight: 13,
      match: [/\bend\s*date\s*month\b/i, /\bend\s*month\b/i],
      deny: [/education|school|college|university/i, asksAvailability],
      type: ["select", "text"],
      profileOnly: true,
      value: (p, _el, _label, index) => dateMonth(latestJob(p, index).endDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceEndYear",
      weight: 13,
      match: [/\bend\s*date\s*year\b/i, /\bend\s*year\b/i],
      deny: [/education|school|college|university/i, asksAvailability],
      type: ["select", "text"],
      profileOnly: true,
      value: (p, _el, _label, index) => dateYear(latestJob(p, index).endDate),
    },
    {
      key: "currentJob",
      weight: 12,
      match: [/\bcurrently\s*(work|employed)\b/i, /\bcurrent\s*(job|role|position)\b/i, /\bthis\s*is\s*my\s*current\s*(job|role)\b/i],
      /**
       * The "I currently work here" box on a history row — never a question.
       *
       * "Do you have any relatives currently employed by Leidos?" and "Are you
       * currently employed?" both matched, and both were answered from whichever
       * history row the question happened to be numbered against: the relatives
       * question came back "Yes". A row's checkbox speaks in the first person;
       * anything addressed to "you", or about somebody else, is a question for
       * another rule.
       */
      deny: [
        THIRD_PARTY,
        /\b(relatives?|family|friends?|spouses?|anyone|someone|any\s+one|people|persons?|members?)\b/i,
        denyOwn(/\b(are|do|have|were|is|will)\s+you\b/i),
        denyOwn(/\b(employed|work(ing)?|employee)\s+(by|for|at|with)\s+(?!this\b|that\b)/i),
      ],
      type: ["checkbox", "radio", "select"],
      profileOnly: true,
      value: (p, _el, _label, index) => (isCurrentJobRow(p, index) ? "Yes" : "No"),
      options: { Yes: ["yes", "currently", "current", "true"], No: ["no", "not current", "false"] },
    },
    {
      /**
       * "Are you currently employed?" — from the work history, not a row.
       *
       * It used to be claimed by the row checkbox rule above and answered from
       * whichever job the question was numbered against, so an applicant with a
       * current job was told they had none.
       */
      key: "currentlyEmployed",
      weight: 12,
      match: [
        /\bare\s+you\s+(currently|presently|now)\s+(employed|working)\b/i,
        /^\s*(currently|presently)\s+employed\s*\??\s*$/i,
        /\bdo\s+you\s+(currently|presently)\s+(have\s+a\s+job|work)\b/i,
      ],
      deny: [
        THIRD_PARTY,
        /\b(relatives?|family|friends?|spouses?|anyone|someone|references?)\b/i,
        // A named employer or a sector is a different question.
        /\b(employed|working|work)\s+(by|for|at|with|in|on)\s+/i,
        /\b(government|federal|military|agency|public\s+sector|competitor)\b/i,
      ],
      type: ["select", "radio"],
      value: (p) => {
        const list = p?.experience ?? [];
        if (!list.some((j) => String(j?.company ?? j?.title ?? "").trim())) return null;
        return currentJobIndex(p) >= 0 ? "Yes" : "No";
      },
      options: { Yes: ["yes", "employed", "currently employed"], No: ["no", "unemployed", "not employed", "not currently employed"] },
    },
    {
      key: "yearsExperience",
      weight: 9,
      // "How many years have you lived at this address?" is not experience.
      match: [/\byears?\s*(of\s*)?(relevant\s*|professional\s*|work\s*)?experience\b/i, /\bhow many years\b[^?|]{0,60}\bexperience\b/i, /\bexperience\s*\(years\)/i],
      type: ["text", "number", "select", "radio"],
      // The whole career for the plain question; only the roles that name the
      // topic for "years of DevOps experience" — see `experienceYears`.
      value: (p, _el, label) => experienceYears(p, label),
    },

    /* ---------------- Education ---------------- */
    ...["education", "experience"].flatMap((family) => ["country", "state", "city"].map((part) => ({
      key: `${family}${part[0].toUpperCase()}${part.slice(1)}`,
      weight: 16,
      match: [part === "country" ? /^\s*country(?:\s*\/\s*region)?\s*\*?\s*$/i : part === "state" ? /^\s*(state|province)(?:\s*\/\s*(province|state))?\s*\*?\s*$/i : /^\s*city\s*\*?\s*$/i],
      require: family === "education" ? /\b(education|school|academic)\b/i : /\b(experience|employment|work\s*history|job\s*history)\b/i,
      type: ["text", "select"],
      profileOnly: true,
      value: (p, el, _label, index) => historyPlace(family === "education" ? schoolAt(p, index) : jobAt(p, index), part, el),
    }))),
    {
      key: "school",
      weight: 10,
      match: [/\b(school|university|college|institution)\b/i],
      deny: [/high\s*school\s*only|graduated\b.*\?/i],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestSchool(p, index).school,
    },
    {
      /**
       * "What is the highest level of education you have completed?"
       *
       * Claimed by the degree rule, which is a history row: it offered the
       * first school's degree name — "Master of Science" — to a menu of levels
       * ("Master's Degree") and matched nothing, so the question was left
       * blank. The level is read across every school on the profile.
       */
      key: "highestEducation",
      weight: 12,
      match: [
        /\bhighest\s+(level\s+of\s+)?(education|degree|qualification|academic|schooling)/i,
        /\b(education|educational)\s+level\b/i,
        /\blevel\s+of\s+(education|schooling|study)\b/i,
        /^\s*education\s*\*?\s*$/i,
      ],
      deny: [/\b(field|major|subject|date|gpa|grade|institution|school\s+name|university\s+name|expected)\b/i],
      type: ["select", "radio", "text"],
      value: (p, _el, label) => highestEducation(p, label),
      options: {
        Doctorate: ["doctorate", "doctoral degree", "doctoral", "phd", "ph.d.", "doctor", "professional degree", "postdoctoral"],
        "Master's Degree": ["master's degree", "master's", "masters degree", "masters", "master", "graduate degree", "graduate", "post graduate", "postgraduate", "mba", "ms", "msc", "ma"],
        "Bachelor's Degree": ["bachelor's degree", "bachelor's", "bachelors degree", "bachelors", "bachelor", "undergraduate degree", "4-year degree", "four-year degree", "4 year degree", "college degree", "university degree", "undergraduate", "bs", "ba"],
        "Associate's Degree": ["associate's degree", "associate degree", "associates degree", "associate's", "associates", "associate", "2-year degree", "two-year degree", "2 year degree"],
        "High School Diploma": ["high school diploma", "high school", "ged", "high school or equivalent", "secondary school", "secondary"],
      },
    },
    {
      key: "educationType",
      weight: 13,
      match: [/^\s*education\s*type\s*\*?\s*$/i],
      type: ["text", "select", "radio"],
      profileOnly: true,
      value: (p, _el, _label, index) => degreeLevel(latestSchool(p, index).degree)?.label || latestSchool(p, index).degree,
      options: DEGREE_OPTIONS,
    },
    {
      key: "degree",
      weight: 10,
      match: [/\bdegree\b/i, /\beducation\s*level\b/i, /\bhighest\s*(level\s*of\s*)?education\b/i],
      deny: [/field|major|subject|date/i],
      type: ["text", "select", "radio"],
      value: (p, _el, _label, index) => latestSchool(p, index).degree,
      options: DEGREE_OPTIONS,
    },
    {
      key: "fieldOfStudy",
      weight: 11,
      match: [/\b(field\s*of\s*study|major|discipline|concentration|area\s*of\s*study)\b/i],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestSchool(p, index).fieldOfStudy,
    },
    {
      key: "educationLocation",
      weight: 8,
      match: [/\b(school|college|university|education)\b.*\blocation\b/i, /\blocation\b.*\b(school|college|university)\b/i],
      type: ["text", "select"],
      profileOnly: true,
      value: (p, _el, _label, index) => latestSchool(p, index).location,
    },
    {
      key: "gpa",
      weight: 11,
      match: [/\b(?:c?gpa)\b/i, /\bgrade\s*point\b/i, /\bfinal\s*score\b/i],
      type: ["text", "number"],
      value: (p, _el, _label, index) => latestSchool(p, index).gpa,
    },
    {
      key: "graduationDate",
      weight: 9,
      match: [/\bdate\s*(?:acquired|awarded|conferred|earned)\b/i, /\b(graduation|grad)\s*(date|year|month)\b/i, /\b(expected|anticipated)\s*graduation\b/i, /\byear\s*of\s*passing\b/i],
      deny: [(label) => /\bdate\s*(?:acquired|awarded|conferred|earned)\b/i.test(label) && !/\b(?:education|school|college|university|degree|academic)\b/i.test(label)],
      type: ["text", "date", "month", "select"],
      value: (p, el, _label, index) => dateForField(latestSchool(p, index).endDate, el),
    },
    ...["Start", "End"].map((which) => ({
      key: `education${which}Date`,
      weight: 13,
      match: [new RegExp(`\\b${which.toLowerCase()}\\s*date\\b`, "i")],
      require: /\b(education|school|college|university|academic)\b/i,
      deny: [asksAvailability],
      type: ["text", "date", "month"],
      profileOnly: true,
      value: (p, el, _label, index) => dateForField(latestSchool(p, index)[`${which.toLowerCase()}Date`], el),
    })),
    /* Split Month / Day / Year controls inside an education block. */
    {
      key: "educationDatePart",
      weight: 16,
      match: [
        /\b(month|year|day|mm|dd|yy(?:yy)?)\b.*\b(education|school|college|university|degree|academic)\b/i,
        /\b(education|school|college|university|degree|academic)\b.*\b(month|year|day|mm|dd|yy(?:yy)?)\b/i,
      ],
      deny: [/work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|birth|dob/i, asksAvailability],
      type: ["select", "text", "number", "month", "date"],
      value: (p, el, label, index) => {
        const school = schoolAt(p, index);
        if (!school) return null;
        const { part, which } = dateSlot(label, el);
        const raw = which === "start" ? school.startDate : school.endDate;
        if (!raw) return null;
        if (!part) return dateForField(raw, el);
        return valueForSlot(raw, part, el);
      },
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationStartMonth",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\b(start|begin)\w*\s*date\s*month\b/i,
        /\b(start|begin)\w*\s*date\s*month\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestSchool(p, index).startDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationStartYear",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\b(start|begin)\w*\s*date\s*year\b/i,
        /\b(start|begin)\w*\s*date\s*year\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestSchool(p, index).startDate),
    },
    {
      key: "educationEndMonth",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\bend\s*date\s*month\b/i,
        /\bend\s*date\s*month\b.*\b(education|school|college|university)\b/i,
        /\bend\s*\(?(or\s+expected)?\)?\s*date\s*month\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestSchool(p, index).endDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationEndYear",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\bend\s*date\s*year\b/i,
        /\bend\s*date\s*year\b.*\b(education|school|college|university)\b/i,
        /\bend\s*\(?(or\s+expected)?\)?\s*date\s*year\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestSchool(p, index).endDate),
    },

    /* ---------------- Work eligibility ---------------- */
    {
      /**
       * Answered only from the profile.
       *
       * These used to fall back to "Yes" — authorised to work, over 18, willing
       * to relocate, willing to take a drug test and a background check — and
       * "No" for prior employment. An application is a document the applicant
       * signs, and those are claims about their legal status and their consent.
       * Filling them from nothing puts words in their mouth on a form an
       * employer will hold them to, so a profile that has not answered leaves
       * the field blank and visibly needing them.
       */
      key: "authorizedToWork",
      weight: 12,
      match: [
        /\b(legally\s*)?(authoriz|eligib)\w*\s*to\s*work\b/i,
        /\bwork\s*authoriz\w*\b/i,
        /\blegally\s*(entitled|permitted)\s*to\s*work\b/i,
        /\bright\s*to\s*work\b/i,
      ],
      deny: [/sponsor/i],
      type: ["select", "radio", "text"],
      /**
       * Profile or nothing.
       *
       * A wrong answer here is disqualifying: "No" to work authorisation, or
       * "Yes" to needing sponsorship when the applicant does not, takes them out
       * of the running before a human reads anything. Yet a null from this rule
       * used to fall through to saved answers and then to the model — so one
       * "No" banked on one portal was replayed as a negative answer across every
       * application after it, which is the behaviour reported.
       *
       * There is no safe guess available here, and the model is the wrong tool
       * for a legal declaration: it can only infer, and an inferred immigration
       * status stated to an employer is a liability. Unanswered means the field
       * is left empty and highlighted for the applicant.
       */
      profileOnly: true,
      value: (p, el, label) => {
        const answer = authorizedFor(p);
        return /\b(?:not|never)\s+(?:(?:legally|currently)\s+)?(?:authori[sz]ed|eligible|entitled|permitted)\b|\bunauthori[sz]ed\b/i.test(label || "")
          ? inverseBinary(answer) : answer;
      },
      options: { Yes: ["yes", "i am", "authorized", "true"], No: ["no", "not authorized", "false"] },
    },
    {
      key: "requireSponsorship",
      weight: 13,
      match: [
        /\b(require|need|seek)\w*\s*(visa\s*)?sponsor/i,
        /\bsponsorship\b.*\b(now|future|require|need)\b/i,
        /\bwill\s*you\s*.*sponsorship\b/i,
        /\bimmigration\s*sponsorship\b/i,
        /\bwithout\b[^?|]{0,50}\bsponsor/i,
        /**
         * "Will you now or in the future require the company to sponsor an
         * immigration case in order to employ you?" — Workday's own wording,
         * with the verb separated from "sponsor". None of the patterns above
         * reached it, so the most consequential question on the page was left
         * for the model.
         */
        /\b(require|need|seek)\w*\b[^?|]{0,50}\bto\s+sponsor\b/i,
        /\bsponsor\w*\b[^?|]{0,60}\b(immigration|visa|h-?1b|work\s*(permit|authori[sz]ation)|employment\s*(visa|authori[sz]ation|based)|green\s*card)\b/i,
        /\b(immigration|visa|h-?1b|work\s*permit)\b[^?|]{0,60}\bsponsor/i,
      ],
      deny: [/\bsponsor(ing|ed)?\s+(an?\s+)?(event|conference|charity|team|club)\b/i],
      type: ["select", "radio", "text"],
      /**
       * Half of these questions are asked the other way round.
       *
       * "Will you require sponsorship?" and "Are you able to work without
       * sponsorship?" want opposite answers from the same fact, and the stored
       * value was written straight into both — so an applicant who needs no
       * sponsorship was telling employers, on the second phrasing, that they
       * could not work without it. That is a disqualifying answer, and the
       * wrong one.
       */
      /**
       * Profile or nothing.
       *
       * A wrong answer here is disqualifying: "No" to work authorisation, or
       * "Yes" to needing sponsorship when the applicant does not, takes them out
       * of the running before a human reads anything. Yet a null from this rule
       * used to fall through to saved answers and then to the model — so one
       * "No" banked on one portal was replayed as a negative answer across every
       * application after it, which is the behaviour reported.
       *
       * There is no safe guess available here, and the model is the wrong tool
       * for a legal declaration: it can only infer, and an inferred immigration
       * status stated to an employer is a liability. Unanswered means the field
       * is left empty and highlighted for the applicant.
       */
      profileOnly: true,
      value: (p, el, label) => {
        const stored = sponsorshipFor(p);
        if (!stored) return null;   // unknown: leave it for the applicant
        const text = String(label ?? "");
        if (!SPONSORSHIP_INVERTED.test(text)) return stored;

        if (stored === "Yes") return "No";

        // Some of these ask about authorisation in the same breath — "legally
        // authorized to work without sponsorship" — and needing no sponsorship
        // only answers half of that.
        const authorized = authorizedFor(p);
        if (/\bauthori[sz]|\beligible|\blegally\b/i.test(text)) {
          if (!authorized) return null;
          if (authorized === "No") return "No";
        }
        return "Yes";
      },
      options: { Yes: ["yes", "i will", "true"], No: ["no", "i do not", "i don't", "false"] },
    },
    {
      key: "visaStatus",
      weight: 10,
      match: [/\bvisa\s*(status|type)\b/i, /\bimmigration\s*status\b/i, /\bwork\s*permit\s*type\b/i],
      type: ["select", "text"],
      /**
       * Profile or nothing.
       *
       * A wrong answer here is disqualifying: "No" to work authorisation, or
       * "Yes" to needing sponsorship when the applicant does not, takes them out
       * of the running before a human reads anything. Yet a null from this rule
       * used to fall through to saved answers and then to the model — so one
       * "No" banked on one portal was replayed as a negative answer across every
       * application after it, which is the behaviour reported.
       *
       * There is no safe guess available here, and the model is the wrong tool
       * for a legal declaration: it can only infer, and an inferred immigration
       * status stated to an employer is a liability. Unanswered means the field
       * is left empty and highlighted for the applicant.
       */
      profileOnly: true,
      value: (p) => W(p).workAuthType || W(p).visaStatus,
    },
    {
      /**
       * "Are you a U.S. citizen?" / "...or permanent resident?" / "Are you a
       * U.S. person (ITAR/EAR)?" — common on defence and federal-contractor
       * applications, and previously left to whatever saved answer looked
       * closest. Answered from the work-authorization type in the profile, or
       * not at all.
       */
      key: "usCitizen",
      weight: 12,
      profileOnly: true,
      match: [
        /\b(u\.?\s?s\.?a?\.?|united\s+states|american)\s+citizen(ship)?\b/i,
        /\bcitizen\s+of\s+the\s+(u\.?\s?s|united\s+states)\b/i,
        /\bu\.?\s?s\.?\s+person\b/i,
      ],
      deny: [THIRD_PARTY, /\b(dual|other\s+than|countr(y|ies)\s+of\s+citizenship|which\s+countr\w*|spouse|parents?|proof|document\w*|upload|number)\b/i,
             /\b(sponsor\w*|authoriz\w*\s+to\s+work)\b/i],
      type: ["select", "radio"],
      value: (p, _el, label) => citizenAnswer(p, label),
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      key: "willingToRelocate",
      weight: 11,
      match: [
        /\bwilling\s*to\s*relocat/i, /\bopen\s*to\s*relocat/i,
        /\b(able|prepared|consider)\w*\s+(to\s+)?relocat/i,
        /\brelocat(e|ion)\b/i,
      ],
      /**
       * "Will you require relocation assistance?" is a different question.
       *
       * The denial used to be any of these words anywhere in the label, so the
       * willingness question itself was refused whenever the page said why it
       * asked: "This position requires relocation to Des Moines. Are you
       * willing to relocate?", or "…willing to relocate at your own expense?".
       * Only a question about support for the move — or about the applicant
       * needing to move — is turned away now.
       */
      deny: [
        (label) => {
          const text = String(label ?? "")
            .replace(/\b(?:at|on)\s+(?:your|my|their|one'?s)\s+own\s+(?:expense|cost)s?\b/gi, " ")
            // Help the employer offers alongside the move is not what is asked:
            // "…available to work on-site with relocation support?"
            .replace(/\bwith\s+(?:(?:full|partial|some|company|paid)\s+)?(?:relocation\s+)?(?:assistance|support|package|help|benefits?)\b(?:\s+(?:provided|offered|available))?/gi, " ");
          const own = ownLabel(text);
          // Whether the applicant needs, expects or wants help with a move.
          if (/\b(?:require|need|expect|request|want|seek|ask)\w*\b[^?|.]{0,40}\b(?:assistance|package|reimburs\w*|stipend|allowance|lump[\s-]*sum|support|help|benefits?|bonus)\b/i.test(text)) return true;
          // A label that is only the help: "Relocation assistance", "Relocation package?".
          if (/^\s*relocation\s+(?:assistance|package|benefits?|bonus|support|reimbursement|expenses?|costs?|allowance|stipend|help)\s*(?:\([^)]*\))?\s*[?*:]?\s*$/i.test(own)) return true;
          return /\b(assistance|package|reimburs\w*|stipend|allowance|lump[\s-]*sum)\b/i.test(text) ||
            /\b(?:will|would|do|does)\s+you\s+(?:require|need|expect|request|want)\b[^?|]{0,40}\brelocat/i.test(text) ||
            /\b(?:require|need|expect|request)s?\s+(?:any\s+)?relocation\b(?!\s+to\b)/i.test(text) ||
            /\b(?:expenses?|costs?)\b[^?|]{0,30}\b(?:covered|paid|reimbursed)\b/i.test(text);
        },
      ],
      type: ["select", "radio", "text"],
      /**
       * Profile or nothing.
       *
       * A wrong answer here is disqualifying: "No" to work authorisation, or
       * "Yes" to needing sponsorship when the applicant does not, takes them out
       * of the running before a human reads anything. Yet a null from this rule
       * used to fall through to saved answers and then to the model — so one
       * "No" banked on one portal was replayed as a negative answer across every
       * application after it, which is the behaviour reported.
       *
       * There is no safe guess available here, and the model is the wrong tool
       * for a legal declaration: it can only infer, and an inferred immigration
       * status stated to an employer is a liability. Unanswered means the field
       * is left empty and highlighted for the applicant.
       */
      profileOnly: true,
      value: (p) => W(p).willingToRelocate || null,  // never assumed: a commitment to move
      options: { Yes: ["yes", "willing", "true"], No: ["no", "not willing", "false"] },
    },
    {
      key: "remotePreference",
      weight: 10,
      // A preference question, not every sentence that mentions "remote".
      match: [
        /\bwork\s*(location\s*)?(arrangement|preference|setting|model|mode|environment|style)\b/i,
        /\b(remote|on-?site|hybrid|in[-\s]office)\s*(\/|or|,)\s*(remote|on-?site|hybrid|in[-\s]office)\b/i,
        /\bremote\s*(work\s*)?preference\b/i,
        /\bpreferred\s*(work(place)?|working)\s*(location|arrangement|setting|model|mode|type)\b/i,
        /\bworkplace\s*type\b/i,
      ],
      type: ["select", "radio"],
      value: (p) => W(p).remotePreference,
    },
    {
      /**
       * "Do you wish to be considered for other opportunities?"
       *
       * A Yes / No question on Workday questionnaires (SEI's among them) that no
       * rule answered, so it sat outlined on every application while the rest
       * of the page filled. Being considered for other openings only widens the
       * applicant's chances, so it is answered Yes — shown as a draft to check,
       * and a No saved for the exact question still wins. Only asked as a
       * question: a lone "keep me informed" checkbox is a marketing consent,
       * and that is the applicant's to give.
       */
      key: "otherOpportunities",
      weight: 11,
      review: true,
      match: [
        /\bconsider(?:ed|ation)?\b[^?|]{0,60}\b(other|future|additional|similar|alternative|different|related)\s+(opportunit\w*|positions?|roles?|jobs?|openings?|vacanc\w*|requisitions?)\b/i,
        /\bopen\s+to\s+(other|additional|similar|alternative|different)\s+(opportunit\w*|positions?|roles?|jobs?|openings?)\b/i,
        /\b(other|future|additional|similar|alternative)\s+(opportunit\w*|positions?|roles?|openings?)\b[^?|]{0,40}\bconsider\w*\b/i,
      ],
      deny: [
        THIRD_PARTY,
        /\b(not|never)\b[^?|]{0,20}\bconsider/i,
        /\b(e-?mail|sms|text\s+messages?|newsletters?|marketing|talent\s+(community|network|pool)|subscribe|alerts?)\b/i,
      ],
      type: ["select", "radio"],
      value: () => "Yes",
      options: { Yes: ["yes", "true", "i would", "interested"], No: ["no", "false", "not interested"] },
    },
    {
      key: "startDate",
      weight: 10,
      match: [
        /\b(available|earliest|possible|potential)\s*(to\s*)?start\s*(date)?\b/i,
        /\bwhen\s*can\s*you\s*start\b/i,
        /\bstart\s*date\b/i,
        /\bavailability\s*date\b/i,
        /**
         * The other ways the same question is put, which were left blank:
         * "Date Available", "Available Date", "When could you start?", "How
         * soon can you start?", "Earliest date you can start", "…when would
         * you be available to begin work?", "When can you join?".
         */
        /\bdate\s+(?:you\s+are\s+|you'?re\s+|you\s+will\s+be\s+)?available\b/i,
        /\bavailable\s+(?:start(?:ing)?\s+)?date\b/i,
        /\bwhen\s+(?:can|could|would|will)\s+you\s+(?:be\s+(?:able|available|ready)\s+to\s+)?(?:start|begin|commence|join|report)\b/i,
        /\bhow\s+soon\b[^?|]{0,40}\b(?:start|begin|commence|join|report|available|availability)\b/i,
        /\bearliest\b[^?|]{0,24}\b(?:date|time)\b[^?|]{0,30}\b(?:start|begin|commence|join|report|available|work)\b/i,
        /\bearliest\s+(?:possible\s+)?(?:start(?:ing)?\s+|joining\s+|availability\s+)?date\b/i,
        /\bavailab\w*\s+(?:to|for)\s+(?:begin|commence|join|report|start)\b/i,
        /\b(?:date|when)\b[^?|]{0,40}\b(?:begin|commence)\s+(?:work|working|employment)\b/i,
        // Asked as yes or no against a time: "Can you start within two weeks
        // of an offer?", "Are you able to start immediately?"
        /\b(?:can|could|would|will)\s+you\s+(?:be\s+(?:able|available|ready)\s+to\s+)?(?:start|begin|commence|join)\s+(?:work(?:ing)?\s+|employment\s+)?(?:within|in|by|immediately|right\s+away|asap)\b/i,
        /\b(?:available|able|ready)\s+to\s+(?:start|begin|commence|join)\s+(?:work(?:ing)?\s+|employment\s+)?(?:within|in|by|immediately|right\s+away|asap)\b/i,
      ],
      /**
       * A bare "Start Date" inside a work or education history is that row's
       * date, and the history words anywhere around it still deny it.
       *
       * But a question that says it is asking about availability — "Available
       * Start Date", "Earliest start date" — is judged on its own words only.
       * On SEI's Workday questionnaire the question above it is "Employment
       * Type Desired", that label was read as the heading of the questions
       * below, and its "employment" took Available Start Date away from this
       * rule and gave it to the work-history date rule: the current job's start
       * went in instead, and Workday rejected "Invalid Date: 01//2022".
       */
      deny: [
        (label) => {
          const text = String(label ?? "");
          const asked = text.split("|").map((s) => s.trim()).filter((s) => AVAILABILITY_RE.test(s));
          if (asked.length) {
            return asked.some((s) =>
              /\b(previous|former|prior|past|current\s*job|experience|work\s*history|job\s*history|education|school|college|university|graduat\w*)\b/i.test(s));
          }
          return /employment\s*start|previous|current\s*job|experience|employment|work\s*history|education|school|college|university/i.test(text);
        },
      ],
      // "select": a date asked as Month / Day / Year lists (`dateListChoice`),
      // or as a list of how soon ("Immediately", "Within 2 weeks"); "radio":
      // that list drawn as radio buttons (`availabilityChoice`).
      type: ["text", "date", "month", "select", "radio"],
      // "Immediately" is today's date in a date box — see `availabilityValue`.
      value: (p, el, label) => availabilityValue(W(p).availableStartDate, el, label, p),
      options: {
        Immediately: ["immediately", "immediate", "asap", "as soon as possible", "right away", "now", "available now"],
      },
    },
    {
      key: "noticePeriod",
      weight: 11,
      match: [/\bnotice\s*period\b/i, /\bhow\s*much\s*notice\b/i],
      type: ["text", "select", "radio"],
      /**
       * Asked as a list ("Immediate", "15 days", "30 days", "60 days"), the
       * profile's notice is the choice that covers it — "0" is "Immediate".
       * Written as the applicant wrote it in a box.
       */
      value: (p, el) => {
        const stored = String(W(p).noticePeriod ?? "").trim();
        if (!stored) return null;
        if (!choiceControl(el)) return stored;
        const days = noticeDays(stored);
        if (days == null) return stored;
        const texts = choiceTextsOf(el);
        if (texts.length) return durationChoice(days, texts);
        return days === 0 ? "Immediately" : stored;
      },
      options: {
        Immediately: ["immediately", "immediate", "immediate joiner", "no notice", "0 days", "none", "serving notice", "less than 15 days"],
      },
    },
    {
      key: "over18",
      // Profile-only: a claim about age is never assumed or generated. If the
      // profile has no answer, leave the question for the applicant rather than
      // letting the AI draft a "Yes" on a federal/consent question.
      profileOnly: true,
      weight: 12,
      /**
       * Only a question that asks whether the applicant is at least 18.
       *
       * The old pattern matched any label containing a bare "18", so "If you
       * are under 18, attach a work permit" and "within the last 18 months"
       * were answered as if they asked the applicant's age.
       */
      match: [
        /\b(at\s+least|over|older\s+than|above|minimum(\s+age)?\s+of)\s+(the\s+age\s+of\s+)?(18|eighteen)(\s*\(18\))?\b/i,
        /\b(18|eighteen)(\s*\(18\))?\s*(years?\s*)?(of\s*age\s*|old\s*)?(or\s+(older|over|above|more)|and\s+(older|over|above)|\+)/i,
        /\blegal\s*(working\s*)?age\b/i,
        /\bof\s+legal\s+age\b/i,
        /^\s*(are\s+you\s+)?(18|eighteen)(\s+years(\s+(of\s+age|old))?)?\s*\??\s*$/i,
        /**
         * Another age, asked the same way: "Are you at least 16 years of
         * age?" is a yes for anyone over 18; "…21 or older?" is answered from
         * a date of birth on the profile (or a no for anyone under 18).
         */
        AGE_AT_LEAST_RE,
        AGE_OR_OLDER_RE,
      ],
      // "…at least 18 years of experience?", "…over 21 employees?" count
      // something else.
      deny: [/\bunder\s+(the\s+age\s+of\s+)?(18|eighteen)\b|\bminors?\b|\bguardian|\bparent|\bmonths?\b/i,
             denyOwn(/\b(experience|service|employees?|hours?|weeks?|days?|miles?|minutes?|lbs?|pounds?|kg|units?|credits?|people|members?)\b/i)],
      type: ["select", "radio"],
      value: (p, _el, label) => ageAnswer(p, label),   // never assumed: a claim about age
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      /**
       * "Are you under the age of 18?" — the age question asked the other way
       * round, answered from the same profile answer, reversed. It was left
       * blank: the age rule rightly refuses "under 18", which is also how an
       * instruction for minors ("If you are under 18, attach a work permit")
       * is worded, and that is still left alone.
       */
      key: "under18",
      profileOnly: true,
      weight: 12,
      match: [
        /^\s*(?:are\s+you\s+)?(?:currently\s+)?(?:under|younger\s+than|below)\s+(?:the\s+age\s+of\s+)?(?:18|eighteen)(?:\s+years(?:\s+(?:of\s+age|old))?)?\s*\??\s*\*?\s*$/i,
        /\bare\s+you\s+(?:a\s+minor|(?:currently\s+)?under\s+(?:the\s+age\s+of\s+)?(?:18|eighteen)|younger\s+than\s+(?:18|eighteen))\b/i,
      ],
      deny: [/\bif\s+(?:you\s+are\s+)?(?:under|a\s+minor|younger)\b|\b(?:permit|parents?|guardians?|upload|attach|consent|certificate|documentation)\b/i],
      type: ["select", "radio"],
      value: (p) => {
        const adult = ageAnswer(p, "Are you at least 18 years of age?");
        return adult === "Yes" ? "No" : adult === "No" ? "Yes" : null;
      },
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      key: "previouslyEmployed",
      // Profile-only: a fact about prior employment at this employer. Never
      // invented by the model, never replayed from a saved answer for a
      // *different* employer on a later portal.
      profileOnly: true,
      weight: 12,
      match: [
        /\b(previously|ever|formerly|before)\s*(been\s*)?(employed|worked)\b/i,
        /\bformer\s*employee\b/i,
        /\bworked\s*(here|for\s*(us|this))\b/i,
        /\bcurrent\s+(or\s+(former|past|previous)\s+)?employee\s+(of|at|with)\b/i,
        /\bhave\s+you\s+(ever\s+)?(been\s+)?(worked|employed)\s+(for|by|at)\b/i,
        // "Have you been employed or contracted by Yum! in the past six months?"
        /\bhave\s+you\s+(ever\s+)?(been\s+)?(worked|employed|contracted)\s+(or\s+(been\s+)?(worked|employed|contracted)\s+)?(for|by|at|with)\b/i,
        /\b(currently|presently)\s+(employed|working)\s+(by|for|at)\s+(?!a\b|an\b|any\b|the\s+(u\.?\s?s|federal|state|government)\b)/i,
        /**
         * The same question in the other shapes it comes in, which were left
         * blank: "Have you ever been an employee of Acme?", "Are you a former
         * Acme employee?", "Are you a current or former Wells Fargo team
         * member?", "Prior employment with Acme?", "Have you previously been
         * on Acme's payroll?".
         */
        /\b(?:been|were\s+you|are\s+you)\s+(?:ever\s+)?(?:an?\s+)?(?:employee|team\s*member|associate|intern|contractor|consultant|temp(?:orary)?\s+(?:employee|worker))\s+(?:of|at|with|for)\b/i,
        /\b(?:current|former|past|previous|ex)[\s-]+(?:or\s+(?:current|former|past|previous)\s+)?(?:[\w&'’.!-]+\s+){0,4}?(?:employee|team\s*member|associate)s?\b/i,
        /\bprior\s+(?:employment|service|work)\s+(?:with|at|for)\b/i,
        /\b(?:previously|ever|formerly)\s+(?:been\s+)?on\s+(?:the\s+)?(?:[\w&'’.!-]+\s+){0,3}?payroll\b/i,
      ],
      /**
       * Only a question about *this* employer.
       *
       * "Have you ever been employed by the U.S. Federal Government?", "...by a
       * competitor?", "...under a different name?" all matched and were given
       * the answer to "have you worked here before" — a wrong statement on
       * exactly the defence and public-sector applications that ask them.
       */
      deny: [
        /\b(government|federal|military|armed\s+forces|civil\s+service|public\s+sector|state\s+or\s+local|agency|agencies|competitor|client|customer|vendor|supplier|sub-?contractor|relatives?|family|spouse|friend|different\s+name|other\s+name|maiden|alias|debarred|suspended|terminated|fired|discharged|dismissed|let\s+go|asked\s+to\s+resign)\b/i,
        /**
         * Somebody else's employment, or how the applicant heard of the job:
         * "Are you related to anyone currently employed by Acme?", "Did any
         * of our current employees inform you about this position?", "Do you
         * know any current employees?". The first was answered as if it asked
         * whether the applicant had worked there.
         */
        denyOwn(/\b(related\s+to|relationships?|refers?|referr?(?:al|als|ed|ing)|inform(?:ed|s)?|told|tell|recommend\w*|know|knows|anyone|someone|any\s+of\s+our|in-?laws?|partners?)\b/i),
        // Only a question about an employer: "…worked with Kubernetes?" is not.
        (label) => !referencesEmployer(label),
      ],
      type: ["select", "radio"],
      /**
       * The applicant's history first, then their stored answer.
       *
       * The stored answer is one value for every employer, so it said "No" on
       * the application of a company listed right there in their experience.
       * An employer the question names — or, on Workday, the tenant in the
       * address — that matches one of theirs is a "Yes"; anything else falls
       * back to what they stored. Never invented by the model.
       */
      value: (p, _el, label) => previousEmploymentAnswer(p, label),
      options: {
        Yes: ["yes", "true"], No: ["no", "false"],
        "Yes, current employee": ["current employee", "currently employed", "yes current", "yes"],
        "Yes, former employee": ["former employee", "previously employed", "past employee", "yes former", "yes"],
      },
    },
    {
      /**
       * "Do you have any relatives employed by Acme?" — from the profile's
       * "Do you have any relatives employed by this company?", on every
       * company's application.
       *
       * There was no profile answer for it, and the question went two ways,
       * both wrong: "Are you related to anyone currently employed by Acme?"
       * was taken for the prior-employment question and answered with whether
       * the applicant had worked there; every other wording was left blank on
       * every application. Weighted above the prior-employment and current-job
       * rules so a relatives question is never theirs.
       *
       * Profile only — a statement about the applicant's family is never
       * drafted. When the profile says nothing, the applicant's own saved
       * answer to the same question (from any company) is used, and otherwise
       * it is left outlined for them.
       */
      key: "relativesEmployed",
      profileOnly: true,
      weight: 13,
      match: RELATIVES_MATCH,
      deny: [
        // The question's own words: a section headed "Industry Affiliations"
        // does not make its relatives question about an industry.
        denyOwn(RELATIVES_DENY),
        // Relatives at this company — named, "this company", "us", "here" —
        // not relatives who work in banking, or a spouse who works at all.
        (label) => !referencesEmployer(label) &&
          !/\b(?:[Dd]oes|[Dd]o|[Dd]id)\s+(?:[A-Z0-9][\w&'’.!-]*\s+){1,5}(?:currently\s+)?employ\b/.test(ownLabel(label)),
      ],
      type: ["select", "radio", "text", "textarea"],
      value: (p, el, label) => relativesAnswer(p, el, label),
      options: {
        Yes: ["yes", "true", "i do", "i have"],
        No: ["no", "false", "none", "i do not", "i don't", "i have no"],
      },
    },
    {
      /**
       * "Did any of our current employees inform you about this position?",
       * "Were you referred by a current employee?", "Did an employee refer
       * you?" — from the profile's "Referred by" and "How did you hear about
       * us?" (see `referralAnswer`). Left blank on every application before.
       */
      key: "employeeReferral",
      weight: 12,
      match: [
        /\b(?:employees?|associates?|team\s*members?|staff(?:\s+members?)?)\b[^?|]{0,50}\b(?:inform(?:ed)?|told|tell|refer(?:red)?|recommend(?:ed)?|let\s+you\s+know|notif(?:y|ied)|encourag\w*|sent|forward(?:ed)?)\b/i,
        /\b(?:were|was|have)\s+you\s+(?:been\s+)?referr?ed\b/i,
        /\breferr?ed\s+by\s+(?:an?\s+|any\s+|one\s+of\s+our\s+)?(?:current\s+)?(?:employee|associate|team\s*member|staff)/i,
        /^\s*(?:employee|internal|staff)\s+referr?al\s*\??\s*\*?\s*$/i,
        /\bdid\s+(?:an?\s+|any\s+)?(?:employee|associate|team\s*member)\s+refer\b/i,
      ],
      deny: [
        // A name, a list of employees, or an agency is a different question.
        denyOwn(/\b(who|whom|name|names|which\s+(?:employee|associate|person)|e-?mail|phone|contact\s+information|agency|agencies|recruiter|staffing|search\s+firm|head\s*hunter|program|bonus|policy)\b/i),
      ],
      type: ["select", "radio"],
      value: (p) => referralAnswer(p),
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      /**
       * "Have you ever been employed by the U.S. Federal Government (military or
       * civilian)?" — common on defence and public-sector applications, and
       * previously left blank for everyone: the prior-employment rule rightly
       * refuses it, and nothing else read the work history for it.
       */
      key: "federalEmployment",
      weight: 12,
      review: true,
      match: [
        /\b(employed|worked|work(ing)?|employee|served|employment)\b[^?|]{0,60}\b(federal\s+government|u\.?\s?s\.?\s+(federal\s+)?government|united\s+states\s+(federal\s+)?government|government\s+agency|federal\s+agency)\b/i,
        /\b(current|former|past)\s+(or\s+(current|former|past)\s+)?(u\.?\s?s\.?\s+)?(federal\s+government|federal|government)\s+(civilian\s+)?employee\b/i,
        /\b(federal|government)\s+(civil\s+service|civilian\s+employment|employment)\b/i,
        /\bcivil\s+service\b[^?|]{0,40}\b(employ\w*|position|service)\b/i,
      ],
      deny: [
        THIRD_PARTY,
        /\b(relatives?|family|friends?|spouses?|anyone|someone)\b/i,
        /\b(contracts?|contractors?|contracting|clearance|debar\w*|exclu\w*|sanction\w*|conflicts?\s+of\s+interest|procurement|lobby\w*|officials?|ethics|revolving|retire\w*|annuitant|pension|benefits?|separat\w*|reinstate\w*|preference)\b/i,
      ],
      type: ["select", "radio"],
      value: (p, _el, label) => governmentHistory(p, label),
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      key: "referredBy",
      weight: 11,
      match: [/\breferr?ed\s*by\b/i, /\breferral\s*(name|source)\b/i, /\bwho\s*referred\b/i],
      type: ["text"],
      value: (p) => W(p).referredBy,
    },
    {
      /**
       * "Today's Date", "Date Signed", and the bare "Date" beside a signature.
       *
       * These are the one date on an application that isn't in the profile —
       * it's whatever day the form is being filled in — so they were left blank
       * on every form. Written as MM/DD/YYYY for a text box and as YYYY-MM-DD
       * for a native date input, which is the only format those accept.
       *
       * The denials matter more than the patterns: a bare "Date" also appears on
       * employment and education rows, and on availability questions, and none
       * of those mean today.
       */
      key: "todayDate",
      identity: true,
      // Above the date-part rules (16). "Today's Date" is an explicit phrase,
      // while those match a loose month/year hint near an education or
      // employment word — which a placeholder of "MM/DD/YYYY" beside an
      // Education heading is enough to satisfy.
      weight: 18,
      match: [
        /\btoday'?s?\s*date\b/i,
        /\bcurrent\s*date\b/i,
        /\bdate\s*(of\s*)?(signature|signed|signing)\b/i,
        /\bsignature\s*date\b/i,
        /\bdate\s*of\s*application\b/i,
        /\bapplication\s*date\b/i,
      ],
      // A bare "Date" is deliberately not matched. It is just as likely to be an
      // employment row's start date or a graduation date, and writing today into
      // one of those is worse than leaving it for the applicant.
      deny: [
        THIRD_PARTY,
        /\b(start|end|from|to|birth|dob|graduation|grad|hire|termination|expiry|expiration|issued|available|availability|joining|last\s*working)\b/i,
      ],
      type: ["text", "date"],
      value: (p, el) => todayFor(el),
    },
    {
      key: "howDidYouHear",
      // Read from the profile so an applicant who actually found the job via
      // a referral or Indeed is not overwritten with "LinkedIn" on every portal.
      // Falls back to null when the profile has no source recorded, in which case
      // the saved-answer memory or the applicant fills it.
      weight: 11,
      /**
       * Portals rarely spell the question out.
       *
       * iCIMS and SuccessFactors label the menu "Source"; Workday uses "How Did
       * You Hear About Us?" but Oracle ships "Referral Source" and Taleo
       * "Recruiting Source". Only the spelled-out phrasing matched, so on the
       * rest the menu was left for the AI pass — which, being a required field
       * on many of them, is what blocked the applicant at submit.
       */
      match: [
        /\bhow\s*did\s*you\s*(hear|find|learn)\b/i,
        /\bwhere\s*did\s*you\s*(hear|find|learn)\b/i,
        /\bhow\s*(did|do)\s*you\s*(come\s*to\s*)?(know|find\s*out)\b/i,
        /\b(referral|recruiting|application|candidate|lead|media|advertising)\s*source\b/i,
        /\bsource\s*of\s*(referral|application|hire|candidate)\b/i,
        /^source$/i,
        /\bhear\s*about\s*(us|this|the)\b/i,
      ],
      /**
       * "Source" alone is only this question on a menu whose choices are places
       * a job is found. A free-text box called "Source" is something else.
       */
      deny: [THIRD_PARTY, /\b(water|power|open|funding|revenue|income|truth|code)\s*source\b/i, /\bsource\s*(code|file|control|system)\b/i],
      type: ["select", "text", "radio"],
      value: (p) => W(p).howDidYouHear || null,
      options: {
        // Ordered most specific first. "Job board" used to outrank "social
        // media" and "professional network", so a list offering LinkedIn only
        // under one of those was answered with the wrong category.
        LinkedIn: ["linkedin", "linked in", "professional network", "professional networking",
                   "social media", "social network", "job board", "job boards", "job site",
                   "online", "internet", "website"],
        Indeed: ["indeed", "job board", "job boards", "online", "internet", "job site"],
        Glassdoor: ["glassdoor", "job board", "job boards", "online"],
        Monster: ["monster", "job board", "job boards", "online"],
        Dice: ["dice", "job board", "job boards", "online"],
        ZipRecruiter: ["ziprecruiter", "job board", "job boards", "online"],
        Naukri: ["naukri", "job board", "job boards", "online"],
        "Company Website": ["company website", "our web site", "our website", "career site", "careers page", "website", "online"],
        Referral: ["referral", "employee referral", "word of mouth", "friend", "personal"],
        "Employee Referral": ["employee referral", "referral", "word of mouth"],
        Recruiter: ["recruiter", "agency", "staffing", "search firm", "head hunter", "direct sourcing"],
        "Job Fair": ["job fair", "career fair", "event", "campus", "university"],
        "Career Fair": ["career fair", "job fair", "event", "campus", "university"],
        Twitter: ["twitter", "x", "social media", "online"],
        Facebook: ["facebook", "social media", "online"],
        Instagram: ["instagram", "social media", "online"],
        Google: ["google", "search engine", "online", "internet"],
        Other: ["other"],
      },
    },
    {
      key: "sourceDetail",
      weight: 12,
      profileOnly: true,
      match: [
        /^\s*please\s+specify\s*[:*]?\s*$/i,
        /^\s*(?:social\s*media|social\s*network(?:ing)?|job\s*boards?(?:\s*\/\s*internet\s*site)?|internet\s*site|source\s*(?:details?|specifics?)|specific\s*source)\s*[*:]?\s*$/i,
      ],
      type: ["select"],
      value: (p, el) => {
        // Legacy ADP renders a second question labelled just "Social Media"
        // after Candidate Source is selected. It is a source detail only in
        // the presence of that parent, not an unrelated social-profile box.
        const root = el?.closest?.("form") || document;
        const hasParent = Array.from(root.querySelectorAll?.("select, [role='combobox']") || [])
          .some((node) => node !== el && /\b(?:candidate|referral|recruiting|application)\s*source\b|\bhow\s*did\s*you\s*(?:hear|find|learn)\b/i.test(String(M.deriveLabel?.(node) || "").split("|")[0]));
        return hasParent ? W(p).howDidYouHear || null : null;
      },
    },
    {
      key: "securityClearance",
      profileOnly: true,
      weight: 11,
      match: [
        /\bsecurity\s*clearance\b/i, /\bclearance\s*(level|status|type)\b/i,
        /\b(active|current|dod|doe|government|federal|public\s*trust|secret|ts\s*\/?\s*sci|top\s*secret|interim)\b[^?|]{0,40}\bclearance\b/i,
      ],
      type: ["select", "radio", "text"],
      /**
       * The level for a level question, yes/no for a yes/no question.
       *
       * The stored value is a level — "None", "Secret", "TS/SCI". Written
       * straight into "Do you hold an active clearance?" it only worked by
       * accident ("None" begins with "No"), a real level matched nothing, and
       * "Are you able to obtain a clearance?" was answered "No" for everyone
       * without one — on a defence contractor's application.
       */
      value: (p, _el, label) => clearanceAnswer(W(p).securityClearance, label, p),
      options: {
        None: ["none", "no clearance", "no security clearance", "not cleared", "not applicable", "n/a"],
        "Top Secret": ["top secret", "top-secret", "ts"],
        "TS/SCI": ["ts/sci", "ts sci", "top secret/sci", "top secret with sci"],
      },
    },
    {
      key: "textMessageConsent",
      weight: 16,
      profileOnly: true,
      match: [/\b(text\s*messag(?:e|es|ing)|sms|texting)\b/i],
      deny: [denyOwn(/\b(code|otp|verification|verify|describe|explain)\b/i)],
      type: ["select", "radio", "checkbox", "text"],
      value: (p, _el, label) => {
        const value = W(p).textMessageConsent;
        if (!/^(Yes|No)$/i.test(value || "")) return null;
        return /\b(opt\s*-?\s*out|do\s+not\s+(?:wish|want)|don['’]t\s+(?:wish|want))\b/i.test(ownLabel(label))
          ? (value.toLowerCase() === "yes" ? "No" : "Yes") : value;
      },
      options: { Yes: ["yes", "agree", "consent", "true"], No: ["no", "decline", "false"] },
    },
    {
      key: "employmentTermination",
      weight: 16,
      profileOnly: true,
      match: [/\b(terminated|fired|dismissed|discharged|asked\s+to\s+resign)\b/i],
      deny: [denyOwn(/\b(harass\w*|violen\w*|misconduct|disciplin\w*|military|service|date|reason|describe|explain|details?|if\s+yes)\b/i)],
      type: ["select", "radio", "checkbox", "text"],
      value: (p) => W(p).employmentTermination || null,
    },
    {
      key: "workplaceMisconduct",
      weight: 17,
      profileOnly: true,
      match: [/\b(harass\w*|workplace\s+violence|violen\w*)\b/i],
      deny: [denyOwn(/\b(policy|training|agree|consent|certify|describe|explain|details?|if\s+yes|convict\w*|arrest\w*)\b/i)],
      require: /\b(terminated|disciplin\w*|dismissed|discharged|fired)\b/i,
      type: ["select", "radio", "checkbox", "text"],
      value: (p) => W(p).workplaceMisconduct || null,
    },
    {
      key: "driversLicense",
      weight: 11,
      match: [/\bdriver'?s?\s*licen[cs]e\b/i],
      // The licence number, its state or its expiry are not "do you have one".
      deny: [denyOwn(/\b(number|no\.|#|state|issu\w*|expir\w*|class|country|upload|copy)\b/i)],
      type: ["select", "radio", "text"],
      value: (p) => W(p).driversLicense,
    },
    {
      key: "willingToDrugTest",
      // Profile-only: consent. The applicant must explicitly state this in the
      // profile; the model is not allowed to invent it and a saved answer from
      // one employer must not transfer to another.
      profileOnly: true,
      weight: 11,
      /**
       * Willingness, not history.
       *
       * `/drug test/` alone matched "Have you ever failed a pre-employment drug
       * test?" and answered it with the applicant's willingness to take one —
       * "Yes". That is an admission, and the opposite of the truth.
       */
      match: [
        /\b(willing|agree|consent|able|prepared)\b[^?|]{0,60}\bdrug\s*(test|screen)/i,
        /\b(submit|undergo|pass|complete|take)\b[^?|]{0,40}\bdrug\s*(test|screen)/i,
        /\bdrug\s*(test|screen)\w*[^?|]{0,40}\b(willing|agree|consent)\b/i,
        /^\s*(pre-?employment\s+)?drug\s*(test|screen)(ing)?(\s*consent)?\s*\??\s*$/i,
      ],
      deny: [/\b(fail|failed|failing|refuse|refused|positive|convict\w*|violat\w*|disciplin\w*|terminat\w*|history)\b/i],
      // "checkbox": "I agree to a drug screen…" as one box to tick — on ADP's
      // pages only, and ticked only when the profile says yes.
      get type() { return onAdpPage() ? ["select", "radio", "checkbox"] : ["select", "radio"]; },
      value: (p) => W(p).willingToDrugTest || null,  // never assumed: this is consent
      options: { Yes: ["yes", "agree", "consent", "true"], No: ["no", "do not", "decline", "false"] },
    },
    {
      key: "willingToBackgroundCheck",
      // Profile-only: consent, same reasoning as willingToDrugTest.
      profileOnly: true,
      weight: 11,
      match: [
        /\b(willing|agree|consent|authoriz\w*|able|prepared)\b[^?|]{0,60}\bbackground\s*(check|screening|investigation)/i,
        /\b(submit|undergo|pass|complete)\b[^?|]{0,40}\bbackground\s*(check|screening|investigation)/i,
        /\bbackground\s*(check|screening|investigation)\w*[^?|]{0,40}\b(willing|agree|consent|authoriz\w*)\b/i,
        /^\s*background\s*(check|screening)(\s*consent|\s*authori[sz]ation)?\s*\??\s*$/i,
      ],
      // "Is there anything in your background...", "Have you been convicted..."
      deny: [/\b(fail|failed|anything|disclose|explain|describe|convict\w*|felony|misdemeanor|criminal|arrest\w*|charges?|reveal|issues?|problems?|discrepanc\w*)\b/i],
      // "checkbox": "I agree to a background check…" as one box to tick — on
      // ADP's pages only, and ticked only when the profile says yes.
      get type() { return onAdpPage() ? ["select", "radio", "checkbox"] : ["select", "radio"]; },
      value: (p) => W(p).willingToBackgroundCheck || null,  // never assumed: this is consent
      options: { Yes: ["yes", "agree", "consent", "true"], No: ["no", "do not", "decline", "false"] },
    },

    /* ---------------- Compensation ---------------- */
    {
      key: "desiredSalary",
      weight: 11,
      match: [
        /\b(desired|expected|requested|target)\s*(annual\s*|base\s*|yearly\s*|hourly\s*|total\s*|starting\s*)?(salary|compensation|pay|rate)\b/i,
        /\bsalary\s*(expectation|requirement|range\s*expectation)/i,
        /\bcompensation\s*(expectation|requirement)/i,
        /\bwhat.*salary.*(looking|expect)/i,
        // "What compensation are you seeking?", "…pay are you looking for?",
        // "What are your pay expectations?"
        /\b(compensation|salary|pay|wage|pay\s*rate)\b[^?|]{0,40}\b(seek|seeking|looking\s+for|expect|expecting|expectations?|desire|desired|want|wanting|requir\w*)\b/i,
        /**
         * "What are your expectations with regards to base salary?" (SEI's
         * Workday questionnaire). The expectation comes first and the salary
         * last, which no pattern above allowed, so the box was left empty
         * beside a profile that holds the answer.
         */
        /\bexpectations?\b[^?|]{0,50}\b(base\s+|annual\s+|yearly\s+|total\s+)?(salary|compensation|pay|wage)\b/i,
      ],
      // Oracle asks it in a multi-line box.
      type: ["text", "number", "textarea"],
      value: (p) => C(p).desiredSalary,
    },
    {
      key: "currentSalary",
      weight: 12,
      match: [/\b(current|present)\s*(salary|compensation|pay)\b/i],
      type: ["text", "number", "textarea"],
      value: (p) => C(p).currentSalary,
    },
    {
      /**
       * How the desired salary is counted — "Annually" or "Hourly" — asked as
       * choices beside the amount (Workforce Now's "What is your desired
       * salary?"). It was left for the applicant beside an amount Appli-Fill had
       * just filled. Answered only alongside a salary in the profile, the way
       * the profile states it: an hourly figure ("45/hr") is hourly, any other
       * amount a year's pay.
       *
       * Only on ADP's pages, and only for choices that are all pay periods
       * ("Annually", "Hourly", "Per year"…) — never a list of amounts or
       * ranges ("$80,000 - $100,000 per year"), and never a list whose choices
       * cannot be read.
       */
      key: "salaryPeriod",
      weight: 10,
      match: [
        /\b(salary|pay|compensation|wage)\s*(frequency|period|basis|type|interval|unit|cycle)\b/i,
        /\b(desired|expected|requested)\s*(annual\s*|base\s*)?(salary|compensation|pay)\b/i,
      ],
      deny: [THIRD_PARTY, /\bcurrency\b/i, () => !onAdpPage()],
      type: ["radio", "select"],
      value: (p, el) => {
        const raw = String(C(p).desiredSalary ?? "").trim();
        if (!raw) return null;
        let options = [];
        try { options = (M.optionTextsFor?.(el) || []).map((o) => String(o ?? "").trim()).filter(Boolean); } catch {}
        options = options.filter((o) => !M.isPlaceholderChoice?.(o));
        if (!options.length || options.some((o) => /\d/.test(o))) return null;
        const PERIOD = /^(per\s+)?(annual(ly)?|annum|yearly|year|hourly|hour|monthly|month|weekly|week|bi-?weekly|semi-?monthly|daily|day|salary|salaried)(\s+(rate|salary|pay))?$/i;
        if (!options.every((o) => PERIOD.test(o))) return null;
        /**
         * How the figure is counted: an hourly figure ("45/hr") is hourly, and
         * otherwise the profile's own Period (Compensation → Period) decides —
         * it used to be ignored, so a profile saved "per hour" was sent as a
         * yearly salary.
         */
        const stated = String(C(p).salaryPeriod ?? "").trim().toLowerCase();
        const period = /\b(hr|hrs|hour|hourly)\b|\/\s*h\b/i.test(raw) ? "hour"
          : /^(hour|hourly|per\s+hour|hr)$/.test(stated) ? "hour"
          : /^(month|monthly|per\s+month|mo)$/.test(stated) ? "month"
          : "year";
        const wanted = { hour: /\bhour/i, month: /\bmonth/i, year: /\b(annual|annum|year|salar)/i }[period];
        if (!options.some((o) => wanted.test(o))) return null;
        return period === "hour" ? "Hourly" : period === "month" ? "Monthly" : "Annually";
      },
      options: {
        Annually: ["annually", "annual", "yearly", "per year", "per annum", "salary", "salaried"],
        Hourly: ["hourly", "per hour", "hourly rate"],
        Monthly: ["monthly", "per month"],
      },
    },
    {
      /**
       * The currency of the desired salary — Workforce Now's "Select Currency
       * Type" beside the amount, and the like on other portals — from the
       * profile's Compensation → Currency. It was never answered: no rule
       * asked for it, and the scan took a list named "currency" for a shop's
       * currency switcher and passed it by.
       */
      key: "salaryCurrency",
      weight: 12,
      match: [
        /\bcurrenc(?:y|ies)\s*(?:type|code|unit|denomination)\b/i,
        /^\s*(?:select\s+(?:a\s+|the\s+|your\s+)?)?(?:preferred\s+|salary\s+|pay\s+|compensation\s+|desired\s+|expected\s+)?currenc(?:y|ies)\s*[:*?]?\s*$/i,
        /\b(?:salary|pay|compensation|wage|rate)\s+currency\b/i,
        /\b(?:which|what|choose|select)\s+(?:a\s+|the\s+|your\s+)?currency\b/i,
        /\bcurrency\b[^?|]{0,30}\b(?:salary|pay|compensation|wage)\b/i,
      ],
      deny: [THIRD_PARTY, /\b(exchange|conversion|convert\w*|crypto\w*|bitcoin)\b/i],
      type: ["select", "radio"],
      value: (p) => currencyCode(C(p).salaryCurrency),
      options: CURRENCY_SYNONYMS,
    },

    /* ---------------- EEO ---------------- */
    {
      /**
       * "I choose not to disclose my sex" / "…my ethnicity or race" (Oracle
       * Recruiting, as a Yes / No list). No for an applicant who has given the
       * answer it is about; Yes for one who declines to self-identify. The
       * gender and race rules took these for the questions themselves and
       * offered "Male" or "Asian" to a Yes / No list.
       */
      key: "declineToDisclose",
      identity: true,
      weight: 14,
      match: [/\b(choose|chose|prefer|wish|want|elect)\s+not\s+to\s+(disclose|answer|provide|state|self[-\s]?identify)\b[^?|]{0,30}\b(sex|gender|ethnicit\w*|race|racial)\b/i,
        /\b(do\s+not|don'?t)\s+wish\s+to\s+disclose\s+my\s+(sex|gender|ethnicit\w*|race)\b/i],
      // Oracle's and ADP's pages; every other site is left as it was.
      deny: [() => !(onOracleCx() || onAdpPage())],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      value: (p, _el, label) => {
        if (E(p).declineToSelfIdentify) return "Yes";
        const aboutRace = /\b(ethnicit\w*|race|racial)\b/i.test(ownLabel(label) || String(label ?? ""));
        return (aboutRace ? (E(p).race || E(p).hispanicLatino) : E(p).gender) ? "No" : null;
      },
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      /**
       * Oracle's "Newly Separated Veteran Discharge Date" (Day / Month / Year)
       * and the like. A date only a veteran has; no profile holds it, and the
       * date parts were open to rules for other dates. Left blank.
       */
      key: "veteranDischargeDate",
      weight: 16,
      blank: true,
      match: [/\bdischarge\s*date\b/i, /\bdate\s*of\s*(discharge|separation)\b/i, /\bseparat\w*\s+veteran\b[^?|]{0,30}\bdate\b/i],
      deny: [() => !(onOracleCx() || onAdpPage())],
      type: ["text", "select", "date"],
      value: () => null,
    },
    {
      /**
       * The protected-veteran categories Oracle lists as check boxes under
       * Veteran Self-Identification Status ("Disabled Veteran", "Active Duty
       * Wartime or Campaign Badge Veterans", "Armed Forces Service Medal
       * Veteran", "Recently Separated Veteran"). None is ticked for an applicant
       * who is not a protected veteran — the unticked boxes are their answer —
       * and a protected veteran picks their own.
       */
      key: "veteranCategory",
      identity: true,
      weight: 13,
      blank: true,
      match: [/\b(disabled|recently\s+separated|newly\s+separated|active\s+duty\s+wartime|campaign\s+badge|armed\s+forces\s+service\s+medal)\b[^?|]{0,20}\bveterans?\b/i],
      deny: [() => !(onOracleCx() || onAdpPage())],
      type: ["checkbox"],
      value: () => null,
    },
    {
      // An explicit profile declaration or exact saved answer, on every portal.
      key: "restrictiveCovenant",
      weight: 12,
      profileOnly: true,
      match: [/\b(non-?compete|non-?solicit(ation)?|restrictive\s+covenants?)\b/i],
      deny: [THIRD_PARTY, /\b(describe|explain|details?|list|upload|attach|copy|provide|willing|would\s+you|will\s+you)\b/i],
      type: ["select", "radio", "checkbox", "text"],
      value: (p) => W(p).signedNonCompete || null,
      options: { No: ["no", "false", "none"], Yes: ["yes", "true"], NA: ["na", "n/a", "not applicable"] },
    },
    {
      key: "gender",
      identity: true,
      weight: 10,
      match: [/\bgender\b/i, /\bsex\b/i],
      deny: [/identity\s*expression|transgender/i],
      type: ["select", "radio"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p, _el, label) => E(p).declineToSelfIdentify ? "Decline to self-identify" :
        (/^\s*gender\s+identity\s*[:?*]?\s*$/i.test(ownLabel(label)) ? E(p).genderIdentity || E(p).gender : E(p).gender),
      options: {
        Male: ["male", "man", "i identify as male"],
        Female: ["female", "woman", "i identify as female"],
        "Non-binary": ["non-binary", "nonbinary", "non binary", "genderqueer", "another gender identity"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
          "choose not to disclose", "i don't want to answer", "prefer not to disclose",
        ],
        "Prefer not to say": [
          "prefer not to say", "decline to self-identify", "decline to self identify",
          "not declared", "do not wish to disclose", "i don't wish to answer",
        ],
      },
    },
    {
      key: "hispanicLatino",
      identity: true,
      weight: 12,
      match: [/\bhispanic\s*(or|\/)?\s*latino\b/i],
      /**
       * The reciprocal of the guard on `race`.
       *
       * Every Workday race dropdown prints "Asian (Not Hispanic or Latino)" and
       * the rest of the category definitions next to itself, so this rule — one
       * weight higher than `race` — matched the race dropdown and answered a
       * seven-way category question with a yes/no. The full category list is
       * signalled by the words "race" or "designation"; an actual
       * Hispanic/Latino question is not disqualified by them, because it is
       * recognised by its own interrogative form first.
       */
      deny: [
        (label) =>
          /\brace\b|\bdesignation/i.test(label) &&
          !/\b(are|do)\s+you\b[^|]{0,40}hispanic|hispanic\s*(or|\/)\s*latino\s*\?/i.test(label) &&
          !HISPANIC_STATEMENT_RE.test(label),
      ],
      /**
       * Also a single checkbox: Oracle Recruiting asks "I am Hispanic or
       * Latino." as one box to tick. The rule only took menus and radios, so the
       * race rule claimed the box instead and never ticked it for a Hispanic
       * applicant. Ticked for "Yes", left clear for "No" — and the other way
       * round for a box that says "I am not Hispanic or Latino".
       */
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p, el, label) => {
        if (E(p).declineToSelfIdentify) return "Decline to self-identify";
        const answer = E(p).hispanicLatino;
        const isBox = el?.type === "checkbox" || el?.getAttribute?.("role") === "checkbox";
        if (isBox && /\bi\s+am\s+not\s+(of\s+)?hispanic/i.test(String(label ?? ""))) {
          const yn = String(answer ?? "").trim().toLowerCase();
          if (/^(yes|y|true)\b/.test(yn)) return "No";
          if (/^(no|n|false)\b/.test(yn)) return "Yes";
          return null;
        }
        return answer;
      },
      options: {
        Yes: ["yes", "yes, hispanic or latino", "hispanic or latino"],
        No: ["no", "not hispanic or latino"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
        ],
      },
    },
    {
      key: "race",
      identity: true,
      weight: 10,
      // "Select the races you identify with." (Oracle) — the plural too.
      match: [/\b(races?|racial|ethnicity|ethnic\s*(group|background))\b/i],
      /**
       * This is why "Asian" kept coming out as "American Indian or Alaska
       * Native" even after the race categories were canonicalised.
       *
       * The deny was a bare /hispanic or latino/ and denials are tested against
       * the *whole* derived label — which includes the text around the field.
       * Every Workday race dropdown prints the category definitions above it
       * ("Asian (Not Hispanic or Latino) - A person having origins in..."), so
       * the phrase was always present, the race rule was always skipped, and
       * the dropdown fell through to saved answers and the model.
       *
       * The intent was only ever to leave the separate "Are you Hispanic or
       * Latino?" yes/no question alone. So: deny when the label is about
       * Hispanic/Latino and says nothing about race or ethnicity, and not
       * otherwise.
       */
      /**
       * "ethnicit" never matched "ethnicity": the closing \b demanded a word
       * boundary before the "y". So when every option on a Workday list reads
       * "Asian (Not Hispanic/Latino) (United States of America)", the list was
       * taken for the separate Hispanic question and refused, and nobody's
       * ethnicity was ticked (uchicago.wd5).
       */
      deny: [
        (label) => {
          if (!/hispanic\s*(or|\/)?\s*latino/i.test(label)) return false;
          // The separate yes/no question, recognised by asking it — even under
          // an "Ethnicity" heading.
          if (/\b(are|do)\s+you\b[^|]{0,40}hispanic|hispanic\s*(or|\/)\s*latino\s*\?/i.test(label)) return true;
          // …or by stating it, as the one box Oracle asks it with.
          if (HISPANIC_STATEMENT_RE.test(label)) return true;
          return !/\b(race|races|racial|ethnicit(y|ies)|ethnic\s*(group|background|origin)|designation)\b/i.test(label);
        },
      ],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p, el, label) => {
        if (E(p).declineToSelfIdentify) return "Decline to self-identify";
        if (/^\s*ethnicity\s*[:?*]?\s*$/i.test(ownLabel(label))) {
          if (E(p).ethnicity) return E(p).ethnicity;
          // A separate Ethnicity menu may ask Hispanic/Latino status, while
          // other portals label their full race category menu "Ethnicity".
          const options = Array.from(el?.options || []).map(o => o.textContent).join(" ");
          if (/hispanic|latino/i.test(options) && !/asian|white|black|african/i.test(options)) {
            const answer = yesNo(E(p).hispanicLatino);
            return answer === "Yes" ? "Hispanic or Latino" : answer === "No" ? "Not Hispanic or Latino" : null;
          }
        }
        return E(p).race || null;
      },
      options: {
        Asian: ["asian", "asian (not hispanic or latino)", "asian (united states of america)"],
        White: ["white", "white (not hispanic or latino)", "caucasian"],
        "Black or African American": ["black or african american", "black", "african american"],
        "Hispanic or Latino": ["hispanic or latino", "hispanic", "latino", "latinx"],
        "Native Hawaiian or Other Pacific Islander": ["native hawaiian or other pacific islander", "pacific islander", "native hawaiian"],
        "American Indian or Alaska Native": ["american indian or alaska native", "american indian", "alaska native", "native american"],
        "Two or More Races": ["two or more races", "two or more", "multiracial", "multi-racial"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
          "choose not to disclose", "i do not wish to self-identify",
        ],
      },
    },
    /* Voluntary self-identification.
     *
     * `eeo: true` tells the engine these are disclosure questions: if the
     * profile has no stored answer and no saved answer exists, it may fall back
     * to `decline`, which is always a permitted and truthful choice. It never
     * invents a factual answer such as "I am not a protected veteran". */
    {
      key: "veteranStatus",
      identity: true,
      weight: 11,
      match: [/\bveteran\b/i, /\bmilitary\s*(service|status)\b/i, /\bprotected\s*veteran\b/i],
      deny: [/spouse|accommodation/i],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => E(p).veteranStatus || (E(p).declineToSelfIdentify ? "I don't wish to answer" : null),
      options: {
        "I am not a protected veteran": [
          "i am not a protected veteran", "not a protected veteran", "i am not a veteran",
          "no, i am not a protected veteran", "non-veteran", "not a veteran", "no",
        ],
        "I identify as one or more of the classifications of a protected veteran": [
          "i identify as one or more of the classifications of a protected veteran",
          "i identify as one or more of the classifications of protected veteran",
          "one or more of the classifications", "i am a protected veteran",
          "yes, i am a protected veteran", "yes",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "i dont wish to answer", "decline to self-identify",
          "decline to self identify", "i prefer not to answer", "prefer not to say",
          "i don't want to answer", "choose not to disclose", "do not wish to disclose",
        ],
      },
    },
    {
      key: "disabilityStatus",
      identity: true,
      weight: 11,
      match: [/\bdisabilit(y|ies)\b/i, /\bsection\s*503\b/i, /\bform\s*cc-?257\b/i],
      /**
       * An accommodation request is not the disability question — judged on
       * the question's own words.
       *
       * The denial read the whole label, and a survey's introduction ("If you
       * need an accommodation because of a disability, contact…") travels with
       * every question under it, so "Do you live with a disability?" was
       * refused along with the accommodation questions it was meant to stop.
       */
      deny: [
        (label) => {
          const parts = String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);
          const own = parts.find((s) => /disabilit|section\s*503|cc-?257|cc-?305/i.test(s)) ?? "";
          return /accommodation/i.test(parts[0] ?? "") || /accommodation/i.test(own);
        },
      ],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => (E(p).declineToSelfIdentify ? "I don't wish to answer" : E(p).disabilityStatus),
      options: {
        "Yes": [
          "yes, i have a disability", "yes i have a disability",
          "yes, i have a disability, or have had one in the past",
          "yes, i have a disability or have a history/record of having a disability",
          "i have a disability", "or have had one in the past", "yes",
        ],
        "No": [
          "no, i do not have a disability", "no i don't have a disability",
          "no, i do not have a disability and have not had one in the past",
          "no, i don't have a disability or have a history/record of having a disability",
          "i do not have a disability", "no",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "i do not want to answer", "i don't want to answer",
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i do not wish to answer", "choose not to disclose",
        ],
      },
    },
    {
      /**
       * "Sexual Orientation" — Ashby's demographic survey (a type-to-search
       * list), Greenhouse's and Lever's voluntary surveys (radios or boxes to
       * tick), some Workday tenants. Answered from the profile's EEO section;
       * with nothing saved it is left for the applicant, and declined when the
       * profile declines to self-identify.
       */
      key: "sexualOrientation",
      identity: true,
      weight: 12,
      match: [/\bsexual\s*orientation\b/i, /\bsexuality\b/i, /\bsexual\s*identity\b/i],
      // "Do you identify as LGBTQ+?" is a yes/no question of its own.
      deny: [/\blgbt/i],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => (E(p).declineToSelfIdentify ? "I don't wish to answer" : E(p).sexualOrientation) || null,
      options: {
        Heterosexual: [
          "heterosexual", "straight", "heterosexual or straight", "heterosexual/straight",
          "straight/heterosexual", "straight or heterosexual", "heterosexual (straight)",
        ],
        Gay: ["gay", "gay man", "gay or lesbian", "gay/lesbian", "homosexual"],
        Lesbian: ["lesbian", "gay or lesbian", "gay/lesbian", "gay woman", "homosexual"],
        Bisexual: ["bisexual", "bisexual and/or pansexual", "bisexual or pansexual", "bisexual/pansexual"],
        Pansexual: ["pansexual", "bisexual and/or pansexual", "bisexual or pansexual", "bisexual/pansexual"],
        Asexual: ["asexual", "asexual or aromantic", "asexual/aromantic"],
        Queer: ["queer"],
        "Prefer to self-describe": [
          "prefer to self-describe", "i prefer to self-describe", "self-describe", "prefer to self describe",
          "not listed", "a sexual orientation not listed", "another sexual orientation",
        ],
        "Prefer not to say": [
          "i don't wish to answer", "prefer not to say", "prefer not to answer", "i prefer not to answer",
          "decline to self-identify", "decline to self identify", "choose not to disclose",
          "do not wish to disclose", "i do not wish to answer",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "prefer not to say", "prefer not to answer", "i prefer not to answer",
          "decline to self-identify", "decline to self identify", "choose not to disclose",
          "do not wish to disclose", "i do not wish to answer",
        ],
      },
    },
    {
      /**
       * "Do you identify as transgender?" — Yes / No / decline, from the
       * profile's EEO section.
       *
       * Never an LGBTQ+ membership question (a gay applicant is a Yes there and
       * a No here), and never the question put the other way round ("Is your
       * gender identity the same as the sex you were assigned at birth?"),
       * whose Yes means No.
       */
      key: "transgender",
      identity: true,
      weight: 12,
      match: [/\btransgender\b/i, /\bidentify\s+as\s+(?:a\s+)?trans\b/i, /\btrans\s+experience\b/i],
      deny: [
        /\blgbt/i,
        /\bassigned\s+(?:to\s+you\s+)?at\s+birth\b|\bsame\s+as\s+(?:the\s+)?(?:sex|gender)\b/i,
        // "What is your gender identity? (Woman, Man, Transgender, …)" is the
        // gender question.
        (label) => /\bgender\s*identity\b/i.test(String(label ?? "")) &&
          !/\bidentify\s+as\s+(?:a\s+)?trans|\btransgender\s*\?/i.test(String(label ?? "")),
      ],
      type: ["select", "radio"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => (E(p).declineToSelfIdentify ? "I don't wish to answer" : E(p).transgender) || null,
      options: {
        Yes: ["yes", "yes, i identify as transgender", "i identify as transgender", "transgender"],
        No: [
          "no", "no, i do not identify as transgender", "i do not identify as transgender",
          "i don't identify as transgender", "cisgender",
        ],
        "Prefer not to say": [
          "i don't wish to answer", "prefer not to say", "prefer not to answer", "i prefer not to answer",
          "decline to self-identify", "decline to self identify", "choose not to disclose",
          "do not wish to disclose", "i do not wish to answer",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "prefer not to say", "prefer not to answer", "i prefer not to answer",
          "decline to self-identify", "decline to self identify", "choose not to disclose",
          "do not wish to disclose", "i do not wish to answer",
        ],
      },
    },

    /* ---------------- Misc ---------------- */
    {
      key: "resume",
      weight: 12,
      match: [/\bresume\b/i, /\bcv\b/i, /\bupload\s*(your\s*)?(resume|cv)\b/i],
      deny: [/cover\s*letter|transcript|portfolio\s*file/i],
      type: ["file"],
      value: () => "__RESUME__",
    },
    {
      key: "coverLetter",
      weight: 12,
      match: [/\bcover\s*letter\b/i, /\bmotivation\s*letter\b/i],
      // File inputs only. A typed cover-letter box is an ordinary question for
      // saved answers (or a draft); the document itself is never attached.
      type: ["file"],
      value: () => "__COVER_LETTER__",
    },
    {
      key: "certifications",
      weight: 8,
      match: [/\b(certification|certifications|professional\s*license|licen[cs]e)\b/i],
      deny: [/driver'?s?/i],
      type: ["text", "textarea"],
      value: (p) => (p?.certifications ?? []).join(", "),
    },
    {
      key: "highSchoolDiplomaOrGED",
      profileOnly: true,
      weight: 18,
      match: [/\b(?:high\s*school\s*(?:diploma|education)|GED|general\s+educational?\s+development)\b/i],
      deny: [denyOwn(/\b(?:name\s+of|school\s+name|institution|date|year|upload|attach|describe|bachelor|master|doctorate|experience)\b/i),
        (label) => !/\b(?:do|did|have|has|hold|possess|completed?|earned?|obtained?|minimum|at\s+least)\b/i.test(ownLabel(label))],
      type: ["text", "select", "radio"],
      value: (p, _el, label) => {
        const answer = yesNo(W(p).highSchoolDiplomaOrGED);
        if (!answer) return null;
        const question = ownLabel(label).split("?")[0];
        return /\bnot\s+(?:have|hold|possess|earned?|completed?|obtained?)\b/i.test(question) ? inverseBinary(answer) : answer;
      },
      options: {Yes: ["yes", "true"], No: ["no", "false"]},
    },
    {
      key: "aliases",
      profileOnly: true,
      weight: 16,
      match: [/\balias(?:es)?\b/i, /\bother\s+names?\b/i, /\bname\(s\)\s+you\s+have\s+used\b/i],
      type: ["text", "textarea"],
      value: (p) => P(p).aliases || null,
    },
    {
      key: "preferredLanguage",
      profileOnly: true,
      weight: 14,
      match: [/\bpreferred\s+language\b/i, /\blanguage\s+preference\b/i],
      type: ["text", "select", "radio"],
      value: (p) => P(p).preferredLanguage || null,
    },
    {
      key: "profileVisibility",
      profileOnly: true,
      weight: 15,
      match: [/\bmake\s+my\s+profile\s+visible\s+to\b/i, /\bprofile\s+visibility\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).profileVisibility || null,
    },
    {
      key: "jobNotifications",
      profileOnly: true,
      weight: 14,
      match: [/\breceive\s+new\s+job\s+posting\s+notifications\b/i],
      type: ["select", "radio", "checkbox"],
      value: (p) => W(p).jobNotifications || null,
      options: {Yes: ["yes", "true"], No: ["no", "false"]},
    },
    {
      key: "languages",
      weight: 8,
      match: [/\b(language|languages|spoken\s*languages|language\s*proficiency)\b/i],
      type: ["text", "textarea"],
      value: (p) => (P(p).languages ?? []).join(", "),
    },
    {
      key: "summary",
      weight: 6,
      match: [/\b(about\s*(you|yourself)|summary|bio|profile\s*summary|tell\s*us\s*about\s*you)\b/i],
      type: ["textarea"],
      value: (p) => p?.summary,
    },
  ];

  // Not rules: the employer helpers the content script uses to recognise the
  // same question asked by a different company. Non-enumerable, so nothing
  // that walks the rule list ever sees them.
  Object.defineProperty(RULES, "helpers", {
    value: { onIcimsPage, hiringCompanyHints, employerNamedIn, sameEmployer, phoneForBox, phoneCodeForProfile, phoneCodeOptions, phoneCodeOfControl },
    enumerable: false,
  });

  global.APPLI_FILL_FIELD_MAP = RULES;
})(typeof window !== "undefined" ? window : globalThis);
