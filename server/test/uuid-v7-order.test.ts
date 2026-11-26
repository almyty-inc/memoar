import { describe, expect, it } from "vitest";
import { uuidV7 } from "../src/ids.js";

describe("uuidV7", () => {
  it("sorts every id after the one before it, through a full counter in one millisecond", () => {
    const now = Date.now() + 60_000;
    const ids = Array.from({ length: 5000 }, () => uuidV7(now));
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!, `id ${index} sorts before id ${index - 1}`).toBe(true);
    }
  });

  it("keeps counting when the clock steps back", () => {
    const later = uuidV7(Date.now() + 120_000);
    expect(uuidV7(Date.now()) > later).toBe(true);
  });
});
