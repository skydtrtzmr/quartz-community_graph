/**
 * 维度子图（`graph/dimensions/**`）在运行期的裁剪规则。
 *
 * ⚠️ 语义必须与 `aggregation-page-pro` 的列表脚本（其 `scripts/aggregationPage.inline.ts`）
 * 保持一致 —— 两个插件之间没有共享包，只能各自实现，故两边都要有单测覆盖同一组用例：
 *
 * - `scope`：**前缀匹配**（`?scope=项目` 命中 `项目/` 下的实体）；`"/"` 表示顶级目录（slug 不含 `/`）
 * - `context`：只保留来源节点本身，或与它**直接相连（一跳）**的实体
 * - 两者都不给：原样返回（产物本身就是「命中实体 + 一跳邻居」）
 *
 * 裁剪口径：先算出「可见的命中实体」，再保留它们的邻居；被筛掉的命中实体会连同其邻居一起消失，
 * 避免出现「已经按范围筛掉了，却还在图上当上下文」的误导。
 */

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
}

export interface DimensionGraphFilterResult {
  nodes: Record<string, unknown>
  edges: DimensionEdge[]
  matched: DimensionMatch[]
}

export function normalizeScope(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim()
  if (trimmed === "" || trimmed === "/") return trimmed === "/" ? "/" : ""
  return trimmed.replace(/^\/+|\/+$/g, "")
}

export function normalizeSlug(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\/index$/, "").replace(/\/+$/, "")
}

/** scope 语义：前缀匹配；`/` 表示顶级目录 */
export function inScope(slug: string, scope: string): boolean {
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

/**
 * 按 scope/context 裁剪维度子图。
 * 无参数时原样返回（不复制对象，省一次大对象拷贝）。
 */
export function filterDimensionGraph(
  graph: DimensionGraphLike,
  params: DimensionFilterParams,
): DimensionGraphFilterResult {
  const scope = normalizeScope(params.scope)
  const context = normalizeSlug(params.context)
  if (scope === "" && context === "") {
    return { nodes: graph.nodes, edges: graph.edges, matched: graph.matched ?? [] }
  }

  const matched = graph.matched ?? []
  const visibleMatched = matched.filter(
    (match) => inScope(match.slug, scope) && connectedTo(graph.edges, context, match.slug),
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
