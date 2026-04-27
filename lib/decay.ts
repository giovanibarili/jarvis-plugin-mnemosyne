import type { Memory } from "./types";

export interface DecayConfig {
  threshold: number;
  categoryMultipliers: Record<string, number>;
}

/**
 * Score-based forgetting (D7).
 *
 * forgetScore = age_days / (confidence * (1 + reinforcements) * categoryMult)
 *
 * Higher score = more decayable. Increases with age, reduces with confidence
 * and reinforcement count. categoryMult lets some categories (e.g. preferences)
 * resist decay more than others.
 */
export function forgetScore(
  memory: Memory,
  now: number,
  multipliers: Record<string, number> = {}
): number {
  const ageDays = (now - memory.last_accessed) / (1000 * 60 * 60 * 24);
  const baseImportance = memory.confidence * (1 + memory.reinforcements);
  const mult = multipliers[memory.category] ?? 1;
  return ageDays / (baseImportance * mult);
}

/**
 * Decay gate. Promoted (long-term) and pinned memories are immortal — they
 * never decay regardless of score. Everything else decays once forgetScore
 * exceeds the configured threshold.
 */
export function shouldDecay(
  memory: Memory,
  config: DecayConfig,
  now: number
): boolean {
  if (memory.promoted_at !== null) return false;
  if (memory.pinned) return false;
  return forgetScore(memory, now, config.categoryMultipliers) > config.threshold;
}
