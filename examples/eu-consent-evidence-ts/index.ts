/**
 * Pre-consent tracker evidence — what fires before the visitor agrees to anything.
 *
 * The whole audit rests on ordering: load, measure, and only then interact. Anything
 * you click before the snapshot is taken makes the phrase "before consent" untrue.
 */
import { Solari } from "@solarisdk/browser"

const target = process.argv[2] ?? "https://www.bbc.com"
const country = process.argv[3] // e.g. "es" — omit for default egress

const TRACKERS = /google-analytics|googletagmanager|doubleclick|facebook|hotjar|clarity\.ms|tiktok|criteo|adnxs/i

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// A managed proxy requires stealth. Without a paid plan, both are refused with
// `SolariError.code === "FeatureRequiresPlan"` — so this stays optional.
const browser = await solari.launch(country ? { stealth: true, proxy: { country } } : {})

try {
  const context = browser.contexts()[0]!
  const page = await context.newPage()

  // CDP, not `page.on("request")`. Playwright's event gives you the URL; only CDP
  // gives you `Network.responseReceivedExtraInfo`, which carries the raw Set-Cookie
  // headers, and `initiator`, which says what loaded it.
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")

  const hits: Array<{ tMs: number; url: string; via?: string; setCookie: string[] }> = []
  const byId = new Map<string, { tMs: number; url: string; via?: string; setCookie: string[] }>()
  const t0 = Date.now()

  cdp.on("Network.requestWillBeSent", (e: any) => {
    const url: string = e.request?.url ?? ""
    if (!TRACKERS.test(url)) return
    const rec = {
      tMs: Date.now() - t0,
      url,
      via: e.initiator?.url ?? e.initiator?.stack?.callFrames?.[0]?.url,
      setCookie: [] as string[],
    }
    byId.set(e.requestId, rec)
    hits.push(rec)
  })

  cdp.on("Network.responseReceivedExtraInfo", (e: any) => {
    const rec = byId.get(e.requestId)
    if (!rec) return
    for (const [k, v] of Object.entries(e.headers ?? {})) {
      if (k.toLowerCase() === "set-cookie") rec.setCookie.push(...String(v).split("\n"))
    }
  })

  await page.goto(target, { waitUntil: "domcontentloaded" })

  // Not `networkidle`: analytics beacons and long-polling keep it pending forever on
  // exactly the sites worth auditing. Wait a fixed settle window instead.
  await page.waitForTimeout(4000)

  console.log(`\n${target}${country ? `  (egress ${browser.proxy?.country}, tz ${browser.proxy?.timezoneId})` : ""}`)
  console.log(`${hits.length} tracker request(s) before any interaction:\n`)
  for (const h of hits.slice(0, 15)) {
    console.log(`  t=${String(h.tMs).padStart(5)}ms  ${new URL(h.url).hostname}`)
    if (h.via) console.log(`             loaded by ${h.via.slice(0, 90)}`)
    for (const c of h.setCookie.slice(0, 2)) console.log(`             Set-Cookie: ${c.slice(0, 80)}`)
  }

  // Whole-browser jar. `context.cookies()` only returns what matches the URLs you
  // pass it — the wrong shape when the point is finding cookies you did not expect.
  const { cookies } = (await cdp.send("Network.getAllCookies")) as any
  const thirdParty = cookies.filter((c: any) => !new URL(target).hostname.endsWith(c.domain.replace(/^\./, "")))
  console.log(`\n${thirdParty.length} third-party cookie(s) in the jar before consent.`)
} finally {
  // close() ends the browser AND releases the session.
  await browser.close()
  // REQUIRED: the client keeps a loopback proxy open for connection retries, and that
  // handle keeps the event loop alive. Skip this and the script hangs after printing.
  await solari.close()
}
