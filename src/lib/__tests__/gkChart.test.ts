import { describe, it, expect } from "vitest";
import { capAndRedistribute } from "../xp";
import { XP_CONFIG } from "../xp";

/**
 * The keeper depth chart's cap-and-redistribute rule, asserted directly.
 *
 * It is four levels inside `projectAll`'s club scan and the number it produces
 * is put through the outfield mass rebalance before anything outside can read
 * it, so a pipeline test cannot see this quantity at all — which is how the
 * defect below survived a suite that already had a block about exactly the
 * failure it reintroduces.
 */
const CAP = XP_CONFIG.preseasonMaxPStart;
const SLOT = XP_CONFIG.gkPreseason.slotMass;
const BETA = XP_CONFIG.gkPreseason.beta;

/** The call site's own arithmetic, so the inputs here are the real inputs. */
function chart(av: number[], score: number[]) {
  const raw = score.map((s) => Math.exp(BETA * s));
  const sum = raw.reduce((a, r, i) => a + av[i] * r, 0);
  const p = raw.map((r, i) => ((av[i] * r) / sum) * SLOT);
  const cond = capAndRedistribute(p, av, raw, CAP);
  const shares = cond.map((c) => Math.max(0, Math.min(CAP, c)));
  return { shares, mass: shares.reduce((s, c, i) => s + c * av[i], 0) };
}

describe("the keeper depth chart's cap", () => {
  it("hands the capped probability to a keeper with room, not to one already pinned", () => {
    /*
     * Found by grid search over availability and score. It needs TWO passes to
     * bite, which is why it survived: pass 0 pins the favourites and gives the
     * spare to the deputy, and only if the DEPUTY then overshoots does pass 1
     * generate spare while the pinned men are back in the recipient list —
     * where they take the largest weight there is and have all of it clamped
     * away. The club's keepers covered 0.7975 of a shirt against a slot mass of
     * 0.95, and the man who lost it was the deputy, exactly as before.
     */
    const { shares, mass } = chart([0.2, 0.5, 0.3], [0.8, 1.0, 0]);
    expect(mass).toBeCloseTo(SLOT, 6);
    expect(shares[2]).toBeCloseTo(0.903, 3);
    expect(shares[2]).toBeGreaterThan(0.395); // what the re-admitting rule gave
  });

  it("conserves the club's slot mass wherever the cap can hold it", () => {
    // Exhaustive over a grid of availabilities and depth-chart scores: the
    // conditional shares, weighted back by availability, always come to the
    // slot mass — or to the most the cap can physically hold, when the club's
    // keepers are too unavailable between them to cover a whole shirt.
    const avs = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1];
    const scores = [0, 0.2, 0.5, 0.8, 1];
    let checked = 0;
    for (const a0 of avs)
      for (const a1 of avs)
        for (const a2 of avs)
          for (const s0 of scores)
            for (const s1 of scores)
              for (const s2 of scores) {
                const av = [a0, a1, a2];
                const { mass } = chart(av, [s0, s1, s2]);
                const capacity = av.reduce((s, a) => s + a * CAP, 0);
                expect(mass).toBeCloseTo(Math.min(SLOT, capacity), 6);
                checked++;
              }
    expect(checked).toBe(8 ** 3 * 5 ** 3);
  });

  it("never puts anyone above the cap", () => {
    for (const av of [[1, 1], [0.1, 1], [0.05, 0.05, 0.05], [0.5, 0.5, 0.5, 0.5]]) {
      const { shares } = chart(av, av.map((_, i) => 1 - i * 0.1));
      for (const s of shares) expect(s).toBeLessThanOrEqual(CAP + 1e-12);
    }
  });

  it("leaves an unavailable keeper at zero rather than dividing by it", () => {
    const { shares, mass } = chart([1, 0], [0.2, 1]);
    expect(shares[1]).toBe(0);
    expect(Number.isFinite(mass)).toBe(true);
    expect(mass).toBeCloseTo(SLOT, 6);
  });
});
