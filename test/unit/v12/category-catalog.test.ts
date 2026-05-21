import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CategoryCatalog } from "../../../lib/v12/category-catalog";

describe("CategoryCatalog", () => {
  let seedDir: string;
  let dynDir: string;

  beforeEach(async () => {
    const root = join(tmpdir(), `cat-${Date.now()}-${Math.random()}`);
    seedDir = join(root, "prompts");
    dynDir = join(root, "categories");
    await fs.mkdir(seedDir, { recursive: true });
    await fs.mkdir(dynDir, { recursive: true });
  });

  it("loads canonical categories from seed dir", async () => {
    await fs.writeFile(join(seedDir, "extract-preference.md"), "---\ndescription: User preferences\nhint: explicit I like/prefer/enjoy\n---\nbody");
    await fs.writeFile(join(seedDir, "extract-glossary.md"), "---\ndescription: New term defined\nhint: \"X means Y\"\n---\nbody");
    const cat = new CategoryCatalog(seedDir, dynDir);
    await cat.load();
    expect(cat.has("preference")).toBe(true);
    expect(cat.has("glossary")).toBe(true);
    expect(cat.get("preference")!.description).toContain("User preferences");
  });

  it("adds dynamic categories from runtime dir", async () => {
    await fs.writeFile(join(dynDir, "ux-pattern.md"), "---\ndescription: UX recurrence\nhint: user picks UX\n---\ntpl");
    const cat = new CategoryCatalog(seedDir, dynDir);
    await cat.load();
    expect(cat.has("ux-pattern")).toBe(true);
  });

  it("materializes a new category to dynDir and adds to live catalog", async () => {
    const cat = new CategoryCatalog(seedDir, dynDir);
    await cat.load();
    await cat.materialize({
      id: "design-rule",
      description: "Design constraint",
      hint: "user states a design rule",
      extractor_template: "you are an extractor",
    });
    expect(cat.has("design-rule")).toBe(true);
    const onDisk = await fs.readFile(join(dynDir, "design-rule.md"), "utf8");
    expect(onDisk).toContain("Design constraint");
    expect(onDisk).toContain("you are an extractor");
  });

  it("renders all categories as a prompt block", async () => {
    await fs.writeFile(join(seedDir, "extract-preference.md"), "---\ndescription: prefs\nhint: I like X\n---\n");
    const cat = new CategoryCatalog(seedDir, dynDir);
    await cat.load();
    const block = cat.renderCatalog();
    expect(block).toContain("preference");
    expect(block).toContain("prefs");
  });

  it("ignores non-extract-*.md files in seed dir", async () => {
    await fs.writeFile(join(seedDir, "triage.md"), "---\ndescription: triage\nhint: h\n---\n");
    await fs.writeFile(join(seedDir, "extract-preference.md"), "---\ndescription: prefs\nhint: h\n---\n");
    const cat = new CategoryCatalog(seedDir, dynDir);
    await cat.load();
    expect(cat.has("triage")).toBe(false);
    expect(cat.has("preference")).toBe(true);
  });
});
