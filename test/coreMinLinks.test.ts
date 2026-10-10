import { describe, expect, it } from "vitest"
import { realLinkCounts, resolveCoreMinLinks, selectScope } from "../src/util/coreMinLinks"
import { selectCoreNodes } from "../src/components/scripts/views"

describe("shared core selection", () => {
  const index = {
    "a": { filePath: "a.md", links: ["b", "b", "a", "tags/x", "missing"] },
    "b": { filePath: "b.md", links: ["c"] },
    "c": { filePath: "c.md", links: [] },
    "isolated": { filePath: "isolated.md", links: [] },
    "folder/": { filePath: "folder/index.md", links: ["isolated"] },
    "tags/x": { filePath: "tags/x.md", links: ["isolated"] },
    "_dimensions/type/x": { filePath: "_dimensions/type/x.md", links: ["isolated"] },
  }
  it("counts only real relationships, including incoming and metadata-only files", () => {
    expect(realLinkCounts(index)).toEqual({ a: 1, b: 2, c: 1, isolated: 0 })
  })
  it("validates the shared threshold and defaults to zero", () => {
    expect(resolveCoreMinLinks(undefined)).toBe(0)
    for (const value of [-1, 1.5, NaN]) expect(() => resolveCoreMinLinks(value)).toThrow("graph.coreMinLinks")
  })
  it("uses domain degree even if a scoped view contains only one of its edges", () => {
    const result = selectScope(new Set(["b", "isolated"]), realLinkCounts(index), 2, [{ source: "a", target: "b" }])
    expect([...result.coreIds]).toEqual(["b"])
    expect([...result.retainedIds]).toEqual(["b", "a"])
    expect(selectScope(new Set(["isolated"]), realLinkCounts(index), 0, []).coreIds.has("isolated")).toBe(true)
  })
  for (const view of ["folder", "dimension"] as const) {
    it(`${view} uses the shared selected subjects, retaining low-degree neighbors without making them cores`, () => {
      const nodes = ["a", "b", "c", "isolated"].map(id => ({ id, isCore: false }))
      const chosen = selectScope(new Set(nodes.map(n => n.id)), realLinkCounts(index), 2,
        [{ source: "a", target: "b" }, { source: "b", target: "c" }])
      selectCoreNodes({ view, nodes, selectedCoreIds: chosen.coreIds, nodeLinkCount: new Map(), contentData: new Map(), slug: "", sharedAggregation: false, hasRegionRules: false })
      expect(nodes.filter(n => n.isCore).map(n => n.id)).toEqual(["b"])
      expect([...chosen.retainedIds]).toEqual(["b", "a", "c"])
    })
  }
})
