import { exitAfterFlush } from "./src/exit-after-flush.js";
import { runResetPassword } from "./src/reset-password.js";

process.exitCode = await runResetPassword();
// The database pool keeps a handle open, so exit explicitly for callers to get
// EOF, but only once everything printed has been written.
await exitAfterFlush(process.exitCode);
