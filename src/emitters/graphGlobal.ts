// graphGlobal.ts - 全局图谱构建期预计算生成器
// （自 v4 client/quartz/plugins/emitters/graphGlobal.tsx 移植，仅调整 import 与类型来源）
//
// 功能：在构建时执行全局图谱的完整计算流程，输出 graphGlobal.json，
//       运行时直接加载预计算结果，跳过所有耗时计算。
//
// 预计算流程与运行时 graph3.inline.ts 中的逻辑完全一致：
// 1. 虚拟节点计算
// 2. 全局链接图构建
// 3. 节点/链接去重 + 孤儿过滤
// 4. 核心节点标记（coreNodeFilter / 连接数阈值 / 硬上限）
// 5. 邻接映射构建（nodeToEdgeNodes / nodeToEdgeLinks）
// 6. 边缘节点聚合（按 aggregation 规则）
// 7. 大区节点生成（按 regionRules）
// 8. 首屏 graphData 组装（region 模式 / 普通收起模式）
//
// 输出：graph/global/graphGlobal.json（一个文件，包含首屏 + 展开所需的全部数据）
//
// 注意：依赖 contentIndex.json 已生成（本插件的 order 必须大于 content-index-pro 的 50）。

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
import { groupShared, readSharedAggregation } from "../util/sharedAggregation"
import type { ContentDetails, IndexableFileData } from "../util/contentIndex"
import {
  extractGroupKey,
  isRuleEffective,
  matchCoreNodeFilter,
} from "../util/aggregation"
import type { AggregationRule, CoreNodeFilterConfig } from "../util/aggregation"

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
  generatedAt: number
  /** 目录显示名映射（目录路径 → 目录 index.md 的 frontmatter.title） */
  folderTitles: Record<string, string>
  config: {
    aggregation?: AggregationRule[]
    regionRules?: AggregationRule[]
    coreNodeFilter?: CoreNodeFilterConfig
    coreNodeLimit?: number
    startCollapsed?: boolean
    filterOrphans?: boolean
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
  /** 边缘节点聚合规则（YAML: options.globalGraph.aggregation） */
  aggregation?: AggregationRule[]
  /** 大区聚合规则（YAML: options.globalGraph.regionRules） */
  regionRules?: AggregationRule[]
  /** 核心节点过滤规则 */
  coreNodeFilter?: CoreNodeFilterConfig
  /** 核心节点数量硬上限 */
  coreNodeLimit?: number
  /** 全局图谱是否默认收起 */
  startCollapsed?: boolean
  /** 是否过滤孤儿节点 */
  filterOrphans?: boolean
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
  filterOrphans: true,
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
    const shared = (ctx.cfg.configuration as unknown as { aggregation?: unknown }).aggregation === undefined
      ? null
      : readSharedAggregation(JSON.parse(await readFile(joinSegments(ctx.argv.output, "static", "aggregation.json"), "utf8")))
    const aggregation: AggregationRule[] = opts.aggregation ?? []
    const regionRules: AggregationRule[] = opts.regionRules ?? []
    const coreNodeFilter: CoreNodeFilterConfig = opts.coreNodeFilter ?? []
    const coreNodeLimit = opts.coreNodeLimit ?? 100
    const startCollapsed = opts.startCollapsed ?? true
    const filterOrphans = opts.filterOrphans ?? true
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
    const effectiveNodeIds = filterOrphans ? nonOrphanNodeIds : neighbourhood
    const effectiveLinks = filterOrphans ? nonOrphanLinks : allLinks
    console.log(
      `  [Step 4] ${filterOrphans ? "Non-orphan" : "Unfiltered"}: ${effectiveNodeIds.size} nodes, ${effectiveLinks.length} links`,
    )

    // ===== Step 5: 核心节点标记 =====
    const coreNodeIdSet = new Set<string>()
    if (coreNodeFilter && coreNodeFilter.length > 0) {
      for (const nodeId of effectiveNodeIds) {
        const details = contentData.get(nodeId as SimpleSlug)
        if (matchCoreNodeFilter(nodeId, details?.frontmatter, coreNodeFilter)) {
          coreNodeIdSet.add(nodeId)
        }
      }
    } else {
      for (const nodeId of effectiveNodeIds) {
        if ((nodeLinkCount.get(nodeId) ?? 0) > 2) {
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

    // 边缘 → 核心计数
    const edgeToCoreCount = new Map<string, number>()
    for (const ids of Object.values(nodeToEdgeNodeIds)) {
      for (const id of ids) {
        edgeToCoreCount.set(id, (edgeToCoreCount.get(id) ?? 0) + 1)
      }
    }

    const hasRegionRules = regionRules && regionRules.length > 0
    const singleLinkEdgeNodeIds = new Set(
      [...edgeNodeIdSet].filter((id) => hasRegionRules || (edgeToCoreCount.get(id) ?? 0) === 1),
    )
    console.log(`  [Step 6] Single-link edges: ${singleLinkEdgeNodeIds.size}`)

    // ===== Step 7: 边缘节点聚合 =====
    const aggNodes: Record<string, PreAggNodeInfo> = {}
    const aggToCore: Record<string, string> = {}
    const childToAgg = new Map<string, string>()
    const childLinksPool: Array<{ source: string; target: string; sourceField?: string }> = []

    const rules = aggregation ?? []

    if (shared) {
      // Every core owns its own membership, including neighbors shared with other cores.
      for (const [coreId, edgeIds] of Object.entries(nodeToEdgeNodeIds)) {
        const grouped = groupShared(edgeIds, shared, id => {
          const details = contentData.get(id as SimpleSlug)
          return { slug: details?.slug ?? id, frontmatter: details?.frontmatter }
        })
        for (const group of grouped.groups) {
          const { rule, key, members: childIds, remainingRules } = group
          const aggId = `agg:shared:${JSON.stringify([coreId, rule, key])}`
          const childLinkIndices: number[] = []
          const memberIds = new Set(childIds)
          for (const link of effectiveLinks) {
            if (memberIds.has(link.source) || memberIds.has(link.target)) {
              childLinkIndices.push(childLinksPool.length)
              childLinksPool.push(link)
            }
          }
          aggNodes[aggId] = {
            coreId, childNodeIds: childIds, childLinkIndices, remainingRules,
            currentField: rule.type === "folder" ? "📁" : rule.field!,
            displayText: rule.type === "folder" ? `📁 ${key === "/" ? folderTitles["/"] ?? "根目录" : folderDisplay(key)}` : key,
          }
          aggToCore[aggId] = coreId
          for (const id of childIds) childToAgg.set(`${coreId}\t${id}`, aggId)
        }
      }
    } else if (rules.length > 0) {
      for (const [coreId, edgeNodeIds] of Object.entries(nodeToEdgeNodeIds)) {
        let leavesForNextRule = edgeNodeIds.filter((id) => singleLinkEdgeNodeIds.has(id))
        if (leavesForNextRule.length <= 1) continue

        for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
          const rule = rules[ruleIdx]
          if (leavesForNextRule.length <= 1) break

          // 检查规则有效性
          if (rule.type !== "folder") {
            if (
              !isRuleEffective(
                leavesForNextRule.map((id) => ({
                  slug: id,
                  frontmatter: contentData.get(id as SimpleSlug)?.frontmatter,
                })),
                rule,
              )
            )
              continue
          }

          const groupMap = new Map<string, string[]>()
          for (const leafId of leavesForNextRule) {
            const details = contentData.get(leafId as SimpleSlug)
            let groupKey: string | null = null
            if (details) {
              groupKey = extractGroupKey({ slug: leafId, frontmatter: details.frontmatter }, rule)
            }
            if (rule.type !== "folder" && groupKey === null) groupKey = "(无)"
            if (groupKey !== null) {
              const group = groupMap.get(groupKey) ?? []
              group.push(leafId)
              groupMap.set(groupKey, group)
            }
          }

          if (rule.type === "folder" && groupMap.size <= 1) continue
          if (groupMap.size === 0) continue

          const currentField = rule.type === "folder" ? "📁" : (rule.field ?? rule.type)
          for (const [groupKey, childIds] of groupMap) {
            const aggId = `agg:${coreId}:${rule.type}:${rule.field ?? ""}:${groupKey}`

            const displayPrefix = rule.type === "folder" ? "📁 " : ""
            const displayText =
              rule.type === "folder"
                ? groupKey === "/"
                  ? `📁 ${folderTitles["/"] ?? "根目录"}`
                  : `📁 ${folderDisplay(groupKey)}`
                : `${displayPrefix}${groupKey}`

            // 收集子节点间链接
            const childLinkIndices: number[] = []
            const childLinkKeySet = new Set<string>()
            for (const l of effectiveLinks) {
              if (childIds.includes(l.source) || childIds.includes(l.target)) {
                const key = `${l.source}->${l.target}`
                if (!childLinkKeySet.has(key)) {
                  childLinkKeySet.add(key)
                  childLinksPool.push({
                    source: l.source,
                    target: l.target,
                    sourceField: l.sourceField,
                  })
                  childLinkIndices.push(childLinksPool.length - 1)
                }
              }
            }

            aggNodes[aggId] = {
              coreId,
              childNodeIds: childIds,
              childLinkIndices,
              remainingRules: rules.slice(ruleIdx + 1),
              currentField,
              displayText,
            }
            aggToCore[aggId] = coreId
            for (const cid of childIds) childToAgg.set(`${coreId}\t${cid}`, aggId)
          }

          // 过滤已被聚合的叶子
          const currentAggedIds = new Set<string>()
          for (const [, info] of Object.entries(aggNodes)) {
            if (info.coreId === coreId && info.currentField === currentField) {
              for (const cid of info.childNodeIds) currentAggedIds.add(cid)
            }
          }
          leavesForNextRule = leavesForNextRule.filter((id) => !currentAggedIds.has(id))
        }
      }
    }
    console.log(`  [Step 7] Agg nodes: ${Object.keys(aggNodes).length}`)

    // 更新 nodeToEdgeNodeIds：聚合子节点替换为聚合节点
    const updatedNodeToEdgeNodeIds: Record<string, string[]> = {}
    const updatedNodeToEdgeLinkIndices: Record<string, number[]> = {}

    for (const [coreId, oldEdgeIds] of Object.entries(nodeToEdgeNodeIds)) {
      const newEdgeIds: string[] = []
      const newLinkIndices: number[] = []
      const replacedAggIds = new Set<string>()

      for (const edgeId of oldEdgeIds) {
        const aggId = childToAgg.get(`${coreId}\t${edgeId}`)
        if (aggId && aggNodes[aggId]?.coreId === coreId) {
          if (!replacedAggIds.has(aggId)) {
            replacedAggIds.add(aggId)
            newEdgeIds.push(aggId)
            newLinkIndices.push(-1)
          }
        } else {
          newEdgeIds.push(edgeId)
          const coreIdx = nodeToEdgeLinkIndices[coreId] ?? []
          for (const li of coreIdx) {
            const l = effectiveLinks[li]
            if (l && (l.source === edgeId || l.target === edgeId)) {
              // [FIX] 链接统一写入 childLinksPool 并存其索引，与运行时
              // pc.allChildLinks[linkIndices[i]] 的查询保持同一索引空间。
              childLinksPool.push({
                source: l.source,
                target: l.target,
                sourceField: l.sourceField,
              })
              newLinkIndices.push(childLinksPool.length - 1)
              break
            }
          }
        }
      }
      updatedNodeToEdgeNodeIds[coreId] = newEdgeIds
      updatedNodeToEdgeLinkIndices[coreId] = newLinkIndices
    }

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
        if (!groupKey) groupKey = "(未分组)"
        const group = groupMap.get(groupKey) ?? []
        group.push(coreId)
        groupMap.set(groupKey, group)
      }

      for (const [groupKey, childCoreIds] of groupMap) {
        const regionId = `region:${groupKey}`
        regionNodes[regionId] = {
          childCoreIds,
          remainingRules: regionRules.slice(1),
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
      generatedAt: Date.now(),
      folderTitles,
      config: {
        aggregation: aggregation.length > 0 ? aggregation : undefined,
        regionRules: regionRules.length > 0 ? regionRules : undefined,
        coreNodeFilter: coreNodeFilter.length > 0 ? coreNodeFilter : undefined,
        coreNodeLimit,
        startCollapsed,
        filterOrphans,
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
      allChildLinks: childLinksPool,
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
    async *emit(ctx, content) {
      if (opts.enabled === false) return
      const contentData = new Map<SimpleSlug, ContentDetails>()
      for (const [, file] of content) {
        const data = file.data as unknown as IndexableFileData
        const slug = data.slug
        if (!slug) continue
        if (data.text && data.text !== "") {
          contentData.set(simplifySlug(slug), {
            slug,
            filePath: (data.relativePath ?? "") as never,
            title: (data.frontmatter?.title as string) || slug,
            links: data.links ?? [],
            tags: (data.frontmatter?.tags as string[]) ?? [],
            content: data.text ?? "",
            frontmatter: data.frontmatter ?? {},
          })
        }
      }
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
