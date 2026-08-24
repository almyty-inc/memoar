import { runReprocess } from "./src/reprocess.js";

await runReprocess();
// Queue and database clients keep handles open; exit explicitly so callers get EOF.
process.exit(process.exitCode ?? 0);
