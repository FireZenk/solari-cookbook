/** Mint a fresh replay link for a session.
 *
 *   node --env-file-if-exists=.env scripts/replay.ts <sessionId>
 *
 *  Runs deliberately store the session id and not the link. `getReplayUrl`
 *  returns a presigned S3 URL whose query string contains AWS temporary
 *  credentials; keeping one in a report or an evidence bundle turns an artifact
 *  into a secret. Ask for a new one when you actually want to watch. */
import { Solari } from "@solarisdk/browser"
import { resolveApiKey } from "../src/apikey.ts"

const sessionId = process.argv[2]
if (!sessionId) {
  console.error("usage: node scripts/replay.ts <sessionId>   (ids are in run.json)")
  process.exit(1)
}

const solari = new Solari({ apiKey: resolveApiKey() })
try {
  const replay = await solari.sessions.getReplayUrl(sessionId)
  console.log(`\nExpires in ${replay.expiresInSeconds}s. Treat it as a credential — do not commit it.\n`)
  console.log(replay.url)
} finally {
  await solari.close()
}
