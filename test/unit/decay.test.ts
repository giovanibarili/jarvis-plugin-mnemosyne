import { describe, it, expect } from "vitest";
import { forgetScore, shouldDecay, type DecayConfig } from "../../lib/decay";
import type { Memory } from "../../lib/types";

const DAY = 24 * 60 * 60 * 1000;

function mkMem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "test-id",
    category: "preference",
    title: "test",
    content: "test content",
    tags: [],
    project: null,
    confidence: 0.5,
    reinforcements: 0,
    visibility: "open",
    pinned: false,
    created_at: Date.now(),
    last_accessed: Date.now(),
    source_session: "main",
    promoted_at: null,
    ...overrides,
  };
}

describe("decay", () => {
  it("memory with low confidence + 0 reinforcements decays at 30 days (threshold 60)", () => {
    const now = Date.now();
    const mem = mkMem({
      confidence: 0.5,
      reinforcements: 0,
      last_accessed: now - 30 * DAY,
    });
    // forgetScore = 30 / (0.5 * 1 * 1) = 60
    expect(forgetScore(mem, now)).toBeCloseTo(60, 1);

    const config: DecayConfig = { threshold: 50, categoryMultipliers: {} };
    expect(shouldDecay(mem, config, now)).toBe(true);

    const stricter: DecayConfig = { threshold: 70, categoryMultipliers: {} };
    expect(shouldDecay(mem, stricter, now)).toBe(false);
  });

  it("high reinforcements resist decay", () => {
    const now = Date.now();
    // 5 reinforcements, conf 0.9, age 100 days
    // forgetScore = 100 / (0.9 * 6 * 1) = 18.5
    const mem = mkMem({
      confidence: 0.9,
      reinforcements: 5,
      last_accessed: now - 100 * DAY,
    });
    expect(forgetScore(mem, now)).toBeCloseTo(18.5, 1);

    const config: DecayConfig = { threshold: 60, categoryMultipliers: {} };
    expect(shouldDecay(mem, config, now)).toBe(false);
  });

  it("pinned never decays even when forgetScore is high", () => {
    const now = Date.now();
    const mem = mkMem({
      confidence: 0.1,
      reinforcements: 0,
      last_accessed: now - 365 * DAY,
      pinned: true,
    });
    // forgetScore = 365 / (0.1 * 1) = 3650, very high
    expect(forgetScore(mem, now)).toBeGreaterThan(1000);

    const config: DecayConfig = { threshold: 60, categoryMultipliers: {} };
    expect(shouldDecay(mem, config, now)).toBe(false);
  });

  it("promoted memories never decay (long-term is immortal)", () => {
    const now = Date.now();
    const mem = mkMem({
      confidence: 0.1,
      reinforcements: 0,
      last_accessed: now - 365 * DAY,
      promoted_at: now - 100 * DAY,
    });
    expect(forgetScore(mem, now)).toBeGreaterThan(1000);

    const config: DecayConfig = { threshold: 60, categoryMultipliers: {} };
    expect(shouldDecay(mem, config, now)).toBe(false);
  });

  it("category multiplier increases resistance for preferred categories", () => {
    const now = Date.now();
    const mem = mkMem({
      category: "preference",
      confidence: 0.5,
      reinforcements: 0,
      last_accessed: now - 30 * DAY,
    });
    // Without multiplier: 60. With 2x multiplier: 30.
    expect(forgetScore(mem, now)).toBeCloseTo(60, 1);
    expect(forgetScore(mem, now, { preference: 2 })).toBeCloseTo(30, 1);

    const config: DecayConfig = {
      threshold: 50,
      categoryMultipliers: { preference: 2 },
    };
    // With 2x multiplier, score 30 < threshold 50 → no decay
    expect(shouldDecay(mem, config, now)).toBe(false);
  });
});
