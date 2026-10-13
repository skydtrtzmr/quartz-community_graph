/** Index incident edges once; keep original ordering, direction and parallel edges. */
export function indexGraphLinks<L extends { source: { id: string }; target: { id: string } }>(links: L[]) {
  const byNode = new Map<string, number[]>()
  links.forEach((link, index) => {
    for (const id of new Set([link.source.id, link.target.id])) {
      const indices = byNode.get(id) ?? []
      indices.push(index)
      byNode.set(id, indices)
    }
  })
  return {
    incident(ids: Iterable<string>): L[] {
      const indices = new Set<number>()
      for (const id of ids) for (const index of byNode.get(id) ?? []) indices.add(index)
      return [...indices].sort((a, b) => a - b).map((index) => links[index])
    },
  }
}
