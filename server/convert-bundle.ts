/**
 * Builds a conversion bundle from a canonical session file, without an archive.
 *
 *   npx tsx convert-bundle.ts <session-or-export.json> <target> [workspacePath] > bundle.json
 *   memoar convert <session-id> --target <target> --bundle bundle.json --here
 *
 * The writers run on the archive, so a change to them is invisible to the CLI
 * until the archive is deployed. This runs the same writers locally, so a
 * change can be resumed in the real tool before it ships.
 */
import { readFileSync } from "node:fs";
import type { Session } from "./libs/canonical/src/generated.js";
import { ConversionEngine } from "./src/convert/engine.js";
import { serializeBundle } from "./src/convert/serialize.js";

const [sessionPath, target, workspacePath] = process.argv.slice(2);
if (!sessionPath || !target) {
  process.stderr.write("usage: convert-bundle.ts <session.json> <target> [workspacePath]\n");
  process.exit(2);
}
// A bare session, or the canonical export (`GET /sessions/{id}/export`).
const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as Session | { sessions: Session[] };
const session = "sessions" in parsed ? parsed.sessions[0]! : parsed;
const bundle = new ConversionEngine().convert(session, target, "fail", undefined, workspacePath ? { workspacePath } : {});
process.stdout.write(serializeBundle(bundle));
process.stdout.write("\n");
