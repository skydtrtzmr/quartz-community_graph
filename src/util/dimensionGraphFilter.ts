/**
 * 维度子图（`graph/dimensions/**`）在运行期的裁剪规则。
 *
 * ⚠️ 语义必须与 `aggregation-page-pro` 的列表脚本（其 `scripts/aggregationPage.inline.ts`）
 * 保持一致 —— 两个插件之间没有共享包，只能各自实现，故两边都要有单测覆盖同一组用例：
 *
 * - `scope`：**前缀匹配**（`?scope=项目` 命中 `项目/` 下的实体）；`"/"` 表示顶级目录（slug 不含 `/`）
 * - `context`：只保留来源节点本身，或与它**直接相连（一跳）**的实体
 * - `filter`：祖先维度约束（`?filter=阶段:规划中,type:产品研发`），命中实体须满足**全部**字段值
 * - 都不给：原样返回（产物本身就是「命中实体 + 一跳邻居」）
 *
 * 裁剪口径：先算出「可见的命中实体」，再保留它们的邻居；被筛掉的命中实体会连同其邻居一起消失，
 * 避免出现「已经按范围筛掉了，却还在图上当上下文」的误导。
 */

import { isFolderIndexSlug } from "./aggregation"

export interface DimensionEdge {
  source: string
  target: string
  sourceField?: string
}

export interface DimensionMatch {
  slug: string
  scope: string
}

export interface DimensionGraphLike {
  nodes: Record<string, unknown>
  edges: DimensionEdge[]
  matched?: DimensionMatch[]
}

export interface DimensionFilterParams {
  scope?: string
  context?: string
  /** 祖先维度约束：`字段:值` 逗号分隔（如 `阶段:规划中,type:产品研发`） */
  filter?: string
}

export interface DimensionGraphFilterResult {
  nodes: Record<string, unknown>
  edges: DimensionEdge[]
  matched: DimensionMatch[]
}

export interface DimensionFilterEntry {
  field: string
  value: string
}

export function normalizeScope(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim()
  if (trimmed === "" || trimmed === "/") return trimmed === "/" ? "/" : ""
  return trimmed.replace(/^\/+|\/+$/g, "")
}

export function normalizeSlug(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\/index$/, "").replace(/\/+$/, "")
}

/** scope 语义：前缀匹配；`/` 表示顶级目录。文件夹索引页（目录自身）不计入任何 scope */
export function inScope(slug: string, scope: string): boolean {
  if (isFolderIndexSlug(slug)) return false
  if (scope === "") return true
  if (scope === "/") return !slug.includes("/")
  return slug.startsWith(scope + "/")
}

/** context 语义：来源节点本身，或与它直接相连（一跳）的实体 */
export function connectedTo(edges: DimensionEdge[], context: string, slug: string): boolean {
  if (context === "") return true
  const target = normalizeSlug(slug)
  if (target === context) return true
  return edges.some((edge) => {
    const source = normalizeSlug(edge.source)
    const to = normalizeSlug(edge.target)
    return (source === context && to === target) || (to === context && source === target)
  })
}

/** 解析 `filter` 参数：`字段:值` 逗号分隔；容错（空段 / 缺冒号 / 空字段值跳过） */
export function parseFilter(raw: string | undefined | null): DimensionFilterEntry[] {
  const s = (raw ?? "").trim()
  if (s === "") return []
  const entries: DimensionFilterEntry[] = []
  for (const part of s.split(",")) {
    const idx = part.indexOf(":")
    if (idx <= 0) continue
    const field = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (field.length === 0 || value.length === 0) continue
    entries.push({ field, value })
  }
  return entries
}

/** 取 frontmatter 字段的第一个值（与 aggregation-pro 的 `firstValue` 口径一致：数组取首个） */
export function firstValue(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return null
}

/** 节点详情是否满足所有 filter 约束（缺 frontmatter / 字段值不匹配 → 不满足） */
function matchesFilter(details: unknown, entries: DimensionFilterEntry[]): boolean {
  if (entries.length === 0) return true
  const fm = (details as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter
  for (const entry of entries) {
    if (firstValue(fm?.[entry.field]) !== entry.value) return false
  }
  return true
}

/** 按 slug 取节点详情（先精确 key，再回退去掉 `/index` 后缀的规范化 key） */
function nodeDetailsOf(graph: DimensionGraphLike, slug: string): unknown {
  const direct = graph.nodes[slug]
  if (direct !== undefined) return direct
  return graph.nodes[normalizeSlug(slug)]
}

/**
 * 按 scope/context/filter 裁剪维度子图。
 * 无参数时原样返回（不复制对象，省一次大对象拷贝）。
 */
export function filterDimensionGraph(
  graph: DimensionGraphLike,
  params: DimensionFilterParams,
): DimensionGraphFilterResult {
  const scope = normalizeScope(params.scope)
  const context = normalizeSlug(params.context)
  const filterEntries = parseFilter(params.filter)
  if (scope === "" && context === "" && filterEntries.length === 0) {
    return { nodes: graph.nodes, edges: graph.edges, matched: graph.matched ?? [] }
  }

  const matched = graph.matched ?? []
  const visibleMatched = matched.filter(
    (match) =>
      inScope(match.slug, scope) &&
      connectedTo(graph.edges, context, match.slug) &&
      matchesFilter(nodeDetailsOf(graph, match.slug), filterEntries),
  )
  const visibleSlugs = new Set(visibleMatched.map((match) => match.slug))
  const hiddenMatched = new Set(
    matched.map((match) => match.slug).filter((slug) => !visibleSlugs.has(slug)),
  )

  // 保留可见命中实体的邻居（一跳），但不把被筛掉的命中实体留作上下文
  const keptSlugs = new Set(visibleSlugs)
  for (const edge of graph.edges) {
    const source = normalizeSlug(edge.source)
    const target = normalizeSlug(edge.target)
    if (visibleSlugs.has(source) && !hiddenMatched.has(target)) keptSlugs.add(target)
    if (visibleSlugs.has(target) && !hiddenMatched.has(source)) keptSlugs.add(source)
  }

  const nodes: Record<string, unknown> = {}
  for (const [slug, details] of Object.entries(graph.nodes)) {
    if (keptSlugs.has(normalizeSlug(slug))) nodes[slug] = details
  }

  const edges = graph.edges.filter(
    (edge) => keptSlugs.has(normalizeSlug(edge.source)) && keptSlugs.has(normalizeSlug(edge.target)),
  )

  return { nodes, edges, matched: visibleMatched }
}
