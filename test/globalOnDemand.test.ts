import { expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuildCtx } from "@quartz-community/types"
import { GraphGlobalEmitter, type GlobalGraphPrecomputed } from "../src/emitters/graphGlobal"

it("prepares only the first screen and retains raw directed relations for later expansion", async () => {
  const output = await mkdtemp(join(tmpdir(), "graph-demand-"))
  try {
    await mkdir(join(output, "static"))
    await mkdir(join(output, "graph"))
    const item = (id: string, links: string[]) => ({ slug: id, title: id, filePath: `${id}.md`, tags: [], links, frontmatter: { title: id } })
    const index = {
      "设备/a": item("设备/a", ["缺陷单/c"]),
      "设备/b": item("设备/b", ["缺陷单/d"]),
      "缺陷单/c": item("缺陷单/c", ["缺陷单/d"]),
      "缺陷单/d": item("缺陷单/d", ["设备/a"]),
    }
    await writeFile(join(output, "static/contentIndex.json"), JSON.stringify(index))
    await writeFile(join(output, "graph/selection.json"), JSON.stringify({ version: 1, coreMinLinks: 0, linkCounts: { "设备/a": 2, "设备/b": 1, "缺陷单/c": 2, "缺陷单/d": 3 } }))
    const ctx = { argv: { output }, cfg: { configuration: {} } } as unknown as BuildCtx
    const emitter = GraphGlobalEmitter({ folders: ["设备"], showTags: false })
    const emitted = await emitter.emit(ctx, [], { css: [], js: [], additionalHead: [] })
    if (Symbol.asyncIterator in emitted) for await (const _file of emitted) { /* consume emitter */ }
    const graph = JSON.parse(await readFile(join(output, "graph/global/graphGlobal.json"), "utf8")) as GlobalGraphPrecomputed
    expect(graph.expansionMode).toBe("on-demand")
    expect(graph.firstScreen.nodes).toEqual(["region:设备"])
    expect(graph.aggNodes).toEqual({})
    expect(Object.keys(graph.nodeDetails).filter(id => id.startsWith("agg:"))).toEqual([])
    expect(graph.allChildLinks.map(l => [l.source, l.target])).toEqual([
      ["设备/a", "缺陷单/c"], ["设备/b", "缺陷单/d"], ["缺陷单/c", "缺陷单/d"], ["缺陷单/d", "设备/a"],
    ])
    const positions = graph.adjacency.nodeToEdgeLinkIndices["设备/a"]
    expect(positions.map(i => graph.allChildLinks[i])).toEqual([graph.allChildLinks[0], graph.allChildLinks[3]])
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
