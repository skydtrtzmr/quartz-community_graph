import { expect, it } from "vitest"
import { indexGraphLinks } from "../src/components/scripts/graphLinkIndex"

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
