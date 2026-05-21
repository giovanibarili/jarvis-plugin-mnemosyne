import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "../../../config.default.json");

async function loadConfig(): Promise<any> {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

describe("Feature flag — pipeline.v12_enabled", () => {
  it("pipeline.v12_enabled defaults to false in config.default.json", async () => {
    const config = await loadConfig();
    expect(config.pipeline).toBeDefined();
    expect(config.pipeline.v12_enabled).toBe(false);
  });

  it("all v12 config sections are present", async () => {
    const config = await loadConfig();
    expect(config.triage_v12).toBeDefined();
    expect(config.classify_v12).toBeDefined();
    expect(config.categories_v12).toBeDefined();
    expect(config.relate_v12).toBeDefined();
  });

  it("v12 sub-fields have the expected shape", async () => {
    const config = await loadConfig();
    // triage
    expect(typeof config.triage_v12.model).toBe("string");
    // classify
    expect(typeof config.classify_v12.model).toBe("string");
    expect(typeof config.classify_v12.max_candidates_per_turn).toBe("number");
    // categories
    expect(typeof config.categories_v12.new_category_min_confidence).toBe("number");
    expect(typeof config.categories_v12.new_category_recurrence_window_days).toBe("number");
    expect(typeof config.categories_v12.new_category_recurrence_min_occurrences).toBe("number");
    expect(typeof config.categories_v12.pending_path).toBe("string");
    expect(typeof config.categories_v12.categories_dir).toBe("string");
    // relate
    expect(typeof config.relate_v12.model).toBe("string");
    expect(typeof config.relate_v12.top_k).toBe("number");
    expect(typeof config.relate_v12.similarity_threshold).toBe("number");
    expect(typeof config.relate_v12.judge_cap_per_memory).toBe("number");
    expect(typeof config.relate_v12.intra_turn_max_pairs).toBe("number");
  });
});
