/** Generates a sample report from SYNTHETIC data — no network, no API key.
 *
 *  This exists so you can see what Gauntlet produces (and so the renderer and
 *  the rules can be changed with immediate feedback) without spending a
 *  session. Nothing here was measured: the target is a fictional host and the
 *  numbers are hand-written. A real run overwrites this shape with evidence. */
import { writeFileSync, mkdirSync } from "node:fs"
import { consentFindings, sortFindings } from "../src/consent/findings.ts"
import { renderReport } from "../src/report/render.ts"
import { trackerListVersion } from "../src/consent/classify.ts"
import { classifyHost, isFirstParty } from "../src/consent/classify.ts"
import type { AuditRun, CapturedCookie, CapturedRequest, CountryAudit } from "../src/types.ts"

const SITE = "shop.example.test"

function req(url: string, tMs: number, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  const host = new URL(url).hostname
  const { entity, category } = classifyHost(host)
  return {
    requestId: `r${tMs}`, url, host, method: "GET", resourceType: "script", tMs,
    status: 200, setCookie: [], entity, category, firstParty: isFirstParty(host, SITE), ...extra,
  }
}

function cookie(name: string, domain: string, days?: number): CapturedCookie {
  const { entity, category } = classifyHost(domain)
  return {
    name, domain, path: "/", session: days === undefined, httpOnly: false, secure: true,
    sameSite: "None", expiresInDays: days, entity, category, firstParty: isFirstParty(domain, SITE),
  }
}

const preRequests: CapturedRequest[] = [
  req(`https://${SITE}/`, 0, { resourceType: "document" }),
  req(`https://${SITE}/app.css`, 42, { resourceType: "stylesheet" }),
  req("https://www.googletagmanager.com/gtm.js?id=GTM-XXXX", 118),
  req("https://www.google-analytics.com/g/collect?v=2&tid=G-XXXX", 181, {
    initiator: "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
    setCookie: ["_ga=GA1.1.884716223.1756000000; Max-Age=63072000; Path=/; SameSite=Lax"],
  }),
  req("https://connect.facebook.net/en_US/fbevents.js", 204, {
    initiator: "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
  }),
  req("https://www.facebook.com/tr?id=1234567890&ev=PageView", 331, {
    initiator: "https://connect.facebook.net/en_US/fbevents.js",
    setCookie: ["_fbp=fb.1.1756000000.9182736455; Max-Age=7776000; Path=/; SameSite=Lax"],
  }),
  req("https://static.hotjar.com/c/hotjar-1234567.js", 358),
  req("https://fonts.gstatic.com/s/inter/v13/font.woff2", 402, { resourceType: "font" }),
  req("https://cdn.cookielaw.org/scripttemplates/otSDKStub.js", 96),
  req("https://analytics.tiktok.com/i18n/pixel/events.js", 611),
  req("https://widget.unknown-vendor.io/embed.js", 720),
]

const audit: CountryAudit = {
  country: "es",
  sessionId: "sess_synthetic_es",
  proxy: { country: "es", tier: "residential", timezoneId: "Europe/Madrid" },
  startedAt: new Date("2026-09-01T09:14:00Z").toISOString(),
  navigationMs: 1284,
  preConsent: {
    requests: preRequests,
    cookies: [
      cookie("_ga", "google-analytics.com", 730),
      cookie("_fbp", "facebook.com", 90),
      cookie("_hjSession", "hotjar.com", 1),
      cookie("cart_id", SITE, 30),
    ],
    storage: [
      { origin: `https://${SITE}`, kind: "localStorage", key: "_hjSessionUser_1234567", bytes: 122 },
      { origin: `https://${SITE}`, kind: "localStorage", key: "ttq_session", bytes: 64 },
    ],
  },
  cmp: {
    detected: true, vendor: "OneTrust", tcfApi: true, bannerVisible: true,
    acceptInFirstLayer: true, rejectInFirstLayer: false,
    acceptLabel: "Aceptar todas", notes: [],
  },
  a11y: {
    ran: true, reachedBanner: false, stops: [
      { index: 1, role: "link", name: "Saltar al contenido", tag: "a", inBanner: false, focusVisible: true, offscreen: false },
      { index: 2, role: "link", name: "Inicio", tag: "a", inBanner: false, focusVisible: false, offscreen: false },
      { index: 3, role: "button", name: "", tag: "button", inBanner: false, focusVisible: false, offscreen: false },
      { index: 4, role: "combobox", name: "Buscar", tag: "input", inBanner: false, focusVisible: true, offscreen: false },
      { index: 5, role: "link", name: "Cesta", tag: "a", inBanner: false, focusVisible: false, offscreen: false },
    ],
    findings: [],
  },
  findings: [],
  screenshots: ["01-pre-consent.png"],
  errors: [],
}

audit.a11y.findings = [
  {
    code: "BANNER_KEYBOARD_UNREACHABLE",
    severity: "critical",
    title: "The consent banner cannot be reached with the keyboard",
    detail:
      "60 Tab presses from the top of the document never moved focus into the visible consent banner. A " +
      "visitor who does not use a mouse cannot accept or refuse — which fails the keyboard requirement and, " +
      "at the same time, means consent cannot be freely given by that visitor.",
    reference:
      "EN 301 549 §9.2.1.1 / WCAG 2.1 SC 2.1.1 (Keyboard) · Directive (EU) 2019/882 (European Accessibility Act)",
    evidence: ["5 focus stops recorded, none inside the banner"],
  },
  {
    code: "UNNAMED_CONTROL",
    severity: "high",
    title: "1 focusable control with no accessible name",
    detail: 'A screen reader announces these as their role alone — "button", "link" — with nothing else.',
    reference: "EN 301 549 §9.4.1.2 / WCAG 2.1 SC 4.1.2 (Name, Role, Value)",
    evidence: ["stop 3: <button> role=button"],
  },
]

audit.findings = sortFindings([
  ...consentFindings({
    preRequests: audit.preConsent.requests,
    preCookies: audit.preConsent.cookies,
    preStorage: audit.preConsent.storage,
    cmp: audit.cmp,
  }),
  ...audit.a11y.findings,
])

const run: AuditRun = {
  target: `https://${SITE}`,
  startedAt: audit.startedAt,
  finishedAt: new Date("2026-09-01T09:14:41Z").toISOString(),
  gauntletVersion: "0.1.0",
  trackerListVersion,
  countries: [audit],
  evidenceDigest: "synthetic-fixture-not-a-real-measurement",
}

const out = process.argv[2] ?? "docs/sample-report.html"
mkdirSync(out.slice(0, out.lastIndexOf("/")) || ".", { recursive: true })
writeFileSync(out, renderReport(run))
console.log(`wrote ${out} (${audit.findings.length} findings from synthetic data)`)
