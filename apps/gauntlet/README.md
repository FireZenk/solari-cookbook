# Gauntlet

**Evidence-grade auditing of the two EU rules that websites break silently: consent and accessibility.**

Point it at a URL. It loads the page from real browsers in several member states,
records every third-party request and cookie *before anything is clicked*, then presses
Tab sixty times to find out whether a keyboard user could have refused at all.

You get a verdict, and — more importantly — a bundle of evidence that stands up
without you: a HAR with tracker requests stamped at 181ms, the raw `Set-Cookie` headers
that wrote to the device, a video replay proving nobody touched the banner, and a
sha256 manifest over the lot.

```bash
export SOLARI_API_KEY=slr_live_...

node src/preflight.ts                                    # what can this key do?
node src/cli.ts https://example.com                      # audit from the default egress
node src/cli.ts https://example.com --countries es,de,fr # audit as a Spaniard, a German, a French user
node src/serve.ts ./runs/example.com-…                   # publish the report on a public URL
```

[Sample report](docs/sample-report.html) — generated from synthetic data, so you can
see the output shape before spending a session.

---

## Why this needs cloud browsers

Three things about this problem make a laptop the wrong machine:

**Jurisdiction is an input, not a footnote.** The same site shows a different banner —
often no banner — depending on where the request comes from. A Spanish IP, a German IP
and a US IP get three different answers, and only one of them is the one a Spanish
regulator would see. Gauntlet runs the same audit from each vantage point through
Solari's managed proxies, with the session timezone matched to the egress.

**The measurement is destroyed by a warm profile.** Cookies from your last visit, an
extension that blocks trackers, a consent choice you made last month — any of these turn
"no trackers fired" into a lie. Every audit runs in a browser that has never existed
before and will not exist again.

**Evidence has to be watchable.** A JSON file saying a tracker fired is a claim. A
session replay showing the page loading, the banner appearing, and nobody clicking it —
next to a HAR showing the request that went out 181ms in — is evidence.

## What it actually measures

### The consent side — ePrivacy Art. 5(3)

Loads the page and touches nothing. Captures via CDP, not Playwright's request events,
because only CDP gives the two things that matter: raw `Set-Cookie` headers (proof
something was *written*, not merely contacted) and the initiator chain (proof of *what*
loaded it — a Google Tag Manager URL in the initiator field is how "our analytics only
fires after consent" gets disproved in one line).

Then it finds the banner — across frames and shadow roots, matching labels in seven EU
languages — checks whether refusing is offered at the same level as accepting, clicks
reject, and watches whether anything changed.

### The accessibility side — EAA / EN 301 549

Not another axe-core wrapper. Static linters read markup; this presses Tab and writes
down where focus actually went — role, accessible name, whether a focus ring was
visible, whether the element was even on screen.

That produces one finding a linter structurally cannot:

> **The consent banner cannot be reached with the keyboard.**
> Sixty Tab presses, none of them landed in the banner covering the page.

Which is two violations at once, and the reason these two audits belong in one tool. A
person who cannot reach the reject button has not freely given consent — the
accessibility failure *is* a consent failure. The European Accessibility Act has applied
since June 2025; the consent rules have applied since 2009.

## The evidence bundle

```
runs/example.com-2026-09-01T…/
  report.html                     one file, no assets, opens offline, prints
  run.json                        every measurement, machine-readable
  evidence-manifest.json          sha256 per file
  es/
    network-pre-consent.har       openable in DevTools; each entry carries msAfterNavigationStart
    requests-pre-consent.json     classified, with initiator chains
    cookies-pre-consent.json      whole jar, third-party included
    web-storage-pre-consent.json  Art. 5(3) is not only about cookies
    keyboard-walk.json            every focus stop, in order
    ax-tree.json                  Chrome's own accessibility tree, unparsed
    cmp.json                      what the banner offered, and in which words
    01-pre-consent.png            what a visitor saw before touching anything
    02-after-reject.png           what changed after refusing
    findings.json
```

## What it does not do

It does not decide whether a site is lawful. Each finding states what was observed and
the provision that observation is relevant to; whether it amounts to an infringement
depends on facts a browser cannot see — who the controller is, what the purpose was, how
the member state implemented the directive.

The tracker list is a curated subset, versioned in `data/trackers.json`, deliberately
not fetched at runtime: a verdict must change because the *site* changed, never because
a remote list moved. Hosts it does not recognise are reported as `unclassified` rather
than silently counted as clean.

Cookie values are masked in the evidence — name and length, not payload. They can be
personal data, and an audit report is a bad place to put some stranger's identifier.

## Cost

A single-country audit with recording is a browser session of well under a minute:
roughly **$0.002** at the free tier's $0.15/hour. Six countries, about a cent. The
`serve` command holds a 1 vCPU sandbox for as long as you leave the link up
(~$0.086/hour).

Managed proxies require `stealth: true`, which is a paid-plan feature — `preflight` tells
you in ten seconds whether your key can do the multi-country half, and `cli` falls back
to a single direct-egress audit rather than failing.

## Layout

```
src/capture.ts            CDP network capture — raw Set-Cookie, initiator chains, quiet detection
src/consent/cmp.ts        banner detection across frames + shadow roots, seven languages
src/consent/classify.ts   host → entity/category, eTLD+1, first-party test
src/consent/findings.ts   the rules: what was measured, which provision it touches
src/consent/probe.ts      one country, one session — ordering is the whole trick
src/a11y/axwalk.ts        the Tab walk and the crossover finding
src/evidence/bundle.ts    HAR reconstruction, sha256 manifest
src/report/render.ts      the single-file report
src/serve.ts              publish a run from a disposable sandbox
src/preflight.ts          what can this key actually do
```

Built on the [Solari](https://getsolari.com) cookbook this repository is forked from.
The minimal version of the consent probe lives in
[`examples/eu-consent-evidence-ts`](../../examples/eu-consent-evidence-ts) in cookbook style.

MIT.
