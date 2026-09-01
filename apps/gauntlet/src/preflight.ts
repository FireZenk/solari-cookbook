/** Ten seconds that decide the shape of your run.
 *
 *  Solari gates a few features by plan, and the one that matters here is
 *  stealth: managed proxies require it, so on a free key the multi-country half
 *  of Gauntlet simply does not exist. Better to learn that from a probe than
 *  from a half-finished audit. */
import { Solari, SolariError } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import { resolveApiKey } from "./apikey.ts"

type Status = "ok" | "blocked" | "failed"
interface Check { name: string; status: Status; note: string; ms: number }

const results: Check[] = []

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, status: "ok", note, ms: Date.now() - t0 })
  } catch (err) {
    const planGated = err instanceof SolariError && (err.code === "FeatureRequiresPlan" || /plan/i.test(err.message))
    results.push({
      name,
      status: planGated ? "blocked" : "failed",
      note: (err as Error).message.slice(0, 140),
      ms: Date.now() - t0,
    })
  }
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey()
  const solari = new Solari({ apiKey })
  const client = new SolariClient({ apiKey })

  try {
    await check("browser: plain session", async () => {
      const b = await solari.launch()
      try {
        const page = await b.newPage()
        await page.goto("https://example.com", { waitUntil: "domcontentloaded" })
        return `title "${await page.title()}" · session ${b.id}`
      } finally { await b.close() }
    })

    await check("browser: stealth", async () => {
      const b = await solari.launch({ stealth: true })
      try { return `session ${b.id}` } finally { await b.close() }
    })

    await check("browser: managed proxy (es)", async () => {
      const b = await solari.launch({ stealth: true, proxy: { country: "es" } })
      try {
        return `egress ${b.proxy?.country ?? "?"} · tier ${b.proxy?.tier ?? "?"} · tz ${b.proxy?.timezoneId ?? "?"}`
      } finally { await b.close() }
    })

    await check("browser: session recording + replay", async () => {
      const b = await solari.launch({ recording: true })
      const id = b.id
      const page = await b.newPage()
      await page.goto("https://example.com", { waitUntil: "domcontentloaded" })
      await b.close()
      for (let i = 0; i < 12; i++) {
        try {
          const replay = await solari.sessions.getReplayUrl(id)
          if (replay?.url) return `replay ready after ~${i * 2.5}s`
        } catch { /* 404 until the async upload lands */ }
        await new Promise((r) => setTimeout(r, 2500))
      }
      throw new Error("replay never appeared within 30s")
    })

    await check("sandbox: create + public port preview", async () => {
      const sbx = await client.sandboxes.create({ template: "base", timeoutMs: 2 * 60_000 })
      try {
        await sbx.connect()
        // Commands are not shell-interpreted: argv goes in `args`.
        const out = await sbx.commands.run("python3", { args: ["-c", "print('sandbox ok')"] })
        const preview = await sbx.previewUrl(8080)
        return `${out.stdout.trim()} · preview ${preview.url}`
      } finally {
        // kill(), not close(): close() only drops the local control channel.
        await sbx.kill()
      }
    })
  } finally {
    await solari.close()
  }

  const pad = Math.max(...results.map((r) => r.name.length))
  console.log("\n  Solari capability probe\n")
  for (const r of results) {
    const mark = r.status === "ok" ? "✓" : r.status === "blocked" ? "▲" : "✗"
    console.log(`  ${mark} ${r.name.padEnd(pad)}  ${String(r.ms).padStart(6)}ms  ${r.note}`)
  }

  const proxy = results.find((r) => r.name.includes("proxy"))
  console.log(
    proxy?.status === "ok"
      ? "\n  Multi-country auditing is available on this key.\n"
      : "\n  Managed proxies are not available on this key — run gauntlet without --countries,\n" +
        "  or upgrade at console.getsolari.com to audit from several member states.\n",
  )
  process.exit(results.some((r) => r.status === "failed") ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
