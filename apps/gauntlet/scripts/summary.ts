/** run.json → markdown, for a CI job summary or a PR comment.
 *
 *   node scripts/summary.ts runs/<dir>/run.json >> "$GITHUB_STEP_SUMMARY" */
import { readFileSync } from "node:fs"
import type { AuditRun, Severity } from "../src/types.ts"

const ICON: Record<Severity, string> = {
  critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", none: "🟢",
}

const path = process.argv[2]
if (!path) { console.error("usage: node scripts/summary.ts <run.json>"); process.exit(1) }
const run = JSON.parse(readFileSync(path, "utf8")) as AuditRun

const all = run.countries.flatMap((c) => c.findings)
const count = (s: Severity): number => all.filter((f) => f.severity === s).length

console.log(`## Gauntlet — \`${run.target}\`\n`)
console.log(
  `${count("critical")} critical · ${count("high")} high · ${count("medium")} medium · ` +
  `${count("low")} low · tracker list \`${run.trackerListVersion}\`\n`,
)

for (const c of run.countries) {
  const tp = c.preConsent.requests.filter((r) => !r.firstParty)
  const entities = [...new Set(tp.filter((r) => r.category !== "cdn").map((r) => r.entity ?? r.host))]
  console.log(`### ${c.country.toUpperCase()}\n`)
  console.log(
    `${tp.length} third-party requests before consent · ${entities.length} distinct parties · ` +
    `banner ${c.cmp.bannerVisible ? "found" : "not found"} · ` +
    `reject in first layer: ${c.cmp.rejectInFirstLayer ? "yes" : "**no**"}` +
    (c.replayAvailable ? " · session replay recorded" : "") + "\n",
  )
  if (c.findings.length === 0) { console.log("_No findings._\n"); continue }
  console.log("| | Finding | Rule |")
  console.log("|---|---|---|")
  for (const f of c.findings) {
    const rule = f.reference.split("—")[0]?.trim() ?? f.reference
    console.log(`| ${ICON[f.severity]} | ${f.title.replace(/\|/g, "\\|")} | ${rule.replace(/\|/g, "\\|")} |`)
  }
  console.log("")
}

console.log(
  "\n<sub>Measurements, not legal advice. Each finding states what was observed and the provision " +
  "it is relevant to. Full evidence bundle is attached to this run.</sub>",
)
