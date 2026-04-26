import { promises as fs } from "fs";
import { join, dirname } from "path";
import matter from "gray-matter";
import { stringify as yamlStringify } from "yaml";
import type { Memory, Category, Visibility } from "./types";
import { titleToSlug } from "./slug";

export type Layer = "short" | "long";

export interface ListFilter {
  category?: Category;
  layer?: Layer;
  visibility?: Visibility;
  pinned?: boolean;
}

export class MarkdownStore {
  constructor(private rootDir: string) {}

  private filePath(layer: Layer, category: Category, slug: string): string {
    return join(this.rootDir, layer, category, `${slug}.md`);
  }

  private layerOf(memory: Memory): Layer {
    return memory.promoted_at ? "long" : "short";
  }

  async write(memory: Memory): Promise<void> {
    const layer = this.layerOf(memory);
    const slug = titleToSlug(memory.title, memory.id);
    const path = this.filePath(layer, memory.category, slug);
    await fs.mkdir(dirname(path), { recursive: true });

    const frontmatter = {
      id: memory.id,
      category: memory.category,
      title: memory.title,
      tags: memory.tags,
      project: memory.project,
      confidence: memory.confidence,
      reinforcements: memory.reinforcements,
      visibility: memory.visibility,
      pinned: memory.pinned,
      created_at: new Date(memory.created_at).toISOString(),
      last_accessed: new Date(memory.last_accessed).toISOString(),
      source_sessions: [memory.source_session],
      promoted_at: memory.promoted_at ? new Date(memory.promoted_at).toISOString() : null,
    };

    const fileContent = `---\n${yamlStringify(frontmatter)}---\n\n${memory.content}\n`;
    await fs.writeFile(path, fileContent, "utf-8");
  }

  async read(id: string): Promise<Memory | null> {
    const all = await this.list({});
    return all.find((m) => m.id === id) ?? null;
  }

  async list(filter: ListFilter): Promise<Memory[]> {
    const layers: Layer[] = filter.layer ? [filter.layer] : ["short", "long"];
    const memories: Memory[] = [];

    for (const layer of layers) {
      const layerDir = join(this.rootDir, layer);
      try {
        await fs.access(layerDir);
      } catch {
        continue;
      }
      const categories = await fs.readdir(layerDir);
      for (const cat of categories) {
        if (filter.category && cat !== filter.category) continue;
        const catDir = join(layerDir, cat);
        const files = await fs.readdir(catDir);
        for (const f of files) {
          if (!f.endsWith(".md")) continue;
          const raw = await fs.readFile(join(catDir, f), "utf-8");
          const { data, content } = matter(raw);
          const mem: Memory = {
            id: data.id,
            category: data.category,
            title: data.title,
            content: content.trim(),
            tags: data.tags ?? [],
            project: data.project ?? null,
            confidence: data.confidence ?? 0.5,
            reinforcements: data.reinforcements ?? 0,
            visibility: data.visibility ?? "open",
            pinned: data.pinned ?? false,
            created_at: new Date(data.created_at).getTime(),
            last_accessed: new Date(data.last_accessed).getTime(),
            source_session: (data.source_sessions ?? ["unknown"])[0],
            promoted_at: data.promoted_at ? new Date(data.promoted_at).getTime() : null,
          };
          if (filter.visibility && mem.visibility !== filter.visibility) continue;
          if (filter.pinned !== undefined && mem.pinned !== filter.pinned) continue;
          memories.push(mem);
        }
      }
    }
    return memories;
  }

  async delete(id: string): Promise<void> {
    const mem = await this.read(id);
    if (!mem) return;
    const layer = this.layerOf(mem);
    const slug = titleToSlug(mem.title, mem.id);
    const path = this.filePath(layer, mem.category, slug);
    await fs.unlink(path);
  }

  async promote(id: string): Promise<void> {
    const mem = await this.read(id);
    if (!mem) throw new Error(`Memory ${id} not found`);
    if (mem.promoted_at) return;
    const oldPath = this.filePath("short", mem.category, titleToSlug(mem.title, mem.id));
    mem.promoted_at = Date.now();
    await this.write(mem);
    await fs.unlink(oldPath);
  }
}
