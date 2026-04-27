import { describe, it, expect } from "vitest";
import { preflight, MnemosyneBootError } from "../../lib/preflight";

describe("preflight", () => {
  it("either passes or throws MnemosyneBootError with structured failures", async () => {
    try {
      await preflight();
      // If it passed, all deps are present on this host — fine
      expect(true).toBe(true);
    } catch (e) {
      // Otherwise, must be a structured boot error (no unexpected throws)
      expect(e).toBeInstanceOf(MnemosyneBootError);
      const err = e as MnemosyneBootError;
      expect(err.failures.length).toBeGreaterThan(0);
      for (const f of err.failures) {
        expect(typeof f.check).toBe("string");
        expect(typeof f.reason).toBe("string");
      }
    }
  }, 30000);

  it("MnemosyneBootError carries failures array", () => {
    const err = new MnemosyneBootError([
      { check: "docker", reason: "not found", action: "install" },
    ]);
    expect(err.name).toBe("MnemosyneBootError");
    expect(err.failures).toHaveLength(1);
    expect(err.message).toContain("preflight failed");
  });
});
