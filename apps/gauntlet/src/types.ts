/** Shared shapes. Everything Gauntlet produces is plain JSON so an auditor can
 *  diff two runs, or a lawyer can read one without running any of this. */

export type Severity = "critical" | "high" | "medium" | "low" | "none"

export type TrackerCategory =
  | "advertising"
  | "analytics"
  | "session-replay"
  | "social"
  | "tag-manager"
  | "data-transfer"
  | "consent"
  | "cdn"
  | "unclassified"

/** One outbound HTTP request, stamped relative to navigation start. */
export interface CapturedRequest {
  requestId: string
  url: string
  host: string
  method: string
  resourceType: string
  /** ms since navigation start. This number is the whole argument: a tracker
   *  hit at t=180ms cannot have been consented to by a human. */
  tMs: number
  status?: number
  /** Raw `Set-Cookie` headers as they came off the wire (CDP extra-info),
   *  not the post-processed jar. This is what makes the evidence hold up. */
  setCookie: string[]
  entity?: string
  category: TrackerCategory
  firstParty: boolean
  /** Who caused this request. A GTM URL here is how "we only load analytics
   *  after consent" gets disproved in one line. */
  initiator?: string
}

export interface CapturedCookie {
  name: string
  domain: string
  path: string
  session: boolean
  httpOnly: boolean
  secure: boolean
  sameSite?: string
  expiresInDays?: number
  entity?: string
  category: TrackerCategory
  firstParty: boolean
}

export interface StorageItem {
  origin: string
  kind: "localStorage" | "sessionStorage"
  key: string
  bytes: number
}

/** What the consent layer looked like, if there was one at all. */
export interface CmpReport {
  detected: boolean
  vendor?: string
  /** IAB TCF v2 `__tcfapi` present. */
  tcfApi: boolean
  bannerVisible: boolean
  /** Accept found in the first layer, without opening "settings". */
  acceptInFirstLayer: boolean
  /** Reject-all found in the first layer. Its absence is the classic dark
   *  pattern: one click to say yes, three to say no. */
  rejectInFirstLayer: boolean
  acceptLabel?: string
  rejectLabel?: string
  /** Reject-all reachable with the keyboard alone. Where GDPR meets the EAA. */
  rejectKeyboardReachable?: boolean
  notes: string[]
}

export interface Finding {
  code: string
  severity: Severity
  title: string
  /** Plain-language statement of what was measured. No legal conclusions —
   *  Gauntlet reports facts and the rule they touch, not a verdict of guilt. */
  detail: string
  /** The rule this measurement is relevant to. */
  reference: string
  evidence: string[]
}

export interface AxStop {
  index: number
  role: string
  name: string
  tag: string
  /** Element is inside the consent banner subtree. */
  inBanner: boolean
  focusVisible: boolean
  offscreen: boolean
}

export interface A11yReport {
  ran: boolean
  stops: AxStop[]
  reachedBanner: boolean
  stopsBeforeBanner?: number
  findings: Finding[]
  /** Skipped when the run is consent-only. */
  skippedReason?: string
}

export interface CountryAudit {
  country: string
  sessionId: string
  proxy?: { country: string; tier?: string; timezoneId: string }
  startedAt: string
  navigationMs: number
  preConsent: {
    requests: CapturedRequest[]
    cookies: CapturedCookie[]
    storage: StorageItem[]
  }
  afterReject?: {
    clicked: boolean
    label?: string
    requests: CapturedRequest[]
    cookies: CapturedCookie[]
  }
  cmp: CmpReport
  a11y: A11yReport
  findings: Finding[]
  /** Whether a replay exists for this session.
   *
   *  Deliberately NOT the replay URL. A presigned S3 link carries AWS temporary
   *  credentials in its query string, so persisting one writes a credential into
   *  a file that ends up in a report, a bundle, and eventually a public repo.
   *  The session id is not a credential; mint a fresh link from it when needed
   *  (`npm run replay <sessionId>`). */
  replayAvailable?: boolean
  screenshots: string[]
  errors: string[]
  /** Set when a bot wall or an error page stood between us and the site. When
   *  this is true the findings list carries exactly one entry saying so. */
  blocked?: { reason: string; evidence: string[] }
}

export interface AuditRun {
  target: string
  startedAt: string
  finishedAt: string
  gauntletVersion: string
  trackerListVersion: string
  countries: CountryAudit[]
  /** sha256 over the evidence files, so a bundle can be shown to be untampered. */
  evidenceDigest?: string
}
