// 构建全局图谱首屏与原始关系索引。首屏之外的分层、邻居聚合在展开时计算。
// 输出 graph/global/graphGlobal.json，保留原始节点/边以支持动态字段切换。
// 依赖 contentIndex.json、aggregation.json 和 selection.json 已生成。

import type {
  BuildCtx,
  FullSlug,
  QuartzEmitterPlugin,
  SimpleSlug,
} from "@quartz-community/types"
import { joinSegments } from "@quartz-community/types"
import { simplifySlug } from "@quartz-community/utils"
import { write } from "../util/write"
import { readFile } from "node:fs/promises"
import { globalCoreRules, readSharedAggregation } from "../util/sharedAggregation"
import type { ContentDetails } from "../util/contentIndex"
import { filterGraphContent } from "../util/contentIndex"
import {
  UNCLASSIFIED_KEY,
  extractGroupKey,
  isRuleEffective,
  matchCoreNodeFilter,
} from "../util/aggregation"
import type { AggregationRule, CoreNodeFilterConfig } from "../util/aggregation"
import { resolveGraphGrouping } from "../util/graphGrouping"
import { qualifiesAsGlobalCore, resolveCoreMinLinks } from "../util/coreMinLinks"

// ===== 预计算 JSON 结构定义 =====

interface PreGraphData {
  nodes: string[]
  links: Array<{ source: string; target: string; sourceField?: string }>
}

interface PreAggNodeInfo {
  coreId: string
  childNodeIds: string[]
  childLinkIndices: number[]
  remainingRules: AggregationRule[]
  currentField: string
  displayText: string
}

interface PreRegionNodeInfo {
  childCoreIds: string[]
  remainingRules: AggregationRule[]
  currentField: string
  /** 显示文本（folder 规则时优先用目录 index.md 的 title） */
  displayText: string
}

interface GlobalGraphPrecomputed {
  version: number
  expansionMode: "on-demand"
  generatedAt: number
  /** 目录显示名映射（目录路径 → 目录 index.md 的 frontmatter.title） */
  folderTitles: Record<string, string>
  config: {
    aggregation?: AggregationRule[]
    regionRules?: AggregationRule[]
    coreNodeFilter?: CoreNodeFilterConfig
    coreNodeLimit?: number
    coreMinLinks?: number
    startCollapsed?: boolean
    filterNonCoreNodes?: boolean
    showTags?: boolean
    removeTags?: string[]
  }
  nodeDetails: Record<
    string,
    { id: string; fullSlug?: string; text: string; tags: string[]; frontmatter?: Record<string, unknown> }
  >
  firstScreen: PreGraphData
  adjacency: {
    nodeToEdgeNodeIds: Record<string, string[]>
    nodeToEdgeLinkIndices: Record<string, number[]>
  }
  aggNodes: Record<string, PreAggNodeInfo>
  aggToCore: Record<string, string>
  regionNodes: Record<string, PreRegionNodeInfo>
  coreToRegion: Record<string, string>
  allChildLinks: Array<{ source: string; target: string; sourceField?: string }>
  coreNodeIds: string[]
  edgeNodeIds: string[]
  nodeLinkCounts: Record<string, number>
}

// ===== 选项 =====

interface Options {
  enabled?: boolean
  /**
   * 主体文件夹白名单（YAML: `options.globalGraph.folders`）；空 / 缺省时由 coreMinLinks 从全部目录选择核心内容节点。
   * 大区 / 邻居分组 / 核心节点均由 `resolveGraphGrouping` 从它 + `configuration.aggregation` 合成。
   */
  folders?: string[]
  /** 核心节点数量硬上限 */
  coreNodeLimit?: number
  /** 全局核心节点的最少连接数；0 纳入孤立内容节点 */
  coreMinLinks?: number
  /** 核心集合只使用共享规则链前 N 项（默认 2） */
  coreAggregationMaxLevels?: number
  /** 全局图谱是否默认收起 */
  startCollapsed?: boolean
  /** 是否过滤非核心节点 */
  filterNonCoreNodes?: boolean
  /** 是否显示标签 */
  showTags?: boolean
  /** 要移除的标签 */
  removeTags?: string[]
}

const defaultOptions: Options = {
  enabled: true,
  coreNodeLimit: 100,
  startCollapsed: true,
  filterNonCoreNodes: true,
  showTags: true,
  removeTags: [],
}

// ===== 辅助函数 =====

function getFrontmatterFieldForLink(
  frontmatter: Record<string, unknown> | undefined,
  targetLink: string,
): string | undefined {
  if (!frontmatter) return undefined
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "string" && value.includes("[[" + targetLink + "]]")) {
      return key
    }
    if (typeof value === "string" && value.includes("[[")) {
      const match = value.match(/\[\[\.?\.?\/?([^\]|#]+)/)
      if (match) {
        const normalizedTarget = match[1].replace(/^\.\//, "").replace(/^\//, "")
        if (normalizedTarget === targetLink || targetLink.endsWith(normalizedTarget)) {
          return key
        }
      }
    }
  }
  return undefined
}

export const GraphGlobalEmitter: QuartzEmitterPlugin<Partial<Options>> = (userOpts) => {
  const opts: Options = { ...defaultOptions, ...userOpts }

  /**
   * 核心计算 + 输出逻辑，供 emit（全量）和 partialEmit（增量）共享。
   * contentData 必须包含全量文件数据。
   */
  async function* computeAndEmit(ctx: BuildCtx, contentData: Map<SimpleSlug, ContentDetails>) {
    contentData = filterGraphContent(contentData)
    const shared = (ctx.cfg.configuration as unknown as { aggregation?: unknown }).aggregation === undefined
      ? null
      : readSharedAggregation(JSON.parse(await readFile(joinSegments(ctx.argv.output, "static", "aggregation.json"), "utf8")))
    // 三个内部分组值不再来自配置：由「主体文件夹白名单 + 站点聚合上下文」合成（见 util/graphGrouping.ts）
    const { aggregation, regionRules, coreNodeFilter } = resolveGraphGrouping({
      folders: opts.folders,
      folderDepth: shared?.root?.depth,
    })
    const coreNodeLimit = opts.coreNodeLimit ?? 100
    const coreMinLinks = resolveCoreMinLinks(opts.coreMinLinks)
    const startCollapsed = opts.startCollapsed ?? true
    const excludeUnlinkedNodes = coreMinLinks > 0
    const selection = JSON.parse(await readFile(joinSegments(ctx.argv.output, "graph", "selection.json"), "utf8")) as import("../util/coreMinLinks").GraphSelection
    const domainCounts = selection.linkCounts
    const filterNonCoreNodes = opts.filterNonCoreNodes ?? true
    const showTags = opts.showTags ?? true
    const removeTags: string[] = opts.removeTags ?? []

    const entryCount = contentData.size
    console.log(`[GraphGlobal] Starting precomputation with ${entryCount} entries...`)
    const totalStart = performance.now()

    // ===== Step 1: 构建目录显示名映射 =====
    const folderTitles: Record<string, string> = {}
    const normalizeFolderKey = (key: string): string =>
      key === "/" ? "/" : key.replace(/^\/+|\/+$/g, "")
    for (const [slug, details] of contentData.entries()) {
      const rel = details.filePath as unknown as string | undefined
      if (rel && (rel === "index.md" || rel.endsWith("/index.md"))) {
        const t = details.frontmatter?.title
        if (typeof t === "string" && t.trim() !== "") {
          folderTitles[normalizeFolderKey(slug)] = t.trim()
        }
      }
    }
    /** folder 分组的显示名：目录 index.md 有 title 时用 title，否则用目录路径 */
    const folderDisplay = (groupKey: string): string =>
      folderTitles[normalizeFolderKey(groupKey)] ?? groupKey

    // ===== Step 2: 虚拟节点计算 =====
    const virtualNodes = new Set<string>()
    const allExistingSlugs = new Set(contentData.keys())
    const allTagSlugs = new Set<string>()

    for (const [, details] of contentData.entries()) {
      for (const tag of details.tags ?? []) {
        allTagSlugs.add(simplifySlug(("tags/" + tag) as FullSlug))
      }
    }
    for (const [, details] of contentData.entries()) {
      for (const link of details.links ?? []) {
        if (!allExistingSlugs.has(link) && !allTagSlugs.has(link) && !link.startsWith("tags/")) {
          virtualNodes.add(link)
        }
      }
    }
    console.log(`  [Step 2] Virtual nodes: ${virtualNodes.size}`)

    // ===== Step 3: 全局链接图构建 =====
    const rawLinks: Array<{ source: string; target: string; sourceField?: string }> = []
    const validLinks = new Set<string>(contentData.keys())
    for (const v of virtualNodes) validLinks.add(v)

    for (const [source, details] of contentData.entries()) {
      for (const dest of details.links ?? []) {
        if (validLinks.has(dest)) {
          const sourceField = getFrontmatterFieldForLink(details.frontmatter, dest)
          rawLinks.push({ source, target: dest, sourceField })
        }
      }
      if (showTags) {
        const localTags = (details.tags ?? [])
          .filter((tag) => !removeTags.includes(tag))
          .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))
        for (const tag of localTags) rawLinks.push({ source, target: tag })
      }
    }
    for (const [source, details] of contentData.entries()) {
      for (const dest of details.links ?? []) {
        if (virtualNodes.has(dest)) {
          const sourceField = getFrontmatterFieldForLink(details.frontmatter, dest)
          rawLinks.push({ source, target: dest, sourceField })
        }
      }
    }
    console.log(`  [Step 3] Raw links: ${rawLinks.length}`)

    // ===== Step 4: 节点构建 + 去重 + 孤儿过滤 =====
    const neighbourhood = new Set<string>(validLinks)
    for (const [, details] of contentData.entries()) {
      for (const tag of details.tags ?? []) {
        if (showTags && !removeTags.includes(tag)) {
          neighbourhood.add(simplifySlug(("tags/" + tag) as FullSlug))
        }
      }
    }

    // 链接去重
    const linkKeySet = new Set<string>()
    const allLinks = rawLinks
      .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
      .filter((l) => {
        const key = `${l.source}->${l.target}`
        if (linkKeySet.has(key)) return false
        linkKeySet.add(key)
        return true
      })

    // 连接数统计
    const nodeLinkCount = new Map<string, number>()
    for (const l of allLinks) {
      nodeLinkCount.set(l.source, (nodeLinkCount.get(l.source) ?? 0) + 1)
      nodeLinkCount.set(l.target, (nodeLinkCount.get(l.target) ?? 0) + 1)
    }

    // 过滤孤儿节点
    const nonOrphanNodeIds = new Set(
      [...neighbourhood].filter((id) => (nodeLinkCount.get(id) ?? 0) > 0),
    )
    const nonOrphanLinks = allLinks.filter(
      (l) => nonOrphanNodeIds.has(l.source) && nonOrphanNodeIds.has(l.target),
    )
    const effectiveNodeIds = excludeUnlinkedNodes ? nonOrphanNodeIds : neighbourhood
    const effectiveLinks = excludeUnlinkedNodes ? nonOrphanLinks : allLinks
    console.log(
      `  [Step 4] ${excludeUnlinkedNodes ? "Non-orphan" : "Unfiltered"}: ${effectiveNodeIds.size} nodes, ${effectiveLinks.length} links`,
    )

    // ===== Step 5: 核心节点标记 =====
    const coreNodeIdSet = new Set<string>()
    if (coreNodeFilter && coreNodeFilter.length > 0) {
      for (const nodeId of effectiveNodeIds) {
        const details = contentData.get(nodeId as SimpleSlug)
        if (matchCoreNodeFilter(nodeId, details?.frontmatter, coreNodeFilter) &&
            qualifiesAsGlobalCore(nodeId, domainCounts[nodeId] ?? 0, coreMinLinks, !!details && Object.hasOwn(domainCounts, nodeId))) {
          coreNodeIdSet.add(nodeId)
        }
      }
    } else {
      for (const nodeId of effectiveNodeIds) {
        if (qualifiesAsGlobalCore(nodeId, domainCounts[nodeId] ?? 0, coreMinLinks, contentData.has(nodeId as SimpleSlug) && Object.hasOwn(domainCounts, nodeId))) {
          coreNodeIdSet.add(nodeId)
        }
      }
    }

    // 硬上限裁剪（配置了 regionRules 时交给大区逻辑处理）
    if (coreNodeLimit && coreNodeLimit > 0 && !(regionRules && regionRules.length > 0)) {
      if (coreNodeIdSet.size > coreNodeLimit) {
        const sorted = [...coreNodeIdSet].sort(
          (a, b) => (nodeLinkCount.get(b) ?? 0) - (nodeLinkCount.get(a) ?? 0),
        )
        const selected = new Set(sorted.slice(0, coreNodeLimit))
        for (const id of coreNodeIdSet) {
          if (!selected.has(id)) coreNodeIdSet.delete(id)
        }
      }
    }
    console.log(`  [Step 5] Core nodes: ${coreNodeIdSet.size}`)

    // ===== Step 6: 邻接映射构建 =====
    const edgeNodeIdSet = new Set([...effectiveNodeIds].filter((id) => !coreNodeIdSet.has(id)))
    const nodeToEdgeNodeIds: Record<string, string[]> = {}
    const nodeToEdgeLinkIndices: Record<string, number[]> = {}

    for (let li = 0; li < effectiveLinks.length; li++) {
      const l = effectiveLinks[li]
      const srcIsEdge = edgeNodeIdSet.has(l.source)
      const tgtIsEdge = edgeNodeIdSet.has(l.target)
      if (srcIsEdge && !tgtIsEdge) {
        if (!nodeToEdgeNodeIds[l.target]) nodeToEdgeNodeIds[l.target] = []
        if (!nodeToEdgeNodeIds[l.target].includes(l.source))
          nodeToEdgeNodeIds[l.target].push(l.source)
        if (!nodeToEdgeLinkIndices[l.target]) nodeToEdgeLinkIndices[l.target] = []
        nodeToEdgeLinkIndices[l.target].push(li)
      } else if (!srcIsEdge && tgtIsEdge) {
        if (!nodeToEdgeNodeIds[l.source]) nodeToEdgeNodeIds[l.source] = []
        if (!nodeToEdgeNodeIds[l.source].includes(l.target))
          nodeToEdgeNodeIds[l.source].push(l.target)
        if (!nodeToEdgeLinkIndices[l.source]) nodeToEdgeLinkIndices[l.source] = []
        nodeToEdgeLinkIndices[l.source].push(li)
      }
    }

    // 首屏之后的邻居聚合在浏览器展开时生成，只保留原始邻接关系。
    const aggNodes: Record<string, PreAggNodeInfo> = {}
    const aggToCore: Record<string, string> = {}
    const updatedNodeToEdgeNodeIds = nodeToEdgeNodeIds
    const updatedNodeToEdgeLinkIndices = nodeToEdgeLinkIndices

    // ===== Step 8: 大区节点生成 =====
    const regionNodes: Record<string, PreRegionNodeInfo> = {}
    const coreToRegion: Record<string, string> = {}

    if (regionRules && regionRules.length > 0) {
      const coreNodesArr = [...coreNodeIdSet]
      const rule = regionRules[0]
      const groupMap = new Map<string, string[]>()

      for (const coreId of coreNodesArr) {
        const details = contentData.get(coreId as SimpleSlug)
        let groupKey: string | null = null
        if (details) {
          groupKey = extractGroupKey({ slug: coreId, frontmatter: details.frontmatter }, rule)
        }
        if (!groupKey) groupKey = UNCLASSIFIED_KEY
        const group = groupMap.get(groupKey) ?? []
        group.push(coreId)
        groupMap.set(groupKey, group)
      }

      for (const [groupKey, childCoreIds] of groupMap) {
        const regionId = `region:${groupKey}`
        regionNodes[regionId] = {
          childCoreIds,
          remainingRules: shared ? globalCoreRules(shared, groupKey, opts.coreAggregationMaxLevels) : regionRules.slice(1),
          currentField: rule.type === "folder" ? "📁" : (rule.field ?? rule.type),
          displayText: rule.type === "folder" ? folderDisplay(groupKey) : groupKey,
        }
        for (const cid of childCoreIds) coreToRegion[cid] = regionId
      }
      console.log(`  [Step 8] Region nodes: ${Object.keys(regionNodes).length}`)
    }

    // ===== Step 9: 节点详情 =====
    const nodeDetails: Record<
      string,
      { id: string; fullSlug?: string; text: string; tags: string[]; frontmatter?: Record<string, unknown> }
    > = {}
    for (const nodeId of effectiveNodeIds) {
      const details = contentData.get(nodeId as SimpleSlug)
      nodeDetails[nodeId] = {
        id: nodeId,
        fullSlug: details?.slug,
        text: nodeId.startsWith("tags/") ? "#" + nodeId.substring(5) : (details?.title ?? nodeId),
        tags: details?.tags ?? [],
        frontmatter: details?.frontmatter,
      }
    }
    // 聚合/大区节点详情
    for (const aggId of Object.keys(aggNodes)) {
      nodeDetails[aggId] = {
        id: aggId,
        text: aggNodes[aggId].displayText,
        tags: [],
      }
    }
    for (const [regionId, info] of Object.entries(regionNodes)) {
      nodeDetails[regionId] = {
        id: regionId,
        text: info.displayText,
        tags: [],
      }
    }

    // ===== Step 10: 首屏 graphData 组装 =====
    let firstScreenNodeIds: string[]
    let firstScreenLinks: Array<{ source: string; target: string; sourceField?: string }>

    if (regionRules && regionRules.length > 0) {
      // 大区模式
      const shouldFilterNonCore = filterNonCoreNodes && coreNodeFilter && coreNodeFilter.length > 0
      const crossRegionEdgeIds = new Set<string>()
      for (const edgeId of edgeNodeIdSet) {
        const neighborRegions = new Set<string>()
        for (const l of effectiveLinks) {
          const otherId = l.source === edgeId ? l.target : l.target === edgeId ? l.source : null
          if (otherId && coreToRegion[otherId]) neighborRegions.add(coreToRegion[otherId])
        }
        if (neighborRegions.size > 1) crossRegionEdgeIds.add(edgeId)
      }

      firstScreenNodeIds = [
        ...Object.keys(regionNodes),
        ...(shouldFilterNonCore
          ? [...crossRegionEdgeIds].filter((id) => coreNodeIdSet.has(id))
          : [...crossRegionEdgeIds]),
      ]
      const visibleSet = new Set(firstScreenNodeIds)
      firstScreenLinks = effectiveLinks.filter(
        (l) => visibleSet.has(l.source) && visibleSet.has(l.target),
      )
    } else {
      // 普通收起模式
      const shouldFilterNonCore = filterNonCoreNodes && coreNodeFilter && coreNodeFilter.length > 0
      firstScreenNodeIds = [
        ...coreNodeIdSet,
        ...Object.keys(aggNodes),
        ...(shouldFilterNonCore ? [] : [...edgeNodeIdSet]),
      ]
      const visibleSet = new Set(firstScreenNodeIds)
      firstScreenLinks = effectiveLinks.filter(
        (l) => visibleSet.has(l.source) && visibleSet.has(l.target),
      )
      // 聚合节点→核心节点的边
      for (const [aggId, info] of Object.entries(aggNodes)) {
        if (!visibleSet.has(info.coreId)) continue
        firstScreenLinks.push({
          source: aggId,
          target: info.coreId,
          sourceField: info.currentField,
        })
      }
    }
    console.log(
      `  [Step 10] First screen: ${firstScreenNodeIds.length} nodes, ${firstScreenLinks.length} links`,
    )

    // ===== 组装输出 =====
    const result: GlobalGraphPrecomputed = {
      version: 1,
      expansionMode: "on-demand",
      generatedAt: Date.now(),
      folderTitles,
      config: {
        aggregation: aggregation.length > 0 ? aggregation : undefined,
        regionRules: regionRules.length > 0 ? regionRules : undefined,
        coreNodeFilter: coreNodeFilter.length > 0 ? coreNodeFilter : undefined,
        coreNodeLimit,
        coreMinLinks,
        startCollapsed,
        filterNonCoreNodes,
        showTags,
        removeTags: removeTags.length > 0 ? removeTags : undefined,
      },
      nodeDetails,
      firstScreen: { nodes: firstScreenNodeIds, links: firstScreenLinks },
      adjacency: {
        nodeToEdgeNodeIds: updatedNodeToEdgeNodeIds,
        nodeToEdgeLinkIndices: updatedNodeToEdgeLinkIndices,
      },
      aggNodes,
      aggToCore,
      regionNodes,
      coreToRegion,
      allChildLinks: effectiveLinks,
      coreNodeIds: [...coreNodeIdSet],
      edgeNodeIds: [...edgeNodeIdSet],
      nodeLinkCounts: Object.fromEntries(nodeLinkCount),
    }

    const jsonStr = JSON.stringify(result)
    const fp = joinSegments("graph", "global", "graphGlobal") as unknown as FullSlug

    yield write({ ctx, content: jsonStr, slug: fp, ext: ".json" })

    const totalEnd = performance.now()
    console.log(`[GraphGlobal] Done in ${(totalEnd - totalStart).toFixed(0)}ms`)
    console.log(
      `[GraphGlobal] Output: ${(jsonStr.length / 1024).toFixed(0)}KB, ` +
        `${firstScreenNodeIds.length} first-screen, ` +
        `${Object.keys(aggNodes).length} agg, ` +
        `${Object.keys(regionNodes).length} region`,
    )
  }

  return {
    name: "GraphGlobal",

    // 全量构建（reset 模式）：content 包含所有文件
    async *emit(ctx, _content) {
      if (opts.enabled === false) return
      const fullIndex = JSON.parse(await readFile(joinSegments(ctx.argv.output, "static", "contentIndex.json"), "utf8")) as Record<string, ContentDetails>
      const contentData = new Map<SimpleSlug, ContentDetails>(Object.entries(fullIndex).map(([id, value]) => [simplifySlug(id as FullSlug), value]))
      yield* computeAndEmit(ctx, contentData)
    },

    // 增量构建（非 reset 模式）：从 contentIndex.json 读取全量数据
    async *partialEmit(ctx, _content, _resources, _changeEvents) {
      if (opts.enabled === false) return
      const fs = await import("node:fs/promises")
      const contentIndexPath = joinSegments(ctx.argv.output, "static", "contentIndex.json")
      let fullIndex: Record<string, ContentDetails> = {}
      try {
        const raw = await fs.readFile(contentIndexPath, "utf-8")
        fullIndex = JSON.parse(raw)
      } catch {
        console.log("[GraphGlobal] contentIndex.json not found, skipping")
        return
      }
      const contentData = new Map<SimpleSlug, ContentDetails>()
      for (const [k, v] of Object.entries(fullIndex)) {
        contentData.set(simplifySlug(k as FullSlug), v)
      }
      yield* computeAndEmit(ctx, contentData)
    },
  }
}

export type { GlobalGraphPrecomputed }
export { getFrontmatterFieldForLink }
