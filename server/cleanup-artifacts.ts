import { runCleanupCommand } from "./src/cleanup/cleanup-command.js";
import { exitAfterFlush } from "./src/exit-after-flush.js";

await runCleanupCommand();
// Queue and database clients keep handles open, so exit explicitly for callers
// to get EOF, but only once the report has been written in full.
await exitAfterFlush(process.exitCode ?? 0);
