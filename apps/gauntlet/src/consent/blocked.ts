/** Did we actually reach the site?
 *
 *  A bot wall returns 403 and serves a CAPTCHA interstitial that has its own
 *  scripts, its own storage and no consent banner. Measure that and you produce
 *  a report accusing a site of things the *challenge page* did — which is worse
 *  than producing nothing, because it looks like evidence.
 *
 *  So: detect the wall, refuse the verdict, say why. */
import type { CapturedRequest, Finding } from "../types.ts"

/** Hosts that mean "you are talking to a bot wall, not the site". */
const CHALLENGE_HOSTS = [
  ["captcha-delivery.com", "DataDome"],
  ["geo.captcha-delivery.com", "DataDome"],
  ["challenges.cloudflare.com", "Cloudflare Turnstile / challenge"],
  ["hcaptcha.com", "hCaptcha"],
  ["px-cdn.net", "PerimeterX / HUMAN"],
  ["perimeterx.net", "PerimeterX / HUMAN"],
  ["imperva.com", "Imperva"],
  ["incapsula.com", "Imperva Incapsula"],
  ["arkoselabs.com", "Arkose Labs"],
  ["queue-it.net", "Queue-it"],
] as const

export interface BlockCheck {
  blocked: boolean
  reason: string
  evidence: string[]
}

export function detectBlock(requests: CapturedRequest[], finalUrl: string): BlockCheck {
  const evidence: string[] = []

  const documents = requests.filter((r) => r.resourceType === "Document")
  const main = documents[0]
  const badStatus = documents.find((d) => d.status !== undefined && d.status >= 400)

  const challenge = requests
    .map((r) => {
      const hit = CHALLENGE_HOSTS.find(([host]) => r.host === host || r.host.endsWith(`.${host}`))
      return hit ? { vendor: hit[1], request: r } : null
    })
    .find(Boolean)

  if (challenge) {
    evidence.push(`${challenge.vendor} served at t=${challenge.request.tMs}ms — ${challenge.request.url.slice(0, 120)}`)
  }
  if (badStatus) {
    evidence.push(`main document returned HTTP ${badStatus.status} (${badStatus.url.slice(0, 120)})`)
  }
  if (main && !badStatus && !challenge) {
    return { blocked: false, reason: "", evidence: [] }
  }

  if (challenge) {
    return {
      blocked: true,
      reason: `blocked by ${challenge.vendor} before the site was reached`,
      evidence,
    }
  }
  if (badStatus) {
    return { blocked: true, reason: `the site returned HTTP ${badStatus.status}`, evidence }
  }
  if (!main) {
    return {
      blocked: true,
      reason: "no main document was captured — the navigation never completed",
      evidence: [`final URL: ${finalUrl}`],
    }
  }
  return { blocked: false, reason: "", evidence: [] }
}

/** The only finding a blocked run is allowed to produce. */
export function blockedFinding(check: BlockCheck): Finding {
  return {
    code: "BLOCKED_BEFORE_MEASUREMENT",
    severity: "none",
    title: `No audit was possible — ${check.reason}`,
    detail:
      "The browser never reached the site, so nothing here describes it. Any tracker, cookie or missing " +
      "banner observed at this point belongs to the challenge page, not to the target, and reporting them " +
      "would be reporting on the wrong document. Retry with stealth and a residential proxy " +
      "(`--countries es`), which is what that combination exists for.",
    reference: "—",
    evidence: check.evidence,
  }
}
