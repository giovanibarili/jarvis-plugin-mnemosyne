/**
 * seed-v12-catalog.ts
 * One-time utility: loads the CategoryCatalog from existing extract-*.md prompts
 * and reports what categories are available for v1.2 classification.
 *
 * Usage: npx tsx scripts/seed-v12-catalog.ts
 */
import { CategoryCatalog } from "../lib/v12/category-catalog";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = join(__dirname, "..");
  const seedDir = join(pluginRoot, "prompts");
  const dynDir = join(homedir(), ".jarvis", "mnemosyne", "categories");

  const catalog = new CategoryCatalog(seedDir, dynDir);
  await catalog.load();

  const entries = catalog.list();
  console.log(`\nCategory catalog loaded — ${entries.length} categories:\n`);
  for (const e of entries) {
    const badge = e.source === "dynamic" ? "[dynamic]" : "[seed]   ";
    console.log(`  ${badge} ${e.id.padEnd(28)} ${e.description}`);
  }
  console.log(`\nSeed dir:    ${seedDir}`);
  console.log(`Dynamic dir: ${dynDir}`);
}

main().catch((e) => {
  console.error("seed-v12-catalog failed:", e);
  process.exit(1);
});
