import { describe, expect, it } from "vitest"
import type { SimpleSlug } from "@quartz-community/types"
import { descendantChildrenOf, directChildrenOf, djb2Hash, getLocalGraphPath } from "../src/emitters/graphLocal"
import { filterGraphContent } from "../src/util/contentIndex"
import type { ContentDetails } from "../src/util/contentIndex"
import { buildFolderGraph } from "../src/emitters/graphFolder"
import { GraphLocalEmitter } from "../src/emitters/graphLocal"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuildCtx, ChangeEvent, ProcessedContent, StaticResources } from "@quartz-community/types"

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

describe("graph virtual node visibility", () => {
  it("hides placeholders and dangling links, keeps dimension pages, tags and generated folder centers", () => {
    const index = new Map<string, { filePath?: string; links: string[]; virtualNode?: boolean; frontmatter?: Record<string, unknown> }>([
      ["real", { filePath: "real.md", links: ["ghost", "legacy", "old-json", "missing", "other", "_dimensions/type/value", "tags/topic"] }],
      ["other", { filePath: "other.md", links: ["real"] }],
      ["ghost", { filePath: "ghost.md", virtualNode: true, links: ["real"] }],
      ["legacy", { filePath: "legacy.md", frontmatter: { virtualNode: true }, links: ["real"] }],
      ["old-json", { filePath: "", links: [] }],
      ["_dimensions/type/", { virtualNode: true, filePath: "", links: ["_dimensions/type/value"] }],
      ["_dimensions/type/value", { virtualNode: true, filePath: "", links: ["real"] }],
      ["tags/topic", { filePath: "", links: [] }],
      ["generated/", { filePath: "", links: ["real"] }],
    ])
    const filtered = filterGraphContent(index)
    expect([...filtered.keys()]).toEqual(["real", "other", "_dimensions/type/", "_dimensions/type/value", "tags/topic", "generated/"])
    expect(filtered.get("real")?.links).toEqual(["other", "_dimensions/type/value", "tags/topic"])
    expect(filtered.get("other")?.links).toEqual(["real"])
    // Browser caches and indexes shared with other plugins must remain untouched.
    expect(index.get("real")?.links).toContain("ghost")
    expect(index.has("ghost")).toBe(true)
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
  it("includes nested content when a parent has no direct files", () => {
    const index = new Map<SimpleSlug, never>([
      ["项目/" as SimpleSlug, {} as never],
      ["项目/核心项目/" as SimpleSlug, {} as never],
      ["项目/核心项目/2025/计划" as SimpleSlug, {} as never],
      ["项目/核心项目/2025/总结" as SimpleSlug, {} as never],
      ["人员/p" as SimpleSlug, {} as never],
    ])
    expect(descendantChildrenOf(index, "项目/" as SimpleSlug)).toEqual([
      "项目/核心项目/2025/计划",
      "项目/核心项目/2025/总结",
    ])
  })
})

describe("folder collection data", () => {
  const make = (id: string, links: string[] = [], tags: string[] = []) => ({
    slug: id, filePath: `${id.replace(/\/$/, "/index")}.md`, title: id,
    links, tags, content: "body must not be shipped", frontmatter: { customCategory: "custom" },
  }) as unknown as ContentDetails

  it("keeps descendants and direct incoming/outgoing context, without recursive context or synthetic center edges", () => {
    const index = new Map<string, ContentDetails>([
      ["课程/", make("课程/")],
      ["课程/子/", make("课程/子/")],
      ["课程/子/a", make("课程/子/a", ["案例/b", "课程/c", "案例/b"], ["tag"])],
      ["课程/c", make("课程/c")],
      ["案例/b", make("案例/b", ["设备/deep", "员工/incoming"])],
      ["员工/incoming", make("员工/incoming", ["课程/c"])],
      ["设备/deep", make("设备/deep")],
      ["课程占位", make("课程占位")],
    ])
    const graph = buildFolderGraph("课程/" as SimpleSlug, index as Map<SimpleSlug, ContentDetails>, { "课程": "课程" }, () => "relation")
    expect(graph.view).toBe("folder")
    expect(Object.keys(graph.nodes).sort()).toEqual(["课程/子/a", "课程/c", "案例/b", "员工/incoming", "tags/tag"].sort())
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ["课程/子/a", "案例/b"], ["课程/子/a", "课程/c"], ["课程/子/a", "tags/tag"], ["员工/incoming", "课程/c"],
    ])
    expect(graph.edges[0].sourceField).toBe("relation")
    expect(Object.values(graph.nodes).every(node => node.content === "")).toBe(true)
    expect(graph.nodes["课程/子/a" as SimpleSlug].frontmatter?.customCategory).toBe("custom")
    expect(graph.nodes["案例/b" as SimpleSlug].links).toEqual([])
    expect(index.get("案例/b")?.links).toEqual(["设备/deep", "员工/incoming"])
    expect(index.get("课程/c")?.content).toBe("body must not be shipped")
  })

  it("retains isolated members and excludes directory pages and placeholders", () => {
    const index = new Map<string, ContentDetails>([
      ["课程/", make("课程/")], ["课程/子/", make("课程/子/")],
      ["课程/子/a", make("课程/子/a")],
      ["课程/ghost", { ...make("课程/ghost"), virtualNode: true }],
    ])
    const graph = buildFolderGraph("课程/" as SimpleSlug, index as Map<SimpleSlug, ContentDetails>, {}, () => undefined)
    expect(Object.keys(graph.nodes)).toEqual(["课程/子/a"])
    expect(graph.edges).toEqual([])
  })

  it("incremental add, relation edit, category edit, move and delete agree with a full build", async () => {
    const output = await mkdtemp(join(tmpdir(), "folder-collection-"))
    try {
      const ctx = { argv: { output }, cfg: { configuration: {} } } as unknown as BuildCtx
      const resources = { css: [], js: [], additionalHead: [] } as StaticResources
      const emitter = GraphLocalEmitter({ localDepth: 3 })
      const index: Record<string, ContentDetails> = {
        "课程/": make("课程/"), "其他/": make("其他/"),
        "课程/a": make("课程/a", ["案例/b"]),
        "案例/b": make("案例/b", ["设备/deep"]), "设备/deep": make("设备/deep"),
      }
      const content = () => Object.values(index).map(details => [null, { data: {
        ...details, relativePath: details.filePath, text: details.content,
      } }]) as unknown as ProcessedContent[]
      const consume = async (result: ReturnType<typeof emitter.emit> | null) => {
        const value = await result
        if (!value) return
        if (Symbol.asyncIterator in value) for await (const _ of value) { /* drain */ }
      }
      const readGraph = async (folder: string) => {
        const data = JSON.parse(await readFile(join(output, "graph/local", `${getLocalGraphPath(folder as SimpleSlug)}.json`), "utf8"))
        delete data.generatedAt
        return data
      }
      await mkdir(join(output, "static"), { recursive: true })
      await consume(emitter.emit(ctx, content(), resources))
      const update = async (ids: string[], mutate: () => void) => {
        mutate()
        await writeFile(join(output, "static/contentIndex.json"), JSON.stringify(index))
        const events = ids.map(id => ({ type: index[id] ? "change" : "delete", path: `${id}.md`, file: { data: { slug: id } } })) as unknown as ChangeEvent[]
        await consume(emitter.partialEmit!(ctx, content(), resources, events))
        const incremental = await Promise.all([readGraph("课程/"), readGraph("其他/")])
        await consume(emitter.emit(ctx, content(), resources))
        expect(incremental).toEqual(await Promise.all([readGraph("课程/"), readGraph("其他/")]))
      }
      await update(["课程/new"], () => { index["课程/new"] = make("课程/new") })
      await update(["案例/b"], () => { index["案例/b"].links = ["课程/new" as SimpleSlug] })
      await update(["课程/a"], () => { index["课程/a"].frontmatter = { customCategory: "changed" } })
      await update(["课程/a", "其他/a"], () => {
        delete index["课程/a"]
        index["其他/a"] = make("其他/a", ["案例/b"])
      })
      await update(["课程/new"], () => { delete index["课程/new"] })
      expect(await readGraph("课程/")).toMatchObject({ view: "folder", nodes: {}, edges: [] })
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })
})
