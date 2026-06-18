# Data sources and licenses

DrugInteract ships **no bundled interaction dataset**. All drug data is fetched
live, from the user's browser, from public U.S. government APIs at query time.
This file documents those sources and their terms, and covers the **data** only.

The application's **source code** is licensed separately under the **MIT License**
(see `LICENSE`). That MIT license applies to the code only - it does **not** apply
to the data, which comes from the public-domain and open U.S. government sources
described below.

## openFDA Drug Label API

- Endpoint: `https://api.fda.gov/drug/label.json`
- Provider: U.S. Food and Drug Administration (FDA)
- Status: **Public domain.** openFDA data is produced by the U.S. federal
  government and is not subject to copyright within the United States.
- Required notice (FDA): **"Do not rely on openFDA to make decisions regarding
  medical care. While we make every effort to ensure that data is accurate, you
  should assume all results are unvalidated."**
- Fields used: `drug_interactions` (Section 7), `contraindications` (Section 4),
  and the `openfda` annotations `generic_name`, `brand_name`, `substance_name`,
  `rxcui`, `spl_set_id`, and `effective_time`.
- No API key is used. Anonymous use is rate-limited per IP by openFDA.

## RxNorm (via the RxNav REST API)

- Endpoint: `https://rxnav.nlm.nih.gov/REST/`
- Provider: U.S. National Library of Medicine (NLM), National Institutes of Health
- Status: RxNorm is in the **public domain**.
- Required notice (NLM): drug name normalization is provided **courtesy of the
  U.S. National Library of Medicine. NLM does not endorse this product.**
- Functions used: `findRxcuiByString`, `spellingsuggestions`, and concept
  relations (`related`) to resolve ingredients.
- The RxNorm drug-drug interaction API was **discontinued on 2 January 2024** and
  is **not** used by this project.

## RxClass (via the RxNav REST API)

- Endpoint: `https://rxnav.nlm.nih.gov/REST/rxclass/`
- Provider: U.S. National Library of Medicine (NLM), National Institutes of Health
- Status: **Public domain.** No license or API key required.
- Required notice (NLM): the drug profile panel (ATC, EPC, MoA, and CYP
  inhibitor/inducer classes) is provided **courtesy of the U.S. National Library
  of Medicine. NLM does not endorse this product.**
- Used for informational background only; it never determines an interaction
  result. RxClass underlying sources include ATC, FDA SPL/DailyMed, and MED-RT.
- RxClass has no CYP "substrate" classification; substrate is never inferred.

## Attribution placement

These attributions appear in the site footer and on the Methods & About page, in
addition to this file.
