/** Consent-banner detection.
 *
 *  Three things make this harder than it looks, and all three show up on real
 *  EU sites: banners live in shadow roots (Usercentrics), banners live in
 *  cross-origin iframes (Sourcepoint), and the button that means "no" is
 *  written in seven languages. So we search every frame, pierce shadow roots,
 *  and match labels in the EU's big seven rather than English alone. */
import type { Frame, Page } from "patchright-core"
import type { CmpReport } from "../types.ts"

/** Elements we touched get tagged, so a later click or keyboard walk can find
 *  the exact node we reasoned about instead of re-running the heuristics. */
export const BANNER_ATTR = "data-gauntlet-banner"
export const ROLE_ATTR = "data-gauntlet-role"

interface InPageResult {
  vendor?: string
  tcfApi: boolean
  bannerVisible: boolean
  bannerText: string
  acceptLabel?: string
  rejectLabel?: string
  settingsLabel?: string
  notes: string[]
}

/** Runs inside the page. Keep it dependency-free and defensive: a throw here
 *  costs us the whole audit for that country. */
function inPageDetect(): InPageResult {
  const notes: string[] = []
  const w = window as unknown as Record<string, unknown>

  const VENDOR_GLOBALS: Array<[string, string]> = [
    ["OneTrust", "OneTrust"],
    ["Optanon", "OneTrust"],
    ["Cookiebot", "Cookiebot"],
    ["CookieConsent", "Cookiebot"],
    ["Didomi", "Didomi"],
    ["UC_UI", "Usercentrics"],
    ["__ucCmp", "Usercentrics"],
    ["_iub", "Iubenda"],
    ["Osano", "Osano"],
    ["_sp_", "Sourcepoint"],
    ["klaro", "Klaro"],
    ["cookieconsent", "Cookie Consent (Osano OSS)"],
    ["tarteaucitron", "Tarteaucitron"],
    ["Cookiehub", "CookieHub"],
    ["axeptioSDK", "Axeptio"],
  ]
  let vendor: string | undefined
  for (const [key, name] of VENDOR_GLOBALS) {
    if (w[key] !== undefined) { vendor = name; break }
  }
  const tcfApi = typeof w["__tcfapi"] === "function"

  /** Every element in the frame, shadow roots included. */
  function deepElements(root: Document | ShadowRoot, out: Element[], depth: number): void {
    if (depth > 6 || out.length > 6000) return
    const all = root.querySelectorAll("*")
    for (const el of Array.from(all)) {
      out.push(el)
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
      if (sr) deepElements(sr, out, depth + 1)
    }
  }
  const elements: Element[] = []
  try { deepElements(document, elements, 0) } catch { notes.push("deep DOM walk truncated") }

  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 20) return false
    const cs = getComputedStyle(el)
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false
    return true
  }

  // "Cookie" is a loanword across the EU, so it carries most of the weight —
  // but the German and French banners that say only "Datenschutz" or
  // "confidentialité" are exactly the ones worth catching.
  const BANNER_WORDS =
    /cookie|consent|consentimiento|privacidad|datenschutz|einwilligung|zustimmung|confidentialit|consentement|consenso|privacidade|toestemming|privacy/i
  const ACCEPT =
    /\b(accept|agree|allow all|got it|ok|aceptar|acepto|de acuerdo|zustimmen|akzeptieren|einverstanden|alle erlauben|accepter|j'accepte|tout accepter|accetta|accetto|aceitar|akkoord|alles accepteren)\b/i
  const REJECT =
    /\b(reject|decline|refuse|deny|only necessary|necessary only|essential only|only essential|rechazar|denegar|solo necesarias|solo las necesarias|s[oó]lo necesarias|ablehnen|nur notwendige|alle ablehnen|refuser|tout refuser|rifiuta|solo necessari|recusar|rejeitar|weigeren|afwijzen|alles weigeren)\b/i
  const SETTINGS =
    /\b(settings|manage|preferences|customi[sz]e|options|configurar|personalizar|ajustes|preferencias|einstellungen|verwalten|anpassen|param[eè]tres|g[eé]rer|personnaliser|impostazioni|gestisci|instellingen|beheren)\b/i

  // A container mentioning "cookie" is not a consent banner. Footers say
  // "Cookie policy" too — the first run of this tool matched one and invented a
  // finding out of it. A banner has to either offer a consent decision (accept /
  // reject) or behave like an overlay (fixed, sticky, or a modal dialog).
  function overlayTraits(el: Element): { overlay: boolean; why: string } {
    const cs = getComputedStyle(el)
    const fixed = cs.position === "fixed" || cs.position === "sticky"
    const z = parseInt(cs.zIndex || "0", 10)
    const dialog = el.getAttribute("role") === "dialog" ||
      el.getAttribute("role") === "alertdialog" ||
      el.hasAttribute("aria-modal")
    const why = [fixed ? `position:${cs.position}` : "", z >= 10 ? `z-index:${z}` : "", dialog ? "role=dialog" : ""]
      .filter(Boolean).join(" ")
    return { overlay: fixed || z >= 10 || dialog, why }
  }

  function labelsOf(el: Element): { accept?: Element; reject?: Element; settings?: Element } {
    const controls = Array.from(
      el.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]"),
    ).filter((c) => visible(c))
    const found: { accept?: Element; reject?: Element; settings?: Element } = {}
    for (const c of controls) {
      const label = ((c.textContent || "") + " " + (c.getAttribute("aria-label") || "")).trim().replace(/\s+/g, " ")
      if (!label || label.length > 80) continue
      if (!found.reject && REJECT.test(label)) { found.reject = c; continue }
      if (!found.accept && ACCEPT.test(label)) { found.accept = c; continue }
      if (!found.settings && SETTINGS.test(label)) found.settings = c
    }
    return found
  }

  let banner: Element | undefined
  let bannerArea = Number.POSITIVE_INFINITY
  let bannerLabels: { accept?: Element; reject?: Element; settings?: Element } = {}
  const nearMisses: string[] = []

  for (const el of elements) {
    const text = (el.textContent || "").slice(0, 4000)
    if (text.length < 15 || text.length > 3000) continue
    if (!BANNER_WORDS.test(text)) continue
    if (!visible(el)) continue
    const found = labelsOf(el)
    const { overlay, why } = overlayTraits(el)

    // Strong: it offers a decision. Weak: only a settings link, which needs to
    // look like an overlay before we believe it. Otherwise: not a banner.
    const decides = Boolean(found.accept || found.reject)
    const qualifies = decides || (Boolean(found.settings) && overlay) || (overlay && Boolean(vendor))
    if (!qualifies) {
      if (Object.keys(found).length > 0 || overlay) {
        nearMisses.push(
          `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}: consent wording but no decision control${why ? ` (${why})` : ""}`,
        )
      }
      continue
    }

    const r = el.getBoundingClientRect()
    const area = r.width * r.height
    if (area < bannerArea) { banner = el; bannerArea = area; bannerLabels = found }
  }

  if (!banner) {
    return {
      vendor,
      tcfApi,
      bannerVisible: false,
      bannerText: "",
      notes: [...notes, ...nearMisses.slice(0, 3)],
    }
  }
  banner.setAttribute("data-gauntlet-banner", "1")

  let acceptLabel: string | undefined
  let rejectLabel: string | undefined
  let settingsLabel: string | undefined
  const readLabel = (el: Element): string =>
    ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).trim().replace(/\s+/g, " ").slice(0, 80)

  if (bannerLabels.accept) {
    acceptLabel = readLabel(bannerLabels.accept)
    bannerLabels.accept.setAttribute("data-gauntlet-role", "accept")
  }
  if (bannerLabels.reject) {
    rejectLabel = readLabel(bannerLabels.reject)
    bannerLabels.reject.setAttribute("data-gauntlet-role", "reject")
  }
  if (bannerLabels.settings) {
    settingsLabel = readLabel(bannerLabels.settings)
    bannerLabels.settings.setAttribute("data-gauntlet-role", "settings")
  }

  return {
    vendor,
    tcfApi,
    bannerVisible: true,
    bannerText: (banner.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600),
    acceptLabel,
    rejectLabel,
    settingsLabel,
    notes,
  }
}

export interface CmpDetection {
  report: CmpReport
  /** Frame holding the banner — a click has to be issued there, not on `page`. */
  frame?: Frame
  bannerText: string
}

/** Detect across every frame. Cross-origin CMP iframes are the norm, not an
 *  edge case, so the main frame coming back empty means very little. */
export async function detectCmp(page: Page): Promise<CmpDetection> {
  const frames = page.frames()
  let best: InPageResult | undefined
  let bestFrame: Frame | undefined
  const notes: string[] = []

  for (const frame of frames) {
    let res: InPageResult | undefined
    try {
      res = await frame.evaluate(inPageDetect)
    } catch (err) {
      // Detached frames and hard CSP are routine here; record and move on.
      notes.push(`frame ${frame.url().slice(0, 80)}: ${(err as Error).message.slice(0, 120)}`)
      continue
    }
    if (!res) continue
    if (res.bannerVisible && (!best || !best.bannerVisible)) { best = res; bestFrame = frame }
    else if (!best) { best = res; bestFrame = frame }
    if (best?.bannerVisible && best.rejectLabel) break
  }

  const r = best ?? { tcfApi: false, bannerVisible: false, bannerText: "", notes: [] }
  const report: CmpReport = {
    detected: Boolean(r.vendor || r.tcfApi || r.bannerVisible),
    vendor: r.vendor,
    tcfApi: r.tcfApi,
    bannerVisible: r.bannerVisible,
    acceptInFirstLayer: Boolean(r.acceptLabel),
    rejectInFirstLayer: Boolean(r.rejectLabel),
    acceptLabel: r.acceptLabel,
    rejectLabel: r.rejectLabel,
    notes: [...notes.slice(0, 5), ...(r.notes ?? [])],
  }
  return { report, frame: bestFrame, bannerText: r.bannerText }
}

/** Click reject-all in the first layer. Returns false when there was nothing
 *  to click — which is itself a finding, not an error. */
export async function clickReject(detection: CmpDetection): Promise<boolean> {
  if (!detection.frame || !detection.report.rejectInFirstLayer) return false
  const locator = detection.frame.locator(`[${ROLE_ATTR}="reject"]`).first()
  try {
    await locator.click({ timeout: 5000 })
    return true
  } catch {
    return false
  }
}
