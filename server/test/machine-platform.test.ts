import { describe, expect, it } from "vitest";
import { normalizePlatform } from "../src/machines.js";

/**
 * One name per operating system.
 *
 * The platform is free text from whichever client registered the machine, and
 * clients disagree: the Rust agent sends Rust's `std::env::consts::OS`, and
 * anything written against Node sends `process.platform`. An account with a
 * machine from each listed "macos" and "darwin" as if they were two systems.
 */
describe("the platform a machine reports", () => {
  it("calls one operating system by one name", () => {
    expect(normalizePlatform("darwin")).toBe("macos");
    expect(normalizePlatform("macos")).toBe("macos");
    expect(normalizePlatform("win32")).toBe("windows");
    expect(normalizePlatform("linux")).toBe("linux");
  });

  it("does not care how the client cased or spaced it", () => {
    expect(normalizePlatform("  Darwin ")).toBe("macos");
    expect(normalizePlatform("Mac OS X")).toBe("macos");
    expect(normalizePlatform("WIN32")).toBe("windows");
  });

  it("keeps a platform it has no alias for, rather than guessing", () => {
    // A system nobody anticipated is better recorded as it was reported than
    // mapped to whichever known name looks closest.
    expect(normalizePlatform("freebsd")).toBe("freebsd");
    expect(normalizePlatform("  openbsd  ")).toBe("openbsd");
  });
});
