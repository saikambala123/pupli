/**
 * APPLI_FILL ATS ADAPTERS
 * -------------------
 * Detects which application system a page belongs to and supplies the
 * platform-specific bits the generic engine can't guess:
 *
 *   formSelector   where the application form lives (limits the field scan)
 *   jobTitle/company  how to read the posting metadata for the tracker
 *   nextButton     for multi-step forms (Workday, iCIMS, Taleo)
 *   submitButton   the final submit, used by Auto Pilot
 *   quirks         flags the engine honours (slow dropdowns, iframes, etc.)
 *
 * Anything not listed here falls through to `generic`, which still works on
 * ordinary HTML forms because matching is label-driven, not selector-driven.
 */

(function (global) {
  const text = (sel, root = document) => root.querySelector(sel)?.textContent?.trim() || null;
  const attr = (sel, name, root = document) => root.querySelector(sel)?.getAttribute(name) || null;

  /**
   * The employer on an ADP application.
   *
   * Recruiting Management names it in the address (myjobs.adp.com/<employer>
   * careers/…), which the rule table reads. Workforce Now's address names
   * nobody (…/recruitment.html?cid=…), and the posting's company was read as
   * "workforcenow" — so "Have you worked for us?" could not be checked against
   * the work history, nor an answer saved there be told apart from the next
   * company's. The page is read instead: its site name, an element naming the
   * company, or the part of the tab's title that is neither ADP's own words
   * ("Career Center", "Recruitment", "Current Openings") nor the job title.
   */
  function adpCompany() {
    const GENERIC = /^(career\s*center|careers?|career\s*site|recruitment|recruiting|current\s+openings?|openings?|job\s+(opportunities|details|search|listings?|openings?|description)|jobs?|apply|application|adp|workforce\s*now|my\s*jobs|candidate\s+(portal|experience|home)|home|search(\s+results)?|welcome)$/i;
    const ok = (s) => {
      const t = String(s ?? "").replace(/\s+/g, " ").replace(/\s*careers?$/i, "").trim();
      return t.length >= 2 && t.length <= 80 && !GENERIC.test(t) ? t : null;
    };
    const site = ok(attr("meta[property='og:site_name']", "content"));
    if (site) return site;
    for (const sel of ["[class*='company-name' i]", "[class*='companyName' i]", "[class*='client-name' i]", "[class*='clientName' i]",
      "[data-automation-id*='company' i]", "[id*='companyName' i]"]) {
      let t = null;
      try { t = ok(text(sel)); } catch {}
      if (t) return t;
    }
    const heading = String(text("h1") || "").trim().toLowerCase();
    const parts = String(document.title || "").split(/\s*[|–—]\s*|\s+-\s+/).map(ok).filter(Boolean);
    return parts.find((p) => p.toLowerCase() !== heading) ?? null;
  }

  const ADAPTERS = {
    greenhouse: {
      label: "Greenhouse",
      // Covers the classic boards.greenhouse.io embed, the current
      // job-boards.greenhouse.io / job-boards.eu.greenhouse.io hosts, and the
      // iframe embed on a company's own careers domain.
      test: () =>
        /greenhouse\.io|boards\.greenhouse/.test(location.hostname) ||
        Boolean(document.querySelector("#application_form, #application-form, #grnhse_app, [id^='job_application']")),
      formSelector:
        "#application_form, #application-form, #grnhse_app form, form#job_application_form, " +
        "form[id*='application'], div[class*='application--form'] form, main form",
      jobTitle: () => text(".app-title, h1.app-title, h1") || document.title.split(" - ")[0],
      company: () =>
        text(".company-name")?.replace(/^at\s+/i, "") ||
        attr("meta[property='og:site_name']", "content") ||
        text("header [class*='company']")?.replace(/^at\s+/i, ""),
      submitButton: "#submit_app, input[type='submit'][value*='Submit'], button[type='submit']",
      // Every choice question on the current forms is a react-select: the
      // control is an <input> whose value is the search text, and the chosen
      // answer is painted into a sibling node. The engine reads that through
      // renderedChoiceText / backingValueHolder rather than the control itself.
      quirks: { iframe: "#grnhse_iframe", reactSelect: true },
    },

    lever: {
      label: "Lever",
      test: () => /jobs\.lever\.co|lever\.co/.test(location.hostname) || Boolean(document.querySelector(".application-form, .lever-application")),
      formSelector: ".application-form, form[action*='apply'], .content form",
      jobTitle: () => text(".posting-headline h2, h2") || document.title.split(" - ")[0],
      company: () => text(".main-header-logo img")?.trim() || attr("meta[property='og:site_name']", "content"),
      submitButton: ".postings-btn[type='submit'], button[type='submit']",
    },

    ashby: {
      label: "Ashby",
      // The class test used to match any page carrying an "ashby" class
      // anywhere — a blog post about Ashby included. It now has to be a form.
      test: () =>
        /ashbyhq\.com/.test(location.hostname) ||
        Boolean(document.querySelector("form[class*='ashby'], [class*='ashby'] form, form[class*='ApplicationForm']")),
      formSelector: "form, [class*='ApplicationForm']",
      jobTitle: () => text("h1, [class*='jobPostingHeader'] h1") || document.title.split(" @ ")[0],
      company: () => document.title.split(" @ ")[1]?.split(" | ")[0] || null,
      submitButton: "button[type='submit']",
      quirks: { slowDropdowns: true },
    },

    oraclehcm: {
      label: "Oracle HCM",
      // `oracle.com` alone matched every page on Oracle's own marketing site.
      // Recruiting always lives under one of these paths or on the
      // `*.fa.*.oraclecloud.com` application hosts.
      test: () =>
        /CandidateExperience|hcmUI|\/recruitingCE/i.test(location.pathname) ||
        /\.fa\.[a-z0-9-]+\.oraclecloud\.com$/i.test(location.hostname) ||
        (/oraclecloud\.com$/i.test(location.hostname) &&
          Boolean(document.querySelector("[data-automation-id], [class*='candidate' i], form"))),
      formSelector: "form, [role='main'], [class*='application']",
      jobTitle: () => text("h1, [data-automation-id*='jobPostingHeader'], [class*='job-title']") || document.title,
      company: () => attr("meta[property='og:site_name']", "content") || location.hostname.split(".")[0],
      nextButton: "button[data-automation-id*='next'], button[aria-label*='Next'], button[type='submit']",
      submitButton: "button[data-automation-id*='submit'], button[type='submit']",
      quirks: { slowDropdowns: true, multiStep: true, dropdownDelay: 900 },
    },

    sapSuccessFactors: {
      label: "SAP SuccessFactors",
      test: () => /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu|cn)|jobs\.sap\.com)$/i.test(location.hostname),
      formSelector: "form, [role='main'], [class*='application']",
      jobTitle: () => text("h1, .jobTitle") || document.title,
      submitButton: "button[type='submit'], input[type='submit']",
      quirks: { multiStep: true, slowDropdowns: true, dropdownDelay: 900 },
    },

    ukg: {
      label: "UKG / UltiPro",
      test: () => /ultipro\.com|ukg\.com|recruiting\.ultipro/.test(location.hostname),
      formSelector: "form, [role='main'], [class*='application']",
      jobTitle: () => text("h1, [class*='job-title']") || document.title,
      submitButton: "button[type='submit'], input[type='submit']",
      quirks: { multiStep: true, slowDropdowns: true, dropdownDelay: 900 },
    },

    workday: {
      label: "Workday",
      test: () =>
        /myworkdayjobs\.com|workday\.com/.test(location.hostname) ||
        Boolean(document.querySelector("[data-automation-id='applyFlowPage'], [data-automation-id='bottom-navigation-next-button'], [data-automation-id='questionnaire']")),
      formSelector: "[data-automation-id='applyFlowPage'], form, [role='main']",
      jobTitle: () =>
        text("[data-automation-id='jobPostingHeader']") ||
        text("h1") ||
        document.title.split(" - ")[0],
      company: () => location.hostname.split(".")[0].replace(/^www$/, "") || null,
      nextButton:
        "[data-automation-id='bottom-navigation-next-button'], button[data-automation-id*='next'], button[data-automation-id='pageFooterNextButton']",
      submitButton: "[data-automation-id='bottom-navigation-next-button'], button[data-automation-id*='submit']",
      // Workday's dropdowns are buttons that open a popup listbox, and the whole
      // form is multi-step, so we go slower and re-scan after each transition.
      quirks: { slowDropdowns: true, multiStep: true, dropdownDelay: 450 },
    },

    icims: {
      label: "iCIMS",
      test: () => /(^|\.)icims\.com$/i.test(location.hostname) || Boolean(document.querySelector("#icims_content_iframe, .iCIMS_MainWrapper")) || Boolean(window.APPLI_FILL_FIELD_MAP?.helpers?.onIcimsPage?.()),
      formSelector: ".iCIMS_MainWrapper, form",
      jobTitle: () => text(".iCIMS_Header, h1") || document.title,
      submitButton: "#quickApplyBtn, input[type='submit'], button[type='submit']",
      quirks: { iframe: "#icims_content_iframe", multiStep: true },
    },

    smartrecruiters: {
      label: "SmartRecruiters",
      test: () => /smartrecruiters\.com/.test(location.hostname),
      formSelector: "form, [class*='application']",
      jobTitle: () => text("h1, [class*='job-title']") || document.title.split(" - ")[0],
      submitButton: "button[type='submit'], [data-test='submit-application']",
    },

    workable: {
      label: "Workable",
      test: () => /workable\.com|apply\.workable/.test(location.hostname),
      formSelector: "form[data-ui='application-form'], form",
      jobTitle: () => text("h1, [data-ui='job-title']") || document.title.split(" - ")[0],
      submitButton: "button[type='submit'], [data-ui='submit-application']",
    },

    taleo: {
      label: "Taleo",
      test: () => /taleo\.net|tbe\.taleo/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text(".titlepage, h1") || document.title,
      nextButton: "a[id*='next'], input[value*='Next'], button[id*='next']",
      submitButton: "input[value*='Submit'], button[id*='submit']",
      quirks: { multiStep: true, slowDropdowns: true },
    },

    jobvite: {
      label: "Jobvite",
      test: () => /jobvite\.com/.test(location.hostname),
      formSelector: ".jv-application, form",
      jobTitle: () => text(".jv-header, h1") || document.title,
      submitButton: ".jv-button-primary, button[type='submit']",
    },

    bamboohr: {
      label: "BambooHR",
      test: () => /bamboohr\.com/.test(location.hostname),
      formSelector: "form, #application",
      jobTitle: () => text("h1, .fab-Card h2") || document.title.split(" - ")[0],
      submitButton: "button[type='submit']",
    },

    breezy: {
      label: "Breezy",
      test: () => /breezy\.hr/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    rippling: {
      label: "Rippling",
      test: () => /rippling\.com|ats\.rippling/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    jazzhr: {
      label: "JazzHR",
      test: () => /applytojob\.com|jazz\.co/.test(location.hostname),
      formSelector: "#job_application, form",
      jobTitle: () => text("h1, .job-title") || document.title,
      submitButton: "input[type='submit'], button[type='submit']",
    },

    recruitee: {
      label: "Recruitee",
      test: () => /recruitee\.com/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    teamtailor: {
      label: "Teamtailor",
      test: () => /teamtailor\.com/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    adp: {
      label: "ADP",
      // Recruiting Management (myjobs.adp.com) and Workforce Now's Career
      // Center (workforcenow.adp.com). Their questions are ADP's SDF web
      // components, answered through `M.isSdfField` and friends.
      test: () => /adp\.com|workforcenow/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      company: () => adpCompany(),
      // Each step's own "Next": an `sdf-button` on Recruiting Management, the
      // footer button on Workforce Now.
      nextButton: "sdf-button.wizard-next-step-btn, #ja_sv_cw_next_footer_btn",
      submitButton: "button[type='submit'], sdf-button.wizard-next-step-btn, #ja_sv_cw_next_footer_btn",
      quirks: { multiStep: true },
    },

    personio: {
      label: "Personio",
      test: () => /personio\.(de|com)/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    pinpoint: {
      label: "Pinpoint",
      test: () => /pinpointhq\.com/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    dover: {
      label: "Dover",
      test: () => /dover\.io|dover\.com/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    bullhorn: {
      label: "Bullhorn",
      test: () => /bullhorn(staffing)?\.com|jobs\.bullhorn/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    paylocity: {
      label: "Paylocity",
      test: () => /paylocity\.com/.test(location.hostname),
      formSelector: "form",
      jobTitle: () => text("h1") || document.title,
      submitButton: "button[type='submit']",
    },

    generic: {
      label: "Generic form",
      test: () => true,
      formSelector: "form",
      jobTitle: () =>
        attr("meta[property='og:title']", "content") ||
        text("h1") ||
        document.title,
      company: () => attr("meta[property='og:site_name']", "content"),
      submitButton: "button[type='submit'], input[type='submit']",
    },
  };

  /** Returns the first adapter whose test passes; `generic` always matches last. */
  function detect() {
    for (const [key, adapter] of Object.entries(ADAPTERS)) {
      if (key === "generic") continue;
      try {
        if (adapter.test()) return { key, ...adapter };
      } catch {
        /* a broken test shouldn't stop detection */
      }
    }
    return { key: "generic", ...ADAPTERS.generic };
  }

  /** Best-effort posting metadata for the tracker. */
  function readJobMeta(adapter) {
    const pick = (fn) => { try { return fn?.(); } catch { return null; } };

    const jsonLd = (() => {
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(node.textContent);
          const item = Array.isArray(data) ? data.find((d) => d["@type"] === "JobPosting") : data;
          if (item?.["@type"] === "JobPosting") return item;
        } catch { /* malformed ld+json is common */ }
      }
      return null;
    })();

    const locationText =
      jsonLd?.jobLocation?.address?.addressLocality ||
      document.querySelector("[class*='location'], [data-automation-id*='location']")?.textContent?.trim() ||
      null;

    return {
      jobTitle: (jsonLd?.title || pick(adapter.jobTitle) || document.title || "Application").slice(0, 180),
      company:
        (jsonLd?.hiringOrganization?.name || pick(adapter.company) || location.hostname.replace(/^www\./, "").split(".")[0])
          ?.slice(0, 120) || null,
      companyDomain: location.hostname,
      location: locationText?.slice(0, 120) || null,
      url: location.href.split("#")[0],
      ats: adapter.key,
      description:
        jsonLd?.description?.replace(/<[^>]+>/g, " ").slice(0, 6000) ||
        document.querySelector("[class*='description'], #content, main")?.textContent?.slice(0, 6000) ||
        "",
    };
  }

  global.APPLI_FILL_ATS = { ADAPTERS, detect, readJobMeta };
})(typeof window !== "undefined" ? window : globalThis);
