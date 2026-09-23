import { describe, expect, it } from "vitest"
import { commonFolderOf } from "../src/util/aggregation"
import {
  filterDimensionGraph,
  inScope,
  normalizeScope,
  type DimensionGraphLike,
} from "../src/util/dimensionGraphFilter"

/**
 * ⚠️ 这里断言的 scope/context 语义必须与 aggregation-page-pro 的列表脚本一致
 * （它那边的用例见该插件 test/ 下的对应测试）。
 */
const graph: DimensionGraphLike = {
  nodes: {
    "任务/t1": { title: "任务一" },
    "任务/t2": { title: "任务二" },
    "项目/p1": { title: "项目一" },
    "人员/org1": { title: "人员一" },
  },
  edges: [
    { source: "项目/p1", target: "任务/t1" },
    { source: "人员/org1", target: "任务/t1" },
  ],
  matched: [
    { slug: "任务/t1", scope: "任务" },
    { slug: "项目/p1", scope: "项目" },
  ],
}

describe("commonFolderOf（聚合节点的目录 scope）", () => {
  it("同一目录 → 该目录；跨目录 → 空；根级 → 空", () => {
    expect(commonFolderOf(["任务/a", "任务/b"])).toBe("任务")
    expect(commonFolderOf(["任务/年度/a", "任务/年度/b"])).toBe("任务/年度")
    expect(commonFolderOf(["任务/a", "项目/b"])).toBe("")
    expect(commonFolderOf(["index", "附件示例"])).toBe("")
    expect(commonFolderOf([])).toBe("")
  })
})

describe("scope 语义（前缀匹配）", () => {
  it("normalizeScope 与 inScope", () => {
    expect(normalizeScope("项目/")).toBe("项目")
    expect(normalizeScope("/")).toBe("/")
    expect(normalizeScope("")).toBe("")
    expect(inScope("项目/p1", "项目")).toBe(true)
    expect(inScope("项目组/p1", "项目")).toBe(false)
    expect(inScope("index", "")).toBe(true)
    expect(inScope("index", "/")).toBe(true)
    expect(inScope("任务/t1", "/")).toBe(false)
  })
})

describe("filterDimensionGraph", () => {
  it("无参数时原样返回（不复制）", () => {
    const result = filterDimensionGraph(graph, {})
    expect(result.nodes).toBe(graph.nodes)
    expect(result.edges).toBe(graph.edges)
    expect(result.matched).toBe(graph.matched)
  })

  it("scope 过滤：只留该目录的命中实体及其邻居，被筛掉的命中实体不留作上下文", () => {
    const result = filterDimensionGraph(graph, { scope: "任务" })
    // 码点序：人员 < 任务
    expect(Object.keys(result.nodes).sort()).toEqual(["人员/org1", "任务/t1"])
    expect(result.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      "人员/org1->任务/t1",
    ])
    expect(result.matched.map((match) => match.slug)).toEqual(["任务/t1"])
  })

  it("顶级 scope（/）在没有命中实体时得到空图", () => {
    const result = filterDimensionGraph(graph, { scope: "/" })
    expect(result.nodes).toEqual({})
    expect(result.edges).toEqual([])
    expect(result.matched).toEqual([])
  })

  it("context 过滤：来源节点自身 + 与它直接相连的命中实体", () => {
    const byMatched = filterDimensionGraph(graph, { context: "任务/t1" })
    expect(byMatched.matched.map((match) => match.slug).sort()).toEqual(["任务/t1", "项目/p1"])

    const byNeighbor = filterDimensionGraph(graph, { context: "人员/org1" })
    expect(byNeighbor.matched.map((match) => match.slug)).toEqual(["任务/t1"])
    expect(Object.keys(byNeighbor.nodes).sort()).toEqual(["人员/org1", "任务/t1"])
  })

  it("context 匹配不到任何实体时得到空图", () => {
    const result = filterDimensionGraph(graph, { context: "组织/org-9" })
    expect(result.matched).toEqual([])
    expect(Object.keys(result.nodes)).toEqual([])
  })

  it("scope 与 context 叠加", () => {
    const result = filterDimensionGraph(graph, { scope: "任务", context: "项目/p1" })
    expect(result.matched.map((match) => match.slug)).toEqual(["任务/t1"])
    expect(Object.keys(result.nodes).sort()).toEqual(["人员/org1", "任务/t1"])
  })

  it("slug 带 /index 或尾斜杠时归一化后再比较", () => {
    const result = filterDimensionGraph(graph, { context: "任务/t1/index" })
    expect(result.matched.map((match) => match.slug).sort()).toEqual(["任务/t1", "项目/p1"])
  })
})
