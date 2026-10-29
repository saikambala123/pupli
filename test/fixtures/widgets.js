/**
 * Mock ATS widgets used by the autofill test harness.
 *
 * These reproduce the three behaviours that broke the real extension:
 *   - portalled listboxes that render at the end of <body>, far from the
 *     control that owns them (Workday, Oracle, SAP)
 *   - "stubborn" menus that ignore Escape and only close when the control is
 *     clicked again (Oracle's date pickers behave this way)
 *   - a widget that reverts its committed value when something synthesises a
 *     click on <body> (SAP SuccessFactors — the "Master's Degree flips back to
 *     No Selection" flicker in the bug report)
 *
 * Instrumentation records, per control: how many times its menu was opened,
 * every committed value, and the maximum number of menus on screen at once.
 */
window.ZTEST = {
  opens: {},
  values: {},          // id -> [committed value, ...] in order
  openNow: new Set(),
  maxConcurrent: 0,
  bodyClicks: 0,
  note(id, value) {
    (this.values[id] = this.values[id] || []).push(value);
  },
  opened(id) {
    this.opens[id] = (this.opens[id] || 0) + 1;
    this.openNow.add(id);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.openNow.size);
  },
  closed(id) {
    this.openNow.delete(id);
  },
  reset() {
    this.opens = {}; this.values = {}; this.openNow = new Set();
    this.maxConcurrent = 0; this.bodyClicks = 0;
  },
};

document.addEventListener("click", (e) => {
  if (e.target === document.body) window.ZTEST.bodyClicks++;
}, true);

/**
 * Builds one portalled combobox.
 *
 * @param {object} spec
 *   id            control id
 *   label         visible label text
 *   options       array of option strings
 *   stubborn      menu ignores Escape (must be closed by re-clicking)
 *   revertOnBodyClick  committed value resets when <body> receives a click
 *   placeholder   text shown when nothing is selected
 */
function makeCombobox(spec) {
  const {
    id, label, options,
    stubborn = false,
    revertOnBodyClick = false,
    placeholder = "Select One",
  } = spec;

  const wrap = document.createElement("div");
  wrap.className = "field";

  const labelEl = document.createElement("label");
  labelEl.id = `${id}-label`;
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-labelledby", `${id}-label`);
  button.setAttribute("aria-controls", `${id}-menu`);
  button.textContent = placeholder;
  wrap.appendChild(button);

  // The menu lives at the end of <body>, not inside the field — this is what
  // makes a document-wide option scan pick up the wrong list.
  const menu = document.createElement("div");
  menu.id = `${id}-menu`;
  menu.setAttribute("role", "listbox");
  menu.style.cssText = "position:absolute;left:0;top:0;width:260px;background:#fff;border:1px solid #ccc;display:none;";
  options.forEach((text, i) => {
    const opt = document.createElement("div");
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", "false");
    opt.id = `${id}-opt-${i}`;
    opt.textContent = text;
    opt.style.cssText = "padding:4px 8px;height:20px;";
    opt.addEventListener("click", () => commit(text, opt));
    menu.appendChild(opt);
  });
  document.body.appendChild(menu);

  let open = false;
  let committed = "";

  const show = () => {
    if (open) return;
    open = true;
    menu.style.display = "block";
    button.setAttribute("aria-expanded", "true");
    window.ZTEST.opened(id);
  };
  const hide = () => {
    if (!open) return;
    open = false;
    menu.style.display = "none";
    button.setAttribute("aria-expanded", "false");
    window.ZTEST.closed(id);
  };
  const commit = (text, opt) => {
    committed = text;
    button.textContent = text;
    button.setAttribute("aria-valuetext", text);
    menu.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute("aria-selected", "false"));
    opt?.setAttribute("aria-selected", "true");
    window.ZTEST.note(id, text);
    hide();
    button.dispatchEvent(new Event("change", { bubbles: true }));
  };

  button.addEventListener("click", () => (open ? hide() : show()));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === " " || e.key === "Enter") show();
    if (e.key === "Escape" && !stubborn) hide();
  });
  if (!stubborn) {
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  }

  if (revertOnBodyClick) {
    // The SAP behaviour: a synthetic click whose target is <body> is read as
    // "cancel", and the committed value is thrown away.
    document.addEventListener("click", (e) => {
      if (e.target === document.body && committed) {
        committed = "";
        button.textContent = placeholder;
        button.removeAttribute("aria-valuetext");
        window.ZTEST.note(id, placeholder);
      }
    }, true);
  }

  return wrap;
}

function makeInput(spec) {
  const { id, label, type = "text", value = "" } = spec;
  const wrap = document.createElement("div");
  wrap.className = "field";
  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.id = id;
  input.name = id;
  input.value = value;
  input.addEventListener("change", () => window.ZTEST.note(id, input.value));
  wrap.append(labelEl, input);
  return wrap;
}

function makeSelect(spec) {
  const { id, label, options } = spec;
  const wrap = document.createElement("div");
  wrap.className = "field";
  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  const select = document.createElement("select");
  select.id = id;
  select.name = id;
  ["Select One", ...options].forEach((text, i) => {
    const opt = document.createElement("option");
    opt.value = i === 0 ? "" : text;
    opt.textContent = text;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => window.ZTEST.note(id, select.value));
  wrap.append(labelEl, select);
  return wrap;
}

function makeRadioGroup(spec) {
  const { name, legend, options } = spec;
  const fs = document.createElement("fieldset");
  const lg = document.createElement("legend");
  lg.textContent = legend;
  fs.appendChild(lg);
  options.forEach((text, i) => {
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.id = `${name}-${i}`;
    input.value = text;
    const lab = document.createElement("label");
    lab.setAttribute("for", input.id);
    lab.textContent = text;
    input.addEventListener("change", () => { if (input.checked) window.ZTEST.note(name, text); });
    row.append(input, lab);
    fs.appendChild(row);
  });
  return fs;
}

window.ZWIDGETS = { makeCombobox, makeInput, makeSelect, makeRadioGroup };

/* ------------------------------------------------------------------ */
/*  iCIMS-style decorated dropdowns                                    */
/* ------------------------------------------------------------------ */

/**
 * A dropdown that is really a hidden <select> wearing a costume.
 *
 * This is the shape iCIMS uses for Country: the visible control shows
 * "— Make a Selection —", the option list is portalled to the end of <body>,
 * and the search box floats *above* the list rather than inside it. The value
 * the form submits lives in the hidden <select>, which the widget keeps in
 * step by listening for its change event.
 *
 * @param spec.searchBox   render the floating "— Type to Search —" input
 * @param spec.exposeRole  give the visible widget role="combobox" (some iCIMS
 *                         builds do, some render a bare div with no ARIA)
 */
function makeBackedDropdown(spec) {
  const { id, label, options, searchBox = true, exposeRole = true, placeholder = "— Make a Selection —" } = spec;

  const wrap = document.createElement("div");
  wrap.className = "field";

  const labelEl = document.createElement("label");
  labelEl.id = `${id}-label`;
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  // The real control, hidden but still the thing that submits.
  const select = document.createElement("select");
  select.id = id;
  select.name = id;
  select.style.display = "none";
  [placeholder, ...options].forEach((text, i) => {
    const opt = document.createElement("option");
    opt.value = i === 0 ? "" : text;
    opt.textContent = text;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    display.textContent = select.value || placeholder;
    if (select.value) window.ZTEST.note(id, select.value);
  });
  wrap.appendChild(select);

  const display = document.createElement("div");
  display.id = `${id}-widget`;
  display.className = "icims-dropdown";
  display.textContent = placeholder;
  display.style.cssText = "border:1px solid #999;padding:4px 8px;min-width:220px;min-height:20px;cursor:pointer;";
  if (exposeRole) {
    display.setAttribute("role", "combobox");
    display.setAttribute("aria-expanded", "false");
    display.setAttribute("aria-labelledby", `${id}-label`);
  }
  wrap.appendChild(display);

  // Portalled list, plus a search box that is a sibling of it, not a child.
  const menu = document.createElement("div");
  menu.id = `${id}-menu`;
  menu.setAttribute("role", "listbox");
  menu.style.cssText = "position:absolute;left:0;top:0;width:280px;max-height:260px;overflow:auto;background:#fff;border:1px solid #ccc;display:none;";

  const search = document.createElement("input");
  search.type = "text";
  search.id = `${id}-search`;
  search.placeholder = "— Type to Search —";
  search.style.cssText = "position:absolute;left:0;top:0;width:280px;display:none;";

  const render = (filter = "") => {
    menu.innerHTML = "";
    const needle = filter.trim().toLowerCase();
    [placeholder, ...options]
      .filter((text) => !needle || text.toLowerCase().includes(needle))
      .slice(0, 40)                      // the real list is windowed too
      .forEach((text) => {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.textContent = text;
        opt.style.cssText = "padding:4px 8px;height:20px;";
        opt.addEventListener("click", () => {
          if (text !== placeholder) {
            select.value = text;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          hide();
        });
        menu.appendChild(opt);
      });
  };

  let open = false;
  const show = () => {
    if (open) return;
    open = true;
    render(searchBox ? search.value : "");
    menu.style.display = "block";
    if (searchBox) search.style.display = "block";
    display.setAttribute("aria-expanded", "true");
    window.ZTEST.opened(id);
  };
  const hide = () => {
    if (!open) return;
    open = false;
    menu.style.display = "none";
    search.style.display = "none";
    display.setAttribute("aria-expanded", "false");
    window.ZTEST.closed(id);
  };

  display.addEventListener("click", () => (open ? hide() : show()));
  search.addEventListener("input", () => render(search.value));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  document.body.append(menu, search);
  return wrap;
}

/**
 * A select whose choices only exist once another field has been answered —
 * "State/Province" showing "Please select a country", and iCIMS's
 * "Please specify" waiting on "How did you hear about us?".
 */
function makeDependentSelect(spec) {
  const { id, label, parentId, waitingText, optionsFor } = spec;

  const wrap = document.createElement("div");
  wrap.className = "field";
  const labelEl = document.createElement("label");
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;

  const select = document.createElement("select");
  select.id = id;
  select.name = id;

  const setWaiting = () => {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = waitingText;
    select.appendChild(opt);
  };
  setWaiting();

  select.addEventListener("change", () => { if (select.value) window.ZTEST.note(id, select.value); });
  wrap.append(labelEl, select);

  // Populate only once the parent has a value, the way a real cascade behaves.
  const sync = () => {
    const parent = document.getElementById(parentId);
    const parentValue = parent?.value || "";
    if (!parentValue) return setWaiting();
    const choices = optionsFor(parentValue);
    if (!choices.length) return setWaiting();
    select.innerHTML = "";
    ["— Make a Selection —", ...choices].forEach((text, i) => {
      const opt = document.createElement("option");
      opt.value = i === 0 ? "" : text;
      opt.textContent = text;
      select.appendChild(opt);
    });
  };
  setTimeout(() => {
    const parent = document.getElementById(parentId);
    parent?.addEventListener("change", sync);
  }, 0);

  return wrap;
}

/**
 * The Greenhouse (job-boards.greenhouse.io) dropdown — a react-select control.
 *
 * This is the shape the August bug report is about, and it breaks every
 * assumption a "read the control's own text" reader makes:
 *
 *   - the control IS an <input role="combobox">, and its `value` is the *search
 *     text*, so it is empty whenever the menu is closed — even when answered
 *   - the chosen answer is rendered in a **sibling** div (`select__single-value`),
 *     never inside the input
 *   - what the form submits is a separate hidden <input>, not a <select>, so
 *     there is no backing select to read either
 *   - `aria-activedescendant` exists only while the menu is open
 *
 * A reader that only inspects the input therefore sees "" for a fully answered
 * question, which makes the engine re-plan it, rewrite it, fail to verify it,
 * retry it, and finally hand it to the AI pass — the user-visible "it goes back
 * to completed fields and edits them again".
 *
 * @param spec.clearable  render the "×" clear indicator Greenhouse shows
 */
function makeReactSelect(spec) {
  const { id, label, options, placeholder = "Select...", clearable = true } = spec;

  const wrap = document.createElement("div");
  wrap.className = "select__container field";

  const labelEl = document.createElement("label");
  labelEl.id = `${id}-label`;
  labelEl.className = "select__label";
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const outer = document.createElement("div");
  outer.className = "select--container";

  const control = document.createElement("div");
  control.className = "select__control";
  control.style.cssText = "border:1px solid #999;padding:4px 8px;min-width:280px;min-height:24px;display:flex;gap:6px;align-items:center;cursor:pointer;";

  const valueContainer = document.createElement("div");
  valueContainer.className = "select__value-container";
  valueContainer.style.cssText = "display:flex;flex:1;gap:4px;align-items:center;min-height:20px;";

  // Placeholder and single-value are siblings of the input, exactly as
  // react-select renders them.
  const placeholderEl = document.createElement("div");
  placeholderEl.className = "select__placeholder";
  placeholderEl.textContent = placeholder;
  placeholderEl.style.color = "#888";

  const singleValue = document.createElement("div");
  singleValue.className = "select__single-value";
  singleValue.id = `${id}-single-value`;
  singleValue.hidden = true;

  const inputContainer = document.createElement("div");
  inputContainer.className = "select__input-container";
  const input = document.createElement("input");
  input.className = "select__input";
  input.id = id;
  input.type = "text";
  input.autocomplete = "off";
  input.value = "";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "true");
  input.setAttribute("aria-labelledby", `${id}-label`);
  input.style.cssText = "border:0;outline:0;min-width:2px;width:100%;";
  inputContainer.appendChild(input);

  valueContainer.append(placeholderEl, singleValue, inputContainer);
  control.appendChild(valueContainer);

  const indicators = document.createElement("div");
  indicators.className = "select__indicators";
  if (clearable) {
    const clear = document.createElement("div");
    clear.className = "select__clear-indicator";
    clear.setAttribute("aria-hidden", "true");
    clear.textContent = "×";
    clear.hidden = true;
    indicators.appendChild(clear);
    wrap.__clear = clear;
  }
  const arrow = document.createElement("div");
  arrow.className = "select__dropdown-indicator";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "▾";
  indicators.appendChild(arrow);
  control.appendChild(indicators);

  outer.appendChild(control);

  // The menu is rendered inline inside the wrapper, not portalled.
  const menu = document.createElement("div");
  menu.className = "select__menu";
  menu.style.cssText = "position:absolute;background:#fff;border:1px solid #ccc;width:280px;max-height:240px;overflow:auto;display:none;z-index:20;";
  const menuList = document.createElement("div");
  menuList.className = "select__menu-list";
  menuList.id = `${id}-listbox`;
  menuList.setAttribute("role", "listbox");
  menu.appendChild(menuList);
  outer.appendChild(menu);

  // What the form actually posts. A hidden <input>, never a <select>.
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = id;
  hidden.value = "";
  outer.appendChild(hidden);

  wrap.appendChild(outer);

  let open = false;
  let committed = "";

  const paint = () => {
    singleValue.hidden = !committed;
    singleValue.textContent = committed;
    placeholderEl.hidden = Boolean(committed) || Boolean(input.value);
    if (wrap.__clear) wrap.__clear.hidden = !committed;
  };

  const commit = (text) => {
    committed = text;
    hidden.value = text;
    input.value = "";                    // react-select clears the search text
    paint();
    window.ZTEST.note(id, text);
    hide();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const render = () => {
    menuList.innerHTML = "";
    const needle = input.value.trim().toLowerCase();
    options
      .filter((text) => !needle || text.toLowerCase().includes(needle))
      .forEach((text, i) => {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(text === committed));
        opt.id = `${id}-option-${i}`;
        opt.className = "select__option";
        opt.textContent = text;
        opt.style.cssText = "padding:4px 8px;height:20px;";
        opt.addEventListener("click", () => commit(text));
        menuList.appendChild(opt);
      });
  };

  const show = () => {
    if (open) return;
    open = true;
    render();
    menu.style.display = "block";
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", menuList.id);
    const first = menuList.querySelector('[role="option"]');
    if (first) input.setAttribute("aria-activedescendant", first.id);
    window.ZTEST.opened(id);
  };
  const hide = () => {
    if (!open) return;
    open = false;
    menu.style.display = "none";
    input.setAttribute("aria-expanded", "false");
    // The menu is gone, so its ids are gone with it.
    input.removeAttribute("aria-activedescendant");
    input.removeAttribute("aria-controls");
    window.ZTEST.closed(id);
  };

  control.addEventListener("mousedown", (e) => {
    if (e.target === input) return;
    open ? hide() : show();
  });
  input.addEventListener("mousedown", () => show());
  input.addEventListener("focus", () => show());
  input.addEventListener("input", () => { paint(); open ? render() : show(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
    if (e.key === "ArrowDown") show();
  });
  if (wrap.__clear) {
    wrap.__clear.addEventListener("mousedown", (e) => { e.stopPropagation(); commit(""); });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  paint();
  return wrap;
}

/**
 * The other two families of dropdown that render their answer where the
 * control cannot see it.
 *
 * @param spec.flavour
 *   "antd"      wrapper div[role=combobox]; answer in `.ant-select-selection-item`,
 *               placeholder in `.ant-select-selection-placeholder`, value in a
 *               hidden input. Ant Design, and the many portals that copy it.
 *   "downshift" an <input role=combobox> that *does* keep the answer in its own
 *               value — Ashby, Lever, anything built on Downshift. Included so
 *               the react-select fix cannot regress the shape that already
 *               worked.
 */
function makeLibrarySelect(spec) {
  const { id, label, options, flavour = "antd", placeholder = "Please select" } = spec;

  const wrap = document.createElement("div");
  wrap.className = "field";
  const labelEl = document.createElement("label");
  labelEl.id = `${id}-label`;
  labelEl.setAttribute("for", id);
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const shell = document.createElement("div");
  shell.className = flavour === "antd" ? "ant-select" : "ds-select";
  shell.style.cssText = "position:relative;display:inline-block;";

  const menu = document.createElement("div");
  menu.setAttribute("role", "listbox");
  menu.id = `${id}-listbox`;
  menu.style.cssText = "position:absolute;top:26px;left:0;width:280px;background:#fff;border:1px solid #ccc;display:none;z-index:20;";

  let committed = "";
  let open = false;
  let control;
  let hidden = null;
  let valueNode = null;
  let placeholderNode = null;

  const paint = () => {
    if (flavour === "antd") {
      valueNode.textContent = committed;
      valueNode.hidden = !committed;
      placeholderNode.hidden = Boolean(committed);
      hidden.value = committed;
    } else {
      control.value = committed;
    }
  };

  const hide = () => {
    if (!open) return;
    open = false;
    menu.style.display = "none";
    control.setAttribute("aria-expanded", "false");
    window.ZTEST.closed(id);
  };
  const render = (filter = "") => {
    menu.innerHTML = "";
    const needle = filter.trim().toLowerCase();
    options
      .filter((t) => !needle || t.toLowerCase().includes(needle))
      .forEach((text, i) => {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(text === committed));
        opt.id = `${id}-option-${i}`;
        opt.textContent = text;
        opt.style.cssText = "padding:4px 8px;height:20px;";
        opt.addEventListener("click", () => {
          committed = text;
          paint();
          window.ZTEST.note(id, text);
          hide();
          control.dispatchEvent(new Event("change", { bubbles: true }));
        });
        menu.appendChild(opt);
      });
  };
  const show = () => {
    if (open) return;
    open = true;
    render(flavour === "downshift" ? control.value : "");
    menu.style.display = "block";
    control.setAttribute("aria-expanded", "true");
    window.ZTEST.opened(id);
  };

  if (flavour === "antd") {
    control = document.createElement("div");
    control.id = id;
    control.setAttribute("role", "combobox");
    control.setAttribute("aria-expanded", "false");
    control.setAttribute("aria-labelledby", `${id}-label`);
    control.tabIndex = 0;
    control.className = "ant-select-selector";
    control.style.cssText = "border:1px solid #999;padding:4px 8px;min-width:260px;min-height:20px;cursor:pointer;";

    placeholderNode = document.createElement("span");
    placeholderNode.className = "ant-select-selection-placeholder";
    placeholderNode.textContent = placeholder;
    valueNode = document.createElement("span");
    valueNode.className = "ant-select-selection-item";
    valueNode.hidden = true;
    control.append(placeholderNode, valueNode);

    hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = id;
    hidden.value = "";
    shell.appendChild(hidden);
  } else {
    control = document.createElement("input");
    control.id = id;
    control.name = id;
    control.type = "text";
    control.autocomplete = "off";
    control.placeholder = placeholder;
    control.setAttribute("role", "combobox");
    control.setAttribute("aria-expanded", "false");
    control.setAttribute("aria-autocomplete", "list");
    control.setAttribute("aria-labelledby", `${id}-label`);
    control.style.cssText = "border:1px solid #999;padding:4px 8px;min-width:260px;";
    control.addEventListener("input", () => (open ? render(control.value) : show()));
  }

  control.addEventListener("mousedown", () => (open ? hide() : show()));
  control.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
    if (e.key === "ArrowDown") show();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  shell.append(control, menu);
  wrap.appendChild(shell);
  paint();
  return wrap;
}

window.ZWIDGETS.makeBackedDropdown = makeBackedDropdown;
window.ZWIDGETS.makeDependentSelect = makeDependentSelect;
window.ZWIDGETS.makeReactSelect = makeReactSelect;
window.ZWIDGETS.makeLibrarySelect = makeLibrarySelect;
