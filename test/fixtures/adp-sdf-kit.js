/**
 * ADP's SDF web components, as the application pages draw them.
 *
 * ADP Recruiting Management (myjobs.adp.com) builds its apply flow out of
 * `sdf-*` custom elements, and Workforce Now uses the same ones for its
 * questions. Their public surface is what other fillers read off the live
 * pages (Jobright's ADP modules):
 *
 *   sdf-input / sdf-textarea   the box is an <input>/<textarea> inside the
 *                              element's shadow root; the element emits
 *                              composed `sdfInput` / `sdfChange` / `sdfBlur`
 *   sdf-select-simple          a shadow root with the frame
 *                              (`[part=frame][role=button].trigger-button`),
 *                              `#selected-label` showing the choice, an
 *                              `sdf-icon.expansion-control`, and an
 *                              `sdf-floating-pane` (`.floating-pane-hidden`
 *                              while closed) holding `[role=listbox]#listbox`.
 *                              Choices are light-DOM `sdf-select-item`s (slotted
 *                              into the list), or `[role=option]` rows drawn in
 *                              the shadow root from `items` — a few at a time,
 *                              more as the list is scrolled — with a filter box
 *                              (`input[part=filter-input]#select-filter-input`)
 *   sdf-radio-group            role=radiogroup, drawn in the light DOM, with its
 *                              `.sdf-form-control-wrapper--label`
 *   sdf-radio-button           `aria-checked` on the element, `[role=radio]` in
 *                              its shadow root; its text in `label` or inside it
 *   sdf-checkbox               `aria-checked` and `label` on the element
 *   sdf-date-picker            an <input> (MM/DD/YYYY) in its shadow root
 *   sdf-phone-number-input     a country `sdf-select-simple[embedded-context=
 *                              phone-number]` and an `input[type=tel]`, both in
 *                              its shadow root
 *   sdf-button                 a <button> in its shadow root
 *
 * The ways these may be drawn that a filler cannot see from outside are
 * switches, so each is tested:
 *
 *   window.__sdf = {
 *     lightBoxes: bool,   sdf-input / sdf-textarea / sdf-date-picker draw their
 *                         box in their own light DOM (scoped) instead
 *     portal: bool,       an open list is drawn in a floating pane at the end of
 *                         the page, not inside the list
 *     labelItems: bool,   an sdf-select-item names itself only by `label`,
 *                         drawn in its own shadow root
 *     pickLatency: ms,    a choice is shown this long after the click
 *     quietFrame: bool,   an open list says so nowhere on the list itself: no
 *                         `aria-expanded` on its frame, no `open` class (with
 *                         `portal`, the only sign is the pane at the page's end)
 *   }
 *
 * Nothing here answers to a value set from outside: a choice is made by
 * clicking (or the keyboard) and a box takes what is typed into it, as on the
 * live pages.
 */
(function () {
  if (window.customElements.get("sdf-input")) return;

  const emit = (host, name, detail) =>
    host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cfg = () => window.__sdf || {};

  const BASE_CSS = `
    :host{display:block;font:14px system-ui,sans-serif;color:#222}
    :host([hidden]){display:none}
    input,textarea{font:inherit;padding:8px 10px;border:1px solid #8a8a8a;border-radius:4px;width:100%;box-sizing:border-box;background:#fff}
    :host([invalid]) input,:host([invalid]) textarea,:host([invalid]) .trigger-button{border-color:#c0392b}
    label{font-size:13px;color:#444}
  `;
  const LIGHT_CSS = "sdf-input,sdf-textarea,sdf-date-picker{display:block}sdf-input input,sdf-textarea textarea,sdf-date-picker input{font:inherit;padding:8px 10px;border:1px solid #8a8a8a;border-radius:4px;width:100%;box-sizing:border-box}";

  /** Where a component draws: its shadow root, or itself when it draws in its light DOM. */
  function drawRoot(host, light) {
    if (light) {
      if (!document.getElementById("sdf-light-css")) {
        const style = document.createElement("style");
        style.id = "sdf-light-css";
        style.textContent = LIGHT_CSS;
        document.head.appendChild(style);
      }
      return host;
    }
    return host.shadowRoot || host.attachShadow({ mode: "open" });
  }

  /* ---------------- sdf-input / sdf-textarea ---------------- */
  class SdfInput extends HTMLElement {
    constructor() {
      super();
      this._value = "";
    }
    get multiline() { return false; }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      const light = Boolean(cfg().lightBoxes);
      const root = drawRoot(this, light);
      const label = this.getAttribute("label");
      const type = this.getAttribute("type") || "text";
      const max = this.getAttribute("maxlength");
      const idAttr = light ? "" : ' id="input"';
      const box = this.multiline
        ? `<textarea${idAttr} part="input" class="input" rows="3"${max ? ` maxlength="${esc(max)}"` : ""}></textarea>`
        : `<input${idAttr} part="input" class="input" type="${esc(type)}" autocomplete="off"${max ? ` maxlength="${esc(max)}"` : ""}>`;
      root.innerHTML = `${light ? "" : `<style>${BASE_CSS}</style>`}
        <div class="sdf-form-control-wrapper" part="wrapper">
          ${label ? `<label class="sdf-form-control-wrapper--label" part="label"${light ? "" : ' for="input"'}>${esc(label)}</label>` : ""}
          <div class="input-container" part="input-container">${box}</div>
        </div>`;
      const input = root.querySelector(".input");
      if (this.hasAttribute("disabled")) input.disabled = true;
      if (this.getAttribute("placeholder")) input.placeholder = this.getAttribute("placeholder");
      input.addEventListener("input", (e) => { e.stopPropagation(); this._value = input.value; emit(this, "sdfInput", input.value); });
      input.addEventListener("change", (e) => { e.stopPropagation(); this._value = input.value; emit(this, "sdfChange", input.value); });
      input.addEventListener("blur", () => emit(this, "sdfBlur", input.value));
    }
    get value() { return this._value; }
  }
  class SdfTextarea extends SdfInput { get multiline() { return true; } }
  customElements.define("sdf-input", SdfInput);
  customElements.define("sdf-textarea", SdfTextarea);

  /* ---------------- sdf-icon / sdf-floating-pane / sdf-button ---------------- */
  customElements.define("sdf-icon", class extends HTMLElement {});
  customElements.define("sdf-floating-pane", class extends HTMLElement {});
  customElements.define("sdf-button", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      this.shadowRoot.innerHTML = `<style>button{font:inherit;padding:8px 18px;border-radius:4px;border:1px solid #1a5bb5;background:#1a5bb5;color:#fff;cursor:pointer}</style><button part="button" type="button"><slot></slot></button>`;
    }
  });

  /* ---------------- sdf-select-item ---------------- */
  customElements.define("sdf-select-item", class extends HTMLElement {
    connectedCallback() {
      this.setAttribute("role", "option");
      if (!this.hasAttribute("aria-selected")) this.setAttribute("aria-selected", "false");
      this.tabIndex = -1;
      // An item that names itself only by `label`, drawn inside itself.
      if (cfg().labelItems && !this.shadowRoot) {
        const text = this.getAttribute("label") || this.textContent.trim();
        this.setAttribute("label", text);
        this.textContent = "";
        this.attachShadow({ mode: "open" }).innerHTML = `<span part="label">${esc(text)}</span>`;
      }
    }
  });
  const itemText = (n) => (n.getAttribute("label") || n.getAttribute("aria-label") || n.textContent || "").trim();

  /* ---------------- sdf-select-simple ---------------- */
  const PAGE = 25;
  class SdfSelectSimple extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._value = "";
      this._items = null;       // [{ value, label }] drawn in the shadow root
      this._open = false;
      this._shown = PAGE;
      this._active = -1;
    }
    set items(list) { this._items = Array.isArray(list) ? list : null; if (this._drawn) this.renderOptions(); }
    get items() { return this._items; }
    get value() { return this._value; }
    get filterable() { return this.hasAttribute("filterable"); }
    /** Rows are drawn by the list itself: from `items`, or always when the list is drawn elsewhere. */
    get drawsRows() { return Boolean(this._items) || this._portal; }

    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      this._portal = Boolean(cfg().portal);
      const placeholder = this.getAttribute("placeholder") || "Select";
      const paneHtml = `
            <div class="list floating-pane-content">
              ${this.filterable ? `<div class="filter"><input part="filter-input" id="select-filter-input" class="filter" placeholder="Filter" aria-label="Filter" autocomplete="off"><button class="filter-input-clear" aria-label="[CLEAR_BUTTON]" type="button">&times;</button></div>` : ""}
              <div id="listbox" role="listbox" tabindex="-1"></div>
            </div>`;
      this.shadowRoot.innerHTML = `<style>${BASE_CSS}
          .select-container{position:relative}
          .trigger-button{display:flex;align-items:center;justify-content:space-between;border:1px solid #8a8a8a;border-radius:4px;padding:8px 10px;min-height:20px;cursor:pointer;background:#fff}
          .placeholder{color:#888}
          sdf-floating-pane{position:absolute;left:0;right:0;z-index:30;background:#fff;border:1px solid #bbb;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,.15);display:block}
          sdf-floating-pane.floating-pane-hidden{display:none}
          #listbox{max-height:220px;overflow:auto}
          [role=option], ::slotted(sdf-select-item){display:block;padding:7px 10px;cursor:pointer}
          [role=option][aria-selected=true]{background:#e6eefb}
          .active{background:#f0f4fb}
          .filter{display:flex;gap:4px;padding:6px}
        </style>
        <div class="select-container" part="container">
          <div class="trigger-button" part="frame" role="button" tabindex="0" aria-haspopup="listbox" aria-expanded="false">
            <span id="selected-label" part="selected-label" class="selected-label"><span class="placeholder">${esc(placeholder)}</span></span>
            <sdf-icon class="expansion-control" part="expansion-trigger-control" aria-hidden="true">&#9662;</sdf-icon>
          </div>
          ${this._portal ? "" : `<sdf-floating-pane class="floating-pane-hidden" aria-hidden="true">${paneHtml}</sdf-floating-pane>`}
        </div>`;
      this.frame = this.shadowRoot.querySelector(".trigger-button");
      if (this._portal) {
        // The list is drawn at the end of the page while it is open.
        this.pane = document.createElement("sdf-floating-pane");
        this.pane.className = "floating-pane-hidden";
        this.pane.setAttribute("aria-hidden", "true");
        this.pane.style.cssText = "position:absolute;z-index:40;background:#fff;border:1px solid #bbb;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,.15);display:none;font:14px system-ui,sans-serif";
        this.pane.innerHTML = paneHtml;
        this.pane.querySelector("#listbox").style.cssText = "max-height:220px;overflow:auto";
        document.body.appendChild(this.pane);
      } else {
        this.pane = this.shadowRoot.querySelector("sdf-floating-pane");
      }
      this.listbox = this.pane.querySelector("#listbox");
      this.filterBox = this.pane.querySelector("#select-filter-input");
      if (this.hasAttribute("disabled")) this.frame.setAttribute("aria-disabled", "true");

      this.frame.addEventListener("click", () => {
        if (this.hasAttribute("disabled")) return;
        this._open ? this.close() : this.open();
      });
      this.frame.addEventListener("keydown", (e) => this.onKey(e));
      this.filterBox?.addEventListener("keydown", (e) => this.onKey(e));
      this.filterBox?.addEventListener("input", () => { this._shown = PAGE; this.renderOptions(); });
      this.pane.querySelector(".filter-input-clear")?.addEventListener("click", () => {
        this.filterBox.value = ""; this._shown = PAGE; this.renderOptions();
      });
      this.listbox.addEventListener("scroll", () => {
        if (!this.drawsRows) return;
        if (this.listbox.scrollTop + this.listbox.clientHeight >= this.listbox.scrollHeight - 30) {
          this._shown += PAGE;
          this.renderOptions();
        }
      });
      // A click on a light-DOM item reaches the element itself.
      this.addEventListener("click", (e) => {
        const item = e.composedPath().find((n) => n?.tagName === "SDF-SELECT-ITEM");
        if (item && this.contains(item) && this._open) this.choose(item.getAttribute("value"), itemText(item));
      });
      document.addEventListener("click", (e) => {
        const path = e.composedPath();
        if (this._open && !path.includes(this) && !path.includes(this.pane)) this.close();
      });
      this.renderOptions();
      const initial = this.getAttribute("value");
      if (initial) {
        const hit = this.allChoices().find((c) => c.value === initial);
        if (hit) this.paint(hit.value, hit.label, false);
      }
    }

    allChoices() {
      if (this._items) return this._items.map((i) => ({ value: String(i.value), label: String(i.label) }));
      return Array.from(this.querySelectorAll("sdf-select-item")).map((n) => ({ value: n.getAttribute("value"), label: itemText(n), node: n }));
    }
    matching() {
      const needle = (this.filterBox?.value || "").trim().toLowerCase();
      return this.allChoices().filter((c) => !needle || c.label.toLowerCase().includes(needle));
    }

    renderOptions() {
      if (!this.listbox) return;
      const showing = this.matching();
      if (this.drawsRows) {
        this.listbox.innerHTML = "";
        showing.slice(0, this._shown).forEach((c, i) => {
          const row = document.createElement("div");
          row.setAttribute("role", "option");
          row.id = `option-${i}`;
          row.className = "option";
          row.style.cssText = "display:block;padding:7px 10px;cursor:pointer";
          row.setAttribute("value", c.value);
          row.setAttribute("aria-selected", String(c.value === this._value));
          row.innerHTML = `<span class="option-label">${esc(c.label)}</span>`;
          row.addEventListener("click", (e) => { e.stopPropagation(); this.choose(c.value, c.label); });
          this.listbox.appendChild(row);
        });
      } else {
        if (!this.listbox.querySelector("slot")) this.listbox.appendChild(document.createElement("slot"));
        const keep = new Set(showing.map((c) => c.node));
        this.querySelectorAll("sdf-select-item").forEach((n) => { n.hidden = !keep.has(n); });
      }
    }

    open() {
      if (this._open) return;
      this._open = true;
      this._shown = PAGE;
      if (this.filterBox) this.filterBox.value = "";
      this.renderOptions();
      this.pane.classList.remove("floating-pane-hidden");
      this.pane.setAttribute("aria-hidden", "false");
      if (this._portal) {
        const r = this.frame.getBoundingClientRect();
        this.pane.style.left = `${r.left + scrollX}px`;
        this.pane.style.top = `${r.bottom + scrollY}px`;
        this.pane.style.width = `${r.width}px`;
        this.pane.style.display = "block";
      }
      if (!cfg().quietFrame) {
        this.frame.setAttribute("aria-expanded", "true");
        this.classList.add("open");
      }
      this._active = -1;
      (window.__log || []).push(`opened ${this.getAttribute("formcontrolname") || this.id || "select"}`);
      if (this.filterBox) setTimeout(() => this.filterBox.focus(), 0);
    }
    close() {
      if (!this._open) return;
      this._open = false;
      this.pane.classList.add("floating-pane-hidden");
      this.pane.setAttribute("aria-hidden", "true");
      if (this._portal) this.pane.style.display = "none";
      this.frame.setAttribute("aria-expanded", "false");
      this.frame.removeAttribute("aria-activedescendant");
      this.classList.remove("open");
      this.pane.querySelectorAll(".active").forEach((n) => n.classList.remove("active"));
      this.querySelectorAll(".active").forEach((n) => n.classList.remove("active"));
    }
    visibleRows() {
      return this.drawsRows
        ? Array.from(this.listbox.querySelectorAll("[role=option]"))
        : Array.from(this.querySelectorAll("sdf-select-item")).filter((n) => !n.hidden);
    }
    onKey(e) {
      if (this.hasAttribute("disabled")) return;
      const rows = this.visibleRows();
      if (e.key === "Escape") { this.close(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!this._open) { this.open(); return; }
        rows.forEach((r) => r.classList.remove("active"));
        this._active = Math.max(0, Math.min(rows.length - 1, this._active + (e.key === "ArrowDown" ? 1 : -1)));
        const row = rows[this._active];
        if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }); }
        return;
      }
      if (e.key === "Enter" && this._open) {
        e.preventDefault();
        const row = rows[this._active];
        if (row) this.choose(row.getAttribute("value"), (row.tagName === "SDF-SELECT-ITEM" ? itemText(row) : row.textContent).trim());
      }
    }
    paint(value, label, announce = true) {
      this._value = value;
      const shown = this.shadowRoot.getElementById("selected-label");
      shown.innerHTML = `<span>${esc(label)}</span>`;
      this.querySelectorAll("sdf-select-item").forEach((n) => n.setAttribute("aria-selected", String(n.getAttribute("value") === value)));
      this.renderOptions();
      if (announce) emit(this, "sdfChange", value);
    }
    choose(value, label) {
      const delay = Number(cfg().pickLatency || 0);
      const done = () => {
        this.paint(value, label);
        (window.__log || []).push(`picked ${this.getAttribute("formcontrolname") || this.id || "select"}: ${label}`);
        this.close();
        this.frame.focus();
      };
      delay ? setTimeout(done, delay) : done();
    }
  }
  customElements.define("sdf-select-simple", SdfSelectSimple);

  /* ---------------- sdf-radio-group / sdf-radio-button ---------------- */
  customElements.define("sdf-radio-group", class extends HTMLElement {
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      this.setAttribute("role", "radiogroup");
      this._value = "";
      const label = this.getAttribute("label");
      if (label) {
        const wrap = document.createElement("div");
        wrap.className = "sdf-form-control-wrapper";
        wrap.innerHTML = `<label class="sdf-form-control-wrapper--label">${esc(label)}</label>`;
        this.prepend(wrap);
      }
      this.addEventListener("sdf-radio-pick", (e) => {
        e.stopPropagation();
        const picked = e.target;
        this.querySelectorAll("sdf-radio-button").forEach((b) => b.setChecked(b === picked));
        this._value = picked.getAttribute("value");
        const text = (picked.getAttribute("label") || picked.textContent).trim();
        (window.__log || []).push(`answered ${this.getAttribute("formcontrolname") || this.id || "radio"}: ${text}`);
        emit(this, "sdfChange", this._value);
      });
    }
    get value() { return this._value; }
  });
  customElements.define("sdf-radio-button", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      if (!this.hasAttribute("aria-checked")) this.setAttribute("aria-checked", "false");
      const label = this.getAttribute("label");
      this.shadowRoot.innerHTML = `<style>
          :host{display:inline-block;margin:4px 14px 4px 0;font:14px system-ui,sans-serif}
          .radio{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
          .indicator{width:16px;height:16px;border:1px solid #777;border-radius:50%;display:inline-block}
          :host([aria-checked=true]) .indicator{background:#1a5bb5}
        </style>
        <div class="radio" part="radio" role="radio" aria-checked="false" tabindex="0">
          <span class="indicator" part="indicator"></span><span class="label" part="label">${label ? esc(label) : ""}<slot></slot></span>
        </div>`;
      const pick = () => {
        if (this.hasAttribute("disabled") || this.getAttribute("aria-checked") === "true") return;
        this.dispatchEvent(new CustomEvent("sdf-radio-pick", { bubbles: true }));
      };
      this.addEventListener("click", pick);
      this.shadowRoot.querySelector(".radio").addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); pick(); }
      });
    }
    setChecked(on) {
      this.setAttribute("aria-checked", String(on));
      this.shadowRoot.querySelector(".radio")?.setAttribute("aria-checked", String(on));
    }
  });

  /* ---------------- sdf-checkbox ---------------- */
  customElements.define("sdf-checkbox", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); this._checked = false; }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      this.setAttribute("aria-checked", "false");
      const label = this.getAttribute("label");
      this.shadowRoot.innerHTML = `<style>
          :host{display:block;margin:6px 0;font:14px system-ui,sans-serif}
          .checkbox{display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer}
          .box{width:16px;height:16px;border:1px solid #777;border-radius:3px;display:inline-block;flex:none}
          :host([aria-checked=true]) .box{background:#1a5bb5}
        </style>
        <div class="checkbox" part="checkbox" role="checkbox" aria-checked="false" tabindex="0">
          <span class="box" part="box"></span><span class="label" part="label">${label ? esc(label) : ""}<slot></slot></span>
        </div>`;
      const toggle = () => {
        if (this.hasAttribute("disabled")) return;
        this._checked = !this._checked;
        this.setAttribute("aria-checked", String(this._checked));
        this.shadowRoot.querySelector(".checkbox").setAttribute("aria-checked", String(this._checked));
        (window.__log || []).push(`${this._checked ? "ticked" : "unticked"} ${this.getAttribute("formcontrolname") || this.id || "checkbox"}`);
        emit(this, "sdfChange", this._checked);
      };
      this.addEventListener("click", toggle);
      this.shadowRoot.querySelector(".checkbox").addEventListener("keydown", (e) => {
        if (e.key === " ") { e.preventDefault(); toggle(); }
      });
    }
    get checked() { return this._checked; }
  });

  /* ---------------- sdf-date-picker ---------------- */
  customElements.define("sdf-date-picker", class extends HTMLElement {
    constructor() { super(); this._value = ""; }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      const light = Boolean(cfg().lightBoxes);
      const root = drawRoot(this, light);
      root.innerHTML = `${light ? "" : `<style>${BASE_CSS} .date-picker{display:flex;gap:6px}</style>`}
        <div class="date-picker" part="container">
          <input${light ? "" : ' id="date-input"'} class="date-input" part="input" type="text" placeholder="MM/DD/YYYY" autocomplete="off">
          <button class="calendar-button" part="calendar-button" aria-label="Open calendar" type="button">&#128197;</button>
        </div>`;
      const input = root.querySelector(".date-input");
      input.addEventListener("input", (e) => { e.stopPropagation(); this._value = input.value; emit(this, "sdfInput", input.value); });
      input.addEventListener("change", (e) => { e.stopPropagation(); this._value = input.value; emit(this, "sdfChange", input.value); });
      input.addEventListener("blur", () => emit(this, "sdfBlur", input.value));
    }
    get value() { return this._value; }
  });

  /* ---------------- sdf-phone-number-input ---------------- */
  const COUNTRIES = [
    ["us", "United States", "+1"], ["ca", "Canada", "+1"], ["in", "India", "+91"], ["gb", "United Kingdom", "+44"],
    ["mx", "Mexico", "+52"], ["ph", "Philippines", "+63"], ["de", "Germany", "+49"], ["au", "Australia", "+61"],
  ];
  customElements.define("sdf-phone-number-input", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); this._number = ""; this._country = "us"; }
    connectedCallback() {
      if (this._drawn) return;
      this._drawn = true;
      this.shadowRoot.innerHTML = `<style>${BASE_CSS} .phone{display:flex;gap:8px} .phone sdf-select-simple{width:42%}</style>
        <div class="phone" part="container">
          <sdf-select-simple embedded-context="phone-number" class="country-select" aria-label="Country code" value="us">
            ${COUNTRIES.map(([iso, name, dial]) => `<sdf-select-item value="${iso}" aria-label="${esc(name)}">${esc(name)} (${dial})</sdf-select-item>`).join("")}
          </sdf-select-simple>
          <input type="tel" id="phone-input" part="input" autocomplete="off" placeholder="(555) 555-5555">
        </div>`;
      const select = this.shadowRoot.querySelector("sdf-select-simple");
      const input = this.shadowRoot.getElementById("phone-input");
      const announce = (name) => emit(this, name, { number: this._number, countryCode: this._country });
      select.addEventListener("sdfChange", (e) => { e.stopPropagation(); this._country = e.detail; announce("sdfChange"); });
      input.addEventListener("input", () => { this._number = input.value; announce("sdfInput"); });
      input.addEventListener("change", () => { this._number = input.value; announce("sdfChange"); });
      input.addEventListener("blur", () => emit(this, "sdfBlur", this._number));
    }
    get value() { return { number: this._number, countryCode: this._country }; }
  });
})();
