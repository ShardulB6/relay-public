import { describe, expect, test } from "vite-plus/test";

import { formatDuration } from "./duration.ts";

describe("formatDuration", () => {
  test("shows seconds, then minutes, then hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(8_900)).toBe("8s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});
