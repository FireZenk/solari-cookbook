/** Host → entity/category, plus the first-party test.
 *
 *  Deliberately boring and offline: the list ships in the repo with a version
 *  stamp, so re-running an audit tomorrow measures the site, not the list. */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { TrackerCategory } from "../types.ts"

interface Entity {
  name: string
  category: TrackerCategory
  domains: string[]
}
interface CategoryMeta {
  severity: "critical" | "high" | "medium" | "low" | "none"
  consentRequired: boolean
  label: string
}
interface TrackerList {
  version: string
  provenance: Record<string, string>
  categories: Record<string, CategoryMeta>
  entities: Entity[]
}

const listPath = fileURLToPath(new URL("../../data/trackers.json", import.meta.url))
const list = JSON.parse(readFileSync(listPath, "utf8")) as TrackerList

/** host → { entity, category }, built once. Longest suffix wins, so
 *  `analytics.tiktok.com` beats a bare `tiktok.com` entry. */
const index = new Map<string, { entity: string; category: TrackerCategory }>()
for (const e of list.entities) {
  for (const d of e.domains) index.set(d.toLowerCase(), { entity: e.name, category: e.category })
}

export const trackerListVersion = list.version
export const categoryMeta = list.categories

/** Multi-label public suffixes we actually meet in EU audits. Not the full PSL:
 *  a 10k-entry list would be dead weight, and a miss only makes us *more*
 *  conservative (we would call a sibling host third-party, and say so). */
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.es", "com.br", "com.au", "com.mx", "com.ar", "com.tr", "com.pl",
  "co.jp", "or.jp", "ne.jp", "co.kr", "co.nz", "co.za", "co.in", "com.cn",
  "com.sg", "com.hk", "com.pt", "com.gr", "com.cy", "com.mt",
])

/** Registrable domain (eTLD+1) under the approximation above. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "")
  const parts = h.split(".")
  if (parts.length <= 2) return h
  const lastTwo = parts.slice(-2).join(".")
  if (MULTI_SUFFIXES.has(lastTwo)) return parts.slice(-3).join(".")
  return lastTwo
}

export function isFirstParty(host: string, siteHost: string): boolean {
  return registrableDomain(host) === registrableDomain(siteHost)
}

/** Walk the host upwards: `a.b.tracker.com` → `b.tracker.com` → `tracker.com`. */
export function classifyHost(host: string): { entity?: string; category: TrackerCategory } {
  const h = host.toLowerCase()
  const parts = h.split(".")
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".")
    const hit = index.get(candidate)
    if (hit) return hit
  }
  return { category: "unclassified" }
}

/** Does dropping this before consent engage Art. 5(3) ePrivacy? */
export function requiresConsent(category: TrackerCategory): boolean {
  const meta = categoryMeta[category]
  return meta ? meta.consentRequired : false
}

export function categorySeverity(category: TrackerCategory): CategoryMeta["severity"] {
  const meta = categoryMeta[category]
  return meta ? meta.severity : "low"
}

export function categoryLabel(category: TrackerCategory): string {
  const meta = categoryMeta[category]
  return meta ? meta.label : "Unclassified third party"
}
