import { runResetPassword } from "./src/reset-password.js";

process.exitCode = await runResetPassword();
// The database pool keeps a handle open; exit explicitly so callers get EOF.
process.exit(process.exitCode);
