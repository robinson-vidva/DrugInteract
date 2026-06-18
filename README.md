# DrugInteract

A free, non-commercial, **educational** drug-drug interaction reference. It is a
fully client-side static web page: no backend, no framework, no build step, and
no bundled dataset. Every lookup is a live query, from your browser, to two free
public U.S. government APIs.

> **Educational use only.** DrugInteract is not medical advice, diagnosis, or
> treatment. Data may be incomplete or contain errors; the absence of a listed
> interaction does **not** mean a combination is safe. Always consult a qualified
> healthcare professional.

## What it does

1. You enter two or more drugs (generic or brand names).
2. Each name is normalized with **RxNorm** and resolved to its active ingredient.
3. For each drug, the **openFDA Drug Label API** is queried by generic name.
4. For each pair, the *Drug Interactions* (Section 7) and *Contraindications*
   (Section 4) text of every returned label is searched, in both directions, for
   the other drug's names.
5. Results are reported as one of five clearly distinct states, with the label's
   own wording quoted and cited.

### The five result states

- **Interaction mentioned** - a label names the other drug (snippet + citation).
- **No interaction mentioned** - labels were searched, nothing found (not "safe").
- **No FDA label to check** - recognized by RxNorm, but no searchable label exists.
- **Drug not recognized** - RxNorm did not recognize the input (suggestions shown).
- **Lookup error** - a transient network/API problem; try again.

It does **not** grade severity (openFDA has no Major/Moderate/Minor) and does not
give clinical recommendations.

## Run locally

No build step. Serve the folder over HTTP (the APIs require `http(s)`, not
`file://`):

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Data sources and licenses

- **openFDA Drug Label API** - U.S. FDA, public domain.
- **RxNorm / RxNav** - U.S. National Library of Medicine, public domain; courtesy
  of the NLM, which does not endorse this product.

See [`DATA_LICENSE.md`](DATA_LICENSE.md) for data terms and required notices, and
[`LICENSE`](LICENSE) for the code license. See the in-app **Methods & About** page
for the full methodology and limitations.
