import type { FilePath, FullSlug, SimpleSlug } from "@quartz-community/types"

/**
 * contentIndex.json 单条目的形状（与 content-index-pro 产出一致，含 frontmatter）。
 * 图谱预计算需要 title / links / tags / frontmatter 四类字段。
 */
export type ContentDetails = {
  slug: FullSlug
  filePath: FilePath
  title: string
  links: SimpleSlug[]
  tags: string[]
  content: string
  frontmatter?: Record<string, unknown>
  virtualNode?: boolean
}

/**
 * 构建期 `ProcessedContent` 中我们需要的字段（其余由其他插件注入，类型上做最小声明）。
 */
export type IndexableFileData = {
  slug?: FullSlug
  relativePath?: FilePath
  links?: SimpleSlug[]
  text?: string
  frontmatter?: Record<string, unknown>
  virtualNode?: boolean
}

/** Dimension pages and tag nodes are intentional graph entities, not broken-link placeholders. */
function isGraphSystemSlug(slug: string): boolean {
  return slug === "_dimensions" || slug.startsWith("_dimensions/") || slug.startsWith("tags/")
}

/** Shared by full/incremental emitters and browser fallback/precomputed local data. */
export function filterGraphContent<K extends string, T extends {
  filePath?: string
  links?: K[]
  virtualNode?: boolean
  frontmatter?: Record<string, unknown>
}>(index: ReadonlyMap<K, T>): Map<K, T> {
  const visible = new Map([...index].filter(([slug, entry]) => {
    if (isGraphSystemSlug(slug)) return true
    if (entry.virtualNode === true || entry.frontmatter?.virtualNode === true) return false
    // Older local JSON used an empty path for unresolved targets, without a flag.
    // Auto-generated folder index pages remain valid graph centers.
    return entry.filePath !== "" || slug === "/" || slug === "index" || slug.endsWith("/") || slug.endsWith("/index")
  }))
  return new Map([...visible].map(([slug, entry]) => [slug, {
    ...entry,
    // Drop unresolved ordinary targets too, otherwise emitters recreate them.
    links: (entry.links ?? []).filter(target => visible.has(target) || isGraphSystemSlug(target)),
  }]))
}
