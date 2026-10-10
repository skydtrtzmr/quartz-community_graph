export const DEFAULT_MAX_VISIBLE_NODES = 500

export function resolveMaxVisibleNodes(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_VISIBLE_NODES
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.maxVisibleNodes must be a positive integer")
  }
  return value as number
}

type Identified = { id: string }
type Link<N> = { source: N; target: N }

/** Apply the file budget before nodes and links enter the simulation. */
export function limitVisibleNodes<N extends Identified, L extends Link<N>>(
  existing: readonly N[],
  proposed: readonly N[],
  links: readonly L[],
  maximum: number,
  isFile: (node: N) => boolean,
  compare: (a: N, b: N) => number,
): { nodes: N[]; links: L[]; omitted: number } {
  const existingIds = new Set(existing.map((node) => node.id))
  const used = existing.filter(isFile).length
  const remaining = Math.max(0, maximum - used)
  const fresh = proposed.filter((node) => !existingIds.has(node.id))
  const files = fresh.filter(isFile).sort(compare)
  const selectedFiles = new Set(files.slice(0, remaining).map((node) => node.id))
  const nodes = fresh.filter((node) => !isFile(node) || selectedFiles.has(node.id))
  const visibleIds = new Set([...existingIds, ...nodes.map((node) => node.id)])
  return {
    nodes,
    links: links.filter((link) => visibleIds.has(link.source.id) && visibleIds.has(link.target.id)),
    omitted: Math.max(0, files.length - remaining),
  }
}
