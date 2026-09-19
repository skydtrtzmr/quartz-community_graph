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
}
