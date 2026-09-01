/** What is actually inside a Solari desktop template, and will the screen
 *  reader talk to us?
 *
 *   node --env-file-if-exists=.env scripts/probe-template.ts
 *
 *  The docs list what the images ship; they do not tell you which browser
 *  binary exists, which user you are, or why speech-dispatcher refuses to
 *  start. Guessing costs a VM per guess, so this asks the machine. */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"
import { resolveApiKey } from "../src/apikey.ts"

const template = process.argv[2] ?? "default"
const client = new SolariClient({ apiKey: resolveApiKey() })
const d = await client.desktops.create({ template, resolution: "1280x720", memMb: 4096, timeoutMs: 10 * 60_000 })
console.log(`template "${template}" · desktop ${d.sessionId.slice(0, 24)}…`)

const sh = async (label: string, script: string): Promise<string> => {
  const r = await d.exec("sh", { args: ["-c", script] })
  const out = String(r.stdout ?? "").trim()
  const err = String(r.stderr ?? "").trim()
  console.log(`\n### ${label} (exit ${r.exitCode})\n${out.slice(0, 700)}${err ? `\nSTDERR: ${err.slice(0, 300)}` : ""}`)
  return out
}

const asset = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../data/${name}`, import.meta.url)), "utf8")

try {
  await d.connect()
  for (let i = 0; i < 30; i++) {
    if ((await d.health() as { ready?: boolean }).ready) break
    await new Promise((r) => setTimeout(r, 1000))
  }

  await sh("identity", "whoami; echo HOME=$HOME; echo DISPLAY=$DISPLAY")
  await sh("browsers", "for b in google-chrome chromium firefox; do command -v $b; done")
  // pkg.install returns a non-zero exitCode rather than throwing, and without an
  // update first, apt claims at-spi2-core does not exist.
  await sh("install", "apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq orca speech-dispatcher dbus-x11 at-spi2-core 2>&1 | tail -2; echo rc=$?")

  await d.fs.write("/root/a11y-setup.sh", asset("desktop-a11y-setup.sh"), 0o755)
  await d.fs.write("/etc/speech-dispatcher/modules/gauntletlog.conf", asset("speechd-gauntletlog.conf"), 0o644)
  await sh("module file on disk", "ls -l /etc/speech-dispatcher/modules/gauntletlog.conf /etc/speech-dispatcher/modules/espeak-ng.conf")

  await sh("dbus", "export HOME=/root XDG_RUNTIME_DIR=/run/user/0 DISPLAY=:0; mkdir -p /run/user/0; dbus-launch --sh-syntax > /tmp/dbus.env 2>/dev/null; head -1 /tmp/dbus.env")

  // speech-dispatcher's sd_generic module refuses to load on this image (any
  // name, any config; sd_espeak-ng loads fine), so capturing Orca's audio path
  // is a dead end here. AT-SPI is the better source anyway: it is where Orca
  // gets its announcements from in the first place.
  await d.fs.write("/root/atspi-listener.py", asset("atspi-listener.py"), 0o755)
  await d.fs.write("/root/a11y-setup.sh", asset("desktop-a11y-setup.sh"), 0o755)

  console.log("\n### starting accessibility stack…")
  console.log("pid", await d.process.start("sh", { args: ["/root/a11y-setup.sh"] }))
  for (let i = 0; i < 30; i++) {
    const r = await d.exec("sh", { args: ["-c", "test -f /tmp/gauntlet-setup-done && echo done || echo waiting"] })
    if (String(r.stdout).includes("done")) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  await sh("stack", "pgrep -a at-spi | head -3; pgrep -a orca | head -2")

  console.log("\n### starting the AT-SPI listener…")
  console.log("pid", await d.process.start("sh", { args: ["-c", "export HOME=/root DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/0; . /tmp/dbus.env; exec python3 /root/atspi-listener.py /tmp/gauntlet-speech.log >> /tmp/listener.log 2>&1"] }))
  await new Promise((r) => setTimeout(r, 4000))
  await sh("listener", "cat /tmp/gauntlet-speech.log 2>&1; echo ---; tail -5 /tmp/listener.log 2>&1")

  console.log("\n### opening chrome on a real page…")
  await d.process.start("sh", { args: ["-c", 'export HOME=/root DISPLAY=:0; . /tmp/dbus.env; exec google-chrome --force-renderer-accessibility --no-first-run --no-sandbox --window-size=1280,720 --app="https://optimusrex.web.app/" >> /tmp/chrome.log 2>&1'] })
  await new Promise((r) => setTimeout(r, 12000))
  await sh("chrome window", "DISPLAY=:0 xdotool getactivewindow getwindowname 2>&1 || wmctrl -l 2>&1 | head -3")

  // F6 moves focus from Chrome's toolbar into the page; without it every Tab
  // just walks the browser's own chrome.
  for (let i = 0; i < 14; i++) {
    await d.keyboard.press("Tab")
    await new Promise((r) => setTimeout(r, 700))
  }
  await sh("captured announcements", "cat /tmp/gauntlet-speech.log 2>&1 | tail -20")

} finally {
  d.close()
  await client.desktops.destroy(d.sessionId).catch(() => {})
  console.log("\ndestroyed")
}
