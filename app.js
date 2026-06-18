// DrugInteract - live client-side drug interaction reference.
// Normalizes drugs via RxNorm, reads U.S. FDA labels via openFDA, and reports
// whether either drug's label text mentions the other. No severity grading.

"use strict";

const RXNORM = "https://rxnav.nlm.nih.gov/REST";
const OPENFDA = "https://api.fda.gov/drug/label.json";

const LABEL_CAP = 100;     // most-recent labels searched per drug
const SNIPPET_RADIUS = 200; // chars of context on each side of a match
const MIN_NAME_LEN = 4;     // shortest name allowed as a text matcher
const MAX_CONCURRENCY = 4;  // polite parallelism for API calls

// Names too generic to use as matchers (would cause false hits in label text).
const NAME_STOPWORDS = new Set([
  "acid", "sodium", "calcium", "potassium", "chloride", "sulfate", "hydrochloride",
  "oral", "tablet", "capsule", "solution", "injection", "extended", "release",
  "kit", "drug", "drugs", "agent", "agents"
]);

// In-memory session caches.
const normalizeCache = new Map(); // input(lower) -> normalize result
const labelCache = new Map();     // ingredientName(lower) -> labels result

let inputSeq = 0;                 // unique ids for input/listbox pairs
let drugTermsPromise = null;      // cached promise of the autocomplete term list

// ---------- small utilities ----------

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  if (children != null) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd || "unknown date";
  return yyyymmdd.slice(0, 4) + "-" + yyyymmdd.slice(4, 6) + "-" + yyyymmdd.slice(6, 8);
}

// Run async tasks with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (res.status === 404) return { __notFound: true };
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ---------- RxNorm normalization ----------

// Resolve one input string to: recognized flag, ingredient name(s), name-set, suggestions.
async function normalizeDrug(input) {
  const key = input.trim().toLowerCase();
  if (normalizeCache.has(key)) return normalizeCache.get(key);

  const out = {
    input: input.trim(),
    recognized: false,
    rxcui: null,
    ingredientNames: [],
    names: new Set(),       // names used to find THIS drug inside another's text
    suggestions: [],
    error: null
  };

  try {
    const d = await getJson(`${RXNORM}/rxcui.json?name=${encodeURIComponent(out.input)}&search=2`);
    const ids = (d.idGroup && d.idGroup.rxnormId) || [];
    if (ids.length === 0) {
      // Not recognized: offer spelling suggestions as "did you mean".
      const s = await getJson(`${RXNORM}/spellingsuggestions.json?name=${encodeURIComponent(out.input)}`);
      const list = s.suggestionGroup && s.suggestionGroup.suggestionList && s.suggestionGroup.suggestionList.suggestion;
      out.suggestions = Array.isArray(list) ? list.slice(0, 6) : [];
      normalizeCache.set(key, out);
      return out;
    }

    out.recognized = true;
    out.rxcui = ids[0];
    out.names.add(out.input.toLowerCase());

    // Resolve related concepts (handles brand input -> ingredient).
    //   IN/MIN -> active ingredient(s): used for the openFDA generic_name search
    //             AND as text matchers.
    //   BN     -> brand names: used ONLY as extra text matchers.
    // Names are taken from RxNorm only. We deliberately do NOT harvest names from
    // a drug's own openFDA labels, because combination products would inject
    // co-ingredient names (e.g. caffeine in an aspirin combination) and cause
    // false-positive matches against unrelated drugs.
    const rel = await getJson(`${RXNORM}/rxcui/${out.rxcui}/related.json?tty=IN+MIN+BN`);
    const groups = (rel.relatedGroup && rel.relatedGroup.conceptGroup) || [];
    for (const g of groups) {
      if (!g.conceptProperties) continue;
      if (g.tty === "IN" || g.tty === "MIN") {
        for (const c of g.conceptProperties) {
          if (c.name) { out.ingredientNames.push(c.name); out.names.add(c.name.toLowerCase()); }
        }
      } else if (g.tty === "BN") {
        for (const c of g.conceptProperties) {
          if (c.name) out.names.add(c.name.toLowerCase());
        }
      }
    }
    if (out.ingredientNames.length === 0) out.ingredientNames.push(out.input); // fallback
  } catch (err) {
    out.error = err.message || "lookup failed";
  }

  normalizeCache.set(key, out);
  return out;
}

// ---------- openFDA labels ----------

function pickText(field) {
  if (Array.isArray(field)) return field.join("\n\n").trim();
  return (field || "").toString().trim();
}

// Fetch and de-duplicate labels for an ingredient name.
async function fetchLabels(ingredientName) {
  const key = ingredientName.toLowerCase();
  if (labelCache.has(key)) return labelCache.get(key);

  const result = { total: 0, fetched: 0, labels: [], error: null };
  try {
    const q = encodeURIComponent(`openfda.generic_name:"${ingredientName}"`);
    const url = `${OPENFDA}?search=${q}&sort=effective_time:desc&limit=${LABEL_CAP}`;
    const d = await getJson(url);
    if (d.__notFound) { labelCache.set(key, result); return result; }

    result.total = (d.meta && d.meta.results && d.meta.results.total) || 0;
    const records = d.results || [];

    const bySet = new Map(); // spl_set_id -> newest label
    for (const r of records) {
      const of = r.openfda || {};
      const setId = (of.spl_set_id && of.spl_set_id[0]) || r.set_id || r.id || ("anon-" + bySet.size);
      const label = {
        spl_set_id: (of.spl_set_id && of.spl_set_id[0]) || null,
        generic_name: of.generic_name || [],
        brand_name: of.brand_name || [],
        substance_name: of.substance_name || [],
        effective_time: r.effective_time || "",
        section7: pickText(r.drug_interactions),
        contra: pickText(r.contraindications)
      };
      const prev = bySet.get(setId);
      if (!prev || (label.effective_time > prev.effective_time)) bySet.set(setId, label);
    }

    result.labels = Array.from(bySet.values()).sort((a, b) => (b.effective_time > a.effective_time ? 1 : -1));
    result.fetched = result.labels.length;
  } catch (err) {
    result.error = err.message || "lookup failed";
  }

  labelCache.set(key, result);
  return result;
}

// ---------- matching ----------

// Build word-boundary regexes from a name-set, filtered to avoid junk matches.
function buildMatchers(nameSet) {
  const seen = new Set();
  const matchers = [];
  for (const raw of nameSet) {
    const name = raw.trim().toLowerCase();
    if (name.length < MIN_NAME_LEN) continue;
    if (NAME_STOPWORDS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const pattern = escapeRegex(name).replace(/\\?\s+/g, "\\s+");
    matchers.push({ name, re: new RegExp("\\b" + pattern + "\\b", "i") });
  }
  return matchers;
}

// First match of any matcher in text -> { name, index } or null.
function firstMatch(text, matchers) {
  if (!text) return null;
  let best = null;
  for (const m of matchers) {
    const hit = m.re.exec(text);
    if (hit && (best === null || hit.index < best.index)) {
      best = { name: hit[0], index: hit.index };
    }
  }
  return best;
}

// Build a context snippet around an index, trimmed toward sentence boundaries.
function makeSnippet(text, index, matchLen) {
  let start = Math.max(0, index - SNIPPET_RADIUS);
  let end = Math.min(text.length, index + matchLen + SNIPPET_RADIUS);
  // Trim leading partial sentence/word.
  if (start > 0) {
    const dot = text.lastIndexOf(". ", index);
    if (dot > start) start = dot + 2;
    else { const sp = text.indexOf(" ", start); if (sp !== -1 && sp < index) start = sp + 1; }
  }
  // Trim trailing partial sentence/word.
  if (end < text.length) {
    const dot = text.indexOf(". ", index + matchLen);
    if (dot !== -1 && dot < end) end = dot + 1;
    else { const sp = text.lastIndexOf(" ", end); if (sp > index + matchLen) end = sp; }
  }
  const before = (start > 0 ? "..." : "") + text.slice(start, index);
  const matched = text.slice(index, index + matchLen);
  const after = text.slice(index + matchLen, end) + (end < text.length ? "..." : "");
  return escapeHtml(before) + "<mark>" + escapeHtml(matched) + "</mark>" + escapeHtml(after);
}

// Search one drug's labels (source) for the other drug's names (matchers).
// Returns directional finding across ALL labels.
function searchDirection(source, matchers) {
  const out = {
    searchable: false,
    labelsChecked: source.labels.length,
    totalOnFile: source.total,
    s7Matches: 0,
    contraMatches: 0,
    s7: null,      // { snippet, full, label }
    contra: null   // { snippet, full, label }
  };
  for (const label of source.labels) {
    if (label.section7 || label.contra) out.searchable = true;

    if (label.section7) {
      const hit = firstMatch(label.section7, matchers);
      if (hit) {
        out.s7Matches++;
        if (!out.s7) out.s7 = { snippet: makeSnippet(label.section7, hit.index, hit.name.length), full: label.section7, label };
      }
    }
    if (label.contra) {
      const hit = firstMatch(label.contra, matchers);
      if (hit) {
        out.contraMatches++;
        if (!out.contra) out.contra = { snippet: makeSnippet(label.contra, hit.index, hit.name.length), full: label.contra, label };
      }
    }
  }
  return out;
}

// ---------- evaluation ----------

const STATE = {
  MENTION: "mention", NOMENTION: "nomention", NOLABEL: "nolabel",
  UNRECOGNIZED: "unrecognized", ERROR: "error"
};

function evaluatePair(a, b) {
  // a, b are objects: { norm, labels, matchers, label } prepared in run().
  if (a.norm.error || b.norm.error || a.labels.error || b.labels.error) {
    return { state: STATE.ERROR, a, b };
  }
  if (!a.norm.recognized || !b.norm.recognized) {
    return { state: STATE.UNRECOGNIZED, a, b };
  }

  const aFindsB = searchDirection(a.labels, b.matchers); // A's labels mention B?
  const bFindsA = searchDirection(b.labels, a.matchers); // B's labels mention A?

  if (!aFindsB.searchable && !bFindsA.searchable) {
    return { state: STATE.NOLABEL, a, b, aFindsB, bFindsA };
  }

  const anyMention =
    aFindsB.s7 || aFindsB.contra || bFindsA.s7 || bFindsA.contra;

  return {
    state: anyMention ? STATE.MENTION : STATE.NOMENTION,
    a, b, aFindsB, bFindsA
  };
}

// ---------- rendering ----------

function drugLabelName(drug) {
  const ing = drug.norm.ingredientNames[0];
  const shown = titleCase(drug.norm.input);
  if (ing && ing.toLowerCase() !== drug.norm.input.toLowerCase()) {
    return `${shown} (${ing})`;
  }
  return shown;
}

function dailyMedLink(label) {
  if (label && label.spl_set_id) {
    return "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=" + encodeURIComponent(label.spl_set_id);
  }
  return null;
}

function renderFinding(sourceDrug, targetDrug, dir, opts) {
  // opts.section: "s7" | "contra"
  const found = opts.section === "s7" ? dir.s7 : dir.contra;
  if (!found) return null;
  const count = opts.section === "s7" ? dir.s7Matches : dir.contraMatches;
  const sectionName = opts.section === "s7" ? "Drug Interactions (Section 7)" : "Contraindications (Section 4)";

  const node = el("div", { class: opts.section === "s7" ? "finding" : "finding secondary" });
  if (opts.section === "contra") node.appendChild(el("div", { class: "sec-tag" }, "Secondary signal"));

  node.appendChild(el("div", { class: "dir" },
    `${titleCase(sourceDrug.norm.input)}'s FDA label mentions ${titleCase(targetDrug.norm.input)}`));

  const label = found.label;
  const gen = (label.generic_name[0] || sourceDrug.norm.ingredientNames[0] || "label");
  const meta = el("div", { class: "meta" });
  let metaText = `In ${sectionName}. Found in ${count} of ${dir.labelsChecked} label(s) checked`;
  if (dir.totalOnFile > dir.labelsChecked) metaText += ` (newest ${dir.labelsChecked} of ${dir.totalOnFile} on file)`;
  metaText += `. Source label: ${gen}, effective ${formatDate(label.effective_time)}.`;
  meta.appendChild(document.createTextNode(metaText));
  const dm = dailyMedLink(label);
  if (dm) {
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(el("a", { href: dm, target: "_blank", rel: "noopener" }, "View on DailyMed"));
  }
  node.appendChild(meta);

  node.appendChild(el("p", { class: "snippet", html: found.snippet }));

  const details = el("details", { class: "full" });
  details.appendChild(el("summary", null, "Show full " + (opts.section === "s7" ? "Section 7" : "Section 4") + " text"));
  details.appendChild(el("pre", null, found.full));
  node.appendChild(details);

  return node;
}

function renderPair(result) {
  const { a, b } = result;
  const titleText = `${drugLabelName(a)}  +  ${drugLabelName(b)}`;
  const pair = el("div", { class: "pair" });

  let badgeText, stateClass;
  switch (result.state) {
    case STATE.MENTION: badgeText = "Interaction mentioned"; stateClass = "s-mention"; break;
    case STATE.NOMENTION: badgeText = "No interaction mentioned"; stateClass = "s-nomention"; break;
    case STATE.NOLABEL: badgeText = "No FDA label to check"; stateClass = "s-nolabel"; break;
    case STATE.UNRECOGNIZED: badgeText = "Drug not recognized"; stateClass = "s-unrecognized"; break;
    default: badgeText = "Lookup error"; stateClass = "s-error";
  }
  pair.className = "pair " + stateClass;

  const h = el("h3", null, titleText);
  h.appendChild(el("span", { class: "badge" }, badgeText));
  pair.appendChild(h);

  if (result.state === STATE.UNRECOGNIZED) {
    for (const d of [a, b]) {
      if (!d.norm.recognized) {
        pair.appendChild(el("p", null, `"${escapeHtml(d.norm.input)}" was not recognized by RxNorm.`));
        if (d.norm.suggestions.length) {
          const wrap = el("div", { class: "suggestions" });
          wrap.appendChild(el("span", { class: "hint" }, "Did you mean: "));
          for (const s of d.norm.suggestions) {
            const btn = el("button", { type: "button" }, s);
            btn.addEventListener("click", () => fillSuggestion(d.norm.input, s));
            wrap.appendChild(btn);
          }
          pair.appendChild(wrap);
        } else {
          pair.appendChild(el("p", { class: "hint" }, "No spelling suggestions available."));
        }
      }
    }
    return pair;
  }

  if (result.state === STATE.ERROR) {
    pair.appendChild(el("p", null, "A network or API error occurred while checking this pair. Please try again."));
    return pair;
  }

  if (result.state === STATE.NOLABEL) {
    pair.appendChild(el("p", null,
      "Both drugs are recognized, but no U.S. FDA label with interaction text was found to search. " +
      "Nothing could be checked for this pair - this is not the same as finding no interaction."));
    return pair;
  }

  if (result.state === STATE.MENTION) {
    const findings = [
      renderFinding(a, b, result.aFindsB, { section: "s7" }),
      renderFinding(b, a, result.bFindsA, { section: "s7" }),
      renderFinding(a, b, result.aFindsB, { section: "contra" }),
      renderFinding(b, a, result.bFindsA, { section: "contra" })
    ].filter(Boolean);
    for (const f of findings) pair.appendChild(f);
    pair.appendChild(el("p", { class: "caveat" },
      "This reflects only the label's own wording. openFDA does not grade severity. " +
      "Consult the full label and a healthcare professional."));
    return pair;
  }

  // NOMENTION
  const checked = [];
  if (result.aFindsB.searchable) checked.push(`${result.aFindsB.labelsChecked} label(s) for ${titleCase(a.norm.input)}`);
  if (result.bFindsA.searchable) checked.push(`${result.bFindsA.labelsChecked} label(s) for ${titleCase(b.norm.input)}`);
  pair.appendChild(el("p", null,
    `Searched ${checked.join(" and ")}; neither names the other in its Drug Interactions or Contraindications text.`));

  // Partial-coverage note when only one side could be searched.
  if (!result.aFindsB.searchable || !result.bFindsA.searchable) {
    const missing = !result.aFindsB.searchable ? a : b;
    pair.appendChild(el("p", { class: "hint" },
      `Note: the reverse direction could not be checked because no searchable FDA label was found for ${titleCase(missing.norm.input)}.`));
  }

  pair.appendChild(el("p", { class: "caveat" },
    "Absence of a listed interaction does NOT mean the combination is safe. Labels are " +
    "incomplete and often describe interactions only at the drug-class level. Always consult a healthcare professional."));
  return pair;
}

function renderDrugSummary(drugs) {
  const box = el("div", { class: "card drug-summary" });
  box.appendChild(el("h2", null, "Drugs checked"));
  const ul = el("ul", null);
  for (const d of drugs) {
    const li = el("li", null);
    li.appendChild(el("span", { class: "name-in" }, titleCase(d.norm.input)));
    if (!d.norm.recognized) {
      li.appendChild(el("span", { class: "tag" }, d.norm.error ? "lookup error" : "not recognized"));
    } else {
      const ing = d.norm.ingredientNames[0] || d.norm.input;
      li.appendChild(document.createTextNode("  ->  ingredient: " + ing));
      if (d.norm.rxcui) li.appendChild(el("span", { class: "tag" }, "RxCUI " + d.norm.rxcui));
      if (d.labels.error) li.appendChild(el("span", { class: "tag" }, "label lookup error"));
      else {
        const more = d.labels.total > d.labels.fetched ? ` (newest ${d.labels.fetched} searched)` : "";
        li.appendChild(el("span", { class: "tag" }, d.labels.total + " FDA label(s)" + more));
      }
    }
    ul.appendChild(li);
  }
  box.appendChild(ul);
  return box;
}

// ---------- autocomplete ----------

// Load RxNorm display names once for type-ahead. Lowercased, de-duplicated,
// sorted. On any failure, resolve to [] so free-text entry still works.
function loadDrugTerms() {
  if (!drugTermsPromise) {
    drugTermsPromise = getJson(`${RXNORM}/displaynames.json`)
      .then(d => {
        const raw = (d.displayTermsList && d.displayTermsList.term) || [];
        const set = new Set();
        for (const t of raw) { const s = t.trim().toLowerCase(); if (s) set.add(s); }
        return Array.from(set).sort();
      })
      .catch(() => []);
  }
  return drugTermsPromise;
}

// Prefix matches first, then substring matches, capped.
function filterTerms(terms, query, limit) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const starts = [], contains = [];
  for (let i = 0; i < terms.length && starts.length < limit; i++) {
    if (terms[i].startsWith(q)) starts.push(terms[i]);
  }
  if (starts.length < limit) {
    for (let i = 0; i < terms.length && (starts.length + contains.length) < limit; i++) {
      if (!terms[i].startsWith(q) && terms[i].includes(q)) contains.push(terms[i]);
    }
  }
  return starts.concat(contains).slice(0, limit);
}

// Attach a keyboard-accessible suggestions dropdown to one input.
function attachAutocomplete(input, list) {
  let items = [], active = -1, timer = null;

  function close() {
    list.hidden = true;
    list.innerHTML = "";
    items = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function updateActive() {
    const lis = list.children;
    for (let i = 0; i < lis.length; i++) lis[i].classList.toggle("active", i === active);
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", input.id + "-opt-" + active);
      lis[active].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function select(term) { input.value = term; close(); }

  function render() {
    loadDrugTerms().then(terms => {
      items = filterTerms(terms, input.value, 10);
      if (!items.length) { close(); return; }
      list.innerHTML = "";
      items.forEach((t, i) => {
        const li = el("li", { class: "ac-item", id: input.id + "-opt-" + i, role: "option" }, t);
        li.addEventListener("mousedown", (e) => { e.preventDefault(); select(t); });
        list.appendChild(li);
      });
      active = -1;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    });
  }

  input.addEventListener("focus", () => {
    loadDrugTerms();
    if (input.value.trim().length >= 2) render();
  });
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 100); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) {
      if (e.key === "ArrowDown" && input.value.trim().length >= 2) render();
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, -1); updateActive(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); select(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { close(); }
  });
  input.addEventListener("blur", () => { setTimeout(close, 150); });
}

// ---------- form wiring ----------

const rowsEl = () => document.getElementById("drug-rows");
const statusEl = () => document.getElementById("status");
const resultsEl = () => document.getElementById("results");

function addRow(value) {
  const rows = rowsEl();
  const idx = rows.children.length + 1;
  const id = "drug-input-" + (inputSeq++);
  const row = el("div", { class: "drug-row" });
  row.appendChild(el("span", { class: "idx" }, String(idx)));

  const wrap = el("div", { class: "ac-wrap" });
  const input = el("input", {
    type: "text", id, placeholder: "Start typing a drug name", "aria-label": "Drug " + idx,
    autocomplete: "off", spellcheck: "false",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id + "-list"
  });
  if (value) input.value = value;
  const list = el("ul", { class: "ac-list", id: id + "-list", role: "listbox", hidden: "" });
  wrap.appendChild(input);
  wrap.appendChild(list);
  row.appendChild(wrap);

  const remove = el("button", { type: "button", class: "btn-icon", "aria-label": "Remove drug " + idx, title: "Remove" }, "Remove");
  remove.addEventListener("click", () => { row.remove(); renumberRows(); });
  row.appendChild(remove);
  rows.appendChild(row);

  attachAutocomplete(input, list);
  return input;
}

function renumberRows() {
  const rows = rowsEl().children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].querySelector(".idx").textContent = String(i + 1);
    const input = rows[i].querySelector("input");
    input.setAttribute("aria-label", "Drug " + (i + 1));
    rows[i].querySelector("button").setAttribute("aria-label", "Remove drug " + (i + 1));
  }
}

function fillSuggestion(originalInput, suggestion) {
  const inputs = rowsEl().querySelectorAll("input");
  for (const input of inputs) {
    if (input.value.trim().toLowerCase() === originalInput.trim().toLowerCase()) {
      input.value = suggestion;
      input.focus();
      break;
    }
  }
}

function getInputs() {
  const inputs = rowsEl().querySelectorAll("input");
  const seen = new Set();
  const list = [];
  for (const input of inputs) {
    const v = input.value.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(v);
  }
  return list;
}

async function run(evt) {
  evt.preventDefault();
  const checkBtn = document.getElementById("check");
  const names = getInputs();
  resultsEl().innerHTML = "";

  if (names.length < 2) {
    statusEl().textContent = "Enter at least two different drugs.";
    return;
  }

  checkBtn.disabled = true;
  statusEl().textContent = "Normalizing drug names with RxNorm...";

  try {
    // 1. Normalize all unique drugs.
    const norms = await mapLimit(names, MAX_CONCURRENCY, normalizeDrug);

    // 2. Fetch FDA labels for recognized drugs (by ingredient name).
    statusEl().textContent = "Reading U.S. FDA labels from openFDA...";
    const drugs = await mapLimit(norms, MAX_CONCURRENCY, async (norm) => {
      let labels = { total: 0, fetched: 0, labels: [], fdaNames: new Set(), error: null };
      if (norm.recognized) labels = await fetchLabels(norm.ingredientNames[0] || norm.input);
      return { norm, labels };
    });

    // 3. Build each drug's matcher set from its RxNorm names (ingredient/brand/input).
    for (const d of drugs) {
      d.matchers = buildMatchers(d.norm.names);
    }

    // 4. Evaluate every unordered pair.
    statusEl().textContent = "Comparing label text for each pair...";
    resultsEl().appendChild(renderDrugSummary(drugs));
    const pairsBox = el("div", { class: "card" });
    pairsBox.appendChild(el("h2", null, "Pairwise results"));

    for (let i = 0; i < drugs.length; i++) {
      for (let j = i + 1; j < drugs.length; j++) {
        const result = evaluatePair(drugs[i], drugs[j]);
        pairsBox.appendChild(renderPair(result));
      }
    }
    resultsEl().appendChild(pairsBox);
    statusEl().textContent = "";
  } catch (err) {
    statusEl().textContent = "Something went wrong: " + (err.message || err) + ". Please try again.";
  } finally {
    checkBtn.disabled = false;
  }
}

function init() {
  addRow("");
  addRow("");
  document.getElementById("add-drug").addEventListener("click", () => addRow("").focus());
  document.getElementById("drug-form").addEventListener("submit", run);
}

document.addEventListener("DOMContentLoaded", init);
