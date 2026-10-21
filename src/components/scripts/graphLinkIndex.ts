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

/** Project a file graph through its currently visible aggregation members.
 * Context may follow visible paths, but cannot make a hidden direct member visible.
 * Treat direction as irrelevant for reachability, while retaining directed edges.
 */
export function projectLocalGraph<N extends { id: string }, L extends {
  source: N; target: N; sourceField?: string
}>(center: string, displayed: N[], displayedLinks: L[], context: N[], rawLinks: L[]) {
  const contextIds = new Set(context.map(node => node.id))
  const available = new Map([...context, ...displayed].map(node => [node.id, node]))
  const adjacency = new Map<string, string[]>()
  const links: L[] = []
  const seenEdges = new Set<string>()
  for (const link of [...displayedLinks, ...rawLinks.filter(link =>
    contextIds.has(link.source.id) || contextIds.has(link.target.id))]) {
    const { source, target } = link
    if (!available.has(source.id) || !available.has(target.id)) continue
    const key = JSON.stringify([source.id, target.id, link.sourceField])
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    links.push(link)
    for (const [a, b] of [[source.id, target.id], [target.id, source.id]]) {
      const neighbors = adjacency.get(a) ?? []
      neighbors.push(b)
      adjacency.set(a, neighbors)
    }
  }
  const reached = new Set<string>()
  const queue = available.has(center) ? [center] : []
  if (queue.length) reached.add(center)
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  const shown = new Set(displayed.map(node => node.id))
  return {
    nodes: [...displayed.filter(node => reached.has(node.id)),
      ...queue.filter(id => contextIds.has(id) && !shown.has(id)).map(id => available.get(id)!)],
    links: links.filter(link => reached.has(link.source.id) && reached.has(link.target.id)),
    // Breadth first order keeps each context node's prerequisite ahead of it in a batch.
    context: queue.filter(id => contextIds.has(id)).map(id => available.get(id)!),
  }
}
