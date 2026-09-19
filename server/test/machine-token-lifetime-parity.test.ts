import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MACHINE_TOKEN_TTL_SECONDS } from "../src/auth/credentials.service.js";

/**
 * A machine token has to outlive the upload it is going to authenticate.
 *
 * The archive validates the bearer once the body has arrived. So the question
 * is not whether the token is alive when the agent starts sending — it is
 * whether the token is still alive when the last byte lands, half an hour of
 * uplink later. Two constants in two languages answer that, and nothing
 * compared them:
 *
 *   - `UPLOAD_TIMEOUT` in the capture agent: 30 minutes, chosen because the
 *     artifact ceiling is 256 MiB and that is how long 256 MiB takes on a
 *     domestic connection. Before it existed the reqwest default of 30 seconds
 *     killed every large upload.
 *   - The machine token TTL in this archive: 900 seconds.
 *
 * Half an hour of permitted upload against a quarter of an hour of credential.
 * Every upload past the fifth minute — which is to say every upload the
 * 30-minute timeout was raised to allow — sent all of its bytes and was then
 * refused with `401 Valid bearer, machine, or API-key credentials are
 * required`. The fix that made large uploads possible was cancelled by the
 * token that authenticated them, and each side looked correct on its own.
 *
 * This reads both real constants rather than two copies of a number, because
 * copies are what drifted. If someone raises the upload window, this fails
 * until the token lifetime is raised with it.
 */
describe("machine token lifetime covers the upload window", () => {
  const transport = resolve(import.meta.dirname, "../../agent/crates/memoar-daemon/src/transport.rs");

  const secondsFromRust = (source: string, name: string): number => {
    const minutes = new RegExp(`${name}: Duration = Duration::from_secs\\((\\d+) \\* 60\\)`).exec(source);
    if (minutes) return Number(minutes[1]) * 60;
    const seconds = new RegExp(`${name}: Duration = Duration::from_secs\\((\\d+)\\)`).exec(source);
    if (seconds) return Number(seconds[1]);
    throw new Error(`${name} is not declared the way this test reads it; update the test, not the constant`);
  };

  it("lets a token outlast the longest upload the agent will attempt", async () => {
    const source = await readFile(transport, "utf8");
    const uploadTimeout = secondsFromRust(source, "UPLOAD_TIMEOUT");

    expect(uploadTimeout).toBeGreaterThan(0);
    expect(
      MACHINE_TOKEN_TTL_SECONDS,
      `a machine token lives ${MACHINE_TOKEN_TTL_SECONDS}s but the agent allows an upload ${uploadTimeout}s, `
        + "so a long upload is authenticated against a credential that expired while it was in flight",
    ).toBeGreaterThan(uploadTimeout);
  });

  /**
   * The agent refuses to begin a request on a token with less than
   * `CREDENTIAL_MARGIN` of life left. If the margin equals or exceeds the whole
   * lifetime, a freshly minted token never qualifies and the transport mints on
   * every request for ever without one succeeding — the opposite failure, and
   * an easy one to introduce while fixing this one.
   */
  it("leaves a fresh token usable rather than born expired", async () => {
    const source = await readFile(transport, "utf8");
    const margin = /CREDENTIAL_MARGIN: Duration = UPLOAD_TIMEOUT/.test(source)
      ? secondsFromRust(source, "UPLOAD_TIMEOUT")
      : secondsFromRust(source, "CREDENTIAL_MARGIN");

    expect(
      MACHINE_TOKEN_TTL_SECONDS,
      `the agent will not start a request on a token with under ${margin}s left, so a token minted for `
        + `${MACHINE_TOKEN_TTL_SECONDS}s is unusable from the moment it is issued`,
    ).toBeGreaterThan(margin);
  });
});
