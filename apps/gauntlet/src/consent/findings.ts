/** Rules. Each one states what was measured and which provision it touches.
 *
 *  Gauntlet does not decide whether a site is lawful — that depends on facts it
 *  cannot see (controller, purpose, national implementation). It reports a
 *  measurement plus the rule that measurement is relevant to, and leaves the
 *  conclusion to whoever is qualified to draw it. */
import type { CapturedCookie, CapturedRequest, CmpReport, Finding, StorageItem } from "../types.ts"
import { categoryLabel, categorySeverity, requiresConsent } from "./classify.ts"

const EPRIVACY = "ePrivacy Directive 2002/58/EC Art. 5(3) — storing or accessing information on a user's device requires prior consent unless strictly necessary"
const GDPR_CONSENT = "GDPR Art. 4(11) + 7 — consent must be freely given, specific, informed and unambiguous"
const EDPB_DARK = "EDPB Guidelines 03/2022 on deceptive design patterns — a refusal must be as easy as an acceptance"
const TRANSFER = "GDPR Chapter V — disclosing an IP address to a third-country recipient is a transfer"

/** Cookie values can be personal data. Evidence keeps the name and shape, not
 *  the payload. */
function maskCookieHeader(line: string): string {
  const eq = line.indexOf("=")
  if (eq < 0) return line.slice(0, 60)
  const name = line.slice(0, eq)
  const rest = line.slice(eq + 1)
  const semi = rest.indexOf(";")
  const value = semi < 0 ? rest : rest.slice(0, semi)
  const attrs = semi < 0 ? "" : rest.slice(semi)
  const masked = value.length <= 6 ? "…" : `${value.slice(0, 6)}…(${value.length} chars)`
  return `${name}=${masked}${attrs}`.slice(0, 200)
}

function describeRequest(r: CapturedRequest): string {
  const via = r.initiator ? ` · loaded by ${r.initiator}` : ""
  return `t=${r.tMs}ms · ${r.method} ${r.url}${via}`
}

export function consentFindings(args: {
  preRequests: CapturedRequest[]
  preCookies: CapturedCookie[]
  preStorage: StorageItem[]
  cmp: CmpReport
  afterReject?: { clicked: boolean; requests: CapturedRequest[]; cookies: CapturedCookie[] }
}): Finding[] {
  const { preRequests, preCookies, preStorage, cmp, afterReject } = args
  const findings: Finding[] = []

  // ── 1. Third-party hosts that need consent, contacted before any click ──
  const consented = preRequests.filter((r) => !r.firstParty && requiresConsent(r.category))
  const byEntity = new Map<string, CapturedRequest[]>()
  for (const r of consented) {
    const key = r.entity ?? r.host
    const bucket = byEntity.get(key)
    if (bucket) bucket.push(r)
    else byEntity.set(key, [r])
  }
  for (const [entity, reqs] of byEntity) {
    const first = reqs[0]
    if (!first) continue
    findings.push({
      code: "PRE_CONSENT_TRACKER",
      severity: categorySeverity(first.category),
      title: `${entity} contacted before any consent interaction`,
      detail:
        `${reqs.length} request${reqs.length === 1 ? "" : "s"} to ${entity} ` +
        `(${categoryLabel(first.category)}), the earliest ${first.tMs}ms after navigation started — ` +
        `before the page had been clicked, and therefore before consent could have been given.`,
      reference: EPRIVACY,
      evidence: reqs.slice(0, 5).map(describeRequest),
    })
  }

  // ── 2. Cookies actually written on the wire, pre-consent ──
  const settersPre = preRequests.filter((r) => r.setCookie.length > 0 && !r.firstParty && requiresConsent(r.category))
  for (const r of settersPre) {
    findings.push({
      code: "PRE_CONSENT_COOKIE",
      severity: "high",
      title: `${r.entity ?? r.host} set ${r.setCookie.length} cookie${r.setCookie.length === 1 ? "" : "s"} before consent`,
      detail:
        `The response at t=${r.tMs}ms carried Set-Cookie headers. This is storage written to the ` +
        `device, not merely a network contact.`,
      reference: EPRIVACY,
      evidence: r.setCookie.slice(0, 5).map(maskCookieHeader),
    })
  }

  const persistentThirdParty = preCookies.filter(
    (c) => !c.firstParty && !c.session && requiresConsent(c.category),
  )
  if (persistentThirdParty.length > 0) {
    findings.push({
      code: "PRE_CONSENT_COOKIE_JAR",
      severity: "high",
      title: `${persistentThirdParty.length} persistent third-party cookie(s) present before consent`,
      detail: "Read from the browser cookie jar after load and before any interaction with the banner.",
      reference: EPRIVACY,
      evidence: persistentThirdParty
        .slice(0, 8)
        .map((c) => `${c.name} · ${c.domain} · expires in ${c.expiresInDays ?? "?"} days · ${c.entity ?? "unclassified"}`),
    })
  }

  // ── 3. Non-cookie storage. Art. 5(3) is technology-neutral. ──
  if (preStorage.length > 0) {
    findings.push({
      code: "PRE_CONSENT_WEB_STORAGE",
      severity: "medium",
      title: `${preStorage.length} localStorage/sessionStorage key(s) written before consent`,
      detail:
        "Art. 5(3) covers any storing of information on the user's terminal equipment, not just cookies. " +
        "Some of these keys may be strictly necessary; the list is reported without judging purpose.",
      reference: EPRIVACY,
      evidence: preStorage.slice(0, 8).map((s) => `${s.kind}["${s.key}"] · ${s.bytes} bytes · ${s.origin}`),
    })
  }

  // ── 4. The banner itself ──
  if (!cmp.bannerVisible && consented.length > 0) {
    findings.push({
      code: "NO_CONSENT_LAYER",
      severity: "high",
      title: "Consent-requiring third parties loaded, and no consent banner was found",
      detail:
        "No visible consent layer was detected in any frame, yet hosts in consent-requiring categories were " +
        "contacted. Either the banner is rendered in a way this audit cannot see, or there is none.",
      reference: GDPR_CONSENT,
      evidence: cmp.notes.slice(0, 3),
    })
  }
  if (cmp.bannerVisible && cmp.acceptInFirstLayer && !cmp.rejectInFirstLayer) {
    findings.push({
      code: "NO_REJECT_FIRST_LAYER",
      severity: "medium",
      title: "Accept is one click; refusing is not offered in the first layer",
      detail:
        `The banner offers "${cmp.acceptLabel}" directly, but no reject-all control was found at the same ` +
        "level. Refusal is therefore more costly than acceptance.",
      reference: EDPB_DARK,
      evidence: [`accept: "${cmp.acceptLabel}"`, "reject: not found in first layer"],
    })
  }

  // ── 5. The one that matters most: ignoring a refusal ──
  if (afterReject?.clicked) {
    const stillTracking = afterReject.requests.filter((r) => !r.firstParty && requiresConsent(r.category))
    if (stillTracking.length > 0) {
      const names = [...new Set(stillTracking.map((r) => r.entity ?? r.host))]
      findings.push({
        code: "TRACKER_AFTER_REJECT",
        severity: "critical",
        title: `Tracking continued after reject-all was clicked (${names.length} host${names.length === 1 ? "" : "s"})`,
        detail:
          "Requests to consent-requiring third parties were observed after the refusal was registered. " +
          "A refusal that changes nothing is the strongest signal in this whole report.",
        reference: EPRIVACY,
        evidence: stillTracking.slice(0, 6).map(describeRequest),
      })
    } else {
      findings.push({
        code: "REJECT_HONOURED",
        severity: "none",
        title: "Reject-all was honoured for the observation window",
        detail: "No consent-requiring third-party requests were seen after the refusal.",
        reference: EPRIVACY,
        evidence: [],
      })
    }
  }

  // ── 6. Third-country transfer, reported at its real (low) severity ──
  const transfers = preRequests.filter((r) => r.category === "data-transfer")
  if (transfers.length > 0) {
    const names = [...new Set(transfers.map((r) => r.entity ?? r.host))]
    findings.push({
      code: "THIRD_COUNTRY_TRANSFER",
      severity: "low",
      title: `IP address disclosed to ${names.join(", ")} on load`,
      detail:
        "These hosts are not trackers, but loading them discloses the visitor's IP to a third-country " +
        "recipient. German courts have treated the Google Fonts case as actionable; self-hosting removes it.",
      reference: TRANSFER,
      evidence: transfers.slice(0, 4).map(describeRequest),
    })
  }

  // ── 7. Honesty about coverage ──
  const unknown = preRequests.filter((r) => !r.firstParty && r.category === "unclassified")
  if (unknown.length > 0) {
    const hosts = [...new Set(unknown.map((r) => r.host))]
    findings.push({
      code: "UNCLASSIFIED_THIRD_PARTY",
      severity: "none",
      title: `${hosts.length} third-party host(s) not in the tracker list`,
      detail:
        "Listed, not judged. The bundled list is a curated subset; an unmatched host is reported so a " +
        "reviewer can decide, rather than being silently counted as clean.",
      reference: "—",
      evidence: hosts.slice(0, 12),
    })
  }

  return findings
}

const ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9))
}

/** Worst severity present, for the one-line headline. */
export function worstSeverity(findings: Finding[]): Finding["severity"] {
  return sortFindings(findings)[0]?.severity ?? "none"
}
