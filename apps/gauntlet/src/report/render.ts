/** Static HTML report. One file, no assets, no network — it has to survive
 *  being emailed to a lawyer, opened offline, and printed. */
import type { AuditRun, CapturedRequest, CountryAudit, Finding, Severity } from "../types.ts"

const SEV_COLOR: Record<Severity, string> = {
  critical: "#ff4d4d",
  high: "#ff8c42",
  medium: "#ffc93c",
  low: "#7bc4ff",
  none: "#5fd68a",
}

const CAT_COLOR: Record<string, string> = {
  advertising: "#ff4d4d",
  analytics: "#ff8c42",
  "session-replay": "#e05be0",
  social: "#ff6fae",
  "tag-manager": "#ffc93c",
  "data-transfer": "#7bc4ff",
  consent: "#5fd68a",
  cdn: "#4a5568",
  unclassified: "#8a94a6",
}

/** Session ids are ~90 characters of host and org prefix. Show enough to match
 *  a console entry without breaking the page. */
function shortSession(id: string): string {
  return id.length <= 28 ? id : `…${id.slice(-24)}`
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function severityBadge(sev: Severity): string {
  return `<span class="badge" style="--c:${SEV_COLOR[sev]}">${esc(sev)}</span>`
}

/** Requests laid out on a time axis. The picture is the argument: a wall of
 *  coloured marks well to the left of any possible human reaction time. */
function timeline(requests: CapturedRequest[]): string {
  const thirdParty = requests.filter((r) => !r.firstParty)
  if (thirdParty.length === 0) return `<p class="muted">No third-party requests before consent.</p>`
  const max = Math.max(1000, ...thirdParty.map((r) => r.tMs))
  const marks = thirdParty
    .slice(0, 200)
    .map((r) => {
      const left = (r.tMs / max) * 100
      const color = CAT_COLOR[r.category] ?? CAT_COLOR.unclassified
      const title = `${r.tMs}ms · ${r.entity ?? r.host} · ${r.category}`
      return `<i style="left:${left.toFixed(2)}%;background:${color}" title="${esc(title)}"></i>`
    })
    .join("")
  return `
    <div class="timeline"><div class="track">${marks}</div>
      <div class="axis"><span>0 ms</span><span>${max} ms since navigation started</span></div>
    </div>`
}

function findingBlock(f: Finding): string {
  const evidence = f.evidence.length
    ? `<details><summary>Evidence (${f.evidence.length})</summary><pre>${f.evidence.map(esc).join("\n")}</pre></details>`
    : ""
  return `
    <article class="finding" style="--c:${SEV_COLOR[f.severity]}">
      <header>${severityBadge(f.severity)}<h4>${esc(f.title)}</h4><code>${esc(f.code)}</code></header>
      <p>${esc(f.detail)}</p>
      <p class="ref">${esc(f.reference)}</p>
      ${evidence}
    </article>`
}

function countryBlock(c: CountryAudit): string {
  const tp = c.preConsent.requests.filter((r) => !r.firstParty)
  const entities = [...new Set(tp.filter((r) => r.category !== "cdn").map((r) => r.entity ?? r.host))]
  const worst = c.findings[0]?.severity ?? "none"
  const proxy = c.proxy
    ? `egress ${esc(c.proxy.country.toUpperCase())}${c.proxy.tier ? ` · ${esc(c.proxy.tier)}` : ""} · tz ${esc(c.proxy.timezoneId)}`
    : "direct egress (no proxy)"

  const walk = c.a11y.ran
    ? `<table class="walk"><thead><tr><th>#</th><th>role</th><th>accessible name</th><th>focus visible</th><th>in banner</th></tr></thead><tbody>${c.a11y.stops
        .slice(0, 25)
        .map(
          (s) =>
            `<tr><td>${s.index}</td><td><code>${esc(s.role)}</code></td><td>${esc(s.name) || '<span class="muted">(none)</span>'}</td><td>${s.focusVisible ? "yes" : '<span class="bad">no</span>'}</td><td>${s.inBanner ? "yes" : ""}</td></tr>`,
        )
        .join("")}</tbody></table>${c.a11y.stops.length > 25 ? `<p class="muted">${c.a11y.stops.length - 25} further stops in keyboard-walk.json</p>` : ""}`
    : `<p class="muted">Keyboard walk not run${c.a11y.skippedReason ? `: ${esc(c.a11y.skippedReason)}` : ""}.</p>`

  if (c.blocked) {
    return `
  <section class="country">
    <h2>${esc(c.country.toUpperCase())} <span class="badge" style="--c:#8a94a6">no measurement</span></h2>
    <p class="meta">${proxy} · session <code>${esc(shortSession(c.sessionId))}</code>${c.replayUrl ? ` · <a href="${esc(c.replayUrl)}">session replay</a>` : ""}</p>
    <div class="blocked">
      <h4>The browser never reached this site — ${esc(c.blocked.reason)}</h4>
      <p>Nothing on this page describes the target. Whatever loaded belonged to the challenge page, and
      reporting it would be reporting on the wrong document.</p>
      <pre>${c.blocked.evidence.map(esc).join("\n")}</pre>
    </div>
  </section>`
  }

  return `
  <section class="country">
    <h2>${esc(c.country.toUpperCase())} ${severityBadge(worst)}</h2>
    <p class="meta">${proxy} · session <code>${esc(shortSession(c.sessionId))}</code> · navigation ${c.navigationMs}ms
      ${c.replayUrl ? ` · <a href="${esc(c.replayUrl)}">session replay</a>` : ""}</p>

    <div class="stats">
      <div><b>${tp.length}</b><span>third-party requests before consent</span></div>
      <div><b>${entities.length}</b><span>distinct third parties</span></div>
      <div><b>${c.preConsent.cookies.filter((k) => !k.firstParty).length}</b><span>third-party cookies</span></div>
      <div><b>${c.preConsent.storage.length}</b><span>web-storage keys</span></div>
    </div>

    <h3>Before any interaction</h3>
    ${timeline(c.preConsent.requests)}

    <h3>Consent layer</h3>
    <ul class="cmp">
      <li>Banner detected: <b>${c.cmp.bannerVisible ? "yes" : "no"}</b>${c.cmp.vendor ? ` · vendor <code>${esc(c.cmp.vendor)}</code>` : ""}${c.cmp.tcfApi ? " · IAB TCF v2 present" : ""}</li>
      <li>Accept in first layer: <b>${c.cmp.acceptInFirstLayer ? esc(c.cmp.acceptLabel) : "not found"}</b></li>
      <li>Reject in first layer: <b class="${c.cmp.rejectInFirstLayer ? "" : "bad"}">${c.cmp.rejectInFirstLayer ? esc(c.cmp.rejectLabel) : "not found"}</b></li>
      ${c.afterReject ? `<li>Reject clicked: <b>yes</b> — ${c.afterReject.requests.filter((r) => !r.firstParty).length} third-party requests observed afterwards</li>` : ""}
    </ul>

    <h3>Keyboard walk</h3>
    ${walk}

    <h3>Evidence</h3>
    <p class="files">${[
      ["network-pre-consent.har", "HAR"],
      ["requests-pre-consent.json", "requests"],
      ["cookies-pre-consent.json", "cookies"],
      ["web-storage-pre-consent.json", "web storage"],
      ["keyboard-walk.json", "keyboard walk"],
      ["ax-tree.json", "AX tree"],
      ["cmp.json", "consent layer"],
      ["findings.json", "findings"],
      ...c.screenshots.map((s) => [s, s.replace(/\.png$/, "")] as [string, string]),
    ]
      .map(([file, label]) => `<a href="${esc(c.country)}/${esc(file)}">${esc(label)}</a>`)
      .join(" · ")}</p>

    <h3>Findings</h3>
    ${c.findings.length ? c.findings.map(findingBlock).join("") : '<p class="muted">No findings.</p>'}

    ${c.errors.length ? `<details class="errors"><summary>Run notes (${c.errors.length})</summary><pre>${c.errors.map(esc).join("\n")}</pre></details>` : ""}
  </section>`
}

export function renderReport(run: AuditRun): string {
  const allFindings = run.countries.flatMap((c) => c.findings)
  const counts: Record<string, number> = {}
  for (const f of allFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  const headline = (["critical", "high", "medium", "low"] as Severity[]).find((s) => counts[s])

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gauntlet — ${esc(run.target)}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#26303d; --fg:#e6edf3; --muted:#8a94a6; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width:980px; margin:0 auto; padding:40px 24px 80px }
  h1 { font-size:26px; margin:0 0 4px } h2 { font-size:20px; margin:0 0 6px }
  h3 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:28px 0 10px }
  h4 { margin:0; font-size:15px; font-weight:600 }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em; color:#9fd0ff }
  a { color:#7bc4ff }
  .muted { color:var(--muted) } .bad { color:#ff8c42 }
  .lede { color:var(--muted); margin:0 0 24px }
  .country { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:24px; margin:24px 0 }
  .meta { color:var(--muted); font-size:13px; margin:0 0 18px }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:16px 0 }
  .stats div { background:#0d1117; border:1px solid var(--line); border-radius:8px; padding:12px }
  .stats b { display:block; font-size:24px; line-height:1.2 } .stats span { font-size:12px; color:var(--muted) }
  .badge { display:inline-block; border:1px solid var(--c); color:var(--c); border-radius:999px;
           padding:1px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; vertical-align:middle }
  .timeline { margin:12px 0 }
  .track { position:relative; height:44px; background:#0d1117; border:1px solid var(--line); border-radius:8px; overflow:hidden }
  .track i { position:absolute; top:6px; width:3px; height:32px; border-radius:2px; opacity:.9 }
  .axis { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-top:4px }
  .finding { border:1px solid var(--line); border-left:3px solid var(--c); border-radius:8px; padding:14px 16px; margin:10px 0; background:#0d1117 }
  .finding header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px }
  .finding header code { margin-left:auto; color:var(--muted) }
  .finding p { margin:6px 0 } .ref { font-size:12px; color:var(--muted) }
  details { margin-top:8px } summary { cursor:pointer; font-size:13px; color:var(--muted) }
  pre { background:#0a0e14; border:1px solid var(--line); border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; white-space:pre-wrap; word-break:break-all }
  table.walk { width:100%; border-collapse:collapse; font-size:13px }
  table.walk th { text-align:left; color:var(--muted); font-weight:500; border-bottom:1px solid var(--line); padding:6px 8px }
  table.walk td { padding:5px 8px; border-bottom:1px solid #1b2230 }
  ul.cmp { padding-left:18px; margin:0 }
  .files { font-size:13px; line-height:2 } .files a { margin-right:2px }
  footer { color:var(--muted); font-size:12px; border-top:1px solid var(--line); margin-top:40px; padding-top:20px }
  .blocked { border:1px solid #4a5568; border-left:3px solid #8a94a6; border-radius:8px; padding:14px 16px; background:#0d1117 }
  .blocked h4 { margin:0 0 8px }
  @media print { body { background:#fff; color:#000 } .country { break-inside:avoid } }
</style></head><body><div class="wrap">
  <h1>Gauntlet report</h1>
  <p class="lede">
    <code>${esc(run.target)}</code> · ${esc(run.startedAt)} ·
    ${run.countries.length} vantage point${run.countries.length === 1 ? "" : "s"} ·
    tracker list <code>${esc(run.trackerListVersion)}</code>
    ${run.evidenceDigest ? `· bundle <code>${esc(run.evidenceDigest.slice(0, 16))}…</code>` : ""}
  </p>
  <p class="lede">
    ${headline
      ? `Highest finding: ${severityBadge(headline)} — ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ${counts.low ?? 0} low.`
      : "No findings above informational."}
  </p>
  ${run.countries.map(countryBlock).join("")}
  <footer>
    Gauntlet ${esc(run.gauntletVersion)} — built on Solari cloud browsers. Measurements, not legal advice:
    each finding states what was observed and the provision it is relevant to. Whether a given site is
    compliant depends on facts this tool cannot see. Every number here is reproducible from the evidence
    bundle next to this file.
  </footer>
</div></body></html>`
}
