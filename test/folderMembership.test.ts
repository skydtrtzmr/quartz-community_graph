import { describe, expect, it } from "vitest"
import {
  extractGroupKey,
  isFolderIndexSlug,
  matchCoreNodeFilter,
} from "../src/util/aggregation"
import {
  groupGlobalNeighbors,
  type AggregationItem,
  type SharedAggregation,
} from "../src/util/sharedAggregation"

describe("isFolderIndexSlug", () => {
  it("recognizes folder index page slugs in every observed form", () => {
    for (const slug of ["项目/", "项目/index", "index", "/", "", "子/目录/"]) {
      expect(isFolderIndexSlug(slug)).toBe(true)
    }
    for (const slug of ["项目/a", "项目/子目录/b", "index-2", "索引"]) {
      expect(isFolderIndexSlug(slug)).toBe(false)
    }
  })
})

describe("folder membership excludes the folder index page", () => {
  const folder = { type: "folder" as const, depth: 1 }

  it("matchCoreNodeFilter: 索引页不是白名单文件夹的核心", () => {
    const rules = [{ type: "folder" as const, depth: 1, values: ["项目"] }]
    expect(matchCoreNodeFilter("项目/a", undefined, rules)).toBe(true)
    expect(matchCoreNodeFilter("项目/", undefined, rules)).toBe(false)
    expect(matchCoreNodeFilter("项目/index", undefined, rules)).toBe(false)
  })

  it("extractGroupKey: 索引页不归属任何文件夹分组", () => {
    expect(extractGroupKey({ slug: "项目/a" }, folder)).toBe("项目")
    expect(extractGroupKey({ slug: "项目/" }, folder)).toBeNull()
    expect(extractGroupKey({ slug: "项目/index" }, folder)).toBeNull()
  })

  it("groupGlobalNeighbors: 邻居里的索引页不落进文件夹分组", () => {
    const shared: SharedAggregation = {
      version: 1,
      configHash: "test",
      minGroupSize: 1,
      root: { type: "folder", depth: 1 },
      resolved: {},
    }
    const items: AggregationItem[] = [
      { slug: "项目/", frontmatter: {} },
      { slug: "项目/a", frontmatter: {} },
    ]
    const grouped = groupGlobalNeighbors(items, shared, (node) => node)
    expect(grouped.groups.flatMap((group) => group.members).map((member) => member.slug)).toEqual([
      "项目/a",
    ])
  })
})
