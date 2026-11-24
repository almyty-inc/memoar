// The window, driven headless by `nsh test`: each test opens the Rust root
// (`nsh.json` "root") and works it as a person would.
//
// Run through `agent/scripts/test-desktop.sh`, which points the app at scratch
// directories (MEMOAR_CONFIG_DIR, MEMOAR_DATA_DIR, MEMOAR_CAPTURE_HOME), puts
// one Claude Code session in the capture home and starts the stand-in archive
// (`examples/stub_archive.rs`) at STUB. The tests share those directories and
// run in order, as a person's day with the app would.
import { expect, open, test } from "nsh/test";

const STUB = "http://127.0.0.1:47613/v1";
const DOWN = "http://127.0.0.1:1/v1";
const PASSWORD = "correct horse battery staple";
const SLOW = { timeout: 30000 };

function start() {
  return open(".", { width: 560, height: 1000, platform: "macos" });
}

async function signIn(app: Awaited<ReturnType<typeof start>>, endpoint: string, email: string, password: string) {
  await app.waitFor("text:Sign in to your archive", SLOW);
  await app.clear("id:endpoint");
  await app.type("id:endpoint", endpoint);
  await app.clear("id:email");
  await app.type("id:email", email);
  await app.clear("id:password");
  await app.type("id:password", password);
  await app.press("id:sign-in");
}

test("an empty form says what is missing", async () => {
  const app = await start();
  await app.waitFor("text:Sign in to your archive", SLOW);
  await app.press("id:sign-in");
  await app.waitFor("id:sign-in-error");
  expect(app.texts()).toContain("Enter the archive's address.");
});

test("an archive that is down fails sign-in and says where it looked", async () => {
  const app = await start();
  await signIn(app, DOWN, "person@example.com", PASSWORD);
  await app.waitFor("id:sign-in-error", SLOW);
  expect(app.texts()).toContain(
    `Cannot reach the archive at ${DOWN}. Check the address and that the server is running.`,
  );
  expect(app.shows("text:This machine")).toBeFalsy();
});

test("a wrong password is refused with the archive's reason", async () => {
  const app = await start();
  await signIn(app, STUB, "person@example.com", "not the password");
  await app.waitFor("text:The archive did not accept these credentials. Check them and try again.", SLOW);
  expect(app.texts()).toContain("Email or password is incorrect. (HTTP 401)");
});

test("signing in captures at once and shows what was uploaded", async () => {
  const app = await start();
  await signIn(app, STUB, "person@example.com", PASSWORD);
  await app.waitFor("text:This machine", SLOW);
  await app.waitFor("text:1 session", SLOW);
  const texts = app.texts();
  expect(texts).toContain(STUB);
  expect(texts).toContain("Capturing every two minutes.");
  expect(texts).toContain("1 artifact");
  expect(texts).toContain("Nothing");
  expect(texts.some((line) => line.includes("Claude Code"))).toBeTruthy();
  expect(texts).toContain("just now");
});

test("capture now runs again and keeps the totals", async () => {
  const app = await start();
  await app.waitFor("text:This machine", SLOW);
  await app.waitUntil(() => app.enabled("id:capture-now"), SLOW);
  await app.press("id:capture-now");
  await app.waitUntil(() => app.texts().includes("Capture now") && app.texts().includes("0 sessions"), SLOW);
  expect(app.texts()).toContain("1 artifact");
  expect(app.shows("id:capture-error")).toBeFalsy();
});

test("pausing stops the timer and resuming starts it", async () => {
  const app = await start();
  await app.waitFor("text:This machine", SLOW);
  await app.press("id:pause");
  await app.waitFor("text:Paused. Nothing is captured until you resume.");
  expect(app.texts()).toContain("Resume");
  expect(app.enabled("id:capture-now")).toBeTruthy();
  await app.press("id:pause");
  await app.waitFor("text:Pause");
});

test("masking can be changed from the window", async () => {
  const app = await start();
  await app.waitFor("text:This machine", SLOW);
  await app.waitUntil(() => app.texts().includes("Masked before upload"), SLOW);
  await app.press("id:mask-email");
  await app.waitUntil(() => app.texts().filter((line) => line === "On").length === 2, SLOW);
  await app.press("id:mask-email");
  await app.waitUntil(() => app.texts().filter((line) => line === "On").length === 1, SLOW);
});

test("signing out returns to sign-in and keeps the address", async () => {
  const app = await start();
  await app.waitFor("text:This machine", SLOW);
  await app.waitUntil(() => app.enabled("id:sign-out"), SLOW);
  await app.press("id:sign-out");
  await app.waitFor("text:Sign in to your archive", SLOW);
  expect(app.value("id:endpoint")).toBe(STUB);
});

test("a revoked key stops capture and asks for a new sign-in", async () => {
  const app = await start();
  await signIn(app, STUB, "revoked@example.com", PASSWORD);
  await app.waitFor("id:capture-error", SLOW);
  const texts = app.texts();
  expect(texts).toContain(
    "The archive no longer accepts this machine's key. Capture has stopped. Sign in again to resume.",
  );
  expect(texts).toContain("Capture has stopped.");
  expect(app.enabled("id:capture-now")).toBeFalsy();
  await app.press("id:sign-in-again");
  await app.waitFor("text:Sign in to your archive", SLOW);
});

test("an API key signs in as memoar login --token does", async () => {
  const app = await start();
  await app.waitFor("text:Sign in to your archive", SLOW);
  await app.press("id:use-api-key");
  await app.waitFor("id:api-key");
  await app.type("id:api-key", "memoar_stub-api-key");
  await app.press("id:sign-in");
  await app.waitFor("text:This machine", SLOW);
  await app.waitUntil(() => app.enabled("id:sign-out"), SLOW);
  await app.press("id:sign-out");
  await app.waitFor("text:Sign in to your archive", SLOW);
});
