import { describe, expect, it } from "vitest"
import { resolveGraphViewConfig, type GraphProOptions } from "../src/options"

describe("four graph configurations", () => {
  it("does not inherit rendering parameters from other views", () => {
    const config: GraphProOptions = {
      localGraph: { depth: 2, scale: 2, fontSize: 0.9 },
      globalGraph: { repelForce: 1.5, centerForce: 0.4, linkDistance: 150, enableRadial: true },
    }
    expect(resolveGraphViewConfig(config, "folder")).toMatchObject({
      depth: 1, scale: 1.1, repelForce: 0.5, centerForce: 0.3,
      linkDistance: 30, fontSize: 0.6, enableRadial: false,
    })
    expect(resolveGraphViewConfig(config, "dimension")).toMatchObject({
      depth: 1, repelForce: 0.38, linkDistance: 72, fontSize: 0.75,
    })
  })

  it("changes one view without changing the other three", () => {
    const baseline: GraphProOptions = { graphDefaults: {
      expandBatchSize: 5, maxVisibleNodes: 40, loadBatchSize: 10,
    } }
    const before = Object.fromEntries((["local", "folder", "dimension", "global"] as const)
      .map(view => [view, resolveGraphViewConfig(baseline, view)]))
    const changed: GraphProOptions = { ...baseline, dimensionGraph: {
      repelForce: 0.7, linkDistance: 90, maxVisibleNodes: 25,
    } }
    expect(resolveGraphViewConfig(changed, "dimension")).toMatchObject({
      repelForce: 0.7, linkDistance: 90, maxVisibleNodes: 25, expandBatchSize: 5,
    })
    for (const view of ["local", "folder", "global"] as const)
      expect(resolveGraphViewConfig(changed, view)).toEqual(before[view])
  })

  it("does not let local depth change a folder or dimension collection", () => {
    const config: GraphProOptions = { localGraph: { depth: 3 } }
    expect(resolveGraphViewConfig(config, "local").depth).toBe(3)
    expect(resolveGraphViewConfig(config, "folder").depth).toBe(1)
    expect(resolveGraphViewConfig(config, "dimension").depth).toBe(1)
  })
})
