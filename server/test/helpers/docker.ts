import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/** Marks every container a test starts, so leftovers can be found by label. */
export const TEST_CONTAINER_LABEL = "memoar.test-fixture=postgres";

/**
 * Runs a docker command and returns its stdout.
 *
 * A failure carries docker's own stderr. The helpers used to discard it, and
 * `docker run` exiting 125 after printing a container id was all CI ever
 * showed: the container had been created and could not start, with the reason
 * thrown away.
 */
export function docker(...args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(describeFailure(args, error), { cause: error });
  }
}

function describeFailure(args: readonly string[], error: unknown): string {
  const failure = error as { status?: number | null; stderr?: unknown; message?: string };
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const status = failure.status ?? "no exit status";
  return `docker ${args.join(" ")} failed (${status}): ${stderr || failure.message || "no output on stderr"}`;
}

export function dockerAvailable(): boolean {
  try {
    docker("info");
    return true;
  } catch {
    return false;
  }
}

export interface PostgresContainerOptions {
  /** The superuser password, for user `memoar` on database `memoar`. */
  password: string;
  /** Extra `docker run` flags, such as `--shm-size`. */
  runArgs?: readonly string[];
}

/**
 * One throwaway Postgres container and the host port it was published on.
 *
 * The port is chosen by Docker when the container starts, never by the test.
 * Every suite used to pin a fixed port in 55979-55996. That range sits inside
 * Linux's ephemeral port range (32768-60999), so any outbound connection on
 * the runner could already hold the port when `docker run` tried to publish
 * it. A fixed port also lets two suites, or two concurrent runs, collide.
 *
 * The name carries the process id and a random suffix for the same reason: a
 * parallel run, or a container left behind by a crashed one, can never share
 * it.
 */
export class PostgresFixture {
  readonly container: string;
  private hostPort: number | null = null;

  constructor(name: string) {
    this.container = `${name}-${process.pid}-${randomBytes(3).toString("hex")}`;
  }

  /** The published host port. Only known once the container has started. */
  get port(): number {
    if (this.hostPort === null) throw new Error(`${this.container} has not been started, so it has no host port yet`);
    return this.hostPort;
  }

  /** A connection URL to the `memoar` database through the published port. */
  url(user: string, password: string): string {
    return `postgres://${user}:${password}@127.0.0.1:${this.port}/memoar`;
  }

  /** Starts the container on a loopback port Docker picks, and records it. */
  start(options: PostgresContainerOptions): void {
    this.remove();
    try {
      docker(
        "run", "-d", "--name", this.container, "--label", TEST_CONTAINER_LABEL, ...(options.runArgs ?? []),
        "-e", "POSTGRES_DB=memoar", "-e", "POSTGRES_USER=memoar", "-e", `POSTGRES_PASSWORD=${options.password}`,
        "-p", "127.0.0.1::5432", POSTGRES_IMAGE,
      );
      this.hostPort = publishedPort(this.container);
    } catch (error) {
      // `docker run` can create the container and then fail to start it.
      this.remove();
      throw error;
    }
  }

  /** Removes the container and its anonymous data volume, which the image declares. */
  remove(): void {
    try { docker("rm", "-f", "-v", this.container); } catch { /* not there */ }
  }
}

/** Reads back the host port Docker published the container's 5432 on. */
function publishedPort(container: string): number {
  const output = docker("port", container, "5432/tcp");
  const match = /:(\d+)\s*$/mu.exec(output.trim().split("\n")[0] ?? "");
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${container} published no usable port: ${JSON.stringify(output)}`);
  return port;
}
