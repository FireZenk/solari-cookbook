/** Rebuild report.html from a run.json, without re-auditing anything.
 *
 *   node scripts/rerender.ts runs/<dir>/run.json
 *
 *  The measurement and its presentation are separate concerns: changing how the
 *  report reads should never mean spending sessions to see the change. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { renderReport } from "../src/report/render.ts"
import type { AuditRun } from "../src/types.ts"

const path = process.argv[2]
if (!path) { console.error("usage: node scripts/rerender.ts <run.json>"); process.exit(1) }
const run = JSON.parse(readFileSync(path, "utf8")) as AuditRun
const out = process.argv[3] ?? join(dirname(path), "report.html")
writeFileSync(out, renderReport(run))
console.log(`wrote ${out}`)
