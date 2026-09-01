/** Find the API key without making the user think about dotenv syntax.
 *
 *  Order: the environment first (that is what CI sets), then a local key file.
 *  The file may be `SOLARI_API_KEY=slr_live_…` or just the key on a line by
 *  itself — pasting a key into a file and having it not work is a bad first
 *  five minutes with a tool. Nothing here logs the value. */
import { existsSync, readFileSync } from "node:fs"

const CANDIDATE_FILES = [".env", ".env.local", ".solari-key"]

export function resolveApiKey(): string {
  const fromEnv = process.env.SOLARI_API_KEY?.trim()
  if (fromEnv) return fromEnv

  for (const file of CANDIDATE_FILES) {
    if (!existsSync(file)) continue
    let contents: string
    try { contents = readFileSync(file, "utf8") } catch { continue }
    for (const line of contents.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const named = /^(?:export\s+)?SOLARI_API_KEY\s*=\s*["']?([^"'\s]+)/.exec(trimmed)
      if (named?.[1]) return named[1]
      if (/^slr_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed // a bare key
    }
  }

  console.error(
    "No Solari API key found.\n\n" +
    "  export SOLARI_API_KEY=slr_live_…\n" +
    "or put the key in ./.env — either `SOLARI_API_KEY=slr_live_…` or the key alone on one line.\n" +
    "Keys come from https://console.getsolari.com\n",
  )
  process.exit(1)
}
