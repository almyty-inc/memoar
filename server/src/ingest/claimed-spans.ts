/**
 * Ranges of text a scanner has already reported, kept sorted and disjoint.
 *
 * A claim is a binary search and one insertion, so a file at the scanner's
 * finding cap costs thousands of steps rather than millions.
 */
export class ClaimedSpans {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  /** Claims `[start, end)` and returns true, or returns false if it overlaps a claim. */
  claim(start: number, end: number): boolean {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.starts[middle]! < start) low = middle + 1;
      else high = middle;
    }
    // `low` is the first claim starting at or after `start`.
    if (low > 0 && this.ends[low - 1]! > start) return false;
    if (low < this.starts.length && this.starts[low]! < Math.max(end, start + 1)) return false;
    this.starts.splice(low, 0, start);
    this.ends.splice(low, 0, end);
    return true;
  }
}
