/** Publish a finished run on a public URL, from a sandbox.
 *
 *   node src/serve.ts ./runs/example.com-2026-09-01…
 *
 *  Why a sandbox and not a static host: the evidence bundle is the point, and
 *  it should be readable by whoever you send the link to — on a phone, without
 *  cloning anything — while the machine serving it is disposable and dies with
 *  the session. Nothing about the run leaves your account permanently. */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { SolariClient } from "@solarisdk/sdk"

const PORT = 8080

function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full))
  }
  return out
}

async function main(): Promise<void> {
  const runDir = process.argv[2]
  const apiKey = process.env.SOLARI_API_KEY
  if (!runDir) { console.error("usage: node src/serve.ts <run-directory>"); process.exit(1) }
  if (!apiKey) { console.error("SOLARI_API_KEY is not set."); process.exit(1) }

  const files = walk(runDir)
  if (!files.includes("report.html")) {
    console.error(`${runDir} has no report.html — is that a gauntlet run directory?`)
    process.exit(1)
  }

  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 30 * 60_000 })
  console.log(`  sandbox ${sandbox.sandboxId}`)

  let closed = false
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    console.log("\n  tearing down the sandbox…")
    // kill() destroys the VM. close() would only drop our control channel and
    // leave it billing until the idle timeout.
    await sandbox.kill().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  try {
    await sandbox.connect()
    await sandbox.commands.run("mkdir", { args: ["-p", "/root/report"] })

    for (const rel of files) {
      const bytes = readFileSync(join(runDir, rel))
      const dest = `/root/report/${rel}`
      const parent = dest.slice(0, dest.lastIndexOf("/"))
      await sandbox.commands.run("mkdir", { args: ["-p", parent] })
      await sandbox.files.write(dest, new Uint8Array(bytes))
    }
    console.log(`  uploaded ${files.length} files`)

    // `run` is not shell-interpreted, so the server is started detached with an
    // explicit shell rather than a background `&` in the command string.
    await sandbox.commands.start("sh", {
      args: ["-c", `cd /root/report && python3 -m http.server ${PORT} > /tmp/http.log 2>&1`],
    })
    await new Promise((r) => setTimeout(r, 1200))

    const preview = await sandbox.previewUrl(PORT)
    const url = preview.token ? `${preview.url}?token=${preview.token}` : preview.url
    console.log(`\n  live report: ${url}/report.html`)
    console.log(`  evidence:    ${url}/\n`)
    console.log("  Ctrl-C to tear the sandbox down.")

    // Keep the process alive while the machine serves.
    await new Promise(() => {})
  } catch (err) {
    console.error(err)
    await shutdown()
  }
}

main().catch(async (err) => { console.error(err); process.exit(1) })
