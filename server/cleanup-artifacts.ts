import { runCleanupCommand } from "./src/cleanup/cleanup-command.js";

await runCleanupCommand();
// Queue and database clients keep handles open, so exit explicitly for callers to get EOF.
process.exit(process.exitCode ?? 0);
