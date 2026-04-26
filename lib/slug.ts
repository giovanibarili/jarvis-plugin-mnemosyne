import slugify from "slugify";

export function titleToSlug(title: string, uuid?: string): string {
  // Pre-replace separator-like punctuation with spaces so words remain split
  // (default slugify "strict" mode would otherwise concatenate `try/catch` -> `trycatch`,
  // and replace `&` with `and`)
  const normalized = title.replace(/[/\\&]+/g, " ");
  const base = slugify(normalized, { lower: true, strict: true });
  if (uuid) {
    const short = uuid.split("-")[0];
    return `${base}-${short}`;
  }
  return base;
}
