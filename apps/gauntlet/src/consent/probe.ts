/** One audit, one country, one browser session.
 *
 *  Order matters and is not negotiable: everything that counts as evidence is
 *  captured *before* anything that counts as an interaction. Load, measure,
 *  screenshot, read the banner — and only then start pressing keys and
 *  clicking. Get that backwards and the central claim ("this fired before
 *  consent") stops being true. */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Solari } from "@solarisdk/browser"
import type { BrowserContext, Page } from "patchright-core"
import { NetworkCapture, readWebStorage } from "../capture.ts"
import { dumpAxTree, keyboardWalk } from "../a11y/axwalk.ts"
import { clickReject, detectCmp } from "./cmp.ts"
import { blockedFinding, detectBlock } from "./blocked.ts"
import { consentFindings, sortFindings } from "./findings.ts"
import { ensureDir, writeCountryEvidence } from "../evidence/bundle.ts"
import type { A11yReport, CountryAudit } from "../types.ts"

export interface ProbeOptions {
  solari: Solari
  target: string
  /** ISO-3166-1 alpha-2, lowercase. `undefined` = direct egress, no proxy,
   *  which is the only mode available without a paid plan. */
  country?: string
  evidenceRoot: string
  a11y: boolean
  recording: boolean
}

export async function auditCountry(opts: ProbeOptions): Promise<CountryAudit> {
  const { solari, target, country, evidenceRoot, a11y, recording } = opts
  const label = country ?? "direct"
  const dir = ensureDir(join(evidenceRoot, label))
  const siteHost = new URL(target).hostname
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const screenshots: string[] = []

  const audit: CountryAudit = {
    country: label,
    sessionId: "",
    startedAt,
    navigationMs: 0,
    preConsent: { requests: [], cookies: [], storage: [] },
    cmp: {
      detected: false, tcfApi: false, bannerVisible: false,
      acceptInFirstLayer: false, rejectInFirstLayer: false, notes: [],
    },
    a11y: { ran: false, stops: [], reachedBanner: false, findings: [], skippedReason: "not requested" },
    findings: [],
    screenshots,
    errors,
  }

  // A proxy requires stealth; without a proxy we stay on the plain path so the
  // whole tool still works on a free key.
  const browser = await solari.launch({
    recording,
    ...(country ? { stealth: true, proxy: { country } } : {}),
  })
  audit.sessionId = browser.id
  if (browser.proxy) {
    audit.proxy = {
      country: browser.proxy.country,
      tier: browser.proxy.tier,
      timezoneId: browser.proxy.timezoneId,
    }
  }

  let axTree: unknown = null

  const finish = async (): Promise<CountryAudit> => {
    await browser.close()
    if (recording) audit.replayUrl = await fetchReplayUrl(opts.solari, audit.sessionId, errors)
    writeCountryEvidence(dir, audit, axTree)
    return audit
  }

  try {
    const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext())
    const page: Page = await context.newPage()
    // Desktop viewport: consent banners often differ on mobile, and we want the
    // layout most auditors will check first.
    await page.setViewportSize({ width: 1440, height: 900 })

    const capture = await NetworkCapture.attach(context, page, siteHost)

    // ── Phase 1: load and measure. No interaction of any kind. ──
    capture.markNavigationStart()
    const navStart = Date.now()
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 })
    } catch (err) {
      errors.push(`navigation: ${(err as Error).message.slice(0, 200)}`)
    }
    audit.navigationMs = Date.now() - navStart
    await capture.waitForQuiet()

    audit.preConsent.requests = capture.requests()
    audit.preConsent.cookies = await capture.cookies()
    audit.preConsent.storage = await readWebStorage(page)

    try {
      const shot = await page.screenshot({ fullPage: false })
      const name = "01-pre-consent.png"
      writeFileSync(join(dir, name), shot)
      screenshots.push(name)
    } catch (err) {
      errors.push(`screenshot: ${(err as Error).message.slice(0, 120)}`)
    }

    // ── Gate: did we reach the site at all? ──
    const block = detectBlock(audit.preConsent.requests, page.url())
    if (block.blocked) {
      audit.blocked = { reason: block.reason, evidence: block.evidence }
      audit.findings = [blockedFinding(block)]
      await capture.detach()
      return await finish()
    }

    // ── Phase 2: read the consent layer (tags the DOM, sends no events) ──
    let detection = await detectCmp(page)
    // Plenty of CMPs inject the banner a couple of seconds after load, well past
    // network quiet. Looking once and concluding "no banner" is how you file a
    // false report.
    if (!detection.report.bannerVisible) {
      await new Promise((r) => setTimeout(r, 3000))
      detection = await detectCmp(page)
    }
    audit.cmp = detection.report

    // ── Phase 3: keyboard walk. Tab presses only — no clicks, so the consent
    //    state is still untouched when we ask whether the banner is reachable. ──
    if (a11y) {
      const walk: A11yReport = await keyboardWalk(page, context, {
        bannerPresent: detection.report.bannerVisible,
        rejectInFirstLayer: detection.report.rejectInFirstLayer,
      })
      audit.a11y = walk
      axTree = await dumpAxTree(context, page)
    }

    // ── Phase 4: now we may interact. Refuse, and watch what happens next. ──
    if (detection.report.rejectInFirstLayer) {
      capture.reset()
      const clicked = await clickReject(detection)
      if (clicked) {
        await capture.waitForQuiet(2000, 8000)
        audit.afterReject = {
          clicked: true,
          label: detection.report.rejectLabel,
          requests: capture.requests(),
          cookies: await capture.cookies(),
        }
        try {
          const shot = await page.screenshot({ fullPage: false })
          const name = "02-after-reject.png"
          writeFileSync(join(dir, name), shot)
          screenshots.push(name)
        } catch { /* the page may have navigated away on reject */ }
      } else {
        errors.push("reject control was detected but could not be clicked")
      }
    }

    const vantageNote = audit.proxy
      ? []
      : [{
          code: "VANTAGE_POINT_NOT_EU",
          severity: "none" as const,
          title: "Measured from Solari's default egress (us-west), not from an EU member state",
          detail:
            "Sites routinely serve a different consent experience by geography — often no banner at all to " +
            "visitors outside the EU. This run therefore describes what a US visitor sees. Re-run with " +
            "--countries to measure the jurisdiction that actually applies.",
          reference: "—",
          evidence: [],
        }]

    audit.findings = sortFindings([
      ...consentFindings({
        preRequests: audit.preConsent.requests,
        preCookies: audit.preConsent.cookies,
        preStorage: audit.preConsent.storage,
        cmp: audit.cmp,
        afterReject: audit.afterReject,
      }),
      ...audit.a11y.findings,
      ...vantageNote,
    ])

    await capture.detach()
  } catch (err) {
    errors.push(`audit: ${(err as Error).message.slice(0, 200)}`)
    // close() ends the browser AND releases the session. Skipping it holds the
    // slot until the plan deadline.
    await browser.close().catch(() => {})
    writeCountryEvidence(dir, audit, axTree)
    throw err
  }

  // The replay upload is async: it only exists once the session is released,
  // which is why finish() closes first and asks for the replay after.
  return await finish()
}

/** Poll for the replay. The docs say 1-3s after release; the cookbook warns it
 *  can take ~30s. Believe the cookbook. */
async function fetchReplayUrl(solari: Solari, sessionId: string, errors: string[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const replay = await solari.sessions.getReplayUrl(sessionId)
      if (replay?.url) return replay.url
    } catch {
      // 404 until the upload lands — expected, keep waiting.
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  errors.push("replay never became available (waited 30s)")
  return undefined
}
