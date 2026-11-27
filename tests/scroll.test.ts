import { describe, expect, it } from "vitest";
import { scrollFraction, scrollTopFor } from "../src/shared/scroll";

describe("scroll fraction", () => {
  it("stores 1 at the bottom of the range, not at 90%", () => {
    // 1750 px of content in a 700 px viewport: the range is 1050.
    expect(scrollFraction(1050, 1750, 700)).toBe(1);
    // The old code divided by scrollHeight, which stored 0.6 here.
    expect(scrollFraction(1050, 1750, 700)).not.toBeCloseTo(1050 / 1750, 5);
  });

  it("round-trips a mid-page offset", () => {
    const stored = scrollFraction(240, 1750, 700);
    expect(stored).toBeCloseTo(240 / 1050, 10);
    expect(scrollTopFor(stored, 1750, 700)).toBeCloseTo(240, 10);
  });

  it("round-trips across a zoom change, which is the point of the fraction", () => {
    const stored = scrollFraction(240, 1750, 700);
    // The same fraction of a taller raster lands proportionally further down:
    // the range grows from 1050 to 2800, so the offset grows with it.
    expect(scrollTopFor(stored, 3500, 700)).toBeCloseTo((240 / 1050) * 2800, 10);
  });

  it("returns 0 when the content does not overflow", () => {
    expect(scrollFraction(0, 700, 700)).toBe(0);
    expect(scrollFraction(50, 600, 700)).toBe(0);
    expect(scrollTopFor(0.5, 700, 700)).toBe(0);
  });

  it("clamps out-of-range and non-finite input", () => {
    expect(scrollFraction(5000, 1750, 700)).toBe(1);
    expect(scrollFraction(-20, 1750, 700)).toBe(0);
    expect(scrollFraction(Number.NaN, 1750, 700)).toBe(0);
    expect(scrollTopFor(1.4, 1750, 700)).toBe(1050);
    expect(scrollTopFor(-1, 1750, 700)).toBe(0);
    expect(scrollTopFor(Number.NaN, 1750, 700)).toBe(0);
    expect(scrollFraction(0, Number.NaN, 700)).toBe(0);
  });
});
