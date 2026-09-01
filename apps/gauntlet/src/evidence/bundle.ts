/** Evidence on disk.
 *
 *  The bundle is the product. A screenshot proves nothing on its own; a HAR
 *  with a tracker request stamped 180ms after navigation, next to a replay of
 *  the same session showing nobody touched the banner, is something you can
 *  put in front of a regulator — or in front of the vendor who told you their
 *  tag "only fires after consent". */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CapturedRequest, CountryAudit } from "../types.ts"

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

/** HAR 1.2, reconstructed from CDP events.
 *
 *  Honest about its limits: no request/response bodies and no per-phase
 *  timings, because we never asked the browser for them (capturing bodies on
 *  every response would change the page's own timing). What it does carry is
 *  the URL, the method, the status, the initiator and the raw Set-Cookie
 *  headers — everything the pre-consent argument rests on. */
export function toHar(requests: CapturedRequest[], pageUrl: string, startedAt: string): unknown {
  const started = new Date(startedAt).getTime()
  return {
    log: {
      version: "1.2",
      creator: { name: "gauntlet", version: "0.1.0", comment: "Reconstructed from CDP Network events; no bodies, no phase timings." },
      pages: [
        {
          startedDateTime: startedAt,
          id: "page_1",
          title: pageUrl,
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries: requests.map((r) => ({
        pageref: "page_1",
        startedDateTime: new Date(started + r.tMs).toISOString(),
        time: -1,
        _gauntlet: {
          msAfterNavigationStart: r.tMs,
          entity: r.entity ?? null,
          category: r.category,
          firstParty: r.firstParty,
          initiator: r.initiator ?? null,
        },
        request: {
          method: r.method,
          url: r.url,
          httpVersion: "HTTP/2",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: r.status ?? 0,
          statusText: "",
          httpVersion: "HTTP/2",
          cookies: [],
          headers: r.setCookie.map((v) => ({ name: "Set-Cookie", value: v })),
          content: { size: -1, mimeType: "" },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: -1, wait: -1, receive: -1 },
      })),
    },
  }
}

/** sha256 of every file written, so the bundle can be shown to be the one that
 *  came out of the run. */
export function writeManifest(dir: string, files: string[], meta: Record<string, unknown>): string {
  const entries = files.map((name) => {
    let digest = "missing"
    try {
      digest = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")
    } catch { /* file not produced this run */ }
    return { file: name, sha256: digest }
  })
  const manifest = { ...meta, files: entries }
  const manifestPath = join(dir, "evidence-manifest.json")
  writeJson(manifestPath, manifest)
  const roll = createHash("sha256").update(entries.map((e) => `${e.file}:${e.sha256}`).join("\n")).digest("hex")
  return roll
}

export function writeCountryEvidence(dir: string, audit: CountryAudit, axTree: unknown): string[] {
  ensureDir(dir)
  const written: string[] = []
  const put = (name: string, value: unknown): void => {
    writeJson(join(dir, name), value)
    written.push(name)
  }

  put("requests-pre-consent.json", audit.preConsent.requests)
  put("cookies-pre-consent.json", audit.preConsent.cookies)
  put("web-storage-pre-consent.json", audit.preConsent.storage)
  put("network-pre-consent.har", toHar(audit.preConsent.requests, audit.country, audit.startedAt))
  put("cmp.json", audit.cmp)
  put("findings.json", audit.findings)
  if (audit.afterReject) {
    put("requests-after-reject.json", audit.afterReject.requests)
    put("network-after-reject.har", toHar(audit.afterReject.requests, audit.country, audit.startedAt))
  }
  if (audit.a11y.ran) put("keyboard-walk.json", audit.a11y.stops)
  if (axTree) put("ax-tree.json", axTree)
  return written
}
