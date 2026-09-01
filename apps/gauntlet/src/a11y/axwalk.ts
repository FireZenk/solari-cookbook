/** Keyboard reality check.
 *
 *  Static linters tell you an element lacks a label. They cannot tell you that
 *  pressing Tab thirty times never reaches the cookie banner that is covering
 *  the page — because that is a property of the running document, not the
 *  markup. So we press Tab and write down where the focus actually went.
 *
 *  The interesting result is the crossover: a consent banner you cannot reach
 *  with a keyboard is simultaneously an accessibility failure (EN 301 549 /
 *  WCAG 2.1.1) and a consent failure — a person who cannot reach the "reject"
 *  button cannot be said to have freely given consent. */
import type { BrowserContext, Page } from "patchright-core"
import type { A11yReport, AxStop, Finding } from "../types.ts"

const WCAG_KEYBOARD = "EN 301 549 §9.2.1.1 / WCAG 2.1 SC 2.1.1 (Keyboard) — all functionality operable through a keyboard interface"
const WCAG_FOCUS_VISIBLE = "EN 301 549 §9.2.4.7 / WCAG 2.1 SC 2.4.7 (Focus Visible)"
const WCAG_NAME = "EN 301 549 §9.4.1.2 / WCAG 2.1 SC 4.1.2 (Name, Role, Value)"
const EAA = "Directive (EU) 2019/882 (European Accessibility Act), applicable since 28 June 2025"

const MAX_TABS = 60

/** Read whatever currently has focus, piercing shadow roots. */
function readFocused(): {
  tag: string
  role: string
  name: string
  inBanner: boolean
  focusVisible: boolean
  offscreen: boolean
  signature: string
} | null {
  let el: Element | null = document.activeElement
  // A focused custom element delegates into its shadow root; follow it down.
  for (let i = 0; i < 5; i++) {
    const sr = (el as (Element & { shadowRoot?: ShadowRoot | null }) | null)?.shadowRoot
    if (sr?.activeElement) el = sr.activeElement
    else break
  }
  if (!el || el === document.body || el === document.documentElement) return null

  const tag = el.tagName.toLowerCase()

  const IMPLICIT: Record<string, string> = {
    a: "link", button: "button", input: "textbox", select: "combobox",
    textarea: "textbox", summary: "button", iframe: "iframe",
  }
  const explicit = el.getAttribute("role")
  const role = explicit || IMPLICIT[tag] || tag

  // Accessible-name computation, trimmed to the cases that occur in practice.
  const labelledby = el.getAttribute("aria-labelledby")
  let name = el.getAttribute("aria-label")?.trim() ?? ""
  if (!name && labelledby) {
    name = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim()
  }
  if (!name) name = (el as HTMLElement).getAttribute?.("alt")?.trim() ?? ""
  if (!name) name = (el as HTMLInputElement).value?.trim?.() ?? ""
  if (!name) name = el.getAttribute("title")?.trim() ?? ""
  if (!name) name = (el.textContent ?? "").replace(/\s+/g, " ").trim()
  name = name.slice(0, 80)

  const banner = document.querySelector("[data-gauntlet-banner]")
  const inBanner = Boolean(banner && (banner === el || banner.contains(el)))

  const cs = getComputedStyle(el)
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0
  const ring = cs.boxShadow !== "none" && cs.boxShadow !== ""
  const bordered = parseFloat(cs.borderWidth || "0") > 0
  const focusVisible = outline || ring || bordered

  const r = el.getBoundingClientRect()
  const offscreen = r.width === 0 || r.height === 0 || r.bottom < 0 || r.right < 0 ||
    r.top > window.innerHeight || r.left > window.innerWidth

  const gauntletRole = el.getAttribute("data-gauntlet-role") ?? ""
  const signature = `${tag}#${el.id || ""}.${(el.className || "").toString().slice(0, 40)}|${name}|${gauntletRole}`

  return { tag, role, name, inBanner, focusVisible, offscreen, signature }
}

export interface AxWalkOptions {
  /** A banner was detected, so "did focus ever reach it" is a real question. */
  bannerPresent: boolean
  rejectInFirstLayer: boolean
}

export async function keyboardWalk(
  page: Page,
  context: BrowserContext,
  opts: AxWalkOptions,
): Promise<A11yReport> {
  const stops: AxStop[] = []
  const findings: Finding[] = []
  const seen = new Set<string>()
  let reachedBanner = false
  let reachedReject = false
  let stopsBeforeBanner: number | undefined

  try {
    // Start from the top of the document without clicking anything — a click
    // would count as an interaction and contaminate the consent timeline.
    await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      active?.blur?.()
      window.scrollTo(0, 0)
    })

    for (let i = 0; i < MAX_TABS; i++) {
      await page.keyboard.press("Tab")
      const focused = await page.evaluate(readFocused)
      if (!focused) continue

      // Focus cycled back to something we already visited: the tab ring closed.
      if (seen.has(focused.signature)) break
      seen.add(focused.signature)

      stops.push({
        index: i + 1,
        role: focused.role,
        name: focused.name,
        tag: focused.tag,
        inBanner: focused.inBanner,
        focusVisible: focused.focusVisible,
        offscreen: focused.offscreen,
      })

      if (focused.inBanner && !reachedBanner) {
        reachedBanner = true
        stopsBeforeBanner = i
      }
      if (focused.signature.endsWith("|reject")) reachedReject = true
    }
  } catch (err) {
    return {
      ran: false,
      stops,
      reachedBanner,
      findings,
      skippedReason: `keyboard walk failed: ${(err as Error).message.slice(0, 160)}`,
    }
  }

  // ── The crossover finding ──
  if (opts.bannerPresent && !reachedBanner) {
    findings.push({
      code: "BANNER_KEYBOARD_UNREACHABLE",
      severity: "critical",
      title: "The consent banner cannot be reached with the keyboard",
      detail:
        `${MAX_TABS} Tab presses from the top of the document never moved focus into the visible consent ` +
        "banner. A visitor who does not use a mouse cannot accept or refuse — which fails the keyboard " +
        "requirement and, at the same time, means consent cannot be freely given by that visitor.",
      reference: `${WCAG_KEYBOARD} · ${EAA}`,
      evidence: [`${stops.length} focus stops recorded, none inside the banner`],
    })
  } else if (opts.bannerPresent && opts.rejectInFirstLayer && !reachedReject) {
    findings.push({
      code: "REJECT_KEYBOARD_UNREACHABLE",
      severity: "critical",
      title: "Reject-all is visible with a mouse but was never focused by the keyboard",
      detail:
        "Focus entered the banner but never landed on the refusal control within the tab ring.",
      reference: `${WCAG_KEYBOARD} · ${EAA}`,
      evidence: [`banner reached at stop ${(stopsBeforeBanner ?? 0) + 1}, reject never focused`],
    })
  }

  if (opts.bannerPresent && reachedBanner && (stopsBeforeBanner ?? 0) > 10) {
    findings.push({
      code: "BANNER_LATE_IN_FOCUS_ORDER",
      severity: "medium",
      title: `The banner is ${stopsBeforeBanner} tab stops deep`,
      detail:
        "A modal layer that blocks the page should receive focus immediately. Here the keyboard user must " +
        "traverse the page behind the banner before reaching it.",
      reference: "EN 301 549 §9.2.4.3 / WCAG 2.1 SC 2.4.3 (Focus Order)",
      evidence: stops.slice(0, 5).map((s) => `${s.index}. ${s.role} "${s.name || "(no name)"}"`),
    })
  }

  const unnamed = stops.filter((s) => !s.name && s.role !== "iframe")
  if (unnamed.length > 0) {
    findings.push({
      code: "UNNAMED_CONTROL",
      severity: "high",
      title: `${unnamed.length} focusable control(s) with no accessible name`,
      detail: "A screen reader announces these as their role alone — \"button\", \"link\" — with nothing else.",
      reference: WCAG_NAME,
      evidence: unnamed.slice(0, 8).map((s) => `stop ${s.index}: <${s.tag}> role=${s.role}`),
    })
  }

  const invisible = stops.filter((s) => !s.focusVisible)
  if (stops.length > 0 && invisible.length / stops.length > 0.3) {
    findings.push({
      code: "FOCUS_NOT_VISIBLE",
      severity: "medium",
      title: `${invisible.length} of ${stops.length} focus stops show no visible focus indicator`,
      detail:
        "Detected by computed style (outline, box-shadow, border) at the moment of focus. A sighted keyboard " +
        "user cannot tell where they are.",
      reference: WCAG_FOCUS_VISIBLE,
      evidence: invisible.slice(0, 8).map((s) => `stop ${s.index}: ${s.role} "${s.name || "(no name)"}"`),
    })
  }

  const offscreen = stops.filter((s) => s.offscreen)
  if (offscreen.length > 0) {
    findings.push({
      code: "FOCUS_OFFSCREEN",
      severity: "medium",
      title: `${offscreen.length} focus stop(s) land on an element that is not on screen`,
      detail: "Focus moved to an element with no visible box — typically a hidden menu left in the tab order.",
      reference: WCAG_FOCUS_VISIBLE,
      evidence: offscreen.slice(0, 6).map((s) => `stop ${s.index}: ${s.role} "${s.name || "(no name)"}"`),
    })
  }

  return { ran: true, stops, reachedBanner, stopsBeforeBanner, findings }
}

/** Raw accessibility tree, saved verbatim as an evidence artifact. We do not
 *  parse it — it is there so a reviewer can check our reading against Chrome's
 *  own computation. */
export async function dumpAxTree(context: BrowserContext, page: Page): Promise<unknown> {
  const cdp = await context.newCDPSession(page)
  try {
    await cdp.send("Accessibility.enable")
    return await cdp.send("Accessibility.getFullAXTree")
  } catch (err) {
    return { error: (err as Error).message }
  } finally {
    try { await cdp.detach() } catch { /* already gone */ }
  }
}
