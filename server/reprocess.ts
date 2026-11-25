import { exitAfterFlush } from "./src/exit-after-flush.js";
import { runReprocess } from "./src/reprocess.js";

await runReprocess();
// Queue and database clients keep handles open, so exit explicitly for callers
// to get EOF, but only once the report has been written in full.
await exitAfterFlush(process.exitCode ?? 0);
