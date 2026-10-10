import { describe, expect, it } from "vitest"
import { limitVisibleNodes, resolveMaxVisibleNodes } from "../src/components/scripts/visibleNodes"

type Node = { id: string; file?: boolean }
const isFile = (node: Node) => !!node.file
const compare = (a: Node, b: Node) => a.id.localeCompare(b.id)

describe("visible graph file budget", () => {
  it("keeps synthetic groups and only links with visible endpoints", () => {
    const group = { id: "region:a" }
    const files = ["c", "a", "b"].map((id) => ({ id, file: true }))
    const links = files.map((node) => ({ source: group, target: node }))
    const result = limitVisibleNodes([], [group, ...files], links, 2, isFile, compare)
    expect(result.nodes.map((node) => node.id)).toEqual(["region:a", "a", "b"])
    expect(result.links.map((link) => link.target.id)).toEqual(["a", "b"])
    expect(result.omitted).toBe(1)
  })

  it("counts shared files once and frees capacity after collapse", () => {
    const a = { id: "a", file: true }
    const b = { id: "b", file: true }
    const c = { id: "c", file: true }
    expect(limitVisibleNodes([a], [a, b, c], [], 2, isFile, compare).nodes).toEqual([b])
    expect(limitVisibleNodes([b], [c], [], 2, isFile, compare).nodes).toEqual([c])
  })

  it("uses a positive integer cap with a 500 node default", () => {
    expect(resolveMaxVisibleNodes(undefined)).toBe(500)
    expect(resolveMaxVisibleNodes(1)).toBe(1)
    expect(() => resolveMaxVisibleNodes(0)).toThrow(/positive integer/)
    expect(() => resolveMaxVisibleNodes(1.5)).toThrow(/positive integer/)
  })
})
