/*
 * Application forms built with React 18, as Workday and Ashby build theirs.
 *
 * Loaded after React and ReactDOM. `window.__FORM` picks the form:
 *
 *   "workday-info"    Workday's My Information: First Name, Last Name,
 *                     Address Line 1, City, Postal Code. Each box keeps what
 *                     is typed in its own state and hands it to the page's
 *                     model only when it is left (onBlur), the way Workday's
 *                     validated boxes do. Save and Continue checks the model:
 *                     "The field First Name is required and must have a value."
 *   "workday-selfid"  The Voluntary Self-Identification of Disability step
 *                     (Form CC-305): Name, Employee ID and a MM / DD / YYYY
 *                     Date, all inside one role="group", as on SEI's tenant.
 *                     `window.__CALENDAR = true` gives the Date Workday's
 *                     calendar button.
 *   "ashby"           Ashby's application: Name (kept when left), Email, and
 *                     two Yes / No questions. Submit lists what is missing.
 *
 * `window.__POPUP_OPEN = true` makes the page behave as it does while the
 * extension's popup is open, which is how a fill is started: the page does not
 * have the focus, so the browser sends it no focus, blur, focusin or focusout
 * events (and no change event when a box is left). Cleared before the
 * applicant presses the page's own button, as clicking the page closes the
 * popup.
 */
(function () {
  const h = React.createElement;
  const { useState } = React;

  for (const type of ["focus", "blur", "focusin", "focusout"]) {
    window.addEventListener(type, (e) => {
      if (window.__POPUP_OPEN && e.isTrusted) e.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener("change", (e) => {
    const t = e.target;
    if (window.__POPUP_OPEN && e.isTrusted && t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !/^(checkbox|radio|file)$/i.test(t.type || "")) {
      e.stopImmediatePropagation();
    }
  }, true);

  window.__model = {};
  window.__errors = null;
  window.__blurs = 0;

  /** A box that hands its text to the model only when it is left. */
  function KeptOnLeave({ id, label, required, setModel, errors, automation, fkit, name, plain }) {
    const [text, setText] = useState("");
    const bad = errors && errors[id];
    const wrap = plain
      ? { className: "ashby-application-form-field-entry" }
      : { "data-automation-id": automation || `formField-${id}`, "data-fkit-id": fkit || `form--${id}`, className: "field" };
    return h("div", wrap,
      h("label", { htmlFor: id, className: plain ? "ashby-application-form-question-title" : undefined },
        label, required ? (plain ? h("span", null, "*") : h("abbr", { title: "required" }, "*")) : null),
      h("input", {
        id, name: name || id, type: "text", value: text, "aria-required": required ? "true" : undefined,
        "aria-invalid": bad ? "true" : "false",
        onChange: (e) => setText(e.target.value),
        onBlur: (e) => { window.__blurs++; const v = e.target.value; setModel((m) => ({ ...m, [id]: v })); },
      }),
      bad ? h("div", { "data-automation-id": "errorMessage", className: "err" }, bad) : null);
  }

  /** A box that hands its text to the model as it is typed. */
  function KeptOnChange({ id, label, required, setModel, errors, type = "text", name }) {
    const [text, setText] = useState("");
    const bad = errors && errors[id];
    return h("div", { className: "ashby-application-form-field-entry" },
      h("label", { htmlFor: id, className: "ashby-application-form-question-title" }, label, required ? h("span", null, "*") : null),
      h("input", {
        id, name: name || id, type, value: text, required,
        onChange: (e) => { const v = e.target.value; setText(v); setModel((m) => ({ ...m, [id]: v })); },
      }),
      bad ? h("div", { className: "err" }, bad) : null);
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  /**
   * Workday's calendar (window.__CALENDAR): the button beside the boxes opens
   * a month of days, today marked datePickerSelectedToday; a day clicked sets
   * the date in the page's model and closes it.
   */
  function Calendar({ onPick, onClose, shown }) {
    const [at, setAt] = useState(shown);
    const today = new Date();
    const days = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
    const turn = (n) => setAt(new Date(at.getFullYear(), at.getMonth() + n, 1));
    return h("div", { "data-automation-id": "datePicker", role: "dialog", style: { position: "absolute", zIndex: 9, background: "#fff", border: "1px solid #99a", padding: 6 },
      onKeyDown: (e) => { if (e.key === "Escape") onClose(); } },
      h("div", null,
        h("button", { type: "button", "aria-label": "Previous Month", onClick: () => turn(-1) }, "<"),
        h("span", { "data-automation-id": "datePickerMonth" }, `${MONTHS[at.getMonth()]} ${at.getFullYear()}`),
        h("button", { type: "button", "aria-label": "Next Month", onClick: () => turn(1) }, ">")),
      h("div", { role: "grid" }, Array.from({ length: days }, (_, i) => {
        const day = new Date(at.getFullYear(), at.getMonth(), i + 1);
        const isToday = day.toDateString() === today.toDateString();
        return h("button", {
          key: i, type: "button", role: "gridcell",
          "aria-label": `${MONTHS[at.getMonth()]} ${i + 1}, ${at.getFullYear()}`,
          "data-automation-id": isToday ? "datePickerSelectedToday" : "datePickerDay",
          onClick: () => onPick(day),
        }, String(i + 1));
      })));
  }

  /** Workday's MM / DD / YYYY date: three spinbuttons, the date kept in the page's model. */
  function DateBoxes({ id, label, model, setModel, errors }) {
    const date = model[id] || { month: "", day: "", year: "" };
    const [open, setOpen] = useState(false);
    const pad = (n) => String(n).padStart(2, "0");
    const part = (kind, cap, min, max, placeholder) => h("div", { "data-automation-id": `dateSection${kind}` },
      h("input", {
        id: `${id}-dateSection${kind}-input`, type: "text", role: "spinbutton",
        "data-automation-id": `dateSection${kind}-input`, "aria-label": kind,
        "aria-valuemin": min, "aria-valuemax": max, "aria-valuetext": date[kind.toLowerCase()] || placeholder,
        value: date[kind.toLowerCase()],
        onChange: (e) => {
          const digits = e.target.value.replace(/\D+/g, "").slice(0, cap);
          setModel((m) => ({ ...m, [id]: { ...(m[id] || { month: "", day: "", year: "" }), [kind.toLowerCase()]: digits } }));
        },
      }));
    const bad = errors && errors[id];
    return h("div", { "data-automation-id": "formField-dateSignedOn", "data-fkit-id": `selfIdentifiedDisabilityData--${id}`, className: "field" },
      h("label", { id: `${id}-label` }, label, h("abbr", { title: "required" }, "*")),
      h("div", { "data-automation-id": "dateInputWrapper", role: "group", "aria-labelledby": `${id}-label`, className: "wd-date" },
        part("Month", 2, 1, 12, "MM"), h("span", null, "/"),
        part("Day", 2, 1, 31, "DD"), h("span", null, "/"),
        part("Year", 4, 1900, 2100, "YYYY")),
      window.__CALENDAR ? h("div", { "data-automation-id": "dateIcon", role: "button", "aria-label": "Calendar", style: { display: "inline-block", cursor: "pointer", padding: "0 6px" },
        onClick: () => setOpen((o) => !o) }, "\u{1F4C5}") : null,
      open ? h(Calendar, {
        shown: date.year && date.month ? new Date(+date.year, +date.month - 1, 1) : new Date(),
        onClose: () => setOpen(false),
        onPick: (d) => {
          window.__pickedFromCalendar = true;
          setModel((m) => ({ ...m, [id]: { month: pad(d.getMonth() + 1), day: pad(d.getDate()), year: String(d.getFullYear()) } }));
          setOpen(false);
        },
      }) : null,
      bad ? h("div", { "data-automation-id": "errorMessage", className: "err" }, bad) : null);
  }

  function WorkdayInfo() {
    const [model, setModel] = useState({});
    const [errors, setErrors] = useState(null);
    window.__model = model;
    const fields = [
      ["legalName--firstName", "First Name"], ["legalName--lastName", "Last Name"],
      ["address--addressLine1", "Address Line 1"], ["address--city", "City"], ["address--postalCode", "Postal Code"],
    ];
    const save = () => {
      const bad = {};
      for (const [id, label] of fields) if (!String(model[id] || "").trim()) bad[id] = `The field ${label} is required and must have a value.`;
      setErrors(bad);
      window.__errors = Object.values(bad);
    };
    return h("div", { "data-automation-id": "applyFlowPage" },
      h("h2", null, "My Information"),
      h("div", { role: "group", "aria-label": "Legal Name" },
        h("h3", null, "Legal Name"),
        fields.slice(0, 2).map(([id, label]) => h(KeptOnLeave, { key: id, id, label, required: true, model, setModel, errors, automation: `formField-${id.split("--")[1]}`, fkit: `name--${id}` }))),
      h("div", { role: "group", "aria-label": "Address" },
        h("h3", null, "Address"),
        fields.slice(2).map(([id, label]) => h(KeptOnLeave, { key: id, id, label, required: true, model, setModel, errors, automation: `formField-${id.split("--")[1]}`, fkit: id }))),
      h("button", { type: "button", id: "save", "data-automation-id": "bottom-navigation-next-button", onClick: save }, "Save and Continue"));
  }

  function WorkdaySelfId() {
    const [model, setModel] = useState({});
    const [errors, setErrors] = useState(null);
    window.__model = model;
    const save = () => {
      const bad = {};
      if (!String(model.name || "").trim()) bad.name = "The field Name is required and must have a value.";
      const d = model.date || {};
      if (!(d.month && d.day && d.year)) bad.date = "The field Date is required and must have a value.";
      else if (!(+d.month >= 1 && +d.month <= 12 && +d.day >= 1 && +d.day <= 31 && /^\d{4}$/.test(d.year))) bad.date = `Error: Invalid Date: ${d.month}/${d.day}/${d.year}`;
      setErrors(bad);
      window.__errors = Object.values(bad);
    };
    return h("div", { "data-automation-id": "applyFlowPage" },
      h("h2", null, "Self Identify"),
      h("div", { role: "group", "aria-labelledby": "cc305-title" },
        h("h3", { id: "cc305-title" }, "Voluntary Self-Identification of Disability"),
        h("div", { "data-automation-id": "richText" }, h("p", null, "Form"), h("p", null, "CC-305"), h("p", null, "OMB Control Number"), h("p", null, "1250-0005"), h("p", null, "Expires"), h("p", null, "04/30/2026")),
        h(KeptOnLeave, { id: "name", label: "Name", required: true, model, setModel, errors, automation: "formField-name", fkit: "selfIdentifiedDisabilityData--name", name: "name" }),
        h(KeptOnLeave, { id: "employeeId", label: "Employee ID (if applicable)", required: false, model, setModel, errors, automation: "formField-employeeId", fkit: "selfIdentifiedDisabilityData--employeeId" }),
        h(DateBoxes, { id: "date", label: "Date", model, setModel, errors })),
      h("button", { type: "button", id: "save", "data-automation-id": "bottom-navigation-next-button", onClick: save }, "Save and Continue"));
  }

  function YesNo({ id, question, model, setModel, errors }) {
    const picked = model[id];
    return h("div", { className: "ashby-application-form-field-entry", "data-q": id },
      h("label", { htmlFor: id, className: "ashby-application-form-question-title" }, question),
      h("div", { className: "_yesno_hkyf8_143" },
        ["Yes", "No"].map((answer) => h("button", {
          key: answer, type: "button",
          className: `_option_1v5e2_35${picked === answer ? " _active_1v5e2_12" : ""}`,
          onClick: () => setModel((m) => ({ ...m, [id]: answer })),
        }, answer)),
        h("input", { type: "checkbox", id, name: id, tabIndex: -1, readOnly: true, checked: picked === "Yes",
          style: { position: "absolute", width: 0, height: 0, opacity: 0, margin: 0, padding: 0 } })),
      errors && errors[id] ? h("div", { className: "err" }, errors[id]) : null);
  }

  function Ashby() {
    const [model, setModel] = useState({});
    const [errors, setErrors] = useState(null);
    window.__model = model;
    const submit = (e) => {
      e.preventDefault();
      const bad = {};
      if (!String(model._systemfield_name || "").trim()) bad._systemfield_name = "This field is required";
      if (!String(model._systemfield_email || "").trim()) bad._systemfield_email = "This field is required";
      for (const id of ["q-auth", "q-sponsor"]) if (!model[id]) bad[id] = "This field is required";
      setErrors(bad);
      window.__errors = Object.keys(bad);
    };
    return h("div", { className: "ashby-application-form-container" },
      h("h1", null, "Platform Engineer II"),
      h("form", { className: "ashby-application-form", id: "app", noValidate: true, onSubmit: submit },
        h(KeptOnLeave, { id: "_systemfield_name", label: "Name", required: true, setModel, errors, name: "_systemfield_name", plain: true }),
        h(KeptOnChange, { id: "_systemfield_email", label: "Email", required: true, setModel, errors, type: "email" }),
        h(YesNo, { id: "q-auth", question: "Are you legally authorized to work in the United States without restrictions?", model, setModel, errors }),
        h(YesNo, { id: "q-sponsor", question: "Will you now or in the future require sponsorship authorization?", model, setModel, errors }),
        h("button", { type: "submit", id: "save" }, "Submit Application")));
  }

  const forms = { "workday-info": WorkdayInfo, "workday-selfid": WorkdaySelfId, ashby: Ashby };
  const root = document.getElementById("root");
  ReactDOM.createRoot(root).render(h(forms[window.__FORM] || WorkdayInfo));
})();
