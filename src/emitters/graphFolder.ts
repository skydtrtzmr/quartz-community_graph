import type { FullSlug, SimpleSlug } from "@quartz-community/types"
import { simplifySlug } from "@quartz-community/utils"
import type { ContentDetails } from "../util/contentIndex"
import { isFolderIndexSlug } from "../util/aggregation"
import type { LocalGraphData, LocalGraphEdge } from "./graphLocal"

/** Collection view: descendants and their incident edges, never a recursive BFS. */
export function buildFolderGraph(
  center: SimpleSlug,
  index: ReadonlyMap<SimpleSlug, ContentDetails>,
  folderTitles: Record<string, string>,
  linkField: (frontmatter: Record<string, unknown> | undefined, target: string) => string | undefined,
): LocalGraphData {
  const folder = center.replace(/\/index$/, "").replace(/\/+$/, "")
  const root = folder === "" || folder === "index"
  const prefix = root ? "" : `${folder}/`
  const members = new Set<SimpleSlug>()
  for (const [id, details] of index) {
    if (!id.startsWith(prefix) || isFolderIndexSlug(id) || !details.filePath ||
      id.startsWith("tags/") || id.startsWith("_dimensions/") ||
      details.virtualNode === true || details.frontmatter?.virtualNode === true) continue
    if (root && id.includes("/")) continue
    members.add(id)
  }

  const nodes: Record<SimpleSlug, ContentDetails> = {}
  const edges: LocalGraphEdge[] = []
  const seen = new Set<string>()
  const addNode = (id: SimpleSlug) => {
    if (nodes[id]) return
    const details = index.get(id)
    if (details) nodes[id] = { ...details, content: "", links: [] }
  }
  const addEdge = (source: SimpleSlug, target: SimpleSlug, sourceField?: string) => {
    const key = `${source}\u0000${target}`
    if (seen.has(key)) return
    seen.add(key)
    addNode(source)
    addNode(target)
    edges.push({ source, target, sourceField })
  }
  for (const id of members) addNode(id)
  for (const [source, details] of index) {
    for (const target of details.links ?? []) {
      if (!members.has(source) && !members.has(target)) continue
      if (!index.has(target)) continue
      addEdge(source, target, linkField(details.frontmatter, target))
    }
    if (!members.has(source)) continue
    for (const tag of details.tags ?? []) {
      const target = simplifySlug(`tags/${tag}` as FullSlug)
      if (!nodes[target]) nodes[target] = {
        slug: target as unknown as FullSlug, filePath: "" as never,
        title: `#${tag}`, content: "", links: [], tags: [],
      }
      addEdge(source, target)
    }
  }
  // Preserve only the relation subset represented by this artifact. This also
  // avoids a second, unused copy of external nodes' full outgoing link lists.
  for (const edge of edges) nodes[edge.source].links.push(edge.target)
  return {
    version: 1, view: "folder", center, depth: 1, generatedAt: Date.now(),
    nodes, edges, folderTitles,
  }
}
