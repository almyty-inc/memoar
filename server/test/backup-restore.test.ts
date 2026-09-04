import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { countRows, dockerAvailable, queryRows, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-backup-test", port: 55985 };

let dataSource: DataSource | null = null;
let store: PostgresArchiveStore;

const CONTEXT: TenantContext = TEST_CONTEXT;
const SESSION_ID = "0191cafe-0000-7000-8000-00000000ba01";
/** Inside the container, where the client's version matches the server's. */
const URL_IN_CONTAINER = "postgres://memoar:contract@127.0.0.1:5432/memoar";
const BACKUP_DIR = "/tmp/memoar-backups";

/**
 * Runs one of the deploy scripts inside the database's own container.
 *
 * That is how a backup is actually taken against a container deployment —
 * `docker compose exec postgres` — and it is the only way the client and the
 * server are guaranteed to be the same major version, which backup.sh now
 * insists on.
 */
function script(name: string, args: string[]): string {
  return execFileSync("docker", ["exec", FIXTURE.container, "sh", `/tmp/${name}`, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Reads a file out of the container. */
function readInContainer(path: string): string {
  return execFileSync("docker", ["exec", FIXTURE.container, "cat", path], { encoding: "utf8" });
}

function shellInContainer(command: string): string {
  return execFileSync("docker", ["exec", FIXTURE.container, "sh", "-c", command], { encoding: "utf8" });
}

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: CONTEXT.userId, tenantId: CONTEXT.tenantId, email: "backup@example.test" });
  store = new PostgresArchiveStore(dataSource);
  await store.saveSession(CONTEXT, { ...TEST_SESSION, id: SESSION_ID, title: "The session a restore has to bring back" });

  for (const name of ["backup.sh", "restore.sh"]) {
    execFileSync("docker", ["cp", resolve(process.cwd(), "..", "deploy", name), `${FIXTURE.container}:/tmp/${name}`]);
  }
}, 300_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

suite("backing up and restoring the archive", () => {
  it("writes a dump with a checksum beside it", () => {
    // Everything else in this repository can be rebuilt from source; the
    // sessions cannot. Nothing dumped the database until now.
    const output = JSON.parse(script("backup.sh", ["--url", URL_IN_CONTAINER, "--out", BACKUP_DIR, "--label", "first"])) as {
      dump: string;
      bytes: number;
      sha256: string;
    };

    expect(output.bytes, "an empty dump is not a backup").toBeGreaterThan(1000);
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readInContainer(`${output.dump}.sha256`).trim()).toBe(output.sha256);
  });

  it("brings the archive back after it is gone", async () => {
    // The test that matters: a backup nobody has restored is a promise rather
    // than a copy.
    const dump = JSON.parse(script("backup.sh", ["--url", URL_IN_CONTAINER, "--out", BACKUP_DIR, "--label", "before-loss"])) as { dump: string };
    const before = await store.getSession(CONTEXT, SESSION_ID);
    expect(before, "the fixture session must exist before it is destroyed").not.toBeNull();

    await dataSource!.query("DROP SCHEMA public CASCADE");
    await dataSource!.query("CREATE SCHEMA public");
    expect(await countRows(dataSource!, "pg_tables WHERE schemaname = 'public'"), "the archive is gone").toBe(0);

    const restored = JSON.parse(script("restore.sh", ["--url", URL_IN_CONTAINER, "--dump", dump.dump])) as {
      sessions: number;
      turns: number;
    };

    expect(restored.sessions).toBeGreaterThan(0);
    const after = await store.getSession(CONTEXT, SESSION_ID);
    expect(after, "the session came back").not.toBeNull();
    expect(after!.title).toBe("The session a restore has to bring back");
    expect(after!.turns).toHaveLength(before!.turns.length);
    expect(after!.turns[0]!.blocks[0]!.text).toBe(before!.turns[0]!.blocks[0]!.text);
  }, 300_000);

  it("restores the tenant policies, not only the rows", async () => {
    // A restore that brings back the rows without the row-level security
    // policies is worse than no restore: the archive would be readable across
    // tenants and would look completely healthy.
    const policies = await queryRows<{ tablename: string }>(
      dataSource!,
      "SELECT tablename FROM pg_policies WHERE schemaname = 'public'",
    );
    expect(policies.length, "no tenant policies survived the restore").toBeGreaterThan(5);

    const forced = await queryRows<{ relname: string }>(
      dataSource!,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`,
    );
    expect(forced.map((row) => row.relname)).toContain("sessions");
  });

  it("refuses to restore over an archive that already has sessions", () => {
    // Restoring an old copy over a working archive is the ordinary way to lose
    // one, so it takes an explicit --replace.
    const dump = JSON.parse(script("backup.sh", ["--url", URL_IN_CONTAINER, "--out", BACKUP_DIR, "--label", "guard"])) as { dump: string };

    expect(() => script("restore.sh", ["--url", URL_IN_CONTAINER, "--dump", dump.dump]))
      .toThrow(/already holds \d+ sessions/u);
    // And goes ahead when told to.
    expect(() => script("restore.sh", ["--url", URL_IN_CONTAINER, "--dump", dump.dump, "--replace"])).not.toThrow();
  }, 300_000);

  it("refuses a dump that does not match its checksum", () => {
    const dump = JSON.parse(script("backup.sh", ["--url", URL_IN_CONTAINER, "--out", BACKUP_DIR, "--label", "damaged"])) as {
      dump: string;
      bytes: number;
    };
    // One byte, in the middle: a truncated file often fails on its own, but a
    // corrupted one can restore happily and silently lose whatever it hit.
    const middle = Math.floor(dump.bytes / 2);
    shellInContainer(`printf '\\xff' | dd of=${dump.dump} bs=1 seek=${middle} conv=notrunc 2>/dev/null`);

    expect(() => script("restore.sh", ["--url", URL_IN_CONTAINER, "--dump", dump.dump, "--replace"]))
      .toThrow(/does not match its checksum/u);
  }, 300_000);

  it("refuses to dump with a client of the wrong major version", () => {
    // pg_dump writes its own version's settings into the file: an 18 client
    // emits `SET transaction_timeout`, which a 16 server rejects part-way
    // through the restore. The backup looks perfect until the day it is needed,
    // so the mismatch is caught when the dump is taken.
    const fake = "/tmp/wrong-version";
    shellInContainer(
      `mkdir -p ${fake} && printf '#!/bin/sh\\necho "pg_dump (PostgreSQL) 18.6"\\n' > ${fake}/pg_dump && chmod +x ${fake}/pg_dump`,
    );

    expect(() => execFileSync(
      "docker",
      ["exec", "-e", `PATH=${fake}:/usr/local/bin:/usr/bin:/bin`, FIXTURE.container,
        "sh", "/tmp/backup.sh", "--url", URL_IN_CONTAINER, "--out", BACKUP_DIR, "--label", "mismatch"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )).toThrow(/pg_dump is version 18 but the server is version 16/u);
  }, 300_000);
});
