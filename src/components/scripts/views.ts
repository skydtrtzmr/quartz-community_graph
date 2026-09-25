import type { ContentDetails } from "../../util/contentIndex";
import { matchCoreNodeFilter, type CoreNodeFilterConfig } from "../../util/aggregation";

export type GraphView = "global" | "local" | "folder" | "dimension";

export interface CoreCandidate {
  id: string;
  isCore?: boolean;
}

export interface CoreSelection<N extends CoreCandidate> {
  view: GraphView;
  nodes: N[];
  nodeLinkCount: Map<string, number>;
  contentData: Map<string, ContentDetails>;
  slug: string;
  sharedAggregation: boolean;
  coreNodeFilter?: CoreNodeFilterConfig;
  coreNodeLimit?: number;
  hasRegionRules: boolean;
}

/** The data attribute is explicit for folder pages; depth still decides global mode. */
export function graphViewOf(
  depth: number,
  dimensionGraph: boolean,
  declaredView?: string,
): GraphView {
  if (dimensionGraph) return "dimension";
  if (depth < 0) return "global";
  if (declaredView === "folder") return "folder";
  return "local";
}

function selectByDegree<N extends CoreCandidate>(
  nodes: N[],
  counts: Map<string, number>,
  threshold: number,
) {
  for (const node of nodes) node.isCore = (counts.get(node.id) ?? 0) > threshold;
}

function selectLocal<N extends CoreCandidate>(selection: CoreSelection<N>) {
  // Preserve the v4-derived behavior until the view-specific focus change is made separately.
  selectByDegree(selection.nodes, selection.nodeLinkCount, 1);
  if (selection.sharedAggregation) {
    for (const node of selection.nodes) node.isCore = node.id === selection.slug;
  }
}

function selectFolder<N extends CoreCandidate>(selection: CoreSelection<N>) {
  selectLocal(selection);
}

function selectDimension<N extends CoreCandidate>(selection: CoreSelection<N>) {
  selectLocal(selection);
}

function selectGlobal<N extends CoreCandidate>(selection: CoreSelection<N>) {
  const { nodes, nodeLinkCount, contentData, coreNodeFilter, coreNodeLimit, hasRegionRules } =
    selection;
  if (coreNodeFilter && coreNodeFilter.length > 0) {
    console.log("[Graph] coreNodeFilter 规则:", JSON.stringify(coreNodeFilter));
    let matchedCount = 0;
    const matchSamples: { id: string; folderKey: string; matched: boolean }[] = [];
    for (const node of nodes) {
      const details = contentData.get(node.id);
      node.isCore = matchCoreNodeFilter(node.id, details?.frontmatter, coreNodeFilter);
      if (node.isCore) matchedCount++;
      const parts = node.id.split("/");
      const folderKey = parts.length > 1 ? parts[0] : "/";
      if (matchSamples.length < 20)
        matchSamples.push({ id: node.id, folderKey, matched: node.isCore });
    }
    console.log(`[Graph] coreNodeFilter 匹配结果: ${matchedCount}/${nodes.length} 个核心节点`);
    console.log("[Graph] 匹配样例 (前20条):", matchSamples);
    const folderStats = new Map<string, number>();
    for (const node of nodes) {
      const parts = node.id.split("/");
      const key = parts.length > 1 ? parts[0] : "/";
      folderStats.set(key, (folderStats.get(key) ?? 0) + 1);
    }
    console.log(
      "[Graph] 一级文件夹分布:",
      Object.fromEntries([...folderStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    );
  } else {
    selectByDegree(nodes, nodeLinkCount, 2);
  }

  // Keep the existing global-only limit, including the region-rule exception.
  if (coreNodeLimit && coreNodeLimit > 0 && !hasRegionRules) {
    const coreNodes = nodes.filter((node) => node.isCore);
    if (coreNodes.length > coreNodeLimit) {
      coreNodes.sort((a, b) => (nodeLinkCount.get(b.id) ?? 0) - (nodeLinkCount.get(a.id) ?? 0));
      const selected = new Set(coreNodes.slice(0, coreNodeLimit).map((node) => node.id));
      for (const node of nodes) {
        if (!selected.has(node.id)) node.isCore = false;
      }
    }
  }
}

/** Stage 1: move existing core classification without changing any view's membership. */
export function selectCoreNodes<N extends CoreCandidate>(selection: CoreSelection<N>): void {
  switch (selection.view) {
    case "global":
      selectGlobal(selection);
      break;
    case "local":
      selectLocal(selection);
      break;
    case "folder":
      selectFolder(selection);
      break;
    case "dimension":
      selectDimension(selection);
      break;
  }
}
