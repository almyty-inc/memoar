import { unzipSync } from "fflate";

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Reads one named file out of an export archive, or treats the input as that
 * file when it is not an archive — people upload both the ZIP they downloaded
 * and the JSON they extracted from it.
 *
 * Entry names are matched by suffix because vendors nest the payload
 * differently (Gemini puts it under `Gemini/`), and traversal-shaped names are
 * never inflated even though nothing here is written to disk.
 */
export function readArchiveEntry(raw: Uint8Array, entryName: string): string {
  if (!isZipBytes(raw)) return Buffer.from(raw).toString("utf8");
  const entries = unzipSync(raw, {
    filter: (entry) =>
      entry.name.endsWith(entryName)
      && !entry.name.includes("..")
      && !entry.name.startsWith("/")
      && entry.originalSize <= MAX_ENTRY_BYTES,
  });
  // The shallowest match wins, so a stray copy nested deeper in the archive
  // cannot shadow the export's own payload.
  const found = Object.entries(entries).sort(([left], [right]) => left.length - right.length)[0];
  if (!found) throw new Error(`archive contains no ${entryName}`);
  return Buffer.from(found[1]).toString("utf8");
}
