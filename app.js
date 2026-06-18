// DrugInteract - live client-side drug interaction reference.
// Normalizes drugs via RxNorm, reads U.S. FDA labels via openFDA, and reports
// whether either drug's label text mentions the other. No severity grading.

"use strict";

const RXNORM = "https://rxnav.nlm.nih.gov/REST";
const RXCLASS = "https://rxnav.nlm.nih.gov/REST/rxclass";
const OPENFDA = "https://api.fda.gov/drug/label.json";

// FDA label sections searched for the other drug's name. Section 7 is the
// primary signal; the others are secondary context that still count as a label
// mention (improves recall - interactions are sometimes only in a boxed warning
// or warnings section).
const LABEL_SECTIONS = [
  { key: "section7", field: "drug_interactions",    name: "Drug Interactions (Section 7)",      primary: true },
  { key: "contra",   field: "contraindications",    name: "Contraindications (Section 4)",      primary: false },
  { key: "boxed",    field: "boxed_warning",        name: "Boxed Warning",                      primary: false },
  { key: "warnings", field: "warnings_and_cautions", name: "Warnings and Cautions (Section 5)", primary: false }
];

const LABEL_CAP = 100;     // most-recent labels searched per drug
const SNIPPET_RADIUS = 200; // chars of context on each side of a match
const MIN_NAME_LEN = 3;     // shortest name allowed as a text matcher
const MAX_CONCURRENCY = 4;  // polite parallelism for API calls

// Names too generic to use as matchers (would cause false hits in label text).
const NAME_STOPWORDS = new Set([
  "acid", "sodium", "calcium", "potassium", "chloride", "sulfate", "hydrochloride",
  "oral", "tablet", "capsule", "solution", "injection", "extended", "release",
  "kit", "drug", "drugs", "agent", "agents"
]);

// In-memory session caches.
const normalizeCache = new Map(); // input(lower) -> normalize result
const labelCache = new Map();     // ingredient-names key -> labels result
const suggestCache = new Map();   // query(lower) -> string[] suggestions
const profileCache = new Map();   // ingredient rxcui -> RxClass profile

let inputSeq = 0;                 // unique ids for input/listbox pairs

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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// GET JSON with small backoff retries on transient failures (network error or
// 5xx server error), up to 2 retries. 404 -> not-found sentinel. 429 -> distinct
// rate-limit error, surfaced to the user rather than retried.
async function getJson(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: { "Accept": "application/json" } });
  } catch (err) {
    if (attempt < 2) { await delay(300 * (attempt + 1)); return getJson(url, attempt + 1); }
    throw err;
  }
  if (res.status === 404) return { __notFound: true };
  if (res.status === 429) { const e = new Error("RATE_LIMIT"); e.rateLimit = true; throw e; }
  if (res.status >= 500 && attempt < 2) { await delay(300 * (attempt + 1)); return getJson(url, attempt + 1); }
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
    ingredientRxcui: null,  // first IN/MIN rxcui, used for the RxClass profile lookup
    ingredientNames: [],
    names: new Set(),       // names used to find THIS drug inside another's text
    suggestions: [],
    error: null,
    rateLimited: false
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
          if (c.rxcui && !out.ingredientRxcui) out.ingredientRxcui = c.rxcui;
        }
      } else if (g.tty === "BN") {
        for (const c of g.conceptProperties) {
          if (c.name) out.names.add(c.name.toLowerCase());
        }
      }
    }
    // Recovery: if no ingredient came back (e.g. an obsolete or remapped
    // concept), ask RxNorm's history/status for the derived active ingredient(s).
    if (out.ingredientNames.length === 0) {
      try {
        const h = await getJson(`${RXNORM}/rxcui/${out.rxcui}/historystatus.json`);
        const derived = h && h.rxcuiStatusHistory && h.rxcuiStatusHistory.derivedConcepts;
        const ings = (derived && derived.ingredientConcept) || [];
        for (const c of ings) {
          if (c.ingredientName) { out.ingredientNames.push(c.ingredientName); out.names.add(c.ingredientName.toLowerCase()); }
          if (c.ingredientRxcui && !out.ingredientRxcui) out.ingredientRxcui = c.ingredientRxcui;
        }
      } catch (e) { /* best effort */ }
    }
    if (out.ingredientNames.length === 0) out.ingredientNames.push(out.input); // final fallback
  } catch (err) {
    out.error = err.message || "lookup failed";
    out.rateLimited = !!err.rateLimit;
  }

  normalizeCache.set(key, out);
  return out;
}

// ---------- openFDA labels ----------

function pickText(field) {
  if (Array.isArray(field)) return field.join("\n\n").trim();
  return (field || "").toString().trim();
}

// Fetch and de-duplicate labels for a drug. Searches every one of the drug's
// ingredient names across BOTH openfda.generic_name and openfda.substance_name
// (recovers salt-form and combination-product labels a single-name search
// misses), unions the results, then de-dupes by spl_set_id (newest wins).
async function fetchLabels(ingredientNames) {
  // Single-ingredient names only for the search (drop MIN "a / b" combo names).
  const searchNames = [];
  const seen = new Set();
  for (const n of ingredientNames) {
    const name = (n || "").trim();
    if (!name || name.indexOf("/") !== -1) continue;
    const lc = name.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    searchNames.push(name);
  }
  if (searchNames.length === 0) {
    for (const n of ingredientNames) { const v = (n || "").trim(); if (v) searchNames.push(v); }
  }

  const key = searchNames.map(n => n.toLowerCase()).sort().join("|");
  if (labelCache.has(key)) return labelCache.get(key);

  const result = { total: 0, fetched: 0, labels: [], error: null, rateLimited: false };
  try {
    const clauses = searchNames.map(n =>
      `openfda.generic_name:"${n}" OR openfda.substance_name:"${n}"`).join(" OR ");
    const url = `${OPENFDA}?search=${encodeURIComponent(clauses)}&sort=effective_time:desc&limit=${LABEL_CAP}`;
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
        effective_time: r.effective_time || ""
      };
      for (const sec of LABEL_SECTIONS) label[sec.key] = pickText(r[sec.field]);
      const prev = bySet.get(setId);
      if (!prev || (label.effective_time > prev.effective_time)) bySet.set(setId, label);
    }

    result.labels = Array.from(bySet.values()).sort((a, b) => (b.effective_time > a.effective_time ? 1 : -1));
    result.fetched = result.labels.length;
  } catch (err) {
    result.error = err.message || "lookup failed";
    result.rateLimited = !!err.rateLimit;
  }

  labelCache.set(key, result);
  return result;
}

// ---------- RxClass drug profile (informational only) ----------

// IMPORTANT: profile data is background context, never an interaction signal.
// The interaction verdict comes only from openFDA label-text matching. We use
// only the drug's OWN classes (rela has_epc / has_moa, relaSource ATC); we
// deliberately exclude contraindication relations (e.g. ci_moa), which would
// imply interactions. RxClass has no CYP "Substrate" classes (only Inhibitor /
// Inducer), so substrate is reported as not classified, never inferred.

// Drug-disposition transporters relevant to interactions (efflux/uptake). We
// deliberately EXCLUDE neurotransmitter transporters (serotonin/dopamine/etc.),
// which are pharmacodynamic targets, not disposition transporters.
function isDispositionTransporter(name) {
  return /(P-Glycoprotein|Breast Cancer Resistance Protein|Organic Anion Transporting Polypeptide|Organic Anion Transporter|Organic Cation Transporter|Multidrug and Toxin Extrusion|Bile Salt Export Pump)/i.test(name);
}
function transporterLabel(name) {
  return name
    .replace(/P-Glycoprotein/i, "P-gp")
    .replace(/Breast Cancer Resistance Protein/i, "BCRP")
    .replace(/Organic Anion Transporting Polypeptide\s*/i, "OATP")
    .replace(/Organic Anion Transporter\s*/i, "OAT")
    .replace(/Organic Cation Transporter\s*/i, "OCT")
    .replace(/Multidrug and Toxin Extrusion(?: Transporter)?\s*/i, "MATE")
    .replace(/Bile Salt Export Pump/i, "BSEP");
}

// Parse the byRxcui rows into family / pharm class / mechanism / CYP / transporters.
function extractProfile(rows) {
  const profile = { atc: [], epc: [], moa: [], cypInhibitor: [], cypInducer: [], transporters: [] };
  const seen = new Set();
  const add = (bucket, value, key) => {
    if (!value || seen.has(key)) return;
    seen.add(key);
    bucket.push(value);
  };

  // ATC needs two passes. RxClass rolls a fixed-dose combination product's ATC
  // up to each of its ingredients, so an ingredient can appear under a family
  // it does not belong to on its own (e.g. simvastatin under "DPP-4 inhibitors"
  // via a simvastatin/sitagliptin combo). We therefore keep an ATC family only
  // when the ingredient has at least one SINGLE-ingredient product (ATCPROD)
  // classified under it. Combination products carry " / " between ingredients.
  const atc = new Map(); // classId -> { id, name, mono }

  for (const r of rows) {
    const c = r.rxclassMinConceptItem || {};
    const name = c.className;
    if (!name) continue;
    const type = c.classType, rela = r.rela;

    if (type === "ATC1-4") {
      let e = atc.get(c.classId);
      if (!e) { e = { id: c.classId, name, mono: false }; atc.set(c.classId, e); }
      const mc = r.minConcept || {};
      if (r.relaSource === "ATCPROD" && mc.name && mc.name.indexOf(" / ") === -1) e.mono = true;
    } else if (type === "EPC" && rela === "has_epc") {
      add(profile.epc, name, "epc|" + name);
    } else if (type === "MOA" && rela === "has_moa") {
      const cyp = name.match(/Cytochrome P450 (\S+) (Inhibitors|Inducers)/i);
      if (cyp) {
        const label = "CYP" + cyp[1].toUpperCase();
        if (/Inhibitor/i.test(cyp[2])) add(profile.cypInhibitor, label, "cypi|" + label);
        else add(profile.cypInducer, label, "cypd|" + label);
      } else if (isDispositionTransporter(name)) {
        add(profile.transporters, transporterLabel(name), "tr|" + name);
      } else {
        add(profile.moa, name, "moa|" + name);
      }
    }
  }

  for (const e of atc.values()) {
    if (e.mono && !/combination/i.test(e.name)) profile.atc.push({ id: e.id, name: e.name });
  }
  return profile;
}

// Fetch a drug's RxClass profile by its ingredient RxCUI. Cached per RxCUI.
// Off the interaction critical path.
async function fetchProfile(rxcui) {
  if (!rxcui) return { empty: true };
  if (profileCache.has(rxcui)) return profileCache.get(rxcui);

  const result = { atc: [], epc: [], moa: [], cypInhibitor: [], cypInducer: [], transporters: [], error: null, rateLimited: false };
  try {
    const d = await getJson(`${RXCLASS}/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}`);
    if (!d.__notFound) {
      const rows = (d.rxclassDrugInfoList && d.rxclassDrugInfoList.rxclassDrugInfo) || [];
      Object.assign(result, extractProfile(rows));
    }
  } catch (err) {
    result.error = err.message || "lookup failed";
    result.rateLimited = !!err.rateLimit;
  }

  profileCache.set(rxcui, result);
  return result;
}

// NLM MedlinePlus patient-info search URL for a drug name (link only -
// MedlinePlus is not browser-fetchable cross-origin, but a hyperlink is fine).
function medlinePlusUrl(name) {
  return "https://vsearch.nlm.nih.gov/vivisimo/cgi-bin/query-meta?query=" +
    encodeURIComponent(name) + "&v%3Aproject=medlineplus";
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

// Search one drug's labels (source) for the other drug's names (matchers),
// across every LABEL_SECTION, over ALL labels. Returns a per-section finding.
function searchDirection(source, matchers) {
  const out = {
    searchable: false,
    labelsChecked: source.labels.length,
    totalOnFile: source.total,
    sections: {} // sec.key -> { count, snippet, full, label } or null
  };
  for (const sec of LABEL_SECTIONS) out.sections[sec.key] = null;

  for (const label of source.labels) {
    let hasText = false;
    for (const sec of LABEL_SECTIONS) {
      const text = label[sec.key];
      if (!text) continue;
      hasText = true;
      const hit = firstMatch(text, matchers);
      if (hit) {
        if (!out.sections[sec.key]) {
          out.sections[sec.key] = { count: 0, snippet: makeSnippet(text, hit.index, hit.name.length), full: text, label };
        }
        out.sections[sec.key].count++;
      }
    }
    if (hasText) out.searchable = true;
  }
  return out;
}

// Did this direction find the other drug in any label section?
function dirHasMention(dir) {
  return LABEL_SECTIONS.some(sec => dir.sections[sec.key]);
}

// ---------- evaluation ----------

const STATE = {
  MENTION: "mention", NOMENTION: "nomention", NOLABEL: "nolabel",
  UNRECOGNIZED: "unrecognized", ERROR: "error", RATELIMIT: "ratelimit"
};

function evaluatePair(a, b) {
  // a, b are objects: { norm, labels, matchers, label } prepared in run().
  if (a.norm.rateLimited || b.norm.rateLimited || a.labels.rateLimited || b.labels.rateLimited) {
    return { state: STATE.RATELIMIT, a, b };
  }
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

  const anyMention = dirHasMention(aFindsB) || dirHasMention(bFindsA);

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

function renderFinding(sourceDrug, targetDrug, dir, sec) {
  const found = dir.sections[sec.key];
  if (!found) return null;

  const node = el("div", { class: sec.primary ? "finding" : "finding secondary" });
  if (!sec.primary) node.appendChild(el("div", { class: "sec-tag" }, "Secondary signal"));

  node.appendChild(el("div", { class: "dir" },
    `${titleCase(sourceDrug.norm.input)}'s FDA label mentions ${titleCase(targetDrug.norm.input)}`));

  const label = found.label;
  const gen = (label.generic_name[0] || sourceDrug.norm.ingredientNames[0] || "label");
  const meta = el("div", { class: "meta" });
  let metaText = `In ${sec.name}. Found in ${found.count} of ${dir.labelsChecked} label(s) checked`;
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
  details.appendChild(el("summary", null, "Show full " + sec.name + " text"));
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
    case STATE.RATELIMIT: badgeText = "Rate limited - wait and retry"; stateClass = "s-ratelimit"; break;
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

  if (result.state === STATE.RATELIMIT) {
    pair.appendChild(el("p", null,
      "openFDA or RxNorm is rate-limiting requests right now (HTTP 429). " +
      "Please wait about a minute and try again. These free services allow only a " +
      "limited number of requests per minute per IP address."));
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
    const findings = [];
    for (const sec of LABEL_SECTIONS) {
      const fa = renderFinding(a, b, result.aFindsB, sec); if (fa) findings.push(fa);
      const fb = renderFinding(b, a, result.bFindsA, sec); if (fb) findings.push(fb);
    }
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
    `Searched ${checked.join(" and ")}; neither names the other in its Drug Interactions, ` +
    `Contraindications, Boxed Warning, or Warnings text.`));

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
    if (d.norm.rateLimited) {
      li.appendChild(el("span", { class: "tag" }, "rate limited (HTTP 429)"));
    } else if (!d.norm.recognized) {
      li.appendChild(el("span", { class: "tag" }, d.norm.error ? "lookup error" : "not recognized"));
    } else {
      const ing = d.norm.ingredientNames[0] || d.norm.input;
      li.appendChild(document.createTextNode("  ->  ingredient: " + ing));
      if (d.norm.rxcui) li.appendChild(el("span", { class: "tag" }, "RxCUI " + d.norm.rxcui));
      if (d.labels.rateLimited) li.appendChild(el("span", { class: "tag" }, "labels rate limited (HTTP 429)"));
      else if (d.labels.error) li.appendChild(el("span", { class: "tag" }, "label lookup error"));
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

// Build the "Drug profiles" card with a loading slot per recognized drug.
// Returns the card plus a map from drug -> body element to fill progressively.
function buildProfilesCard(drugs) {
  const box = el("div", { class: "card profiles" });
  box.appendChild(el("h2", null, "Drug profiles"));
  box.appendChild(el("p", { class: "note" },
    "Informational background from RxClass: drug family, pharmacologic class, mechanism, and CYP enzymes. " +
    "This is context only and is NOT used to determine interactions. A shared class, target, or CYP enzyme " +
    "does not by itself mean two drugs interact - the interaction result above comes only from FDA label text."));
  const slots = new Map();
  for (const d of drugs) {
    if (!d.norm.recognized) continue;
    const block = el("div", { class: "profile" });
    block.appendChild(el("h3", null, titleCase(d.norm.input)));
    const body = el("div", { class: "profile-body" });
    body.appendChild(el("p", { class: "hint" }, "Loading profile from RxClass..."));
    block.appendChild(body);
    box.appendChild(block);
    slots.set(d, body);
  }
  return { box, slots };
}

function fillProfile(body, profile, norm) {
  body.innerHTML = "";
  if (profile.rateLimited) {
    body.appendChild(el("p", { class: "hint" }, "Profile rate limited (HTTP 429) - wait and try again."));
    return;
  }
  if (profile.error) {
    body.appendChild(el("p", { class: "hint" }, "Profile lookup failed; try again later."));
    return;
  }

  const row = (label, value) => {
    const r = el("div", { class: "profile-row" });
    r.appendChild(el("span", { class: "profile-label" }, label));
    r.appendChild(el("span", { class: "profile-value" }, value));
    body.appendChild(r);
  };
  const NA = "not available in RxClass";
  row("Drug family (ATC)", profile.atc.length ? profile.atc.map(a => `${a.name} (${a.id})`).join("; ") : NA);
  row("Pharmacologic class (EPC)", profile.epc.length ? profile.epc.join("; ") : NA);
  row("Mechanism / target class (MoA)", profile.moa.length ? profile.moa.join("; ") : NA);

  // CYP enzymes: substrate is never classified by RxClass; show inhibitor /
  // inducer where present. Stated as fact about the data, not a prediction.
  const cypRow = el("div", { class: "profile-row" });
  cypRow.appendChild(el("span", { class: "profile-label" }, "CYP enzymes"));
  const cypVal = el("div", { class: "profile-value cyp" });
  cypVal.appendChild(el("div", null, [el("span", { class: "cyp-tag" }, "Substrate"), document.createTextNode(" not classified in RxClass")]));
  if (profile.cypInhibitor.length) {
    cypVal.appendChild(el("div", null, [el("span", { class: "cyp-tag" }, "Inhibitor"), document.createTextNode(" " + profile.cypInhibitor.join(", "))]));
  }
  if (profile.cypInducer.length) {
    cypVal.appendChild(el("div", null, [el("span", { class: "cyp-tag" }, "Inducer"), document.createTextNode(" " + profile.cypInducer.join(", "))]));
  }
  // Absence of data, not absence of the property: RxClass CYP coverage is
  // incomplete (e.g. it has no inhibitor/inducer class for rifampin or
  // fluoxetine), so make that explicit rather than silently omitting the line.
  if (!profile.cypInhibitor.length && !profile.cypInducer.length) {
    cypVal.appendChild(el("div", null, [el("span", { class: "cyp-tag" }, "Inhibitor / inducer"), document.createTextNode(" none recorded in RxClass (coverage is incomplete)")]));
  }
  cypRow.appendChild(cypVal);
  body.appendChild(cypRow);

  // Drug-disposition transporters (P-gp, OATP, etc.). Shown only when present;
  // coverage is incomplete (RxClass has no transporter "substrate" class either).
  if (profile.transporters && profile.transporters.length) {
    row("Transporters", profile.transporters.join("; "));
  }

  // Patient-facing info: a link to the NLM MedlinePlus search for this drug.
  if (norm) {
    const r = el("div", { class: "profile-row" });
    r.appendChild(el("span", { class: "profile-label" }, "Patient info"));
    const v = el("span", { class: "profile-value" });
    v.appendChild(el("a", { href: medlinePlusUrl(norm.ingredientNames[0] || norm.input), target: "_blank", rel: "noopener" }, "Search MedlinePlus (patient info)"));
    r.appendChild(v);
    body.appendChild(r);
  }
}

// ---------- autocomplete ----------

// Dosage-form / unit / device tokens that mark a candidate as not a clean
// drug name (RxNorm approximateTerm returns these as noise).
const SUGGEST_NOISE = new Set([
  "pill", "oral", "tablet", "capsule", "injectable", "solution", "suspension",
  "product", "topical", "delayed", "release", "spray", "kit", "mg", "ml", "mcg",
  "cream", "ointment", "patch", "drops", "intravenous", "subcutaneous", "gram",
  "milligram", "pack", "lotion", "gel", "foam", "powder", "syrup", "elixir",
  "lozenge", "suppository", "intramuscular", "ophthalmic", "otic", "nasal",
  "inhalation", "extended", "sublingual", "chewable", "effervescent", "granules",
  "film", "implant", "ring", "shampoo", "swab", "paste", "wipe", "wafer",
  "disintegrating", "metered", "actuation", "hour", "unit", "units", "dose",
  "coated", "prefilled", "injector", "concentrate", "rectal", "vaginal",
  "transdermal", "liquid", "sterile", "spike", "aspirating"
]);

// True if a candidate name looks like a clean drug name (no dose strings,
// bracketed forms, digits, or device/dosage-form words).
function isCleanSuggestion(name) {
  if (/[\[\]\d]/.test(name)) return false;
  const toks = name.split(/[\s\/,\-]+/).filter(Boolean);
  if (!toks.length) return false;
  for (const t of toks) if (SUGGEST_NOISE.has(t)) return false;
  return true;
}

// Per-keystroke suggestions via RxNorm approximateTerm. Cleans noise, prefers
// prefix matches, caps the list, caches per query. Resolves to [] on any
// failure or short query so free-text entry always works.
async function fetchSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  if (suggestCache.has(q)) return suggestCache.get(q);

  let out = [];
  try {
    const d = await getJson(`${RXNORM}/approximateTerm.json?term=${encodeURIComponent(q)}&maxEntries=30`);
    const cands = (d.approximateGroup && d.approximateGroup.candidate) || [];
    const seen = new Set();
    const clean = [];
    for (const c of cands) {
      if (!c.name) continue;
      const name = c.name.toLowerCase().trim();
      if (seen.has(name) || !isCleanSuggestion(name)) continue;
      seen.add(name);
      clean.push(name);
    }
    const prefix = clean.filter(n => n.startsWith(q));
    const pool = prefix.length ? prefix : clean;
    pool.sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1));
    out = pool.slice(0, 10);
  } catch (e) {
    out = [];
  }
  suggestCache.set(q, out);
  return out;
}

// Attach a keyboard-accessible suggestions dropdown to one input.
function attachAutocomplete(input, list) {
  let items = [], active = -1, timer = null, seq = 0, blurred = false;

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
    const q = input.value;
    const mySeq = seq;
    fetchSuggestions(q).then(suggestions => {
      // Ignore stale responses: a newer keystroke invalidated this, or focus lost.
      if (mySeq !== seq || blurred) return;
      items = suggestions;
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
    blurred = false; seq++;
    if (input.value.trim().length >= 3) render();
  });
  // Bump seq on every keystroke so any in-flight request is invalidated at once.
  input.addEventListener("input", () => { blurred = false; seq++; clearTimeout(timer); timer = setTimeout(render, 180); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) {
      if (e.key === "ArrowDown" && input.value.trim().length >= 3) render();
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, -1); updateActive(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); select(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { close(); }
  });
  input.addEventListener("blur", () => { blurred = true; setTimeout(close, 150); });
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
      let labels = { total: 0, fetched: 0, labels: [], error: null, rateLimited: false };
      if (norm.recognized) labels = await fetchLabels(norm.ingredientNames.length ? norm.ingredientNames : [norm.input]);
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
    pairsBox.appendChild(el("p", { class: "note" },
      "Each pair is checked independently. This tool does not model additive or " +
      "cumulative effects across three or more drugs (for example, several sedatives taken together)."));

    for (let i = 0; i < drugs.length; i++) {
      for (let j = i + 1; j < drugs.length; j++) {
        const result = evaluatePair(drugs[i], drugs[j]);
        pairsBox.appendChild(renderPair(result));
      }
    }
    resultsEl().appendChild(pairsBox);

    // Drug profiles (RxClass) - informational only. Fetched AFTER the interaction
    // verdict is already shown, off the critical path, and rendered progressively.
    // This panel never affects the interaction result above.
    const recognized = drugs.filter(d => d.norm.recognized);
    if (recognized.length) {
      const { box, slots } = buildProfilesCard(drugs);
      resultsEl().appendChild(box);
      mapLimit(recognized, MAX_CONCURRENCY, async (d) => {
        const profile = await fetchProfile(d.norm.ingredientRxcui || d.norm.rxcui);
        const body = slots.get(d);
        if (body) fillProfile(body, profile, d.norm);
      }).catch(() => { /* profiles are best-effort; ignore */ });
    }

    statusEl().textContent = "";
  } catch (err) {
    statusEl().textContent = "Something went wrong: " + (err.message || err) + ". Please try again.";
  } finally {
    checkBtn.disabled = false;
  }
}

// One-click examples that populate the rows and run a check.
const EXAMPLES = [
  ["warfarin", "aspirin"],
  ["warfarin", "fluconazole"],
  ["simvastatin", "clarithromycin"]
];

function setDrugs(list) {
  const rows = rowsEl();
  rows.innerHTML = "";
  for (const name of list) addRow(name);
  while (rows.children.length < 2) addRow("");
}

function runExample(pair) {
  setDrugs(pair);
  document.getElementById("drug-form").requestSubmit();
}

function buildExamples() {
  const box = document.getElementById("example-chips");
  if (!box) return;
  for (const pair of EXAMPLES) {
    const chip = el("button", { type: "button", class: "chip" }, pair.join(" + "));
    chip.addEventListener("click", () => runExample(pair));
    box.appendChild(chip);
  }
}

function init() {
  addRow("");
  addRow("");
  document.getElementById("add-drug").addEventListener("click", () => addRow("").focus());
  document.getElementById("drug-form").addEventListener("submit", run);
  buildExamples();
}

document.addEventListener("DOMContentLoaded", init);
