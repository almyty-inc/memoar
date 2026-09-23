import { describe, expect, it } from "vitest";
import { AwsS3ClientPort } from "../src/ingest/object-storage.js";

/**
 * Which address shape the client signs for.
 *
 * MinIO needs path-style — `endpoint/bucket/key`. DigitalOcean Spaces documents
 * the opposite, and its own SDK guidance is to use the virtual-hosted form,
 * `bucket.fra1.digitaloceanspaces.com`. This was hard-coded to path-style, so
 * adopting a provider that wants the other shape meant editing the source.
 *
 * It matters more than it looks because of how it fails: the request reaches
 * the provider and is refused at signature verification, which reads like a bad
 * key rather than a wrong address shape. Someone would sooner re-issue
 * credentials than suspect this line.
 *
 * The default must stay path-style — the Compose stack and every deployment
 * today are MinIO — so these pin the default as much as the switch.
 */
describe("object storage addressing", () => {
  const base = { endpoint: "https://example.invalid", region: "fra1", accessKeyId: "a", secretAccessKey: "b" };
  const styleOf = (port: AwsS3ClientPort) =>
    (port as unknown as { internal: { config: { forcePathStyle: boolean } } }).internal.config.forcePathStyle;

  it("uses path style unless told otherwise", () => {
    expect(styleOf(new AwsS3ClientPort(base)), "MinIO needs path style and is what every deployment runs").toBe(true);
    expect(styleOf(new AwsS3ClientPort({ ...base, forcePathStyle: true }))).toBe(true);
  });

  it("can be switched to virtual-hosted for a provider that wants it", () => {
    expect(styleOf(new AwsS3ClientPort({ ...base, forcePathStyle: false })), "there would be no way to adopt Spaces").toBe(false);
  });

  it("signs the public endpoint the same way as the internal one", () => {
    // The pre-signed URL an agent fetches is signed by the public signer. If the
    // two clients disagreed about address shape, downloads would fail while
    // everything the archive does internally kept working — the hardest kind of
    // difference to notice.
    const port = new AwsS3ClientPort({ ...base, publicEndpoint: "https://objects.example.invalid", forcePathStyle: false });
    const publicStyle = (port as unknown as { publicSigner: { config: { forcePathStyle: boolean } } }).publicSigner.config.forcePathStyle;
    expect(publicStyle).toBe(styleOf(port));
  });
});
