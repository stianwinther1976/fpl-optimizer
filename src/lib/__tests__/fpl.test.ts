import { describe, it, expect } from "vitest";
import { rankPercentile } from "../fpl";

describe("rankPercentile", () => {
  it("uses more decimals the closer to the top you are", () => {
    expect(rankPercentile(1_000, 10_000_000)).toBe("Top 0.010%");
    expect(rankPercentile(50_000, 10_000_000)).toBe("Top 0.50%");
    expect(rankPercentile(500_000, 10_000_000)).toBe("Top 5.0%");
    expect(rankPercentile(4_000_000, 10_000_000)).toBe("Top 40%");
  });

  it("never claims a rank better than the field allows", () => {
    expect(rankPercentile(11_000_000, 10_000_000)).toBe("Top 100%");
  });

  it("returns null rather than a bogus percentage when inputs are missing", () => {
    expect(rankPercentile(null, 10_000_000)).toBeNull();
    expect(rankPercentile(1_000, null)).toBeNull();
    expect(rankPercentile(1_000, 0)).toBeNull();
    expect(rankPercentile(0, 10_000_000)).toBeNull();
  });
});
