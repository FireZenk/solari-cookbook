/** The demonstrator: a real Linux desktop, a real screen reader, no mouse.
 *
 *   node --env-file-if-exists=.env src/desktop-demo.ts https://example.com
 *
 *  `cli.ts` is the instrument — deterministic, cheap, runs in CI. This is what
 *  you show someone who does not believe the instrument. Chrome opens on a VM,
 *  Orca starts, and the only input for the rest of the run is the Tab key.
 *
 *  What gets captured is not audio. Orca decides what to announce by reading the
 *  AT-SPI accessibility tree over D-Bus; this listens to the same bus and writes
 *  down the same facts — one line per focus change, exactly the name and role
 *  the toolkit exposed. No synthesiser, no transcription, nothing to mishear.
 *
 *  The result cross-checks the audit: if the cloud browser says a control has no
 *  accessible name, the desktop announces it as a bare "push button". Two
 *  independent instruments, same answer. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"
import type { Desktop } from "@solarisdk/sdk"
import { resolveApiKey } from "./apikey.ts"

const TABS = 30
const LOG = "/tmp/gauntlet-speech.log"

const asset = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../data/${name}`, import.meta.url)), "utf8")

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function sh(desktop: Desktop, script: string): Promise<string> {
  const r = await desktop.exec("sh", { args: ["-c", script] })
  return String(r.stdout ?? "")
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "https://example.com"
  const outDir = join("runs", `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  mkdirSync(outDir, { recursive: true })

  const client = new SolariClient({ apiKey: resolveApiKey() })
  const desktop = await client.desktops.create({
    template: "default",     // ships Chrome, VS Code, LibreOffice, Thunar
    resolution: "1280x720",
    memMb: 4096,             // Chrome plus a screen reader on 2 GB is tight
    record: true,            // server-side mp4; the URL resolves after record.stop()
    timeoutMs: 15 * 60_000,  // rolling idle window, not a hard deadline
  })

  console.log(`\n  desktop ${desktop.sessionId.slice(0, 24)}…`)
  console.log(`  watch live: ${desktop.streamUrl}\n`)

  try {
    await desktop.connect()

    process.stdout.write("  waiting for X11… ")
    for (let i = 0; i < 40; i++) {
      if ((await desktop.health() as { ready?: boolean }).ready) break
      await sleep(1000)
    }
    console.log("up")

    // apt needs an update first or it claims at-spi2-core does not exist. And
    // `pkg.install` reports failure in an exit code rather than throwing, which
    // is how an earlier version of this file printed "done" over a failed
    // install and then wondered why nothing spoke.
    process.stdout.write("  installing orca + at-spi… ")
    const install = await sh(
      desktop,
      "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq orca at-spi2-core dbus-x11 wmctrl xdotool 2>&1 | tail -1; echo rc=$?",
    )
    if (!install.includes("rc=0")) {
      console.log("failed")
      console.error(`  apt said: ${install.trim().slice(0, 300)}`)
      return
    }
    console.log("done")

    await desktop.fs.write("/root/a11y-setup.sh", asset("desktop-a11y-setup.sh"), 0o755)
    await desktop.fs.write("/root/atspi-listener.py", asset("atspi-listener.py"), 0o755)

    process.stdout.write("  starting at-spi + orca… ")
    await desktop.process.start("sh", { args: ["/root/a11y-setup.sh"] })
    for (let i = 0; i < 40; i++) {
      if ((await sh(desktop, "cat /tmp/gauntlet-setup-done 2>/dev/null")).includes("done")) break
      await sleep(2000)
    }
    const running = await sh(desktop, "pgrep -a orca | head -1")
    console.log(running.trim() ? "orca running" : "orca not detected (continuing)")

    await desktop.process.start("sh", {
      args: ["-c", `export HOME=/root DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/0; . /tmp/dbus.env; exec python3 /root/atspi-listener.py ${LOG} >> /tmp/listener.log 2>&1`],
    })
    await sleep(4000)
    const attached = (await sh(desktop, `cat ${LOG} 2>/dev/null`)).includes("listener attached")
    console.log(`  accessibility listener: ${attached ? "attached" : "not attached"}`)

    // --app drops the browser chrome entirely. Without it, Tab walks Chrome's
    // own toolbar forever and never enters the page — which is what the first
    // version of this demo actually recorded.
    process.stdout.write("  opening chrome… ")
    await desktop.process.start("sh", {
      args: ["-c", `export HOME=/root DISPLAY=:0; . /tmp/dbus.env; exec google-chrome --force-renderer-accessibility --no-first-run --no-sandbox --test-type --window-size=1280,505 --window-position=0,24 --app="${target}" >> /tmp/chrome.log 2>&1`],
    })
    await sleep(12000)
    const pageTitle = (await sh(desktop, "DISPLAY=:0 xdotool getactivewindow getwindowname 2>/dev/null")).trim()
    console.log(pageTitle ? `"${pageTitle}"` : "loaded")

    // Half the point of a demonstration is that the viewer can see what is being
    // claimed. A terminal tailing the announcement log puts the screen reader's
    // words on screen next to the focus ring that produced them.
    await desktop.process.start("sh", {
      args: ["-c", `export DISPLAY=:0; exec xfce4-terminal --title=announcements --geometry=150x11+0+532 --hide-menubar --hide-toolbar --command "tail -f ${LOG}" >> /tmp/term.log 2>&1`],
    })
    await sleep(3000)

    const shot = async (name: string): Promise<void> => {
      writeFileSync(join(outDir, name), await desktop.screenshot({ format: "png" }))
    }
    await shot("00-loaded.png")

    // Opening the terminal took the focus, and the log says so in its own words:
    // "Terminal — terminal [focused]". Tab would then go nowhere. Activate the
    // browser window and confirm it took, rather than assuming.
    let focused = false
    for (let attempt = 0; attempt < 4 && !focused; attempt++) {
      await sh(desktop, `DISPLAY=:0 wmctrl -a "${pageTitle}" 2>/dev/null || DISPLAY=:0 xdotool search --name "${pageTitle.slice(0, 20)}" windowactivate %1 2>/dev/null`)
      await sleep(1200)
      const active = (await sh(desktop, "DISPLAY=:0 xdotool getactivewindow getwindowname 2>/dev/null")).trim()
      focused = active.length > 0 && !/announcements|terminal/i.test(active)
      if (!focused) console.log(`  (focus was on "${active}", retrying)`)
    }
    if (!focused) console.log("  could not return focus to the browser — the walk will be empty")
    await sleep(800)

    // Everything before this was setup; the recording should only hold the walk.
    await desktop.record.start({ fps: 12 }).catch(() => console.log("  (server-side recording unavailable)"))
    await sleep(1500)

    console.log(`\n  pressing Tab ${TABS} times — no mouse from here on\n`)
    const transcript: Array<{ stop: number; announced: string }> = []
    let seen = 1 // skip the "(listener attached)" line

    for (let i = 1; i <= TABS; i++) {
      await desktop.keyboard.press("Tab")
      await sleep(900) // let the toolkit emit the focus event, and let a viewer read it

      const lines = (await sh(desktop, `cat ${LOG} 2>/dev/null`)).split("\n").filter(Boolean)
      const fresh = lines.slice(seen)
      seen = lines.length

      if (fresh.length > 0) {
        const announced = fresh.join(" · ").slice(0, 160)
        transcript.push({ stop: i, announced })
        console.log(`  ${String(i).padStart(2)}. 🔊 ${announced}`)
      } else {
        console.log(`  ${String(i).padStart(2)}. (focus did not move)`)
      }
      if (i % 5 === 0) await shot(`tab-${String(i).padStart(2, "0")}.png`)
    }

    await sleep(2500) // hold on the last announcement rather than cutting on it
    writeFileSync(join(outDir, "announcements.json"), JSON.stringify(transcript, null, 2) + "\n")

    const unnamed = transcript.filter((t) => t.announced.includes("(no accessible name)"))
    console.log(`\n  ${transcript.length} announcements captured, ${unnamed.length} with no accessible name`)
    console.log(`  transcript: ${join(outDir, "announcements.json")}`)

    const rec = await desktop.record.stop().catch(() => null)
    const url = (rec as { url?: string } | null)?.url ?? desktop.recordingUrl
    if (url) writeFileSync(join(outDir, "recording-url.txt"), url + "\n")
    console.log(`  video: ${url ? join(outDir, "recording-url.txt") : "(not available)"}`)
    console.log(`  frames: ${outDir}\n`)
  } finally {
    // close() drops the local channel only; destroy() ends the session.
    desktop.close()
    await client.desktops.destroy(desktop.sessionId).catch(() => {})
  }
}

main().catch((err) => {
  const code = (err as { code?: string }).code
  if (code === "FeatureRequiresPlan" || /requires a paid plan/i.test(String((err as Error).message))) {
    console.error("\n  Desktops need a paid plan. The audit itself (`npm run gauntlet`) does not.\n")
    process.exit(3)
  }
  console.error(err)
  process.exit(1)
})
