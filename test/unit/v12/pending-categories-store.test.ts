import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PendingCategoriesStore } from "../../../lib/v12/pending-categories-store";

describe("PendingCategoriesStore", () => {
  let path: string;
  beforeEach(async () => {
    path = join(tmpdir(), `pending-${Date.now()}-${Math.random()}.json`);
  });
  afterEach(async () => {
    try { await fs.unlink(path); } catch {}
  });

  it("returns null when slug is not present", async () => {
    const s = new PendingCategoriesStore(path);
    await s.load();
    expect(s.get("ux-pattern")).toBeNull();
  });

  it("registers a new slug with occurrences=1", async () => {
    const s = new PendingCategoriesStore(path);
    await s.load();
    s.register({
      id: "ux-pattern",
      description: "UX recurrence",
      hint: "user describes UX choice",
      extractor_template: "tpl",
    });
    await s.save();
    const entry = s.get("ux-pattern");
    expect(entry).not.toBeNull();
    expect(entry!.occurrences).toBe(1);
  });

  it("increments occurrences when slug seen again within 7d", async () => {
    const s = new PendingCategoriesStore(path);
    await s.load();
    s.register({ id: "ux-pattern", description: "d", hint: "h", extractor_template: "t" });
    s.register({ id: "ux-pattern", description: "d", hint: "h", extractor_template: "t" });
    expect(s.get("ux-pattern")!.occurrences).toBe(2);
  });

  it("resets occurrences when last_seen older than 7d", async () => {
    const s = new PendingCategoriesStore(path);
    await s.load();
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(
      path,
      JSON.stringify({
        "ux-pattern": {
          slug: "ux-pattern",
          description: "d", hint: "h", extractor_template: "t",
          occurrences: 3,
          first_seen_ts: oldTs,
          last_seen_ts: oldTs,
        },
      }),
    );
    await s.load();
    s.register({ id: "ux-pattern", description: "d", hint: "h", extractor_template: "t" });
    expect(s.get("ux-pattern")!.occurrences).toBe(1);
  });

  it("removes entry", async () => {
    const s = new PendingCategoriesStore(path);
    await s.load();
    s.register({ id: "x", description: "d", hint: "h", extractor_template: "t" });
    s.remove("x");
    expect(s.get("x")).toBeNull();
  });

  it("purges entries older than 30d with <2 occurrences on gc()", async () => {
    const s = new PendingCategoriesStore(path);
    const oldTs = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(
      path,
      JSON.stringify({
        "stale": { slug: "stale", description: "d", hint: "h", extractor_template: "t",
                   occurrences: 1, first_seen_ts: oldTs, last_seen_ts: oldTs },
        "fresh": { slug: "fresh", description: "d", hint: "h", extractor_template: "t",
                   occurrences: 1, first_seen_ts: new Date().toISOString(), last_seen_ts: new Date().toISOString() },
      }),
    );
    await s.load();
    const purged = s.gc({ maxAgeDays: 30, minOccurrencesToKeep: 2 });
    expect(purged).toEqual(["stale"]);
    expect(s.get("stale")).toBeNull();
    expect(s.get("fresh")).not.toBeNull();
  });
});
