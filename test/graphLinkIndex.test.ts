import { expect, it } from "vitest"
import { indexGraphLinks, projectLocalGraph } from "../src/components/scripts/graphLinkIndex"

it("preserves directed and parallel edges, self loops and input order when selecting group links", () => {
  const node = (id: string) => ({ id })
  const edge = (a: string, b: string) => ({ source: node(a), target: node(b) })
  const links = [edge("b", "a"), edge("a", "a"), edge("c", "d"), edge("a", "b"), edge("b", "a")]
  const index = indexGraphLinks(links)
  for (const ids of [[], ["a"], ["b", "a"], ["missing"], ["c", "a"]]) {
    const members = new Set(ids)
    expect(index.incident(ids)).toEqual(links.filter(l => members.has(l.source.id) || members.has(l.target.id)))
  }
})

it("gates downstream components behind visible aggregation members, through nested expansion and collapse", () => {
  const [center, folder, status, a, b, x, y] = ["course", "cases", "review", "a", "b", "x", "y"].map(id => ({ id }))
  const edge = (source: typeof center, target: typeof center) => ({ source, target })
  const raw = [edge(center, a), edge(center, b), edge(a, x), edge(x, y)]
  const root = edge(center, folder), branch = edge(folder, status), leaf = edge(status, a)
  const ids = (nodes: typeof center[]) => nodes.map(node => node.id)
  // x/y form a connected component of their own, so merely removing zero-degree nodes is insufficient.
  expect(ids(projectLocalGraph(center.id, [center, folder, x, y], [root, raw[3]], [x, y], raw).nodes)).toEqual(["course", "cases"])
  expect(ids(projectLocalGraph(center.id, [center, folder, status], [root, branch], [x, y], raw).nodes)).toEqual(["course", "cases", "review"])
  const expanded = projectLocalGraph(center.id, [center, folder, status, a], [root, branch, leaf], [x, y], raw)
  expect(ids(expanded.nodes)).toEqual(["course", "cases", "review", "a", "x", "y"])
  // showAggregatedNodeLinks=false: the original center link must not be restored.
  expect(expanded.links).not.toContain(raw[0])
  expect(expanded.links).toContain(raw[2])
  const collapsed = projectLocalGraph(center.id, [center, folder, status, x, y], expanded.links, [x, y], raw)
  expect(ids(collapsed.nodes)).toEqual(["course", "cases", "review"])
})

it("uses only loaded members of a batch and preserves context through another visible path", () => {
  const [center, ga, gb, a, b, x, y] = ["course", "ga", "gb", "a", "b", "x", "y"].map(id => ({ id }))
  const edge = (source: typeof center, target: typeof center, sourceField?: string) => ({ source, target, sourceField })
  const roots = [edge(center, ga), edge(center, gb)]
  const raw = [edge(center, a), edge(center, b), edge(a, x, "related"), edge(b, x), edge(b, y)]
  const first = projectLocalGraph(center.id, [center, ga, gb, a], [...roots, edge(ga, a)], [x, y], raw)
  expect(first.context.map(node => node.id)).toEqual(["x"])
  const second = projectLocalGraph(center.id, [...first.nodes, b], [...first.links, edge(gb, b)], [x, y], raw)
  expect(second.context.map(node => node.id).sort()).toEqual(["x", "y"])
  const collapsedA = projectLocalGraph(center.id, second.nodes.filter(node => node !== a), second.links, [x, y], raw)
  expect(collapsedA.context.map(node => node.id).sort()).toEqual(["x", "y"])
  expect(collapsedA.links).not.toContain(raw[2])
  expect(collapsedA.links).toContain(raw[3])
  const hiddenAgain = projectLocalGraph(center.id, collapsedA.nodes.filter(node => node !== b), collapsedA.links, [x, y], raw)
  expect(hiddenAgain.context).toEqual([])
})

it("orders context by visible prerequisites and removes dangling edges", () => {
  const center = { id: "c" }, a = { id: "a" }, x = { id: "x" }, y = { id: "y" }, hidden = { id: "hidden" }
  const links = [{ source: center, target: a }, { source: a, target: x }, { source: x, target: y }, { source: hidden, target: x }]
  const graph = projectLocalGraph(center.id, [center, a], [links[0]], [y, x], links)
  expect(graph.context).toEqual([x, y])
  expect(graph.links).toEqual(links.slice(0, 3))
  const firstBatch = projectLocalGraph(center.id, [center, a, x], graph.links, [], [])
  expect(firstBatch.nodes).toEqual([center, a, x])
  expect(firstBatch.links).toEqual(links.slice(0, 2))
})
