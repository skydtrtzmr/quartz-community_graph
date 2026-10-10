export const DEFAULT_MAX_VISIBLE_NODES = 500
/** 「+N」占位节点每次点击加载的节点数（graph.loadBatchSize 的默认值） */
export const DEFAULT_LOAD_BATCH_SIZE = 100

export function resolveMaxVisibleNodes(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_VISIBLE_NODES
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.maxVisibleNodes must be a positive integer")
  }
  return value as number
}

export function resolveLoadBatchSize(value: unknown): number {
  if (value === undefined) return DEFAULT_LOAD_BATCH_SIZE
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.loadBatchSize must be a positive integer")
  }
  return value as number
}

type Identified = { id: string }
type Link<N> = { source: N; target: N }

export interface LimitedNodes<N, L> {
  /** 本批进入模拟/渲染的节点 */
  nodes: N[]
  /** 两端都可见的边 */
  links: L[]
  /**
   * 超出首批预算的文件节点（按比较器排序后的保序队列）。
   * **不丢弃**——调用方把它折叠进「+N」占位节点，点击后经 takeOverflowBatch 分批加载。
   */
  overflow: N[]
  /** 与溢出节点相关的边（至少一端在溢出集）；加载溢出节点时按两端可见性补齐 */
  overflowLinks: L[]
  /** = overflow.length，保留字段名兼容旧调用 */
  omitted: number
}

/**
 * 首批预算：按文件节点数给 proposed 划出「首批可见」与「溢出」两段。
 * 与旧版的差异：溢出段不再丢弃，而是由调用方折叠成「+N」占位节点分批加载。
 */
export function limitVisibleNodes<N extends Identified, L extends Link<N>>(
  existing: readonly N[],
  proposed: readonly N[],
  links: readonly L[],
  maximum: number,
  isFile: (node: N) => boolean,
  compare: (a: N, b: N) => number,
): LimitedNodes<N, L> {
  const existingIds = new Set(existing.map((node) => node.id))
  const used = existing.filter(isFile).length
  const remaining = Math.max(0, maximum - used)
  const fresh = proposed.filter((node) => !existingIds.has(node.id))
  const files = fresh.filter(isFile).sort(compare)
  const selectedFiles = new Set(files.slice(0, remaining).map((node) => node.id))
  const overflowFiles = files.slice(remaining)
  const overflowIds = new Set(overflowFiles.map((node) => node.id))
  const nodes = fresh.filter((node) => !isFile(node) || selectedFiles.has(node.id))
  const visibleIds = new Set([...existingIds, ...nodes.map((node) => node.id)])
  // 溢出相关边：至少一端在溢出集。加载溢出节点后，两端均可见的边由调用方补回。
  const overflowLinks = links.filter(
    (link) => overflowIds.has(link.source.id) || overflowIds.has(link.target.id),
  )
  return {
    nodes,
    links: links.filter((link) => visibleIds.has(link.source.id) && visibleIds.has(link.target.id)),
    overflow: overflowFiles,
    overflowLinks,
    omitted: overflowFiles.length,
  }
}
