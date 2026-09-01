# Pre-consent tracker evidence (TypeScript)

Load a page from a chosen country and record every third-party request **before anything
is clicked** — the measurement behind every EU cookie-consent complaint.

Uses a raw CDP session rather than `page.on("request")`, because CDP is the only place
the wire-level `Set-Cookie` header and the initiator chain survive. Those two fields are
the difference between "a tracker was contacted" and "this script wrote that cookie to
the device, at 181ms, before the banner existed".

`proxy` requires `stealth: true`, and both are paid-plan features — drop the `proxy`
option to run the same audit from the default egress.

## Run

```bash
cd examples/eu-consent-evidence-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start                            # or: npm start -- https://example.com es
```

Source: [`index.ts`](index.ts)
