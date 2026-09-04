// Form-widget kit for the Landing Page config editors (Audio/Webhooks/Settings/Lyrics
// tabs). Self-contained: every widget takes its value + an onChange-style callback as
// params and touches nothing outside itself — callers (app.js, overlay-panel.js) are
// responsible for markDirty()/re-render side effects inside the callback they pass in.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function grid(cols) {
  const g = document.createElement("div");
  g.className = "fgrid";
  g.style.cssText = `display:grid;grid-template-columns:${cols};gap:16px 20px`;
  return g;
}

// Single-column form pages (Audio/Webhooks/Settings) share one centered column so
// the content edge never lurches tab-to-tab and fields don't stretch to full width.
export function formCol() {
  const d = document.createElement("div");
  d.className = "fcol";
  return d;
}

export function sectionCard(title, subtitle) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:22px;margin-bottom:18px";
  if (title) {
    const h = document.createElement("div");
    h.style.cssText = "margin-bottom:16px";
    h.innerHTML = `<div style="font-family:var(--disp);font-size:16px;font-weight:700">${esc(title)}</div>` +
      (subtitle ? `<div style="font-size:12.5px;color:var(--dim);margin-top:2px">${esc(subtitle)}</div>` : "");
    card.appendChild(h);
  }
  return card;
}

export function field(label, value, onInput, opts = {}) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const inp = document.createElement("input");
  inp.className = "field" + (opts.ro ? " ro" : "");
  inp.value = value ?? "";
  if (opts.ro) inp.readOnly = true;
  if (opts.type) inp.type = opts.type;
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (!opts.ro && onInput) inp.oninput = () => onInput(inp.value);
  w.appendChild(inp);
  return w;
}

// Full-width setting row: title + description on the left, switch on the right,
// vertically centred, with a top divider. For standalone toggles (not grid cells).
export function settingRow(label, desc, on, onToggle) {
  const w = document.createElement("div");
  w.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding-top:18px;border-top:1px solid var(--line)";
  w.innerHTML = `<div style="min-width:0"><div style="font-size:14px;font-weight:600">${esc(label)}</div>` +
    (desc ? `<div style="font-size:12.5px;color:var(--dim);margin-top:2px">${esc(desc)}</div>` : "") + `</div>`;
  const sw = document.createElement("div");
  sw.className = "sw " + (on ? "on" : "off");
  sw.innerHTML = "<i></i>";
  sw.style.flex = "0 0 auto";
  sw.onclick = onToggle;
  w.appendChild(sw);
  return w;
}

// A masked secret editor. `cfg` = {isSet, get, set, onDirty, reveal?}: isSet (bool)
// at construction time, get()/set(v) read/write the backing field, onDirty() flags
// unsaved changes, and an optional async reveal() fetches the real value on demand
// (item 10) — only offered when the caller passes one (server-allowlisted keys).
export function secretRow(label, cfg) {
  const { isSet, get, set, onDirty, reveal } = cfg;
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const box = document.createElement("div");
  box.className = "field row";
  box.style.justifyContent = "space-between";
  let revealed = false, revealedValue = "";
  const link = (text, onClick) => {
    const a = document.createElement("a");
    a.href = "#"; a.style.cssText = "font-size:12px;white-space:nowrap;margin-left:12px";
    a.textContent = text; a.onclick = (e) => { e.preventDefault(); onClick(); };
    return a;
  };
  const render = () => {
    const current = get();
    box.innerHTML = "";
    if (typeof current === "string") {
      // Replace flow: typing a new value.
      const inp = document.createElement("input");
      inp.className = "field"; inp.type = "password"; inp.placeholder = "New value"; inp.value = current;
      inp.style.cssText = "border:none;background:transparent;padding:0;box-shadow:none";
      inp.oninput = () => { set(inp.value); onDirty(); };
      box.append(inp, link("Cancel", () => { set(isSet); revealed = false; render(); }));
    } else if (revealed) {
      // Showing the fetched plaintext, read-only.
      const val = document.createElement("input");
      val.className = "field"; val.readOnly = true; val.value = revealedValue;
      val.style.cssText = "border:none;background:transparent;padding:0;box-shadow:none;font-family:ui-monospace,monospace;font-size:13px";
      box.append(val, link("Hide", () => { revealed = false; render(); }),
        link("Replace", () => { set(""); revealed = false; onDirty(); render(); }));
    } else {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.style.cssText = isSet ? "background:var(--ind-s);color:var(--ind)" : "background:var(--warn-s);color:var(--warn)";
      pill.textContent = isSet ? "Set" : "Not set";
      pill.style.marginRight = "auto";
      box.append(pill);
      if (reveal && isSet) box.append(link("View", async () => {
        try { revealedValue = await reveal(); revealed = true; render(); } catch { /* leave masked */ }
      }));
      box.append(link("Replace", () => { set(""); onDirty(); render(); }));
    }
  };
  w.appendChild(box);
  render();
  return w;
}

export function ovSelect(label, val, pairs, onChange) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const s = document.createElement("select");
  s.className = "field";
  for (const opt of pairs) {
    const [text, value] = Array.isArray(opt) ? opt : [opt, opt];
    const op = document.createElement("option");
    op.value = value; op.textContent = text; if (value === String(val)) op.selected = true;
    s.appendChild(op);
  }
  s.onchange = () => onChange(s.value);
  w.appendChild(s);
  return w;
}

export function ovRange(label, val, min, max, step, onChange, fmt = (v) => v) {
  const w = document.createElement("div");
  const val0 = Number(val);
  w.innerHTML = `<label class="flabel">${esc(label)}: <span class="ovval" style="color:var(--ind)">${esc(fmt(val0))}</span></label>`;
  const inp = document.createElement("input");
  inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = val0;
  inp.style.cssText = "width:100%;accent-color:var(--ind)";
  inp.oninput = () => { const n = Number(inp.value); w.querySelector(".ovval").textContent = fmt(n); onChange(n); };
  w.appendChild(inp);
  return w;
}

export function ovNum(label, val, onChange) {
  return field(label, val, (v) => onChange(Number(v) || 0), { type: "number" });
}

export function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

// Colour picker: HSL sliders (tracks tinted to preview the value) + a swatch that
// opens the native picker for direct selection. Value is emitted as hex.
export function ovColour(label, val, onChange) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  let [h, s, l] = hexToHsl(val || "#ffffff");

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:12px;align-items:center";
  const swatch = document.createElement("button");
  swatch.type = "button"; swatch.title = "Pick colour";
  swatch.style.cssText = "position:relative;width:42px;height:42px;flex:0 0 auto;border-radius:10px;border:1px solid var(--line2);cursor:pointer;padding:0";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.style.cssText = "position:absolute;inset:0;opacity:0;cursor:pointer";
  swatch.appendChild(picker);

  const sliders = document.createElement("div");
  sliders.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:7px";
  const mk = (max) => { const i = document.createElement("input"); i.type = "range"; i.className = "hsl"; i.min = "0"; i.max = String(max); i.step = "1"; return i; };
  const hI = mk(360), sI = mk(100), lI = mk(100);
  sliders.append(hI, sI, lI);
  row.append(swatch, sliders);
  w.appendChild(row);

  // Repaint tracks + swatch for a hex. Slider edits round-trip through integer HSL
  // (a slight, expected quantisation); a native-picker hex is stored verbatim.
  const paint = (hex) => {
    hI.value = h; sI.value = s; lI.value = l;
    swatch.style.background = hex; picker.value = hex;
    hI.style.background = "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";
    sI.style.background = `linear-gradient(to right,hsl(${h},0%,${l}%),hsl(${h},100%,${l}%))`;
    lI.style.background = `linear-gradient(to right,hsl(${h},${s}%,0%),hsl(${h},${s}%,50%),hsl(${h},${s}%,100%))`;
  };
  const commit = (hex) => onChange(hex);
  const fromSliders = () => { const hex = hslToHex(h, s, l); paint(hex); commit(hex); };
  hI.oninput = () => { h = Number(hI.value); fromSliders(); };
  sI.oninput = () => { s = Number(sI.value); fromSliders(); };
  lI.oninput = () => { l = Number(lI.value); fromSliders(); };
  picker.oninput = () => { [h, s, l] = hexToHsl(picker.value); paint(picker.value); commit(picker.value); };
  paint(hslToHex(h, s, l));
  return w;
}

// Segmented icon group (alignment, anchor) — settings whose choices read as glyphs.
export function ovIconGroup(label, val, options, setter) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const seg = document.createElement("div");
  seg.style.cssText = "display:flex;background:var(--sub);border:1px solid var(--line2);border-radius:10px;padding:3px;gap:2px";
  for (const opt of options) {
    const on = String(val) === opt.value;
    const b = document.createElement("button");
    b.type = "button"; b.title = opt.title;
    b.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;padding:8px;border:none;border-radius:7px;cursor:pointer;" +
      (on ? "background:var(--card);color:var(--ind);box-shadow:var(--sh)" : "background:transparent;color:var(--dim)");
    b.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${opt.icon}</svg>`;
    b.onclick = () => setter(opt.value);
    seg.appendChild(b);
  }
  w.appendChild(seg);
  return w;
}
