import { describe, expect, it } from "vitest"
import { globalCoreRules, groupGlobalNeighbors, groupShared, type AggregationItem, type SharedAggregation } from "../src/util/sharedAggregation"

const shared: SharedAggregation = {
  version: 1, configHash: "test", minGroupSize: 1,
  root: { type: "folder", depth: 1 },
  resolved: {
    项目: [{ type: "field", field: "阶段" }, { type: "field", field: "type" }, { type: "field", field: "status" }],
    组织: [{ type: "field", field: "type" }],
    任务: [{ type: "field", field: "status" }], 问答: [],
  },
}
const describeNode = (node: AggregationItem) => node
describe("global aggregation roles", () => {
  it("expands core folders through their shared field chains", () => {
    const items = [
      { slug: "项目/a", frontmatter: { 阶段: "计划", type: "A" } },
      { slug: "项目/b", frontmatter: { 阶段: "计划", type: "B" } },
    ]
    const first = groupShared(items, shared, describeNode, globalCoreRules(shared, "项目"))
    expect(first.leaves).toEqual([])
    expect(first.groups.map(g => g.key)).toEqual(["计划"])
    const second = groupShared(first.groups[0].members, shared, describeNode, first.groups[0].remainingRules)
    expect(second.groups.map(g => g.key)).toEqual(["A", "B"])
    expect(groupShared(second.groups[0].members, shared, describeNode, second.groups[0].remainingRules).leaves).toEqual([items[0]])
    expect(globalCoreRules(shared, "组织")).toEqual([{ type: "field", field: "type" }])
  })
  it("retains a single neighbor folder but stops before its field rules", () => {
    const items = [{ slug: "任务/a", frontmatter: { status: "完成" } }]
    const grouped = groupGlobalNeighbors(items, shared, describeNode)
    expect(grouped.groups[0].key).toBe("任务")
    expect(grouped.groups[0].remainingRules).toEqual([])
    expect(groupShared(items, shared, describeNode, grouped.groups[0].remainingRules).leaves).toEqual(items)
    expect(groupShared(items, shared, describeNode).groups[0].key).toBe("完成")
  })
  it("uses shared folder depth and threshold without dropping small categories", () => {
    const artifact = { ...shared, root: { type: "folder" as const, depth: 2 }, minGroupSize: 2 }
    const items = [{ slug: "a/b/1" }, { slug: "a/b/2" }, { slug: "a/c/3" }]
    expect(groupGlobalNeighbors(items, artifact, describeNode).groups.map(g => g.key)).toEqual(["a/b", "a/c"])
    expect(groupGlobalNeighbors([items[2]], artifact, describeNode).leaves).toEqual([items[2]])
  })
  it("honors explicit empty branches and rejects missing contexts", () => {
    expect(globalCoreRules(shared, "问答")).toEqual([])
    expect(() => globalCoreRules(shared, "不存在")).toThrow("missing context")
  })
  it("caps the selected prefix before missing fields are skipped, without changing shared rules", () => {
    const rules = globalCoreRules(shared, "项目")
    const items = [{ slug: "项目/a", frontmatter: { status: "进行中" } }]
    expect(groupShared(items, shared, describeNode, rules)).toEqual({ groups: [], leaves: items })
    expect(shared.resolved.项目).toHaveLength(3)
    expect(globalCoreRules(shared, "项目", 1)).toHaveLength(1)
    expect(groupShared(items, shared, describeNode, globalCoreRules(shared, "项目", 3)).groups[0].key).toBe("进行中")
    for (const invalid of [0, -1, 1.5, NaN]) {
      expect(() => globalCoreRules(shared, "项目", invalid)).toThrow("positive integer")
    }
  })
})
