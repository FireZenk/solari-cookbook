/** gauntlet — audit a page for pre-consent tracking and keyboard accessibility.
 *
 *   node src/cli.ts https://example.com --countries es,de --out ./runs
 *
 *  Run `node src/preflight.ts` first: it tells you in ten seconds whether your
 *  key can use managed proxies, which decides whether the multi-country half of
 *  this tool is available to you at all. */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Solari, SolariError } from "@solarisdk/browser"
import { resolveApiKey } from "./apikey.ts"
import { auditCountry } from "./consent/probe.ts"
import { trackerListVersion } from "./consent/classify.ts"
import { ensureDir, writeJson, writeManifest } from "./evidence/bundle.ts"
import { renderReport } from "./report/render.ts"
import type { AuditRun, CountryAudit } from "./types.ts"

const VERSION = "0.1.0"

interface Args {
  target: string
  countries: string[]
  a11y: boolean
  recording: boolean
  out: string
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ""
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1))
      else if ((argv[i + 1] ?? "").startsWith("--") || i + 1 >= argv.length) flags.set(a.slice(2), "true")
      else { flags.set(a.slice(2), argv[++i] ?? ""); }
    } else positional.push(a)
  }
  const target = positional[0] ?? ""
  if (!target) {
    console.error(`gauntlet ${VERSION}

  node src/cli.ts <url> [options]

  --countries es,de,fr   Audit from these countries (managed proxies; needs a paid plan)
  --no-a11y              Skip the keyboard/accessibility walk
  --no-recording         Skip session recording (slightly cheaper, loses the replay evidence)
  --out <dir>            Where to write the run (default ./runs)
`)
    process.exit(1)
  }
  return {
    target: target.startsWith("http") ? target : `https://${target}`,
    countries: (flags.get("countries") ?? "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
    a11y: flags.get("no-a11y") !== "true",
    recording: flags.get("no-recording") !== "true",
    out: flags.get("out") ?? "./runs",
  }
}

function slug(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "-").replace(/-+$/, "").slice(0, 60)
}

function isPlanError(err: unknown): boolean {
  return err instanceof SolariError && (err.code === "FeatureRequiresPlan" || /plan/i.test(err.message))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = resolveApiKey()

  const startedAt = new Date().toISOString()
  const runDir = ensureDir(join(args.out, `${slug(args.target)}-${startedAt.replace(/[:.]/g, "-")}`))
  const solari = new Solari({ apiKey })

  const countries: Array<string | undefined> = args.countries.length ? args.countries : [undefined]
  const audits: CountryAudit[] = []
  let proxyBlocked = false

  console.log(`\n  gauntlet ${VERSION} → ${args.target}`)
  console.log(`  vantage points: ${countries.map((c) => c ?? "direct").join(", ")}`)
  console.log(`  evidence: ${runDir}\n`)

  try {
    for (const country of countries) {
      const label = country ?? "direct"
      process.stdout.write(`  [${label}] auditing… `)
      try {
        // Cloud browsers die occasionally — a dropped proxy, a lost slot. Losing
        // a whole vantage point to one flake would quietly change the report.
        let audit
        for (let attempt = 1; ; attempt++) {
          try {
            audit = await auditCountry({
              solari,
              target: args.target,
              country,
              evidenceRoot: runDir,
              a11y: args.a11y,
              recording: args.recording,
            })
            break
          } catch (err) {
            if (attempt >= 2 || isPlanError(err)) throw err
            process.stdout.write("retrying… ")
          }
        }
        audits.push(audit)
        if (audit.blocked) {
          console.log(`NO MEASUREMENT — ${audit.blocked.reason}`)
        } else {
          const worst = audit.findings[0]?.severity ?? "none"
          const tp = audit.preConsent.requests.filter((r) => !r.firstParty).length
          console.log(`${worst.toUpperCase()} · ${tp} third-party requests pre-consent · ${audit.findings.length} findings`)
        }
      } catch (err) {
        if (isPlanError(err) && country) {
          proxyBlocked = true
          console.log("blocked")
          console.error(
            `\n  Managed proxies need stealth, and stealth needs a paid plan.\n` +
            `  Either drop --countries to audit from the default egress, or upgrade at console.getsolari.com.\n`,
          )
          break
        }
        console.log("failed")
        console.error(`  ${(err as Error).message}`)
      }
    }

    // Never end a run with nothing: if the proxy path is closed, still produce
    // the audit that any plan can run.
    if (audits.length === 0 && proxyBlocked) {
      process.stdout.write("  [direct] auditing without a proxy… ")
      const audit = await auditCountry({
        solari, target: args.target, country: undefined,
        evidenceRoot: runDir, a11y: args.a11y, recording: args.recording,
      })
      audits.push(audit)
      console.log(`${audit.findings[0]?.severity.toUpperCase() ?? "NONE"} · ${audit.findings.length} findings`)
    }
  } finally {
    // The browser client keeps a loopback proxy open for connection retries.
    // Without this the process prints everything and then hangs forever.
    await solari.close()
  }

  const run: AuditRun = {
    target: args.target,
    startedAt,
    finishedAt: new Date().toISOString(),
    gauntletVersion: VERSION,
    trackerListVersion,
    countries: audits,
  }

  writeJson(join(runDir, "run.json"), run)
  const digest = writeManifest(
    runDir,
    ["run.json", ...audits.flatMap((a) => [`${a.country}/findings.json`, `${a.country}/requests-pre-consent.json`, `${a.country}/network-pre-consent.har`])],
    { target: run.target, startedAt, gauntletVersion: VERSION, trackerListVersion },
  )
  run.evidenceDigest = digest
  writeJson(join(runDir, "run.json"), run)
  writeFileSync(join(runDir, "report.html"), renderReport(run))

  const all = audits.flatMap((a) => a.findings)
  const critical = all.filter((f) => f.severity === "critical").length
  const high = all.filter((f) => f.severity === "high").length
  console.log(`\n  ${critical} critical · ${high} high across ${audits.length} vantage point(s)`)
  console.log(`  report:   ${join(runDir, "report.html")}`)
  console.log(`  evidence: ${runDir} (sha256 ${digest.slice(0, 16)}…)\n`)

  // Exit non-zero when something critical was measured, so this drops into CI
  // without a wrapper script.
  process.exit(critical > 0 ? 2 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
