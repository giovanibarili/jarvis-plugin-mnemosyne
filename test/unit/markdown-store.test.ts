import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { titleToSlug } from "../../lib/slug";
import { MarkdownStore } from "../../lib/markdown-store";
import type { Memory } from "../../lib/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuid } from "uuid";

describe("titleToSlug", () => {
  it("converts title with spaces to kebab-case", () => {
    expect(titleToSlug("Sir prefers Effect-TS")).toBe("sir-prefers-effect-ts");
  });

  it("strips special chars", () => {
    expect(titleToSlug("Use try/catch & throw!")).toBe("use-try-catch-throw");
  });

  it("appends short uuid suffix when collision", () => {
    const a = titleToSlug("Test", "abc12345-...");
    expect(a).toBe("test-abc12345");
  });
});

describe("MarkdownStore", () => {
  let dir: string;
  let store: MarkdownStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-test-"));
    store = new MarkdownStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes memory to short/<category>/<slug>.md", async () => {
    const mem: Memory = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      category: "preference",
      title: "Sir prefers Effect-TS",
      content: "Sir prefers Effect-TS for TS error handling",
      tags: ["typescript", "effect-ts"],
      project: null,
      confidence: 0.85,
      reinforcements: 1,
      visibility: "open",
      pinned: false,
      created_at: Date.now(),
      last_accessed: Date.now(),
      source_session: "main",
      promoted_at: null,
    };
    await store.write(mem);
    const read = await store.read(mem.id);
    expect(read).toBeDefined();
    expect(read?.title).toBe(mem.title);
    expect(read?.tags).toEqual(["typescript", "effect-ts"]);
  });

  it("lists memories by category", async () => {
    const a: Memory = { id: uuid(), category: "preference", title: "A", content: "a", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null };
    const b: Memory = { ...a, id: uuid(), title: "B", content: "b" };
    await store.write(a);
    await store.write(b);
    const list = await store.list({ category: "preference", layer: "short" });
    expect(list.length).toBe(2);
  });

  it("moves memory from short to long on promote", async () => {
    const id = uuid();
    const mem: Memory = { id, category: "preference", title: "x", content: "y", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null };
    await store.write(mem);
    await store.promote(id);
    const longList = await store.list({ layer: "long" });
    const shortList = await store.list({ layer: "short" });
    expect(longList.find((m) => m.id === id)).toBeDefined();
    expect(shortList.find((m) => m.id === id)).toBeUndefined();
  });

  it("deletes memory atomically", async () => {
    const id = uuid();
    const mem: Memory = { id, category: "preference", title: "x", content: "y", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null };
    await store.write(mem);
    await store.delete(id);
    expect(await store.read(id)).toBeNull();
  });

  it("rebuilds memory list from filesystem", async () => {
    const ids = Array.from({ length: 5 }, () => uuid());
    for (const id of ids) {
      await store.write({ id, category: "preference", title: id, content: "c", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null });
    }
    const all = await store.list({});
    expect(all.length).toBe(5);
  });
});
