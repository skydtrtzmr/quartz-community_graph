import { describe, expect, it } from "vitest"
import type { SimpleSlug } from "@quartz-community/types"
import { directChildrenOf, djb2Hash, getLocalGraphPath } from "../src/emitters/graphLocal"

/**
 * 运行时读取端（graph3.inline.ts）使用的算法副本。
 * 构建期与读取期必须逐字符一致，否则局部图谱 JSON 找不到。
 */
function runtimeLocalGraphPath(fullSlug: string): string {
  let hash = 5381
  for (let i = 0; i < fullSlug.length; i++) {
    hash = (hash << 5) + hash + fullSlug.charCodeAt(i)
    hash = hash & 0xffffffff
  }
  const h = (hash >>> 0).toString(16).padStart(8, "0").slice(0, 4)
  return `${h.slice(0, 2)}/${h.slice(2, 4)}/${fullSlug}`
}

describe("graphLocal 路径协议", () => {
  it("djb2 输出 8 位十六进制且稳定", () => {
    expect(djb2Hash("api-test-page")).toMatch(/^[a-f0-9]{8}$/)
    expect(djb2Hash("api-test-page")).toBe(djb2Hash("api-test-page"))
  })

  it("不同 slug 分布到不同桶", () => {
    const paths = ["page-a", "page-b", "page-c"].map((s) => getLocalGraphPath(s as SimpleSlug))
    expect(new Set(paths).size).toBe(3)
    for (const p of paths) expect(p).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{2}\/page-[abc]$/)
  })

  it("支持中文 slug", () => {
    expect(getLocalGraphPath("中文笔记" as SimpleSlug)).toMatch(
      /^[a-f0-9]{2}\/[a-f0-9]{2}\/中文笔记$/,
    )
  })

  it("支持带路径分隔符的嵌套 slug（保留原始目录结构）", () => {
    const p = getLocalGraphPath("folder/page-name" as SimpleSlug)
    expect(p).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{2}\/folder\/page-name$/)
    expect(p).toBe(getLocalGraphPath("folder/page-name" as SimpleSlug))
  })

  it("构建端路径与运行时读取端算法逐字符一致（v4 兼容性回归）", () => {
    const slugs = [
      "index",
      "人员/person-00001",
      "任务/task-00020",
      "中文笔记",
      "a/b/c/deep-page",
      "tags/知识图谱",
    ]
    for (const slug of slugs) {
      expect(getLocalGraphPath(slug as SimpleSlug)).toBe(runtimeLocalGraphPath(slug))
    }
  })
})

describe("folder graph membership", () => {
  it("includes every direct file without the old 60-file cap", () => {
    const index = new Map<SimpleSlug, never>()
    index.set("项目/" as SimpleSlug, {} as never)
    for (let i = 0; i < 75; i++) index.set(`项目/p${i}` as SimpleSlug, {} as never)
    index.set("项目/子目录/p" as SimpleSlug, {} as never)
    index.set("人员/p" as SimpleSlug, {} as never)
    expect(directChildrenOf(index, "项目/" as SimpleSlug)).toHaveLength(75)
  })
})
