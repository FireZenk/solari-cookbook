/** CDP network capture.
 *
 *  Playwright's own `page.on("request")` would be simpler, but it cannot show
 *  you the raw `Set-Cookie` headers or the initiator chain — and those are the
 *  two things that turn "there was a tracker" into evidence: the header proves
 *  a cookie was *written*, the initiator proves what wrote it. */
import type { BrowserContext, CDPSession, Page } from "patchright-core"
import type { CapturedCookie, CapturedRequest, StorageItem } from "./types.ts"
import { classifyHost, isFirstParty } from "./consent/classify.ts"

interface RawRequest {
  requestId: string
  url: string
  method: string
  resourceType: string
  tMs: number
  initiator?: string
  status?: number
  setCookie: string[]
}

export class NetworkCapture {
  private readonly cdp: CDPSession
  private readonly siteHost: string
  private readonly raw = new Map<string, RawRequest>()
  private order: string[] = []
  private t0 = 0
  private lastActivity = 0

  private constructor(cdp: CDPSession, siteHost: string) {
    this.cdp = cdp
    this.siteHost = siteHost
  }

  static async attach(context: BrowserContext, page: Page, siteHost: string): Promise<NetworkCapture> {
    const cdp = await context.newCDPSession(page)
    const cap = new NetworkCapture(cdp, siteHost)
    await cdp.send("Network.enable")
    cap.wire()
    return cap
  }

  private wire(): void {
    this.cdp.on("Network.requestWillBeSent", (e: any) => {
      const url: string = e.request?.url ?? ""
      if (!url.startsWith("http")) return // data:/blob:/about: carry no egress
      const rec: RawRequest = {
        requestId: e.requestId,
        url,
        method: e.request?.method ?? "GET",
        resourceType: e.type ?? "Other",
        tMs: Math.max(0, Math.round(performanceNow() - this.t0)),
        initiator: initiatorUrl(e.initiator),
        setCookie: [],
      }
      this.raw.set(e.requestId, rec)
      this.order.push(e.requestId)
      this.lastActivity = performanceNow()
    })

    this.cdp.on("Network.responseReceived", (e: any) => {
      const rec = this.raw.get(e.requestId)
      if (rec) rec.status = e.response?.status
      this.lastActivity = performanceNow()
    })

    // Raw response headers before the browser processes them — this is the only
    // place the wire-level `Set-Cookie` survives.
    this.cdp.on("Network.responseReceivedExtraInfo", (e: any) => {
      const rec = this.raw.get(e.requestId)
      if (!rec) return
      const headers = e.headers ?? {}
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== "set-cookie") continue
        for (const line of String(v).split("\n")) {
          const trimmed = line.trim()
          if (trimmed) rec.setCookie.push(trimmed)
        }
      }
      this.lastActivity = performanceNow()
    })

    this.cdp.on("Network.loadingFinished", () => { this.lastActivity = performanceNow() })
    this.cdp.on("Network.loadingFailed", () => { this.lastActivity = performanceNow() })
  }

  /** Zero the clock. Every `tMs` afterwards is "ms after navigation start",
   *  which is the number the whole pre-consent argument rests on. */
  markNavigationStart(): void {
    this.t0 = performanceNow()
    this.lastActivity = this.t0
  }

  /** Drop everything captured so far — used to separate the pre-consent phase
   *  from the after-reject phase without opening a second session. */
  reset(): void {
    this.raw.clear()
    this.order = []
    this.markNavigationStart()
  }

  /** Wait until the page stops talking. Not `networkidle`: long-polling and
   *  analytics beacons keep that pending forever on real sites. */
  async waitForQuiet(quietMs = 1500, maxMs = 12000): Promise<void> {
    const deadline = performanceNow() + maxMs
    for (;;) {
      const now = performanceNow()
      if (now - this.lastActivity >= quietMs) return
      if (now >= deadline) return
      await sleep(150)
    }
  }

  requests(): CapturedRequest[] {
    const out: CapturedRequest[] = []
    for (const id of this.order) {
      const r = this.raw.get(id)
      if (!r) continue
      let host: string
      try { host = new URL(r.url).hostname } catch { continue }
      const { entity, category } = classifyHost(host)
      out.push({
        requestId: r.requestId,
        url: r.url.length > 500 ? r.url.slice(0, 500) + "…" : r.url,
        host,
        method: r.method,
        resourceType: r.resourceType,
        tMs: r.tMs,
        status: r.status,
        setCookie: r.setCookie,
        entity,
        category,
        firstParty: isFirstParty(host, this.siteHost),
        initiator: r.initiator,
      })
    }
    return out
  }

  /** Whole-browser cookie jar, third-party cookies included. `context.cookies()`
   *  only returns what matches the URLs you pass it, which is exactly the wrong
   *  shape when the point is to find cookies you did not expect. */
  async cookies(): Promise<CapturedCookie[]> {
    const res = (await this.cdp.send("Network.getAllCookies")) as any
    const now = Date.now() / 1000
    const out: CapturedCookie[] = []
    for (const c of res.cookies ?? []) {
      const domain = String(c.domain ?? "").replace(/^\./, "")
      const { entity, category } = classifyHost(domain)
      out.push({
        name: c.name,
        domain,
        path: c.path ?? "/",
        session: Boolean(c.session),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite,
        expiresInDays: c.session || !c.expires || c.expires < 0
          ? undefined
          : Math.round(((c.expires as number) - now) / 86400),
        entity,
        category,
        firstParty: isFirstParty(domain, this.siteHost),
      })
    }
    return out
  }

  async detach(): Promise<void> {
    try { await this.cdp.detach() } catch { /* session already gone */ }
  }
}

/** localStorage/sessionStorage written before consent. Storage that is not a
 *  cookie is still "information stored in the terminal equipment" under
 *  Art. 5(3) ePrivacy — a point many sites' banners quietly ignore. */
export async function readWebStorage(page: Page): Promise<StorageItem[]> {
  const out: StorageItem[] = []
  for (const frame of page.frames()) {
    let origin = ""
    try { origin = new URL(frame.url()).origin } catch { continue }
    try {
      const items = await frame.evaluate(() => {
        const read = (store: Storage, kind: string) => {
          const rows: Array<{ kind: string; key: string; bytes: number }> = []
          for (let i = 0; i < store.length && i < 200; i++) {
            const key = store.key(i)
            if (key === null) continue
            rows.push({ kind, key, bytes: (store.getItem(key) ?? "").length })
          }
          return rows
        }
        return [...read(localStorage, "localStorage"), ...read(sessionStorage, "sessionStorage")]
      })
      for (const it of items) {
        out.push({ origin, kind: it.kind as StorageItem["kind"], key: it.key, bytes: it.bytes })
      }
    } catch {
      // Cross-origin frame or blocked storage — nothing to read, nothing to say.
    }
  }
  return out
}

function initiatorUrl(initiator: any): string | undefined {
  if (!initiator) return undefined
  if (initiator.url) return String(initiator.url).slice(0, 300)
  const frame = initiator.stack?.callFrames?.[0]
  if (frame?.url) return String(frame.url).slice(0, 300)
  return initiator.type ? `(${initiator.type})` : undefined
}

function performanceNow(): number {
  return Number(process.hrtime.bigint() / 1000000n)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
