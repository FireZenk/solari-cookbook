/** The demonstrator: a real Linux desktop, a real screen reader, no mouse.
 *
 *   node src/desktop-demo.ts https://example.com
 *
 *  The audit in `cli.ts` is the instrument — deterministic, cheap, CI-able. This
 *  is the thing you show a person who does not believe the instrument. Chrome
 *  opens on a VM, Orca starts, and the only input is the Tab key. Whatever the
 *  screen reader announces is captured as text, so the transcript sits next to
 *  the video and says the same thing.
 *
 *  The capture trick: speech-dispatcher's `generic` output module runs an
 *  arbitrary command per utterance. Point that command at a log file instead of
 *  a synthesiser and the speech stream becomes a file you can read — no audio
 *  processing, no transcription, exactly the words Orca chose.
 *
 *  Best-effort by design. If Orca or the AT-SPI bus refuses to come up on the
 *  template, the run degrades to a keyboard-only walk with screenshots: still a
 *  demonstration, minus the transcript. It never blocks the audit itself. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SolariClient } from "@solarisdk/sdk"
import type { Desktop } from "@solarisdk/sdk"

const TABS = 25
const SPEECH_LOG = "/tmp/gauntlet-speech.log"

/** speech-dispatcher generic module that writes utterances to a file. */
const GENERIC_CONF = `
GenericExecuteSynth "printf '%s\\n' \\"$DATA\\" >> ${SPEECH_LOG}"
GenericCmdDependency "printf"
GenericDelimiters " " "." ","
GenericPunctNone ""
GenericPunctSome "--punct=some"
GenericPunctAll "--punct=all"
AddVoice "en" "MALE1" "en"
DefaultVoice "MALE1"
`

const SPEECHD_CONF = `
AddModule "gauntletlog" "sd_generic" "gauntletlog.conf"
DefaultModule gauntletlog
DefaultVoiceType "MALE1"
DefaultLanguage "en"
LogLevel 3
`

async function sh(desktop: Desktop, script: string, timeoutLabel: string): Promise<string> {
  // `exec` takes a binary plus argv; a shell has to be asked for explicitly.
  const res = await desktop.exec("sh", { args: ["-c", script] })
  if (res.exitCode !== 0) {
    console.log(`    · ${timeoutLabel}: exit ${res.exitCode} ${String(res.stderr ?? "").slice(0, 160)}`)
  }
  return String(res.stdout ?? "")
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "https://example.com"
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) { console.error("SOLARI_API_KEY is not set."); process.exit(1) }

  const outDir = join("runs", `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  mkdirSync(outDir, { recursive: true })

  const client = new SolariClient({ apiKey })
  const desktop = await client.desktops.create({
    template: "default",          // ships Chrome, VS Code, LibreOffice, Thunar
    resolution: "1280x720",
    memMb: 4096,                  // Chrome plus a screen reader on 2 GB is tight
    record: true,                 // server-side mp4; the URL resolves after record.stop()
    timeoutMs: 15 * 60_000,       // rolling idle window, not a hard deadline
  })

  console.log(`\n  desktop ${desktop.sessionId}`)
  console.log(`  watch live: ${desktop.streamUrl}\n`)

  let speechWorked = false
  try {
    await desktop.connect()

    process.stdout.write("  waiting for X11… ")
    for (let i = 0; i < 40; i++) {
      const health = await desktop.health()
      if ((health as { ready?: boolean }).ready) break
      await sleep(1000)
    }
    console.log("up")

    await desktop.record.start({ fps: 8 }).catch(() => console.log("  (server-side recording unavailable)"))

    // ── Screen reader ──
    process.stdout.write("  installing orca + speech-dispatcher… ")
    const install = await desktop.pkg.install("apt", ["orca", "speech-dispatcher", "at-spi2-core"]).catch(() => null)
    console.log(install ? "done" : "failed (continuing without a transcript)")

    if (install) {
      await desktop.fs.write("/etc/speech-dispatcher/modules/gauntletlog.conf", GENERIC_CONF).catch(() => {})
      await sh(desktop, `mkdir -p /root/.config/speech-dispatcher && printf '%s' '${SPEECHD_CONF.replace(/'/g, "'\\''")}' > /root/.config/speech-dispatcher/speechd.conf`, "speechd config")
      await sh(desktop, `: > ${SPEECH_LOG}`, "reset speech log")

      // AT-SPI has to be switched on for the toolkit, and Chrome only exposes its
      // accessibility tree when asked — without this flag Orca narrates an empty
      // window and the demo silently proves nothing.
      await sh(desktop, "gsettings set org.gnome.desktop.interface toolkit-accessibility true", "toolkit-accessibility")
      await sh(desktop, "(/usr/libexec/at-spi-bus-launcher --launch-immediately &) ; sleep 1", "at-spi bus")
      await sh(desktop, "(speech-dispatcher -d &) ; sleep 1", "speech-dispatcher")
      await sh(desktop, "(orca --replace --no-setup &) ; sleep 4", "orca")
      const speaking = await sh(desktop, `test -s ${SPEECH_LOG} && echo yes || echo no`, "speech probe")
      speechWorked = speaking.trim() === "yes"
      console.log(`  orca speech capture: ${speechWorked ? "live" : "no utterances yet (will re-check after tabbing)"}`)
    }

    // ── Chrome, keyboard only from here on ──
    process.stdout.write("  opening chrome… ")
    await desktop.process
      .start("google-chrome", {
        args: [
          "--force-renderer-accessibility", // expose the AX tree to AT-SPI
          "--no-first-run",
          "--start-maximized",
          target,
        ],
      })
      .catch(async () => {
        // Template naming differs between images; try the usual aliases.
        await sh(desktop, `(chromium --force-renderer-accessibility --no-first-run "${target}" &) || (google-chrome-stable --force-renderer-accessibility "${target}" &)`, "chrome fallback")
      })
    await sleep(9000)
    console.log("loaded")

    const shot = async (name: string): Promise<void> => {
      const png = await desktop.screenshot({ format: "png" })
      writeFileSync(join(outDir, name), png)
    }
    await shot("00-loaded.png")

    // ── The walk. Tab only. ──
    console.log(`\n  pressing Tab ${TABS} times — no mouse from here on\n`)
    const transcript: Array<{ stop: number; spoken: string }> = []
    let seen = 0
    for (let i = 1; i <= TABS; i++) {
      await desktop.keyboard.press("Tab")
      await sleep(700) // give Orca time to speak the new focus

      let spoken = ""
      try {
        const log = await desktop.fs.readText(SPEECH_LOG)
        const lines = log.split("\n").filter(Boolean)
        spoken = lines.slice(seen).join(" · ").slice(0, 160)
        seen = lines.length
      } catch { /* no log means no screen reader; the screenshots still land */ }

      if (spoken) {
        speechWorked = true
        transcript.push({ stop: i, spoken })
        console.log(`  ${String(i).padStart(2)}. 🔊 ${spoken}`)
      } else {
        console.log(`  ${String(i).padStart(2)}. (silence)`)
      }
      if (i % 5 === 0) await shot(`tab-${String(i).padStart(2, "0")}.png`)
    }

    writeFileSync(join(outDir, "speech-transcript.json"), JSON.stringify(transcript, null, 2) + "\n")

    console.log(
      speechWorked
        ? `\n  transcript: ${join(outDir, "speech-transcript.json")}`
        : "\n  No speech was captured — the screenshots and the video still show the keyboard walk.",
    )

    const rec = await desktop.record.stop().catch(() => null)
    if (rec) console.log(`  video: ${(rec as { url?: string }).url ?? desktop.recordingUrl ?? "(check the console)"}`)
    console.log(`  frames: ${outDir}\n`)
  } finally {
    // close() drops the local channel only; destroy() ends the session.
    desktop.close()
    await client.desktops.destroy(desktop.sessionId).catch(() => {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => { console.error(err); process.exit(1) })
