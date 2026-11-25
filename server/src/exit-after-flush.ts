/**
 * Ends an operator script once everything it printed has been written.
 *
 * The scripts exit explicitly because queue and database clients keep handles
 * open. `process.exit` does not wait for stdout, and writes to a pipe are
 * asynchronous, so a report larger than one pipe buffer was cut off at 65,536
 * bytes when it was piped through `kubectl exec`: the dry run of the artifact
 * cleanup on dev came back as invalid JSON. Writing an empty chunk queues
 * behind everything already written, so its callback runs once stdout and
 * stderr have both drained.
 */
export async function exitAfterFlush(code: typeof process.exitCode): Promise<never> {
  await drain(process.stdout);
  await drain(process.stderr);
  process.exit(code);
}

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}
