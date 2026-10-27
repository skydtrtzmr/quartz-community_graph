// @ts-nocheck
// ============================================================================
// graph-pro 交互层（局部图谱 + 全局图谱）
// 移植自 v4：client/quartz/components/scripts/graph3.inline.ts
// 移植差异：
//   1. d3 / pixi.js / @tweenjs/tween.js 作为 npm 依赖随插件本地打包（零 CDN）
//   2. 工具函数改从 @quartz-community/utils 取（v5 同名同语义：getFullSlug 读 body.dataset.slug）
//   3. 类型改为 type-only import，避免把 Graph.tsx（preact）卷进页面脚本
//   4. 依赖额外挂到 globalThis，兼容任何遗留的 window.d3 / window.PIXI 访问
// ============================================================================
import type { ContentDetails } from "../../util/contentIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  zoomIdentity,
  select,
  drag,
  zoom,
} from "d3"
import { Text, Graphics, Application, Container, Circle } from "pixi.js"
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import {
  registerEscapeHandler,
  removeAllChildren,
  getFullSlug,
  resolveRelative,
  simplifySlug,
  slugifyPath,
  getBasePath,
  getFullSlugFromUrl,
} from "@quartz-community/utils"
import type { FullSlug, SimpleSlug } from "@quartz-community/types"
import type { D3Config } from "../Graph"
import { AggregationRule, UNCLASSIFIED_KEY, commonFolderOf } from "../../util/aggregation"
import { focusNodeIds, graphViewOf, isExpandableCollectionNode, selectCoreNodes } from "./views"
import { resolveCoreMinLinks, selectScope, type GraphSelection } from "../../util/coreMinLinks"
import { createGraphSimulation, createGraphLinkForce, createAggAwareCollide, simulationSettings } from "./graphSimulation"
import { indexGraphLinks, projectLocalGraph } from "./graphLinkIndex"
import { createOnDemandCache } from "./onDemandCache"
import { createGraphRenderScope } from "./graphRenderScope"
import { expansionSeedAngle } from "./expansionLayout"
import { filterDimensionGraph, parseFilter } from "../../util/dimensionGraphFilter"
import { globalCoreRules, groupGlobalNeighbors, groupShared, readSharedAggregation } from "../../util/sharedAggregation"
import { selectSharedRules } from "../../util/dimensionSelection"
import { showOriginalCenterLink } from "../../util/aggregatedLinks"
import { ExpansionPages, resolveExpandBatchSize, resolveMaxVisibleNodes, resolveLoadBatchSize } from "./expansionPages"
import { createExpansionControls, type ExpansionControlItem } from "./expansionControls"
import { filterGraphContent } from "../../util/contentIndex"
import * as d3Namespace from "d3"
import * as pixiNamespace from "pixi.js"

;(globalThis as any).d3 = (globalThis as any).d3 ?? d3Namespace
;(globalThis as any).PIXI = (globalThis as any).PIXI ?? pixiNamespace

// ============ Singleton 守护 ============
// inline 脚本在每次 SPA 导航后都会重新执行，用模块级标志防止重复初始化
let initialized = false
if (initialized) {
  // 脚本重复执行，直接退出
  console.log("graph2.inline.ts: initialized 已初始化，直接退出")

  // @ts-ignore - early return at module level via throw-trick not needed; the if block handles it
} else {
  initialized = true
  console.log("graph2.inline.ts: 初始化")
  console.debug("[Graph] Initializing singleton graph script.")
  main()
}

// ============ 类型定义 ============
interface LocalGraphData {
  version: number
  view?: "folder"
  expansionMode?: "on-demand"
  center: SimpleSlug
  depth: number
  generatedAt: number
  nodes: Record<SimpleSlug, ContentDetails>
  edges: Array<{ source: SimpleSlug; target: SimpleSlug; sourceField?: string }>
  folderTitles?: Record<string, string>
  /** 维度子图（aggregation-page-pro 产物）扩展：命中实体 + 各自所属目录上下文 */
  matched?: Array<{ slug: string; scope: string }>
}

/** 拼接 basePath 与相对产物地址（basePath 允许带或不带前导斜杠） */
function joinArtifactUrl(basePath: string, path: string): string {
  const prefix = basePath ? (basePath.startsWith("/") ? basePath : `/${basePath}`) : ""
  return `${prefix}/${path.replace(/^\//, "")}`
}

/** 逐段编码（保留 `/`），用于含中文取值的维度子图地址 */
function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

// ============ Local Graph 缓存模块（供 graph2 和 Backlinks 共享）============
//
// 设计目标：确保同一 slug 的 local graph JSON 只发起一次网络请求
//
// 工作原理 - Promise 缓存模式：
// 1. 使用 Map 缓存 fetch Promise，key = `${basePath}:${fullSlug}`
// 2. 首次调用 fetchCachedLocalGraph() 时：
//    - 检查缓存，发现没有 → 创建新的 Promise（此时 fetch 开始）
//    - 将 Promise 存入缓存 → 返回 Promise
// 3. 后续调用时：
//    - 检查缓存，发现已有 → 直接返回缓存的 Promise（不重复创建，不重复 fetch）
//
// 执行顺序无关性：
// - 无论 graph2.inline.ts（局部图谱）还是 Backlinks（反向链接）先调用
// - Promise 被创建时，async 函数体会立即执行到第一个 await（即 fetch 开始）
// - 后续调用返回的是同一个 Promise，网络请求只有一次
//
// SPA 导航兼容性：
// - 页面导航会重新执行 graph2.inline.ts（singleton 守护确保单次执行）
// - 模块级的 localGraphPromiseCache 在页面刷新时会重新初始化
// - 因此每次导航到新页面都会获取最新的 local graph 数据
//
// 对比 contentIndex 的 fetchData：
// - fetchData 没有 TTL，导航后不重新 fetch（适合静态数据）
// - localGraph 缓存随页面刷新重置（适合每页独立的数据）
//
declare global {
  interface Window {
    __localGraphCache: {
      fetch: (fullSlug: string, basePath: string) => Promise<any | null>
    }
  }
}

// Promise 缓存：key -> Promise<data>
const localGraphPromiseCache = new Map<string, Promise<any | null>>()

// 纯 JS 实现的 djb2 哈希（替代 sha256，兼容 HTTP 非安全上下文）
function djb2Hash(message: string): string {
  let hash = 5381
  for (let i = 0; i < message.length; i++) {
    hash = (hash << 5) + hash + message.charCodeAt(i)
    hash = hash & 0xffffffff
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// 统一使用 djb2Hash 计算路径，与构建端 graphLocal.tsx 保持一致
function getLocalGraphHash(message: string): string {
  return djb2Hash(message).slice(0, 4)
}

// ===== 全局图谱预计算 JSON 加载 =====
// 构建时已计算好的全局图谱首屏数据 + 展开所需映射，运行时直接加载即可跳过全部计算
interface GlobalGraphPrecomputed {
  version: number
  generatedAt: number
  config: {
    aggregation?: AggregationRule[]
    regionRules?: AggregationRule[]
    coreNodeFilter?: any
    coreNodeLimit?: number
    startCollapsed?: boolean
    filterNonCoreNodes?: boolean
    showTags?: boolean
    removeTags?: string[]
  }
  nodeDetails: Record<
    string,
    { id: string; text: string; tags: string[]; frontmatter?: Record<string, unknown> }
  >
  firstScreen: {
    nodes: string[]
    links: Array<{ source: string; target: string; sourceField?: string }>
  }
  adjacency: {
    nodeToEdgeNodeIds: Record<string, string[]>
    nodeToEdgeLinkIndices: Record<string, number[]>
  }
  aggNodes: Record<
    string,
    {
      coreId: string
      childNodeIds: string[]
      childLinkIndices: number[]
      remainingRules: AggregationRule[]
      currentField: string
    }
  >
  aggToCore: Record<string, string>
  regionNodes: Record<
    string,
    { childCoreIds: string[]; remainingRules: AggregationRule[]; currentField: string }
  >
  coreToRegion: Record<string, string>
  allChildLinks: Array<{ source: string; target: string; sourceField?: string }>
  coreNodeIds: string[]
  edgeNodeIds: string[]
  nodeLinkCounts: Record<string, number>
  /** 目录显示名映射（目录路径 → 目录 index.md 的 frontmatter.title），旧版 JSON 无此字段 */
  folderTitles?: Record<string, string>
}

async function fetchGlobalGraphPrecomputed(
  basePath: string,
): Promise<GlobalGraphPrecomputed | null> {
  const indexPath = basePath
    ? `/${basePath}/graph/global/graphGlobal.json`
    : `/graph/global/graphGlobal.json`
  try {
    const resp = await fetch(indexPath)
    if (!resp.ok) return null
    const json = await resp.json()
    console.log(
      `[Graph] ✅ graphGlobal.json loaded: ${json.firstScreen?.nodes?.length ?? 0} first-screen nodes`,
    )
    return json as GlobalGraphPrecomputed
  } catch (e) {
    console.log("[Graph] ❌ graphGlobal.json not found, falling back to runtime computation")
    return null
  }
}

async function fetchCachedLocalGraph(
  fullSlug: string,
  basePath: string,
  overrideUrl?: string,
): Promise<any | null> {
  // ⚠️ 产物（emitters/graphLocal.ts）是以 **simplifySlug 之后**的 slug 作为键落盘的：
  // index 类页面 `项目/index` → `项目/`。这里必须先把 slug 归一化再算 hash / 拼路径，
  // 否则文件夹页（以及其它 index 派生页）会 404 → 回退 BFS → 只渲染出「中心节点自己」。
  const simpleSlug = simplifySlug(fullSlug as FullSlug) as unknown as string

  // 容器显式指定了产物地址（维度值页）时，以该地址为准并单独缓存
  const cacheKey = overrideUrl ? `url:${overrideUrl}` : `${basePath}:${simpleSlug}`

  // 检查 Promise 缓存 - 命中则直接返回已有 Promise
  if (localGraphPromiseCache.has(cacheKey)) {
    console.log("[LocalGraph Cache] 使用缓存 Promise:", cacheKey)
    return localGraphPromiseCache.get(cacheKey)!
  }

  // 创建新的 fetch Promise 并缓存
  // 注意：async IIFE 被调用时函数体立即执行，fetch 请求从这里开始
  const fetchPromise = (async () => {
    const hash = getLocalGraphHash(simpleSlug)
    const dir1 = hash.slice(0, 2)
    const dir2 = hash.slice(2, 4)
    const localGraphPath = overrideUrl
      ? encodePathSegments(joinArtifactUrl(basePath, overrideUrl))
      : basePath
        ? `/${basePath}/graph/local/${dir1}/${dir2}/${encodeURIComponent(simpleSlug)}.json`
        : `/graph/local/${dir1}/${dir2}/${encodeURIComponent(simpleSlug)}.json`

    try {
      console.log("[LocalGraph Cache] Fetch:", localGraphPath)
      const response = await fetch(localGraphPath)
      if (!response.ok) {
        console.log("[LocalGraph Cache] Fetch failed:", response.status)
        return null
      }
      const data = await response.json()
      console.log("[LocalGraph Cache] Fetch success:", cacheKey)
      return data
    } catch (e) {
      console.log("[LocalGraph Cache] Fetch error:", e)
      return null
    }
  })()

  localGraphPromiseCache.set(cacheKey, fetchPromise)
  return fetchPromise
}

// 暴露给全局，让 Backlinks runtime 脚本可以使用共享缓存
window.__localGraphCache = {
  fetch: fetchCachedLocalGraph,
}

function main() {
  // ============ 世代计数器（竞态保护）============
  // 每次新的导航都会递增世代，旧的异步渲染检测到世代变化后自我废弃
  let renderGeneration = 0

  function readDimensionOrder(folder: string, basePath: string): string[] {
    try {
      const raw = localStorage.getItem(`quartz:dimensionOrder:${basePath}:${folder}`)
      const value = raw ? JSON.parse(raw) : []
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  }

  function currentFolder(fullSlug: string): string {
    const slug = fullSlug.replace(/\/index$/, "").replace(/\/+$/, "")
    return fullSlug.endsWith("/index") ? slug : slug.slice(0, slug.lastIndexOf("/"))
  }

  function dimensionMaxLevels(): number {
    const raw = document.querySelector<HTMLElement>(".explorer3")?.dataset.dimensionmaxlevels
    const parsed = Number.parseInt(raw ?? "", 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 2
  }

  function checkGeneration(gen: number): boolean {
    return gen === renderGeneration
  }

  // ============ basePath（多域名支持）============
  let basePath = ""

  // ============ 类型定义 ============
  type GraphicsInfo = {
    color: string
    gfx: Graphics
    alpha: number
    active: boolean
  }

  type NodeData = {
    id: SimpleSlug
    text: string
    tags: string[]
    isCore?: boolean
    /** 当前视角的主节点；只影响视觉标记，不参与聚合和力布局。 */
    isFocus?: boolean
    isExpanded?: boolean
    edgeNodeCount?: number
    isAggregation?: boolean
    /** 聚合节点收起时的碰撞半径（基于子节点数量） */
    aggCollapsedRadius?: number
    /** 聚合节点展开后的碰撞半径 */
    aggExpandedRadius?: number
    /** 聚合节点包含的子节点数量 */
    aggChildCount?: number
    /** 聚合节点展开后，子节点相对于聚合中心的目标偏移（用于 tick 强约束） */
    aggTargetOffset?: { x: number; y: number }
    /** 大区节点标记 */
    isRegion?: boolean
    /** 大区节点包含的核心节点 ID 列表 */
    regionChildIds?: SimpleSlug[]
  } & SimulationNodeDatum

  type SimpleLinkData = {
    source: SimpleSlug
    target: SimpleSlug
    sourceField?: string
  }

  type LinkData = {
    source: NodeData
    target: NodeData
    sourceField?: string
  } & SimulationLinkDatum<NodeData>

  type LinkRenderData = GraphicsInfo & {
    simulationData: LinkData
    label?: Text
    /** 是否为聚合边（聚合节点→核心节点） */
    isAggregation?: boolean
  }

  type NodeRenderData = GraphicsInfo & {
    simulationData: NodeData
    label: Text
    badge?: Graphics
    badgeText?: Text
    /** 节点中心显示的直接关联数量（全局图谱核心节点） */
    countLabel?: Text
    /** 是否为聚合节点 */
    isAggregation?: boolean
    /** 聚合节点展开后的背景圆圈 */
    aggBg?: Graphics
    /** 聚合节点展开后的半径 */
    aggExpandedRadius?: number
  }

  type TweenNode = {
    update: (time: number) => void
    stop: () => void
  }

  const DOUBLE_CLICK_DELAY = 300

  // ============ 对象池（复用 Graphics/Text，减少 GC 和 GPU 碎片）============
  class ObjectPool<T> {
    private pool: T[] = []
    private createFn: () => T
    private resetFn: (obj: T) => void

    constructor(createFn: () => T, resetFn: (obj: T) => void) {
      this.createFn = createFn
      this.resetFn = resetFn
    }

    acquire(): T {
      return this.pool.length > 0 ? this.pool.pop()! : this.createFn()
    }

    release(obj: T): void {
      this.resetFn(obj)
      this.pool.push(obj)
    }

    clear(): void {
      for (const obj of this.pool) {
        this.resetFn(obj)
        if (typeof (obj as any).destroy === "function") {
          // Graphics owns its context; Pixi's text/white textures are shared.
          ;(obj as any).destroy()
        }
      }
      this.pool = []
    }
  }

  // ============ visited 记录 ============
  const localStorageKey = "graph-visited"
  function getVisited(): Set<SimpleSlug> {
    return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? "[]"))
  }

  function addToVisited(slug: SimpleSlug) {
    const visited = getVisited()
    visited.add(slug)
    localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
  }

  // ============ 预加载 fetchData（让数据在后台并行下载）============
  let fetchDataStarted = false
  function ensureFetchData() {
    if (fetchDataStarted) return
    fetchDataStarted = true
    console.log("[Graph] 预加载 fetchData 开始")
    fetchData
      .then(() => {
        console.log("[Graph] 预加载 fetchData 完成")
      })
      .catch((err) => {
        console.error("[Graph] 预加载 fetchData 失败:", err)
      })
  }

  // ============ 渲染核心函数 ============
  async function renderGraph(
    graph: HTMLElement,
    fullSlug: FullSlug,
    generation: number,
    isRequestCurrent: () => boolean = () => true,
  ): Promise<() => void> {
    const isCurrent = () => checkGeneration(generation) && isRequestCurrent() && graph.isConnected
    if (!isCurrent()) return () => {}
    const startedAt = performance.now()
    let phaseStartedAt = startedAt
    const timings: Record<string, number> = {}
    const markPhase = (name: string) => {
      const now = performance.now()
      timings[name] = Math.round((now - phaseStartedAt) * 10) / 10
      phaseStartedAt = now
    }
    console.log("[renderGraph] start")
    const slug = simplifySlug(fullSlug)
    const visited = getVisited()
    removeAllChildren(graph)

    if (!isCurrent()) return () => {}

    let {
      drag: enableDrag,
      zoom: enableZoom,
      depth,
      scale,
      repelForce,
      centerForce,
      linkDistance,
      fontSize,
      opacityScale,
      removeTags,
      showTags,
      focusOnHover,
      enableRadial,
      showArrows = true,
      showBadge = false,
      startCollapsed = false,
      countLabelMaxDisplay = 99,
      aggregation,
      showAggregatedNodeLinks = false,
      coreNodeFilter,
      coreNodeLimit: rawCoreNodeLimit,
      coreMinLinks,
      expandBatchSize: rawExpandBatchSize,
      maxVisibleNodes: rawMaxVisibleNodes,
      loadBatchSize: rawLoadBatchSize,
      coreAggregationMaxLevels,
      regionRules,
      expandCoresOnRegionOpen = true,
      filterNonCoreNodes = true,
      colorBy,
    } = JSON.parse(graph.dataset["cfg"]!) as D3Config



    // 全局图谱默认硬上限 100；局部图谱不设上限
    const declaredView = graph.dataset.graphView ?? (graph.dataset.dimensionGraph !== undefined
      ? "dimension" : depth < 0 ? "global" : "local")
    const coreNodeLimit = declaredView === "global" ? (rawCoreNodeLimit ?? 100) : rawCoreNodeLimit

    // 约定：basePath 不带前导斜杠（Graph 组件用 getBasePath 去掉；注入宿主取自 body[data-basepath] 会带），
    // 这里统一裁掉，避免拼出 `//<域>/graph/...` 这类 404 路径
    basePath = (graph.dataset.basepath || "").replace(/^\//, "")

    // 维度值页：容器自带产物地址（graph/dimensions/**），并由脚本按 URL 参数裁剪
    const localGraphUrl = graph.dataset["localGraphUrl"] || undefined
    const isDimensionGraph = graph.dataset["dimensionGraph"] !== undefined
    let selection: GraphSelection | undefined
    if (declaredView === "global" || declaredView === "dimension" || declaredView === "folder") {
      const response = await fetch(`${basePath ? `/${basePath}` : ""}/graph/selection.json`)
      if (!response.ok) throw new Error(`[Graph] selection.json: HTTP ${response.status}; rebuild domain`)
      selection = await response.json() as GraphSelection
      coreMinLinks = resolveCoreMinLinks(coreMinLinks ?? selection.coreMinLinks)
    }
    markPhase("selection")
    const excludeUnlinkedGlobalNodes = declaredView === "global" && resolveCoreMinLinks(coreMinLinks) > 0


    const dimensionScope = isDimensionGraph
      ? new URLSearchParams(window.location.search).get("scope") ?? ""
      : ""
    const dimensionValue = isDimensionGraph
      ? document.querySelector<HTMLElement>("[data-dimension-value]")
      : null
    const dimensionUsedFields = new Set<string>()
    if (isDimensionGraph) {
      const field = dimensionValue?.dataset.field
      if (field) dimensionUsedFields.add(field)
      for (const entry of parseFilter(new URLSearchParams(window.location.search).get("filter"))) {
        dimensionUsedFields.add(entry.field)
      }
    }

    // Stage 2: local graph consumes the shared artifact, including subsequent expansion.
    // The dataset only enables loading; rule values come exclusively from the JSON.
    let sharedAggregation = null
    if (graph.dataset.sharedAggregation === "true") {
      try {
        const response = await fetch(`${basePath ? `/${basePath}` : ""}/static/aggregation.json`)
        if (!response.ok) throw new Error(`aggregation.json: HTTP ${response.status}`)
        const artifact = readSharedAggregation(await response.json())
        sharedAggregation = selectSharedRules(
          artifact,
          (folder) => readDimensionOrder(folder, basePath),
          dimensionMaxLevels(),
          isDimensionGraph ? dimensionScope : currentFolder(fullSlug),
        )
        if (isDimensionGraph) {
          // The current value and its ancestor filters have already been consumed by the list.
          // Only the remaining configured dimensions can partition this graph.
          sharedAggregation = {
            ...sharedAggregation,
            resolved: Object.fromEntries(
              Object.entries(sharedAggregation.resolved).map(([folder, rules]) => [
                folder,
                rules.filter((rule) => rule.type !== "field" || !dimensionUsedFields.has(rule.field!)),
              ]),
            ),
          }
        }
      } catch (error) {
        if (!isCurrent()) return () => {}
        graph.textContent = "聚合规则加载失败，请检查 aggregation.json 并重新构建。"
        console.error("[Graph] Shared aggregation failed", error)
        return () => {}
      }
      if (!isCurrent()) return () => {}
    }

    markPhase("aggregation")
    // Folder collections carry their own scope and never use the file-page BFS depth.
    const precomputeDepth = parseInt(graph.dataset["precomputeDepth"] ?? "1")

    const isFolderGraph = graph.dataset.graphView === "folder" && depth > 0
    const usePrecomputed = isFolderGraph || (depth > 0 && depth <= precomputeDepth)

    // 优化：如果是局部图谱且使用预计算，先尝试加载预计算 JSON
    // 如果成功，直接使用预计算数据，跳过 fetchData 和 BFS
    let localGraphData: LocalGraphData | null = null
    let data: Map<SimpleSlug, ContentDetails> | null = null

    if (usePrecomputed) {
      console.log("[Graph] ===== ATTEMPTING TO LOAD LOCAL GRAPH JSON (priority) =====")
      try {
        if (!isCurrent()) return () => {}
        const pdata = await fetchCachedLocalGraph(fullSlug, basePath, localGraphUrl)
        if (!isCurrent()) return () => {}
        if (pdata && (isFolderGraph && pdata.view === "folder" || pdata.depth >= depth)) {
          localGraphData = pdata as LocalGraphData
          const visibleNodes = filterGraphContent(new Map(Object.entries(localGraphData.nodes)))
          localGraphData = {
            ...localGraphData,
            nodes: Object.fromEntries(visibleNodes),
            edges: localGraphData.edges.filter(edge => visibleNodes.has(edge.source) && visibleNodes.has(edge.target)),
            matched: localGraphData.matched?.filter(match => visibleNodes.has(match.slug)),
          }
          // 维度子图：按 ?scope=（目录前缀）与 ?context=（来源节点一跳）裁剪，
          // 必须在下面构建 neighbourhood/links 之前完成，这样后续所有派生结构都一致
          if (isDimensionGraph) {
            const params = new URLSearchParams(window.location.search)
            const filtered = filterDimensionGraph(localGraphData, {
              scope: params.get("scope") ?? "",
              context: params.get("context") ?? "",
              filter: params.get("filter") ?? "",
            })
            // ⚠️ 必须浅拷贝：fetchCachedLocalGraph 返回的是 Promise 缓存里的**同一个对象**，
            // 原地裁剪会让第二次裁剪作用在已裁剪的数据上（切回 scope 后图谱越裁越空）
            localGraphData = {
              ...localGraphData,
              nodes: filtered.nodes as typeof localGraphData.nodes,
              edges: filtered.edges as typeof localGraphData.edges,
              matched: filtered.matched,
            }
            // 调试用：把裁剪后的规模写到容器上，便于排查「参数是否真的生效」
            graph.dataset["dimensionNodeCount"] = String(Object.keys(filtered.nodes).length)
            graph.dataset["dimensionEdgeCount"] = String(filtered.edges.length)
            console.log(
              `[Graph] 维度子图裁剪：scope=${params.get("scope") ?? "-"} context=${params.get("context") ?? "-"} filter=${params.get("filter") ?? "-"} -> ${Object.keys(filtered.nodes).length} 节点 / ${filtered.edges.length} 边`,
            )
          }
          const nodeCount = Object.keys(localGraphData.nodes).length
          console.log(
            `[Graph] ===== SUCCESS: Loaded local JSON with ${nodeCount} nodes, ${localGraphData.edges.length} edges =====`,
          )
          console.log("[Graph] ===== SKIPPING fetchData (using precomputed data) =====")
        } else if (pdata) {
          console.log(
            `[Graph] Local JSON depth (${(pdata as any).depth}) < required (${depth}), will use fetchData + BFS`,
          )
        } else {
          console.log("[Graph] Local JSON not found, will use fetchData + BFS")
        }
      } catch (e) {
        console.log("[Graph] Error fetching local JSON:", e, "- will use fetchData + BFS")
      }
    }

    // 如果预计算不可用或不需要，使用 fetchData + BFS/全局
    let globalPrecomputed: GlobalGraphPrecomputed | null = null
    if (!localGraphData) {
      if (!isCurrent()) return () => {}

      // [GRAPH3] 全局图谱优先加载预计算的 graphGlobal.json
      if (declaredView === "global") {
        console.log("[GRAPH3] 全局图谱模式，尝试加载 graphGlobal.json...")
        globalPrecomputed = await fetchGlobalGraphPrecomputed(basePath)
      }

      if (globalPrecomputed) {
        // ===== 预计算路径：从 graphGlobal.json 构建所有运行时数据结构 =====
        console.log("[GRAPH3] ✅ 使用预计算数据，跳过全部运行时计算")
        data = new Map() // 空 Map，预计算分支会填充 contentData
      } else {
        // 回退：加载完整 contentIndex
        console.log("[DEBUG] 开始等待 fetchData")
        data = filterGraphContent(new Map(
          Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
            simplifySlug(k as FullSlug),
            v,
          ]),
        ))
        console.log("[DEBUG] fetchData 完成，数据条目数:", data.size)
      }
      if (!isCurrent()) return () => {}
    } else {
      // 局部预计算成功时，从 localGraphData.nodes 构建 graphData
      console.log("[Graph] ===== BUILDING graphData FROM PRECOMPUTED =====")
      data = new Map(Object.entries(localGraphData.nodes) as [SimpleSlug, ContentDetails][])
    }

    // 确保 data 已定义（TypeScript 智能推断）
    const contentData = data!
    markPhase("loadAndParseGraph")
    graph.dataset.rawNodeCount = String(contentData.size || Object.keys(globalPrecomputed?.nodeDetails ?? {}).length)
    const graphView = graphViewOf(depth, isDimensionGraph, declaredView)
    const isGlobalGraph = graphView === "global"
    const expandBatchSize = resolveExpandBatchSize(rawExpandBatchSize)
    const initialNodeLimit = resolveMaxVisibleNodes(rawMaxVisibleNodes)
    const loadBatchSize = resolveLoadBatchSize(rawLoadBatchSize)

    // ===== 前向声明：预计算路径和计算路径都会设置的变量 =====
    // 这些变量在展开/收起函数中被引用，必须提升到两个路径的公共作用域
    let allNodes: NodeData[] = []
    let nodeLinkCount = new Map<string, number>()
    let nodeToEdgeNodes: Map<SimpleSlug, NodeData[]> = new Map()
    let nodeToEdgeLinks: Map<SimpleSlug, LinkData[]> = new Map()
    let aggNodeToChildNodes: Map<SimpleSlug, NodeData[]> = new Map()
    let aggNodeToChildLinks: Map<SimpleSlug, LinkData[]> = new Map()
    let aggToCoreMap: Map<SimpleSlug, SimpleSlug> = new Map()
    let regionNodeInfoMap: Map<SimpleSlug, any> = new Map()
    let coreToRegionMap: Map<SimpleSlug, SimpleSlug> = new Map()
    // [FOLDER-TITLE] 目录显示名映射（目录路径 → 目录 index.md 的 frontmatter.title）
    let folderTitleMap: Map<string, string> = new Map()
    /** folder 分组的显示名：目录 index.md 有 title 时用 title，否则用目录路径 */
    const normalizeFolderKey = (key: string): string =>
      key === "/" ? "/" : key.replace(/^\/+|\/+$/g, "")
    const folderDisplay = (groupKey: string): string =>
      folderTitleMap.get(normalizeFolderKey(groupKey)) ?? groupKey
    // 局部图谱预计算不会携带全局 graphGlobal.json 的 folderTitles，
    // 因此从当前图数据的目录 index.md 补建映射，保证局部聚合与全局图谱一致。
    if (!globalPrecomputed) {
      for (const [nodeSlug, details] of contentData.entries()) {
        const filePath = details.filePath as unknown as string | undefined
        const title = details.frontmatter?.title
        if (
          filePath &&
          (filePath === "index.md" || filePath.endsWith("/index.md")) &&
          typeof title === "string" &&
          title.trim() !== ""
        ) {
          folderTitleMap.set(normalizeFolderKey(nodeSlug), title.trim())
        }
      }
      for (const [key, title] of Object.entries(localGraphData?.folderTitles ?? {})) {
        folderTitleMap.set(normalizeFolderKey(key), title)
      }
      console.log(
        `[DBG-folderTitle] local/预计算路径: size=${folderTitleMap.size}, ` +
          `keys=[${[...folderTitleMap.keys()].join(",")}]`,
      )
    }
    let graphData: { nodes: NodeData[]; links: LinkData[] }
    const listingHost = graphView === "dimension"
      ? document.querySelector<HTMLElement>("[data-dimension-value][data-listing-sort]")
      : document.querySelector<HTMLElement>("[data-unified-folder-list][data-listing-sort]")
    let listingSort: { default?: any; folders?: Record<string, any> } = {}
    try { listingSort = JSON.parse(listingHost?.dataset.listingSort ?? "{}") } catch { /* title fallback */ }
    const listingFolder = graphView === "dimension" ? dimensionScope : currentFolder(fullSlug)
    const listingRule = (() => {
      let folder = listingFolder
      while (folder) {
        if (listingSort.folders?.[folder]) return listingSort.folders[folder]
        folder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ""
      }
      return listingSort.default ?? { field: "title", order: "asc" }
    })()
    const sortField = typeof listingRule === "string" ? listingRule : listingRule.field || "title"
    const sortDirection = typeof listingRule === "object" && listingRule.order === "desc" ? -1 : 1
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
    const sortValue = (node: NodeData) => {
      const detail = contentData.get(node.id)
      return sortField === "title" ? detail?.frontmatter?.title ?? detail?.title ?? node.text
        : detail?.frontmatter?.[sortField]
    }
    const compareListingValue = (a: NodeData, b: NodeData) => {
      const av = sortValue(a), bv = sortValue(b)
      const missing = (value: unknown) => value === undefined || value === null || value === ""
      if (missing(av) !== missing(bv)) return missing(av) ? 1 : -1
      if (!missing(av)) {
        const result = typeof av === "number" && typeof bv === "number" ? av - bv
          : collator.compare(String(av), String(bv))
        if (result) return result * sortDirection
      }
      return collator.compare(String(a.text ?? a.id), String(b.text ?? b.id))
    }
    const isVisibleFile = (node: NodeData) =>
      !node.isRegion && !node.isAggregation &&
      (selection ? Object.hasOwn(selection.linkCounts, node.id) : !!contentData.get(node.id)?.filePath)
    const compareVisibleFiles = (a: NodeData, b: NodeData) =>
      ((selection?.linkCounts[b.id] ?? nodeLinkCount.get(b.id) ?? 0) -
        (selection?.linkCounts[a.id] ?? nodeLinkCount.get(a.id) ?? 0)) ||
      compareListingValue(a, b) || collator.compare(String(a.id), String(b.id))
    let localContextOrder = new Map<string, number>()
    const expansionPages = new ExpansionPages<NodeData, LinkData>(expandBatchSize, (a, b) =>
      Number(b.id === slug) - Number(a.id === slug) ||
      (graphView === "local" ? Number(localContextOrder.has(a.id)) - Number(localContextOrder.has(b.id)) : 0) ||
      (graphView === "local" && localContextOrder.has(a.id) && localContextOrder.has(b.id)
        ? localContextOrder.get(a.id)! - localContextOrder.get(b.id)! : 0) ||
      Number(!!b.isRegion || !!b.isAggregation) - Number(!!a.isRegion || !!a.isAggregation) ||
      compareVisibleFiles(a, b))
    const initialPageId = "__graph_initial__"
    const localContextPageId = "__local_context__"
    const updateVisibleCount = () => {
      graph.dataset.visibleFileCount = String(graphData.nodes.filter(isVisibleFile).length)
      graph.dataset.visibleNodeCount = String(graphData.nodes.length)
      graph.dataset.initialNodeLimit = String(initialNodeLimit)
      graph.dataset.totalFileCount = String(new Set(allNodes.filter(isVisibleFile).map(node => node.id)).size)
      if (graphView === "local") {
        graph.dataset.localContextCount = String(graphData.nodes.filter(node => localContextIds.has(node.id)).length)
        graph.dataset.disconnectedNodeCount = String(graphData.nodes.length -
          projectLocalGraph(slug, graphData.nodes, graphData.links, [], []).nodes.length)
      }
    }
    let allLinks: LinkData[] = []

    // 聚合节点信息类型（expandNode 使用）
    interface AggregationNodeInfo {
      node: NodeData
      coreId: SimpleSlug
      childNodes: NodeData[]
      childLinks: LinkData[]
      remainingRules: AggregationRule[]
      currentField: string
      /** 产生该聚合的规则（double-click 跳转时决定目标页类型） */
      rule: AggregationRule
      /** 该聚合所属的目录上下文（成员共同目录；无共同目录为 ""） */
      scope: string
      /** 该聚合的分组键（folder 规则时即目录路径，用于跳转文件夹页） */
      groupKey?: string
      /** 祖先字段值约束（未来多级字段聚合时填充；跳转维度值页时编码为 ?filter=） */
      ancestorFilter?: Array<{ field: string; value: string }>
    }

    /** 从聚合节点 id 里取分组键（仅预计算产物的节点需要，其余构造点都有 groupKey） */
    function aggGroupKeyOf(id: string): string {
      if (id.startsWith("agg:shared:")) {
        try {
          const parsed = JSON.parse(id.slice("agg:shared:".length))
          const key = Array.isArray(parsed) ? parsed[2] : undefined
          return typeof key === "string" ? key : ""
        } catch {
          return ""
        }
      }
      const parts = id.split(":")
      return parts.length >= 5 ? parts.slice(4).join(":") : ""
    }

    /** 站点根前缀（basePath 可能带或不带前导斜杠） */
    function siteRoot(): string {
      if (!basePath) return ""
      return basePath.startsWith("/") ? basePath : `/${basePath}`
    }

    /**
     * 维度子图的 slug 清单（懒加载 + 缓存）。
     * 取值 slug 会做冲突消解，运行期无法靠 slugify 复现，所以清单以构建期为准；
     * 拿不到清单时回退到 slugifyPath（绝大多数取值一致）。
     */
    let dimensionManifestPromise: Promise<any | null> | null = null
    function loadDimensionManifest(): Promise<any | null> {
      if (!dimensionManifestPromise) {
        const url = encodePathSegments(joinArtifactUrl(basePath, "graph/dimensions/index.json"))
        dimensionManifestPromise = fetch(url)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      }
      return dimensionManifestPromise
    }

    /**
     * 聚合节点双击的跳转目标（站点相对路径）：
     * - `field` 规则 → 维度值页 `/_dimensions/<fieldSlug>/<valueSlug>?scope=&context=`
     * - `folder` 规则 → 既有文件夹页 `/<目录>/`（不产新页）
     */
    async function resolveAggregationTarget(nodeId: SimpleSlug): Promise<string | null> {
      const info = aggNodeInfoMap.get(nodeId)
      if (!info) return null
      const isFolder = info.rule ? info.rule.type === "folder" : info.currentField === "📁"

      if (isFolder) {
        const key = (info.groupKey ?? "").replace(/^\/+|\/+$/g, "")
        const root = siteRoot()
        return key ? `${root}/${encodePathSegments(key)}/` : `${root}/`
      }

      const field = info.rule && info.rule.type === "field" ? info.rule.field : info.currentField
      const value = info.groupKey ?? ""
      if (!field || field === "📁" || !value) return null

      const manifest = await loadDimensionManifest()
      const manifestField = manifest?.fields?.find(
        (entry: { field: string }) => entry.field === field,
      )
      const manifestValue = manifestField?.values?.find(
        (entry: { value: string }) => entry.value === value,
      )
      const fieldSlug: string = manifestField?.fieldSlug ?? slugifyPath(field)
      const valueSlug: string = manifestValue?.valueSlug ?? slugifyPath(value)

      const params = new URLSearchParams()
      if (info.scope) params.set("scope", info.scope)
      // ?context= 仅在从普通内容页（有局部图谱的页面）跳转时携带：
      // 文件夹页（simplifySlug 带尾斜杠）与维度值页（_dimensions/ 前缀）的 slug
      // 没有"来源节点"语义，且维度值页会因此把 _dimensions/** 逐跳传播。
      const fromSlug = simplifySlug(getFullSlug(window))
      const isContentPage =
        !!fromSlug && !fromSlug.startsWith("_dimensions/") && !fromSlug.endsWith("/")
      if (isContentPage) params.set("context", fromSlug)
      // 祖先维度约束：与目录树二级节点入口一致的 `?filter=字段:值,...` 机制。
      // 当前图谱聚合是「目录 + 单字段」，字段级节点没有字段级祖先 → ancestorFilter 为空；
      // 未来图谱支持多级字段聚合时，此处自动带上祖先 filter，保持入口一致。
      if (info.ancestorFilter && info.ancestorFilter.length > 0) {
        params.set(
          "filter",
          info.ancestorFilter.map((entry) => `${entry.field}:${entry.value}`).join(","),
        )
      }

      const target = `${siteRoot()}/_dimensions/${encodePathSegments(fieldSlug)}/${encodePathSegments(valueSlug)}`
      const query = params.toString()
      return query ? `${target}?${query}` : target
    }

    /** 统一节点跳转：普通节点 → 文档；聚合节点 → 维度值页 / 文件夹页；大区节点不跳转 */
    function navigateToNode(nodeId: SimpleSlug, fullSlug: FullSlug): void {
      if (nodeId.startsWith("agg:")) {
        void resolveAggregationTarget(nodeId).then((target) => {
          if (target) window.spaNavigate(new URL(target, window.location.origin))
          else console.log("[Graph] 聚合节点没有可跳转的目标页:", nodeId)
        })
        return
      }
      if (nodeId.startsWith("region:")) {
        console.log("[Graph] 大区节点暂不支持跳转:", nodeId)
        return
      }
      const targ = resolveRelative(fullSlug, nodeId)
      window.spaNavigate(new URL(targ, window.location.toString()))
    }
    let aggNodeInfoMap: Map<SimpleSlug, AggregationNodeInfo> = new Map()

    const describeAggregationNode = (node: NodeData) => {
      const details = contentData.get(node.id)
      return { slug: details?.slug ?? node.id, frontmatter: details?.frontmatter }
    }
    let indexedLinks: LinkData[] | undefined
    let linkIndex: ReturnType<typeof indexGraphLinks<LinkData>> | undefined
    const incidentLinks = (ids: Iterable<string>) => {
      if (indexedLinks !== allLinks) {
        indexedLinks = allLinks
        linkIndex = indexGraphLinks(allLinks)
      }
      return linkIndex!.incident(ids)
    }
    const fallbackAggregation = { version: 1 as const, configHash: "fallback", minGroupSize: 2,
      root: { type: "folder" as const, depth: 1 }, resolved: {} }
    const groupChildrenCache = new Map<string, NodeData[]>()
    const createSharedGroups = (parent: NodeData, members: NodeData[], rules?: AggregationRule[], folderOnly = false) => {
      const cacheKey = JSON.stringify([parent.id, folderOnly, rules])
      const cached = groupChildrenCache.get(cacheKey)
      if (cached) return cached
      const artifact = sharedAggregation ?? fallbackAggregation
      const result = folderOnly
        ? groupGlobalNeighbors(members, artifact, describeAggregationNode)
        : groupShared(members, artifact, describeAggregationNode, rules)
      const nodes = [...result.leaves]
      for (const group of result.groups) {
        const { rule, key, remainingRules } = group
        const id = `agg:shared:${JSON.stringify([parent.id, rule, key])}` as SimpleSlug
        const node: NodeData = {
          id, text: rule.type === "folder" ? `📁 ${key === "/" ? folderTitleMap.get("/") ?? "根目录" : folderDisplay(key)}` : key,
          tags: [], isCore: false, isAggregation: true, edgeNodeCount: 1,
          aggChildCount: group.members.length,
          aggCollapsedRadius: Math.min(30, Math.max(16, 2 + Math.sqrt(group.members.length))),
        }
        // Child edges are prepared only when this aggregation is opened.
        const childLinks: LinkData[] = []
        const currentField = rule.type === "folder" ? "📁" : rule.field
        aggNodeInfoMap.set(id, {
          node,
          coreId: parent.id,
          childNodes: group.members,
          childLinks,
          remainingRules,
          currentField,
          rule,
          scope: commonFolderOf(group.members.map((member) => String(member.id))),
          groupKey: key,
        })
        aggNodeToChildNodes.set(id, group.members)
        aggNodeToChildLinks.set(id, childLinks)
        aggToCoreMap.set(id, parent.id)
        nodes.push(node)
      }
      groupChildrenCache.set(cacheKey, nodes)
      return nodes
    }

    // 仅在主体节点真正展开时准备邻居，未展开主体不产生聚合对象和成员边副本。
    const neighborPlans = createOnDemandCache((id: SimpleSlug) => {
      const center = allNodes.find(node => node.id === id)!
      const centerLinks = incidentLinks([id])
      const ids = new Set(centerLinks.map(link => link.source.id === id ? link.target.id : link.source.id))
      ids.delete(id)
      const members = allNodes.filter(node => ids.has(node.id) &&
        (graphView === "local" || !node.isCore) && !node.isAggregation && !node.isRegion)
      const nodes = createSharedGroups(center, members, sharedAggregation ? undefined : aggregation ?? [], graphView !== "local" && !!sharedAggregation)
      const visible = new Set(nodes.map(node => node.id))
      const links: LinkData[] = [
        ...centerLinks.filter(link => visible.has(link.source.id === id ? link.target.id : link.source.id)),
        ...nodes.filter(node => node.isAggregation).map(node => ({ source: node, target: center })),
      ]
      nodeToEdgeNodes.set(id, nodes)
      nodeToEdgeLinks.set(id, links)
      return { nodes, links }
    })
    const prepareNeighbors = (id: SimpleSlug) => {
      const plan = neighborPlans.get(id)
      graph.dataset.neighborPlans = String(neighborPlans.size)
      return plan
    }
    graph.dataset.expansionMode = "on-demand"
    graph.dataset.neighborPlans = "0"

    // [GRAPH3] 预计算路径 vs 运行时计算路径
    if (globalPrecomputed) {
      console.log("[GRAPH3] ===== 使用预计算数据构建图谱 =====")
      const t0 = performance.now()

      // 从 nodeDetails 构建 contentData（供 expandNode 的 frontmatter 分组使用）
      const pc = globalPrecomputed
      // [FOLDER-TITLE] 从预计算 JSON 恢复目录显示名映射
      folderTitleMap = new Map(
        Object.entries(pc.folderTitles ?? {}).map(([key, title]) => [
          normalizeFolderKey(key),
          title,
        ]),
      )
      for (const [id, detail] of Object.entries(pc.nodeDetails)) {
        contentData.set(id as SimpleSlug, {
          slug: (detail.fullSlug ?? id) as any,
          filePath: "" as any,
          title: detail.text,
          links: [],
          tags: detail.tags,
          content: "",
          frontmatter: detail.frontmatter as any,
        })
      }

      // 构建 allNodes（所有非孤立节点）
      const coreIds = new Set(pc.coreNodeIds)
      allNodes = Object.values(pc.nodeDetails).filter(d => !Object.hasOwn(pc.aggNodes, d.id)).map((d) => ({
        id: d.id as SimpleSlug,
        text: d.text,
        tags: d.tags,
        isCore: coreIds.has(d.id),
      }))
      // 标记聚合/大区节点，并补充预计算路径缺失的运行时属性
      for (const id of Object.keys(pc.regionNodes)) {
        const n = allNodes.find((x) => x.id === id)
        if (n) {
          n.isCore = true
          ;(n as any).isRegion = true
          const info = pc.regionNodes[id]
          n.edgeNodeCount = info.childCoreIds.length
          n.aggCollapsedRadius = Math.min(
            40,
            Math.max(25, 5 + Math.sqrt(info.childCoreIds.length) * 3),
          )
        }
      }

      // nodeLinkCount
      nodeLinkCount = new Map(Object.entries(pc.nodeLinkCounts))
      // 为所有核心节点设置 edgeNodeCount（与运行时路径一致）
      for (const n of allNodes) {
        if (n.isCore && n.edgeNodeCount === undefined) {
          n.edgeNodeCount = nodeLinkCount.get(n.id) ?? 0
        }
        if (n.isExpanded === undefined) n.isExpanded = false
      }

      // 邻接映射（nodeToEdgeNodes / nodeToEdgeLinks）
      // 需要将 nodeId 转为 NodeData 引用
      const allNodeMap = new Map(allNodes.map((n) => [n.id, n]))
      // 邻居聚合与对象引用在展开主体时准备。
      // regionNodeInfoMap
      for (const [regionId, info] of Object.entries(pc.regionNodes)) {
        const childCores = (info.childCoreIds as string[])
          .map((id) => allNodeMap.get(id as SimpleSlug))
          .filter(Boolean) as NodeData[]
        const regionNode = allNodeMap.get(regionId as SimpleSlug)
        if (regionNode) {
          regionNodeInfoMap.set(regionId as SimpleSlug, {
            node: regionNode,
            childCores,
            remainingRules: sharedAggregation && regionId.startsWith("region:")
              ? globalCoreRules(sharedAggregation, regionId.slice("region:".length), coreAggregationMaxLevels)
              : info.remainingRules,
            currentField: info.currentField,
          })
        }
        for (const cid of info.childCoreIds) {
          coreToRegionMap.set(cid as SimpleSlug, regionId as SimpleSlug)
        }
      }

      // 构建首屏 graphData
      const firstScreenNodes = pc.firstScreen.nodes
        .map((id) => allNodeMap.get(id as SimpleSlug))
        .filter(Boolean) as NodeData[]
      const firstScreenLinks: LinkData[] = pc.firstScreen.links
        .map((l) => {
          const sn = allNodeMap.get(l.source as SimpleSlug)
          const tn = allNodeMap.get(l.target as SimpleSlug)
          if (!sn || !tn) return null
          return { source: sn, target: tn, sourceField: l.sourceField }
        })
        .filter(Boolean) as LinkData[]

      graphData = { nodes: firstScreenNodes, links: firstScreenLinks }

      // allLinks：预计算路径下用全部子链接（用于展开后的连通性判断）
      allLinks = pc.allChildLinks
        .map((l) => {
          const sn = allNodeMap.get(l.source as SimpleSlug)
          const tn = allNodeMap.get(l.target as SimpleSlug)
          if (!sn || !tn) return null
          return { source: sn, target: tn, sourceField: l.sourceField }
        })
        .filter(Boolean) as LinkData[]

      console.log(
        `[GRAPH3] 预计算数据构建完成: ${(performance.now() - t0).toFixed(1)}ms, ${firstScreenNodes.length} nodes, ${firstScreenLinks.length} links`,
      )
    } else {
      // [FOLDER-TITLE] 运行时计算路径：从 contentData 构建目录显示名映射
      // （Quartz 中目录 index.md 的 slug 恰好等于目录路径）
      // [FIX] 不能在这里 new Map() 重置：局部图谱的 contentData 只有邻域节点、通常不含
      // 目录 index 页，重置会把上面已合并的 localGraphData.folderTitles 清空，
      // 导致聚合节点显示原始目录名（person/task）而非 index.md 的 title。
      // 这里改为只做补充合并（幂等），保留已有映射。
      for (const [key, title] of Object.entries(localGraphData?.folderTitles ?? {})) {
        folderTitleMap.set(normalizeFolderKey(key), title)
      }
      for (const [slug, details] of contentData.entries()) {
        const rel = details.filePath as unknown as string | undefined
        if (rel && (rel === "index.md" || rel.endsWith("/index.md"))) {
          const t = details.frontmatter?.title
          if (typeof t === "string" && t.trim() !== "") {
            folderTitleMap.set(normalizeFolderKey(slug), t.trim())
          }
        }
      }
      console.log(
        `[DBG-folderTitle] fallback/BFS路径: size=${folderTitleMap.size}, ` +
          `keys=[${[...folderTitleMap.keys()].join(",")}]`,
      )
      const virtualNodes = new Set<SimpleSlug>()
      const allExistingSlugs = new Set(contentData.keys())
      const allTagSlugs = new Set<SimpleSlug>()

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
      console.log("[DEBUG] 动态计算虚拟节点完成，数量:", virtualNodes.size)

      // ===== 构建链接图 =====
      const links: SimpleLinkData[] = []
      const tags: SimpleSlug[] = []
      const validLinks = new Set(contentData.keys())
      for (const v of virtualNodes) validLinks.add(v)

      function getFrontmatterFieldForLink(
        frontmatter: any,
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

      if (isGlobalGraph) {
        const source = rawCoreNodeLimit !== undefined ? "配置值" : "默认值"
        console.log(`[Graph] 全局图谱 coreNodeLimit: ${coreNodeLimit} (${source})`)
      }

      const neighbourhood = new Set<SimpleSlug>()

      if (!isGlobalGraph) {
        if (localGraphData) {
          console.log(
            `[Graph] ===== USING PRECOMPUTED LOCAL JSON (depth: ${localGraphData.depth}) =====`,
          )
          const startTime = performance.now()
          // 使用预计算数据
          for (const [nodeSlug, nodeData] of Object.entries(localGraphData.nodes)) {
            neighbourhood.add(nodeSlug as SimpleSlug)
            if (!nodeData.filePath) virtualNodes.add(nodeSlug as SimpleSlug)
            if (nodeSlug.startsWith("tags/") && !tags.includes(nodeSlug as SimpleSlug)) {
              tags.push(nodeSlug as SimpleSlug)
            }
          }
          for (const edge of localGraphData.edges) {
            links.push({ source: edge.source, target: edge.target, sourceField: edge.sourceField })
          }
          const endTime = performance.now()
          console.log(
            `[Graph] Raw graph prepared: ${neighbourhood.size} nodes, ${links.length} edges in ${(endTime - startTime).toFixed(2)}ms (not rendered counts)`,
          )
        } else {
          console.log(`[Graph] ===== USING CONTENTINDEX BFS (depth: ${depth}) =====`)
          const startTime = performance.now()
          // 回退到 BFS（带深度限制，双向扩展）
          const queue: Array<{ slug: SimpleSlug; depth: number }> = [{ slug, depth: 0 }]
          const visitedSet = new Set<SimpleSlug>()

          while (queue.length > 0) {
            const { slug: current, depth: currentDepth } = queue.shift()!
            if (visitedSet.has(current)) continue
            visitedSet.add(current)
            neighbourhood.add(current)
            if (currentDepth >= depth) continue

            const currentData = contentData.get(current)
            if (currentData) {
              for (const dest of currentData.links ?? []) {
                if (validLinks.has(dest)) {
                  const sourceField = getFrontmatterFieldForLink(
                    (currentData as any).frontmatter,
                    dest,
                  )
                  links.push({ source: current, target: dest, sourceField })
                  queue.push({ slug: dest, depth: currentDepth + 1 })
                }
              }
              if (showTags) {
                const localTags = (currentData.tags ?? [])
                  .filter((tag) => !removeTags.includes(tag))
                  .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))
                for (const tag of localTags) {
                  if (!tags.includes(tag)) tags.push(tag)
                  links.push({ source: current, target: tag })
                  neighbourhood.add(tag)
                }
              }
              for (const dest of currentData.links ?? []) {
                if (virtualNodes.has(dest)) {
                  const sourceField = getFrontmatterFieldForLink(
                    (currentData as any).frontmatter,
                    dest,
                  )
                  links.push({ source: current, target: dest, sourceField })
                  queue.push({ slug: dest, depth: currentDepth + 1 })
                }
              }
            }

            // 入链接
            for (const [source, details] of contentData.entries()) {
              if ((details.links ?? []).includes(current)) {
                const sourceField = getFrontmatterFieldForLink(
                  (details as any).frontmatter,
                  current,
                )
                links.push({ source, target: current, sourceField })
                queue.push({ slug: source, depth: currentDepth + 1 })
              }
            }
          }
          const endTime = performance.now()
          console.log(
            `[Graph] ContentIndex BFS rendered: ${neighbourhood.size} nodes, ${links.length} edges in ${(endTime - startTime).toFixed(2)}ms`,
          )
        }
      } else {
        console.log("[DEBUG] 全局图谱：使用完整链接图构建")
        const startTime = performance.now()
        // 全局图谱：完整链接图
        for (const [source, details] of contentData.entries()) {
          for (const dest of details.links ?? []) {
            if (validLinks.has(dest)) {
              const sourceField = getFrontmatterFieldForLink((details as any).frontmatter, dest)
              links.push({ source, target: dest, sourceField })
            }
          }
          if (showTags) {
            const localTags = (details.tags ?? [])
              .filter((tag) => !removeTags.includes(tag))
              .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))
            tags.push(...localTags.filter((tag) => !tags.includes(tag)))
            for (const tag of localTags) links.push({ source, target: tag })
          }
        }
        for (const [source, details] of contentData.entries()) {
          for (const dest of details.links ?? []) {
            if (virtualNodes.has(dest)) {
              const sourceField = getFrontmatterFieldForLink((details as any).frontmatter, dest)
              links.push({ source, target: dest, sourceField })
            }
          }
        }
        validLinks.forEach((id) => neighbourhood.add(id))
        if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
        virtualNodes.forEach((v) => neighbourhood.add(v))
        const endTime = performance.now()
        console.log(
          `[DEBUG] 全局链接图构建完成 - 耗时: ${(endTime - startTime).toFixed(2)}ms, 节点数: ${neighbourhood.size}, 链接数: ${links.length}`,
        )
      }

      // ===== 节点和链接构建 =====

      allNodes = [...neighbourhood].map((url) => ({
        id: url,
        text: url.startsWith("tags/")
          ? "#" + url.substring(5)
          : (contentData.get(url)?.title ?? url),
        tags: contentData.get(url)?.tags ?? [],
        isCore: false,
      }))

      // 链接去重
      const allNodeById = new Map(allNodes.map(node => [node.id, node]))
      const linkKeySet = new Set<string>()
      allLinks = links
        .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
        .filter((l) => {
          const key = `${l.source}->${l.target}`
          if (linkKeySet.has(key)) return false
          linkKeySet.add(key)
          return true
        })
        .map((l) => ({
          source: allNodeById.get(l.source)!,
          target: allNodeById.get(l.target)!,
          sourceField: l.sourceField,
        }))

      // 构建产物里的目录→文件边只用于发现后代文件，不是真实内容关系。
      if (graphView === "folder") {
        allLinks = allLinks.filter((link) => link.source.id !== slug && link.target.id !== slug)
      }


      let selectedCoreIds: Set<string> | undefined
      if ((graphView === "folder" || graphView === "dimension") && selection) {
        const candidates = focusNodeIds(graphView, allNodes, slug, localGraphData?.matched ?? [],
          id => !!contentData.get(id as SimpleSlug)?.filePath)
        const scoped = selectScope(candidates, selection.linkCounts, resolveCoreMinLinks(coreMinLinks),
          allLinks.map(link => ({ source: link.source.id, target: link.target.id })))
        selectedCoreIds = scoped.coreIds
        allNodes = allNodes.filter(node => scoped.retainedIds.has(node.id))
        allLinks = allLinks.filter(link => scoped.retainedIds.has(link.source.id) && scoped.retainedIds.has(link.target.id))
        graph.dataset.coreSelectedCount = String(scoped.coreIds.size)
        graph.dataset.coreTotalCount = String(candidates.size)
        const statusHost = graph.parentElement
        let status = statusHost?.querySelector<HTMLElement>(".graph-selection-status")
        if (!status && statusHost) {
          status = document.createElement("div")
          status.className = "graph-selection-status"
          status.style.cssText = "font-size:.8rem;color:var(--gray);padding:.25rem 0"
          statusHost.appendChild(status)
        }
        if (status) status.textContent = `图谱主体 ${scoped.coreIds.size} / ${candidates.size}`
      }
      // 连接数统计
      nodeLinkCount = new Map<string, number>()
      for (const l of allLinks) {
        nodeLinkCount.set(l.source.id, (nodeLinkCount.get(l.source.id) ?? 0) + 1)
        nodeLinkCount.set(l.target.id, (nodeLinkCount.get(l.target.id) ?? 0) + 1)
      }

      // 过滤孤儿节点
      const folderCoreIds = graphView === "folder"
        ? focusNodeIds("folder", allNodes, slug, [], (id) => !!contentData.get(id as SimpleSlug)?.filePath)
        : new Set<string>()
      const nonOrphanNodes = allNodes.filter(
        (n) => (nodeLinkCount.get(n.id) ?? 0) > 0 || (selectedCoreIds ?? folderCoreIds).has(n.id) || (graphView === "global" && !excludeUnlinkedGlobalNodes),
      )
      const nonOrphanNodeIds = new Set(nonOrphanNodes.map((n) => n.id))
      const nonOrphanLinks = allLinks.filter(
        (l) => nonOrphanNodeIds.has(l.source.id) && nonOrphanNodeIds.has(l.target.id),
      )

      // 文件夹视角的后代文件是核心集合；其余视角保留各自规则。
      selectCoreNodes({
        view: graphView,
        nodes: nonOrphanNodes,
        selectedCoreIds,
        domainLinkCounts: selection ? new Map(Object.entries(selection.linkCounts)) : undefined,
        nodeLinkCount,
        contentData,
        slug,
        sharedAggregation: !!sharedAggregation,
        coreNodeFilter,
        coreNodeLimit,
        coreMinLinks,
        hasRegionRules: !!(regionRules && regionRules.length > 0),
      })

      const edgeNodes = nonOrphanNodes.filter(node => !node.isCore)
      for (const node of nonOrphanNodes) {
        node.edgeNodeCount = nodeLinkCount.get(node.id) ?? 0
        node.isExpanded = false
      }
      // 文件页中心的邻居属于首屏；集合图谱此处不计算任何主体的邻居聚合。
      if (graphView === "local" && allNodes.some(node => node.id === slug)) {
        prepareNeighbors(slug)
        for (const info of aggNodeInfoMap.values()) nonOrphanNodes.push(info.node)
      }

      // ===== 大区节点生成（全局图谱 + 配置了 regionRules）=====
      regionNodeInfoMap = new Map<
        SimpleSlug,
        {
          node: NodeData
          childCores: NodeData[]
          remainingRules: AggregationRule[]
          currentField: string
        }
      >()
      coreToRegionMap = new Map<SimpleSlug, SimpleSlug>()
      let scopedFirstScreenNodes: NodeData[] | null = null

      if (graphView === "folder" || graphView === "dimension") {
        const scopedCores = nonOrphanNodes.filter((n) => n.isCore && !n.isAggregation)
        const firstLevel = sharedAggregation
          ? groupShared(scopedCores, sharedAggregation, describeAggregationNode)
          : { groups: [], leaves: scopedCores }
        scopedFirstScreenNodes = [...firstLevel.leaves]
        for (const group of firstLevel.groups) {
          const regionId = `region:${graphView}:${JSON.stringify([slug, group.rule, group.key])}` as SimpleSlug
          const regionNode: NodeData = {
            id: regionId,
            text: group.rule.type === "field"
              ? `${group.rule.field}: ${group.key}`
              : `📁 ${folderDisplay(group.key)}`,
            tags: [],
            isCore: true,
            isRegion: true,
            regionChildIds: group.members.map((member) => member.id),
            edgeNodeCount: group.members.length,
            // 文件夹页画布较小，分区圈不必与全局大区等大。
            aggCollapsedRadius: Math.min(30, Math.max(18, 4 + Math.sqrt(group.members.length) * 2.2)),
          }
          regionNodeInfoMap.set(regionId, {
            node: regionNode,
            childCores: group.members,
            remainingRules: group.remainingRules,
            currentField: group.rule.type === "folder" ? "📁" : group.rule.field,
          })
          for (const member of group.members) coreToRegionMap.set(member.id, regionId)
          scopedFirstScreenNodes.push(regionNode)
        }
      }

      if (isGlobalGraph && regionRules && regionRules.length > 0) {
        const coreNodes = nonOrphanNodes.filter((n) => n.isCore && !n.isAggregation && !n.isRegion)
        const rule = regionRules[0]
        const groupMap = new Map<string, NodeData[]>()

        for (const core of coreNodes) {
          const details = contentData.get(core.id)
          let groupKey: string | null = null

          if (details) {
            if (rule.type === "folder") {
              const parts = String(core.id).split("/")
              const depth = rule.depth ?? 1
              if (parts.length > 1) {
                const folderParts =
                  depth > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)) : [parts[0]]
                groupKey = folderParts.join("/")
              } else {
                groupKey = "/"
              }
            } else if (rule.type === "field") {
              const field = rule.field ?? ""
              const rawValue = (details as any).frontmatter?.[field]
              if (!Array.isArray(rawValue) && rawValue !== undefined && rawValue !== null) {
                groupKey = String(rawValue)
              }
            }
          }

          if (!groupKey) groupKey = UNCLASSIFIED_KEY
          const group = groupMap.get(groupKey) ?? []
          group.push(core)
          groupMap.set(groupKey, group)
        }

        for (const [groupKey, childCores] of groupMap) {
          const regionId = `region:${groupKey}` as SimpleSlug
          const regionNode: NodeData = {
            id: regionId,
            text: rule.type === "folder" ? folderDisplay(groupKey) : groupKey,
            tags: [],
            isCore: true,
            isRegion: true,
            regionChildIds: childCores.map((c) => c.id),
            edgeNodeCount: childCores.length,
            aggCollapsedRadius: Math.min(40, Math.max(25, 5 + Math.sqrt(childCores.length) * 3)),
          }
          regionNodeInfoMap.set(regionId, {
            node: regionNode,
            childCores,
            remainingRules: sharedAggregation ? globalCoreRules(sharedAggregation, groupKey, coreAggregationMaxLevels) : regionRules.slice(1),
            currentField: rule.type === "folder" ? "📁" : (rule.field ?? rule.type),
          })
          for (const c of childCores) {
            coreToRegionMap.set(c.id, regionId)
          }
          nonOrphanNodes.push(regionNode)
        }

        console.log(
          `[Graph] 大区聚合完成：${regionNodeInfoMap.size} 个大区，${coreToRegionMap.size} 个核心节点`,
        )
      }

      // 全局图谱的连接门槛决定是否移除无边节点；局部/文件夹/维度图保留候选节点。
      const initialNodes = excludeUnlinkedGlobalNodes ? nonOrphanNodes : allNodes
      const initialLinks = excludeUnlinkedGlobalNodes ? nonOrphanLinks : allLinks

      if (graphView === "folder" || graphView === "dimension") {
        // 有后续维度时首屏显示分区；末级值页保留命中实体原貌。
        const visibleNodes = scopedFirstScreenNodes ?? []
        const visibleIds = new Set(visibleNodes.map((node) => node.id))
        graphData = {
          nodes: visibleNodes,
          links: nonOrphanLinks.filter(
            (link) => visibleIds.has(link.source.id) && visibleIds.has(link.target.id),
          ),
        }
      } else if (isGlobalGraph && startCollapsed) {
        if (regionRules && regionRules.length > 0) {
          // [REGION] 大区模式首屏：大区节点 + 跨区叶节点
          // 若 filterNonCoreNodes 为 true 且配置了 coreNodeFilter，则额外过滤掉不符合核心节点条件的非核心节点
          const shouldFilterNonCore =
            filterNonCoreNodes && coreNodeFilter && coreNodeFilter.length > 0
          const crossRegionEdgeIds = new Set<string>()
          for (const edge of edgeNodes) {
            const neighborRegions = new Set<string>()
            for (const l of nonOrphanLinks) {
              const otherId =
                l.source.id === edge.id ? l.target.id : l.target.id === edge.id ? l.source.id : null
              if (otherId && coreToRegionMap.has(otherId)) {
                neighborRegions.add(coreToRegionMap.get(otherId)!)
              }
            }
            if (neighborRegions.size > 1) {
              crossRegionEdgeIds.add(edge.id)
            }
          }

          const visibleNodes = initialNodes.filter((n) => {
            if (n.isRegion) return true
            if (crossRegionEdgeIds.has(n.id)) {
              // 跨区叶节点也要过滤非核心节点
              if (shouldFilterNonCore && !n.isCore) return false
              return true
            }
            return false
          })
          const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
          const visibleLinks = initialLinks.filter(
            (l) => visibleNodeIds.has(l.source.id) && visibleNodeIds.has(l.target.id),
          )
          graphData = { nodes: visibleNodes, links: visibleLinks }
          console.log(
            `[Graph] 大区模式首屏：${visibleNodes.length} 个节点（${regionNodeInfoMap.size} 个大区 + ${crossRegionEdgeIds.size} 个跨区文件）`,
          )
        } else {
          // 全局图谱默认收起：核心节点 + 聚合节点 + 它们之间的链接
          // 若 filterNonCoreNodes 为 true 且配置了 coreNodeFilter，则只显示核心节点和聚合节点
          const shouldFilterNonCore =
            filterNonCoreNodes && coreNodeFilter && coreNodeFilter.length > 0
          const visibleNodes = initialNodes.filter(
            (n) => n.isCore || n.isAggregation || (!shouldFilterNonCore && !n.isCore),
          )
          const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
          const visibleLinks = initialLinks.filter(
            (l) => visibleNodeIds.has(l.source.id) && visibleNodeIds.has(l.target.id),
          )
          // 添加聚合节点到核心节点的边
          for (const [aggId, info] of aggNodeInfoMap) {
            const coreId = aggToCoreMap.get(aggId)
            if (!coreId || !visibleNodeIds.has(coreId)) continue
            const exists = visibleLinks.some(
              (l) =>
                (l.source.id === aggId && l.target.id === coreId) ||
                (l.source.id === coreId && l.target.id === aggId),
            )
            if (!exists) {
              visibleLinks.push({
                source: info.node,
                target: visibleNodes.find((n) => n.id === coreId)!,
                sourceField: info.currentField,
              })
            }
          }
          graphData = { nodes: visibleNodes, links: visibleLinks }
        }
      } else {
        // 局部图谱 / 非startCollapsed：过滤掉已被聚合的子节点，加入聚合节点
        // 收集所有被聚合的子节点 ID
        const aggregatedChildIds = new Set<string>()
        for (const [, info] of aggNodeInfoMap) {
          for (const child of info.childNodes) aggregatedChildIds.add(child.id)
        }
        // 过滤掉被聚合的子节点
        const filteredNodes = initialNodes.filter((n) => !aggregatedChildIds.has(n.id))
        // 过滤掉涉及被聚合子节点的链接
        const filteredLinks = initialLinks.filter(
          (l) => !aggregatedChildIds.has(l.source.id) && !aggregatedChildIds.has(l.target.id),
        )
        // 加入聚合节点和聚合链接
        const mergedNodes = [...filteredNodes]
        const mergedLinks = [...filteredLinks]
        const mergedNodeIds = new Set(mergedNodes.map((n) => n.id))
        for (const [aggId, info] of aggNodeInfoMap) {
          const coreId = aggToCoreMap.get(aggId)
          if (!coreId || !mergedNodeIds.has(coreId)) continue
          if (!mergedNodeIds.has(aggId)) mergedNodes.push(info.node)
          const coreNode = mergedNodes.find((n) => n.id === coreId)
          const exists = mergedLinks.some(
            (l) =>
              (l.source.id === aggId && l.target.id === coreId) ||
              (l.source.id === coreId && l.target.id === aggId),
          )
          if (!exists && coreNode) {
            mergedLinks.push({
              source: info.node,
              target: coreNode,
              sourceField: info.currentField,
            })
          }
        }
        graphData = { nodes: mergedNodes, links: mergedLinks }
      }
    } // end else (!globalPrecomputed)

    const directLocalIds = new Set<string>([slug])
    if (graphView === "local") {
      for (const link of incidentLinks([slug])) {
        directLocalIds.add(link.source.id)
        directLocalIds.add(link.target.id)
      }
    }
    const localContextNodes = graphView === "local"
      ? allNodes.filter(node => !directLocalIds.has(node.id) && !node.isAggregation && !node.isRegion)
      : []
    const localContextIds = new Set(localContextNodes.map(node => node.id))
    let initialLocalContext = new Set<string>()
    if (graphView === "local") {
      const projected = projectLocalGraph(slug, graphData.nodes, graphData.links, localContextNodes, allLinks)
      graphData = { nodes: projected.nodes, links: projected.links }
      localContextOrder = new Map(projected.context.map((node, index) => [node.id, index]))
      initialLocalContext = new Set(projected.context.map(node => node.id))
    }

    // Limit the initial screen before creating Pixi objects or the simulation.
    // Later user-triggered expansions use their own batch size, without this ceiling.
    if (graphData.nodes.length > initialNodeLimit) {
      const first = expansionPages.open(initialPageId, [], graphData.nodes, graphData.links, loadBatchSize, initialNodeLimit)
      graphData = { nodes: first.nodes, links: first.links }
    }
    const contextPendingInInitialPage = new Set([...initialLocalContext].filter(id => !graphData.nodes.some(node => node.id === id)))

    const focusIds = focusNodeIds(
      graphView,
      allNodes,
      slug,
      localGraphData?.matched ?? [],
      (id) => graphView === "global" || !!contentData.get(id as SimpleSlug)?.filePath,
    )
    for (const node of allNodes) node.isFocus = focusIds.has(node.id)
    graph.dataset["focusNodeCount"] = String(focusIds.size)

    const tweens = new Map<string, TweenNode>()

    // 追踪展开的聚合节点与其子节点的映射，用于碰撞检测时跳过父子碰撞
    const expandedAggChildren = new Map<SimpleSlug, Set<SimpleSlug>>()
    const expansionPins = new Set<SimpleSlug>()
    function releaseExpansionPin(node: NodeData) {
      if (!expansionPins.has(node.id)) return
      // Clicking also starts a D3 drag, whose temporary fx/fy must not be restored
      // as a permanent pin when this aggregation is collapsed.
      node.fx = null
      node.fy = null
      expansionPins.delete(node.id)
    }

    function nodeRadius(d: NodeData) {
      if (d.aggExpandedRadius) return d.aggExpandedRadius
      if (d.aggCollapsedRadius) return d.aggCollapsedRadius
      const linkCount = nodeLinkCount.get(d.id) ?? 0
      // 标签节点：连接数通常很大，缩小整体半径
      if (d.id.startsWith("tags/")) {
        return 2 + Math.sqrt(linkCount) * 0.65
      }
      // 核心节点（连接数>1）最小半径更大，视觉上更突出
      const baseRadius = d.isCore ? 8 : 2
      return baseRadius + Math.sqrt(linkCount)
    }

    const focusRingOffset = 3
    const focusRingStrokeWidth = 2.5
    const focusOuterRadius = (node: NodeData) =>
      nodeRadius(node) + focusRingOffset + focusRingStrokeWidth / 2

    const width = graph.offsetWidth
    const height = Math.max(graph.offsetHeight, 250)

    // ===== 检查点 3: Pixi 初始化前 =====
    if (!isCurrent()) return () => {}

    markPhase("prepareGraph")
    graph.dataset.visibleNodeCount = String(graphData.nodes.length)
    graph.dataset.visibleEdgeCount = String(graphData.links.length)
    console.debug(`[Graph] Initial visible graph (${graphView}): ${graphData.nodes.length} nodes, ${graphData.links.length} edges`)

    console.log("[DEBUG] 开始初始化 D3 simulation")
    const dynamics = simulationSettings(graphView)
    const simulation: Simulation<NodeData, LinkData> = createGraphSimulation(
      graphData.nodes, graphData.links, graphView,
      { repelForce, centerForce, linkDistance, enableRadial }, width, height,
      createAggAwareCollide(nodeRadius, expandedAggChildren, () => dragging, graphView === "folder"),
    )
    console.log(`[Graph] ${graphView} layout: radial=${enableRadial}, velocityDecay=${simulation.velocityDecay()}`)

    simulation.on("end", () => {
      // 局部图谱只在展开布局收敛前固定被点击的聚合节点；之后恢复受力运动。
      if (graphView === "local") {
        for (const node of graphData.nodes) releaseExpansionPin(node)
      }
      console.log("[DEBUG] D3 simulation 布局计算完成（已收敛）")
    })

    // 展开/拖拽后约束子节点不跑出聚合圆圈，以及约束聚合节点不溢出画布
    simulation.on("tick", () => {
      const halfW = width / 2
      const halfH = height / 2
      for (const [aggId, childIds] of expandedAggChildren) {
        const aggNode = graphData.nodes.find((n) => n.id === aggId)
        if (!aggNode || aggNode.x == null || aggNode.y == null || !aggNode.aggExpandedRadius)
          continue
        const cx = aggNode.x
        const cy = aggNode.y
        // 约束聚合节点本身不溢出画布（考虑展开半径）
        const expandedR = aggNode.aggExpandedRadius
        if (cx - expandedR < -halfW) aggNode.x = -halfW + expandedR
        if (cx + expandedR > halfW) aggNode.x = halfW - expandedR
        if (cy - expandedR < -halfH) aggNode.y = -halfH + expandedR
        if (cy + expandedR > halfH) aggNode.y = halfH - expandedR
        const boundR = expandedR * 0.85 // 留出边距，不让子节点贴着边界
        for (const childId of childIds) {
          const child = graphData.nodes.find((n) => n.id === childId)
          if (!child || child.x == null || child.y == null) continue

          // 强约束：将子节点固定到目标均匀分布位置（跟随聚合中心移动），
          // 抵消 forceManyBody / forceLink / collide 等外力导致的抖动和圆周聚集
          if (child.aggTargetOffset) {
            const targetX = cx + child.aggTargetOffset.x
            const targetY = cy + child.aggTargetOffset.y
            child.x = targetX
            child.y = targetY
          }

          // 兜底：确保子节点不超出聚合圆圈边界
          const dx = child.x - cx
          const dy = child.y - cy
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > boundR) {
            const scale = boundR / dist
            child.x = cx + dx * scale
            child.y = cy + dy * scale
          }
        }
      }
    })

    console.log("[DEBUG] D3 simulation 初始化完成，开始计算布局")

    // CSS 变量预计算（Pixi 不支持 CSS 变量）
    const cssVars = [
      "--secondary",
      "--tertiary",
      "--gray",
      "--light",
      "--lightgray",
      "--dark",
      "--darkgray",
      "--bodyFont",
    ] as const
    const computedStyleMap = cssVars.reduce(
      (acc, key) => {
        acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key)
        return acc
      },
      {} as Record<(typeof cssVars)[number], string>,
    )

    const categoryPalette = ["#2563eb", "#0f766e", "#7c3aed", "#c05621", "#db2777", "#0891b2"]
    const categoryColor = (value: string): string => {
      let hash = 0
      for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
      return categoryPalette[Math.abs(hash) % categoryPalette.length]
    }

    // [STYLE] 大文件夹 / 大区分色调色板（品牌蓝为固定首色，色轮均分；浅深两套明度）
    const folderPaletteLight = [
      "#0369a1", "#0d9488", "#7c3aed", "#ea580c", "#16a34a", "#db2777", "#ca8a04", "#4f46e5",
    ]
    const folderPaletteDark = [
      "#38bdf8", "#2dd4bf", "#a78bfa", "#fb923c", "#4ade80", "#f472b6", "#facc15", "#818cf8",
    ]
    const folderPalette =
      document.documentElement.getAttribute("saved-theme") === "dark"
        ? folderPaletteDark
        : folderPaletteLight

    // 大区 → 颜色：按 regionNodeInfoMap 插入顺序用索引分配（与 groupKey 内容无关，
    // 规避已知的 groupKey 尾部空格等脏数据导致的问题）
    const regionColorMap = new Map<SimpleSlug, string>()
    {
      let _ri = 0
      for (const id of regionNodeInfoMap.keys()) {
        regionColorMap.set(id, folderPalette[_ri++ % folderPalette.length])
      }
    }

    // 一级目录 → 颜色（不在任何大区内的散点节点兜底）
    const folderColorMap = new Map<string, string>()
    const folderColor = (id: string): string => {
      const seg = id.split("/")[0]
      if (!folderColorMap.has(seg)) {
        folderColorMap.set(seg, folderPalette[folderColorMap.size % folderPalette.length])
      }
      return folderColorMap.get(seg)!
    }

    // 连线颜色：跟随 source 端（核心/大区）的区色，从"一片灰线"变为按区着色的关系网
    const linkColor = (ld: { source: NodeData; target: NodeData }): string => {
      const src = ld.source
      if (src.isAggregation) return computedStyleMap["--tertiary"]
      if (src.isRegion) return regionColorMap.get(src.id) ?? computedStyleMap["--lightgray"]
      const rid = coreToRegionMap.get(src.id)
      if (rid) return regionColorMap.get(rid) ?? computedStyleMap["--lightgray"]
      return computedStyleMap["--lightgray"]
    }

    const color = (d: NodeData) => {
      const isCurrent = d.id === slug
      if (isCurrent) return computedStyleMap["--secondary"]
      if (d.id.startsWith("tags/")) return computedStyleMap["--tertiary"]
      if (colorBy) {
        const raw = contentData.get(d.id)?.frontmatter?.[colorBy]
        const value = Array.isArray(raw) ? raw[0] : raw
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          return categoryColor(String(value))
        }
      }
      // [STYLE] 按大区 / 一级目录分色（替代原先统一 --gray 的单色观感）；
      // 区内节点继承大区色，展开后归属感一眼可见
      const rid = coreToRegionMap.get(d.id)
      if (rid) return regionColorMap.get(rid) ?? folderColor(d.id)
      if (d.isRegion) return regionColorMap.get(d.id) ?? computedStyleMap["--secondary"]
      return folderColor(d.id)
    }

    let hoveredNodeId: string | null = null
    let hoveredNeighbours: Set<string> = new Set()
    let edgeLabelDefaultAlpha = 0
    const linkRenderData: LinkRenderData[] = []
    const nodeRenderData: NodeRenderData[] = []

    function updateHoverInfo(newHoveredId: string | null) {
      hoveredNodeId = newHoveredId
      if (newHoveredId === null) {
        hoveredNeighbours = new Set()
        for (const n of nodeRenderData) n.active = false
        for (const l of linkRenderData) l.active = false
      } else {
        hoveredNeighbours = new Set()
        for (const l of linkRenderData) {
          const ld = l.simulationData
          if (ld.source.id === newHoveredId || ld.target.id === newHoveredId) {
            hoveredNeighbours.add(ld.source.id)
            hoveredNeighbours.add(ld.target.id)
          }
          l.active = ld.source.id === newHoveredId || ld.target.id === newHoveredId
        }
        for (const n of nodeRenderData) {
          n.active = hoveredNeighbours.has(n.simulationData.id)
        }
      }
    }

    let dragStartTime = 0
    let dragging = false

    function renderLinks() {
      tweens.get("link")?.stop()
      const tweenGroup = new TweenGroup()
      for (const l of linkRenderData) {
        const isAgg = l.isAggregation
        const defaultColor = isAgg ? computedStyleMap["--tertiary"] : linkColor(l.simulationData)
        const defaultAlpha = isAgg ? 0.35 : 1
        const alpha = hoveredNodeId ? (l.active ? 1 : defaultAlpha * 0.3) : defaultAlpha
        l.color = l.active ? computedStyleMap["--gray"] : defaultColor
        tweenGroup.add(new Tweened<LinkRenderData>(l).to({ alpha }, 200))
      }
      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("link", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderLabels() {
      tweens.get("label")?.stop()
      const tweenGroup = new TweenGroup()
      const defaultScale = 1 / scale
      const activeScale = defaultScale * 1.1

      for (const n of nodeRenderData) {
        const nodeId = n.simulationData.id
        if (hoveredNodeId === nodeId) {
          tweenGroup.add(
            new Tweened<Text>(n.label).to(
              { alpha: 1, scale: { x: activeScale, y: activeScale } },
              100,
            ),
          )
        } else {
          tweenGroup.add(
            new Tweened<Text>(n.label).to(
              { alpha: n.label.alpha, scale: { x: defaultScale, y: defaultScale } },
              100,
            ),
          )
        }
      }

      // 边标签跟随 hover 高亮
      for (const l of linkRenderData) {
        if (l.label) {
          if (l.active) {
            l.label.style.fill = computedStyleMap["--dark"]
            tweenGroup.add(
              new Tweened<Text>(l.label).to(
                { alpha: 1, scale: { x: activeScale, y: activeScale } },
                100,
              ),
            )
          } else {
            l.label.style.fill = computedStyleMap["--darkgray"]
            tweenGroup.add(
              new Tweened<Text>(l.label).to(
                { alpha: edgeLabelDefaultAlpha, scale: { x: defaultScale, y: defaultScale } },
                100,
              ),
            )
          }
        }
      }

      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("label", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderNodes() {
      tweens.get("hover")?.stop()
      const tweenGroup = new TweenGroup()
      for (const n of nodeRenderData) {
        const alpha = hoveredNodeId !== null && focusOnHover ? (n.active ? 1 : 0.2) : 1
        tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
        if (n.badge) {
          tweenGroup.add(new Tweened<Graphics>(n.badge, tweenGroup).to({ alpha }, 200))
        }
        if (n.badgeText) {
          tweenGroup.add(new Tweened<Text>(n.badgeText, tweenGroup).to({ alpha }, 200))
        }
        if (n.countLabel) {
          tweenGroup.add(new Tweened<Text>(n.countLabel, tweenGroup).to({ alpha }, 200))
        }
      }
      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("hover", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderPixiFromD3() {
      if (isGlobalGraph) {
        for (const n of nodeRenderData) {
          if (n.badge) n.badge.visible = !n.simulationData.isExpanded
          if (n.badgeText) n.badgeText.visible = !n.simulationData.isExpanded
          if (n.countLabel) n.countLabel.visible = !n.simulationData.isExpanded
        }
      }
      renderNodes()
      renderLinks()
      renderLabels()
    }

    tweens.forEach((tween) => tween.stop())
    tweens.clear()

    console.log("[DEBUG] 开始初始化 Pixi Application")
    markPhase("initializeSimulation")
    const app = new Application()
    await app.init({
      width,
      height,
      antialias: true,
      autoStart: false,
      autoDensity: true,
      backgroundAlpha: 0,
      preference: "webgpu",
      resolution: window.devicePixelRatio,
      eventMode: "static",
    })
    console.log("[DEBUG] Pixi Application 初始化完成")
    markPhase("initializePixi")

    // ===== 检查点 4: Pixi 初始化完成后 =====
    if (!isCurrent()) {
      simulation.stop()
      app.destroy({ removeView: true }, { children: true, context: true })
      return () => {}
    }

    graph.appendChild(app.canvas)
    const stage = app.stage
    stage.interactive = false

    const edgeLabelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
    const labelsContainer = new Container<Text>({ zIndex: 4, isRenderGroup: true })
    const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
    const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
    stage.addChild(linkContainer, edgeLabelsContainer, nodesContainer, labelsContainer)

    // ===== 对象池初始化 =====
    const graphicsPool = new ObjectPool<Graphics>(
      () => new Graphics({ interactive: true, eventMode: "static", cursor: "pointer" }),
      (gfx) => {
        gfx.clear()
        gfx.removeAllListeners()
        gfx.visible = true
        gfx.alpha = 1
        if (gfx.parent) gfx.parent.removeChild(gfx)
      },
    )
    const textPool = new ObjectPool<Text>(
      () =>
        new Text({
          interactive: false,
          eventMode: "none",
          text: "",
          alpha: 0,
          anchor: { x: 0.5, y: 1.2 },
          style: {
            fontSize: fontSize * 15,
            fill: computedStyleMap["--dark"],
            fontFamily: computedStyleMap["--bodyFont"],
            wordWrap: true,
            wordWrapWidth: 160,
          },
          resolution: window.devicePixelRatio * 4,
        }),
      (label) => {
        label.text = ""
        label.alpha = 0
        label.visible = true
        if (label.parent) label.parent.removeChild(label)
        label.style.fill = computedStyleMap["--dark"]
      },
    )
    const linkGraphicsPool = new ObjectPool<Graphics>(
      () => new Graphics({ interactive: false, eventMode: "none" }),
      (gfx) => {
        gfx.clear()
        gfx.visible = true
        gfx.alpha = 1
        if (gfx.parent) gfx.parent.removeChild(gfx)
      },
    )

    // ===== 辅助函数：创建节点渲染对象 =====
    /** 用短线段模拟虚线圆弧 */
    function drawDashedCircle(
      gfx: Graphics,
      cx: number,
      cy: number,
      r: number,
      dash: number,
      gap: number,
      strokeColor: string,
      strokeAlpha: number,
      strokeWidth: number,
    ) {
      const segments = 120
      const circumference = 2 * Math.PI * r
      const dashCount = Math.floor(circumference / (dash + gap))
      const pointsPerDash = Math.max(2, Math.floor(segments / dashCount))
      const pointsPerGap = Math.max(1, Math.floor((segments / dashCount) * (gap / (dash + gap))))

      for (let i = 0; i < dashCount; i++) {
        const startIdx = i * (pointsPerDash + pointsPerGap)
        const dashPoints: { x: number; y: number }[] = []
        for (let j = 0; j < pointsPerDash; j++) {
          const idx = (startIdx + j) % segments
          const angle = (idx / segments) * Math.PI * 2
          dashPoints.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r })
        }
        if (dashPoints.length > 1) {
          gfx.moveTo(dashPoints[0].x, dashPoints[0].y)
          for (let k = 1; k < dashPoints.length; k++) {
            gfx.lineTo(dashPoints[k].x, dashPoints[k].y)
          }
        }
      }
      gfx.stroke({ width: strokeWidth, color: strokeColor, alpha: strokeAlpha })
    }

    function createNodeRenderObject(n: NodeData): NodeRenderData {
      const nodeId = n.id
      const isTagNode = nodeId.startsWith("tags/")
      const isAggNode = n.isAggregation ?? false
      const isRegionNode = n.isRegion ?? false
      const r = isAggNode || isRegionNode ? (n.aggCollapsedRadius ?? 14) : nodeRadius(n)

      const label = textPool.acquire()
      label.text = n.text
      label.alpha = 0
      label.scale.set(1 / scale)

      // 聚合节点 / 大区节点标签：上方显示，使用 --tertiary 色和更小字号
      if (isAggNode || isRegionNode) {
        label.anchor.set(0.5, 0)
        label.style = {
          fontSize: fontSize * (isRegionNode ? 14 : 12),
          fill: isRegionNode ? computedStyleMap["--dark"] : computedStyleMap["--tertiary"],
          fontFamily: computedStyleMap["--bodyFont"],
          fontWeight: "bold",
        }
        if (isRegionNode) {
          label.alpha = 1
        }
      }

      const gfx = graphicsPool.acquire()
      gfx.label = nodeId
      gfx.hitArea = new Circle(0, 0, r + 8)
      if (isRegionNode) {
        // 大区节点：按区分色填充 + 同色虚线边框
        const regionColor = regionColorMap.get(nodeId) ?? computedStyleMap["--secondary"]
        gfx.circle(0, 0, r).fill({ color: regionColor, alpha: 0.12 })
        drawDashedCircle(gfx, 0, 0, r, 6, 4, regionColor, 0.55, 2)
      } else if (isAggNode) {
        // 聚合节点（可展开）：双圆环 + 浅色填充，专属标识
        gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
        gfx.circle(0, 0, r).stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
        gfx
          .circle(0, 0, r - 4)
          .stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
      } else if (n.isCore && !isTagNode) {
        // 核心节点（可展开）：大区色实心圆 + 浅色中心数字，与叶子实心填充明显区分
        gfx.circle(0, 0, r).fill({ color: color(n), alpha: 0.85 })
      } else {
        // 叶子节点（不可展开）：实心填充圆，最普通
        gfx.circle(0, 0, r).fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })
        if (isTagNode) gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
      }
      // 当前视角的真实主节点：加外环，不改变 isCore 及节点半径/布局。
      if (n.isFocus && !isTagNode) {
        gfx.circle(0, 0, r + focusRingOffset).stroke({
          width: focusRingStrokeWidth,
          color: computedStyleMap["--secondary"],
          alpha: 0.95,
        })
      }

      let oldLabelOpacity = 0
      gfx.on("pointerover", (e) => {
        updateHoverInfo(e.target.label)
        oldLabelOpacity = label.alpha
        if (!dragging) renderPixiFromD3()
      })
      gfx.on("pointerleave", () => {
        updateHoverInfo(null)
        label.alpha = oldLabelOpacity
        if (!dragging) renderPixiFromD3()
      })

      // 初始位置：靠近已有的相邻核心节点
      if (n.x === undefined || n.y === undefined) {
        const connectedCore = graphData.nodes.find(
          (cn) =>
            cn.isCore &&
            allLinks.some(
              (l) =>
                (l.source.id === cn.id && l.target.id === n.id) ||
                (l.target.id === cn.id && l.source.id === n.id),
            ),
        )
        if (connectedCore?.x !== undefined && connectedCore?.y !== undefined) {
          n.x = connectedCore.x + (Math.random() - 0.5) * 50
          n.y = connectedCore.y + (Math.random() - 0.5) * 50
        } else {
          n.x = (Math.random() - 0.5) * width * 0.5
          n.y = (Math.random() - 0.5) * height * 0.5
        }
      }

      nodesContainer.addChild(gfx)
      labelsContainer.addChild(label)

      // 徽章（显示关联数量；可通过 Graph 配置项 showBadge 开关）
      let badge: Graphics | undefined
      let badgeText: Text | undefined
      const edgeCount = n.edgeNodeCount ?? 0
      if (n.isCore && showBadge && edgeCount > 0) {
        const badgeRadius = Math.max(8, Math.min(14, 6 + Math.sqrt(edgeCount) * 2))
        badge = new Graphics()
          .circle(0, 0, badgeRadius)
          .fill({ color: computedStyleMap["--secondary"] })
          .stroke({ width: 1, color: computedStyleMap["--light"] })
        badgeText = new Text({
          text: edgeCount > 99 ? `99+` : String(edgeCount),
          style: {
            fontSize: 10,
            fontFamily: computedStyleMap["--bodyFont"],
            fill: computedStyleMap["--light"],
            fontWeight: "bold",
          },
        })
        badgeText.anchor.set(0.5, 0.5)
        const shouldHideBadge = n.isExpanded ?? false
        badge.visible = !shouldHideBadge
        badgeText.visible = !shouldHideBadge
        nodesContainer.addChild(badge)
        labelsContainer.addChild(badgeText)
      }

      // [FEATURE] 在节点圆中心显示直接关联数量
      // [FIX] 1. 添加 resolution 解决模糊问题 2. 悬浮到数字上时触发节点高亮，保持一致的交互体验
      let countLabel: Text | undefined
      // 核心节点始终显示中心数字（不限于 countLabelMin），标签节点除外
      if (n.isCore && !isTagNode && (n.edgeNodeCount ?? 0) > 0) {
        const count = n.edgeNodeCount ?? 0
        countLabel = new Text({
          text: count > countLabelMaxDisplay ? `${countLabelMaxDisplay}+` : String(count),
          style: {
            fontSize: Math.max(10, r * 0.95),
            fontFamily: computedStyleMap["--bodyFont"],
            fill: isRegionNode ? computedStyleMap["--dark"] : computedStyleMap["--light"],
            fontWeight: "bold",
          },
          resolution: window.devicePixelRatio * 4,
        })
        countLabel.anchor.set(0.5, 0.5)
        const shouldHideCount = n.isExpanded ?? false
        countLabel.visible = !shouldHideCount
        labelsContainer.addChild(countLabel)

        // [FIX] 悬浮到数字上时触发节点高亮，保持一致的交互体验
        countLabel.eventMode = "static"
        countLabel.cursor = "pointer"
        countLabel.on("pointerover", () => {
          updateHoverInfo(nodeId)
          if (!dragging) renderPixiFromD3()
        })
        countLabel.on("pointerleave", () => {
          updateHoverInfo(null)
          if (!dragging) renderPixiFromD3()
        })
        // 转发点击事件到下层节点 gfx
        countLabel.on("pointerdown", (e: any) => {
          gfx.emit("pointerdown", e)
        })
      }

      // 聚合节点：在节点中心显示子节点数量（与核心节点风格一致）
      if (isAggNode && (n.aggChildCount ?? 0) > 0) {
        const count = n.aggChildCount ?? 0
        countLabel = new Text({
          text: count > countLabelMaxDisplay ? `${countLabelMaxDisplay}+` : String(count),
          style: {
            fontSize: Math.max(8, r * 0.75),
            fontFamily: computedStyleMap["--bodyFont"],
            fill: computedStyleMap["--secondary"],
            fontWeight: "bold",
          },
          resolution: window.devicePixelRatio * 4,
        })
        countLabel.anchor.set(0.5, 0.5)
        const shouldHideCount = n.isExpanded ?? false
        countLabel.visible = !shouldHideCount
        labelsContainer.addChild(countLabel)

        // 聚合节点中心数字也要支持点击和悬浮高亮
        countLabel.eventMode = "static"
        countLabel.cursor = "pointer"
        countLabel.on("pointerover", () => {
          updateHoverInfo(nodeId)
          if (!dragging) renderPixiFromD3()
        })
        countLabel.on("pointerleave", () => {
          updateHoverInfo(null)
          if (!dragging) renderPixiFromD3()
        })
        countLabel.on("pointerdown", (e: any) => {
          gfx.emit("pointerdown", e)
        })
      }

      return {
        simulationData: n,
        gfx,
        label,
        color: color(n),
        alpha: 1,
        active: false,
        badge,
        badgeText,
        countLabel,
        isAggregation: isAggNode || undefined,
      }
    }

    function createLinkRenderObject(l: LinkData): LinkRenderData {
      const gfx = linkGraphicsPool.acquire()
      linkContainer.addChild(gfx)

      // 创建边标签
      let label: Text | undefined
      if (l.sourceField) {
        label = new Text({
          text: l.sourceField,
          style: {
            fontSize: fontSize * 15 * 0.85,
            fill: computedStyleMap["--darkgray"],
            fontFamily: computedStyleMap["--bodyFont"],
            stroke: { width: 1, color: computedStyleMap["--light"] },
          },
          alpha: 0,
          resolution: window.devicePixelRatio * 4,
        })
        label.anchor.set(0.5, 0.5)
        edgeLabelsContainer.addChild(label)
      }

      return {
        simulationData: l,
        gfx,
        label,
        color:
          l.source.isAggregation || l.target.isAggregation
            ? computedStyleMap["--tertiary"]
            : linkColor(l),
        alpha: l.source.isAggregation || l.target.isAggregation ? 0.35 : 1,
        active: false,
        isAggregation: l.source.isAggregation || l.target.isAggregation || undefined,
      }
    }

    // ===== 渲染初始节点和链接 =====
    for (const n of graphData.nodes) {
      nodeRenderData.push(createNodeRenderObject(n))
    }

    for (const l of graphData.links) {
      linkRenderData.push(createLinkRenderObject(l))
    }

    // ===== 展开/收起边缘节点 =====
    const expandedNodeIds = new Set<SimpleSlug>()

    function syncLocalContext(addBudget = 0) {
      if (graphView !== "local") return
      const pool = localContextNodes.filter(node => !contextPendingInInitialPage.has(node.id))
      const projected = projectLocalGraph(slug, graphData.nodes, graphData.links, pool, allLinks)
      const reachable = new Set(projected.context.map(node => node.id))
      const removeIds = new Set(graphData.nodes.filter(node => localContextIds.has(node.id) && !reachable.has(node.id)).map(node => node.id))
      if (removeIds.size) {
        tweens.forEach(tween => tween.stop())
        tweens.clear()
      }
      for (let i = nodeRenderData.length - 1; i >= 0; i--) {
        const rd = nodeRenderData[i]
        if (!removeIds.has(rd.simulationData.id)) continue
        graphicsPool.release(rd.gfx)
        textPool.release(rd.label)
        rd.badge?.destroy()
        rd.badgeText?.destroy()
        rd.countLabel?.destroy()
        rd.aggBg?.destroy()
        nodeRenderData.splice(i, 1)
      }
      graphData.nodes = graphData.nodes.filter(node => !removeIds.has(node.id))
      if (hoveredNodeId && removeIds.has(hoveredNodeId)) updateHoverInfo(null)
      const visible = new Set(graphData.nodes.map(node => node.id))
      // BFS order ensures a context's visible predecessor is added first.
      for (const node of projected.context.filter(node => !visible.has(node.id)).slice(0, addBudget)) {
        visible.add(node.id)
        graphData.nodes.push(node)
        nodeRenderData.push(createNodeRenderObject(node))
      }
      const links = projected.links.filter(link => visible.has(link.source.id) && visible.has(link.target.id))
      const keyFor = (link: LinkData) => JSON.stringify([link.source.id, link.target.id, link.sourceField])
      const wanted = new Set(links.map(keyFor))
      for (let i = linkRenderData.length - 1; i >= 0; i--) {
        if (wanted.has(keyFor(linkRenderData[i].simulationData))) continue
        linkGraphicsPool.release(linkRenderData[i].gfx)
        linkRenderData[i].label?.destroy()
        linkRenderData.splice(i, 1)
      }
      const existingLinks = new Set(linkRenderData.map(rd => keyFor(rd.simulationData)))
      for (const link of links) {
        if (!existingLinks.has(keyFor(link))) linkRenderData.push(createLinkRenderObject(link))
      }
      graphData.links = links
      const loadedContext = projected.context.filter(node => visible.has(node.id))
      const pendingContext = projected.context.filter(node => !visible.has(node.id))
      if (pendingContext.length) {
        const ordered = [...loadedContext, ...pendingContext]
        localContextOrder = new Map(ordered.map((node, index) => [node.id, index]))
        // Context has its own ordinary-node queue; aggregation progress still
        // counts actual members, and automatic disclosure remains bounded.
        expansionPages.open(localContextPageId, graphData.nodes, ordered, projected.links,
          loadBatchSize, loadedContext.length)
      } else expansionPages.close(localContextPageId)
    }

    function expandNode(nodeId: SimpleSlug) {
      if (expandedNodeIds.has(nodeId)) return

      const targetNode = graphData.nodes.find((n) => n.id === nodeId)
      // [REGION] 大区节点展开：加入内部核心节点及其邻接边缘节点
      if (targetNode?.isRegion || regionNodeInfoMap.has(nodeId)) {
        const nodesToAdd: NodeData[] = []
        let linksToAdd: LinkData[] = []

        // 获取子核心节点列表（优先从 map 取，fallback 从节点属性恢复）
        let childCores: NodeData[]
        if (regionNodeInfoMap.has(nodeId)) {
          childCores = regionNodeInfoMap.get(nodeId)!.childCores
        } else if (targetNode?.regionChildIds) {
          childCores = targetNode.regionChildIds
            .map((id) => allNodes.find((n) => n.id === id)!)
            .filter(Boolean)
        } else {
          childCores = []
        }

        const regionInfo = regionNodeInfoMap.get(nodeId)
        const remainingRules = regionInfo?.remainingRules ?? []

        if ((graphView === "folder" || graphView === "dimension" || isGlobalGraph) && sharedAggregation) {
          // 全局、文件夹和值页分区内的核心集合均沿剩余字段链展开。
          const regionNode = graphData.nodes.find((node) => node.id === nodeId)!
          const children = createSharedGroups(regionNode, childCores, remainingRules)
          const visible = new Set([...graphData.nodes, ...children].map((node) => node.id))
          for (const child of children) {
            if (!graphData.nodes.some((node) => node.id === child.id)) nodesToAdd.push(child)
            linksToAdd.push({ source: regionNode, target: child })
          }
          linksToAdd.push(...allLinks.filter(
            (link) => visible.has(link.source.id) && visible.has(link.target.id),
          ))
          // Shared-neighbor pools can contain the same real edge more than once.
          const seenLinks = new Set(graphData.links.map(link => JSON.stringify([link.source.id, link.target.id])))
          linksToAdd = linksToAdd.filter(link => {
            const key = JSON.stringify([link.source.id, link.target.id])
            if (seenLinks.has(key)) return false
            seenLinks.add(key)
            return true
          })
        } else if (remainingRules.length > 0 && childCores.length > 0) {
          // [REGION] 有多层规则：按 remainingRules 创建子聚合节点
          const coresForNextRule = childCores.filter(
            (n) => !graphData.nodes.some((gn) => gn.id === n.id),
          )

          if (coresForNextRule.length > 0) {
            let effectiveRuleIdx = -1
            let effectiveGroupMap: Map<string, NodeData[]> | null = null
            let effectiveRule: AggregationRule | null = null

            for (let i = 0; i < remainingRules.length; i++) {
              const rule = remainingRules[i]
              const groupMap = new Map<string, NodeData[]>()
              let hasValidValue = false

              for (const core of coresForNextRule) {
                const details = contentData.get(core.id)
                let groupKey: string | null = null

                if (details) {
                  if (rule.type === "folder") {
                    const parts = String(core.id).split("/")
                    const depth = rule.depth ?? 1
                    if (parts.length > 1) {
                      const folderParts =
                        depth > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)) : [parts[0]]
                      groupKey = folderParts.join("/")
                    } else {
                      groupKey = "/"
                    }
                  } else if (rule.type === "field") {
                    const field = rule.field ?? ""
                    const rawValue = (details as any).frontmatter?.[field]
                    if (!Array.isArray(rawValue) && rawValue !== undefined && rawValue !== null) {
                      hasValidValue = true
                      groupKey = String(rawValue)
                    }
                  }
                }

                if (rule.type !== "folder" && !groupKey) {
                  groupKey = UNCLASSIFIED_KEY
                }
                if (groupKey !== null) {
                  const group = groupMap.get(groupKey) ?? []
                  group.push(core)
                  groupMap.set(groupKey, group)
                }
              }

              if (rule.type === "folder") {
                if (groupMap.size <= 1) continue
              } else {
                if (!hasValidValue || groupMap.size === 0) continue
              }

              effectiveRuleIdx = i
              effectiveGroupMap = groupMap
              effectiveRule = rule
              break
            }

            if (effectiveRuleIdx >= 0 && effectiveGroupMap && effectiveRule) {
              const remainingRulesAfter = remainingRules.slice(effectiveRuleIdx + 1)
              const displayPrefix = effectiveRule.type === "folder" ? "📁 " : ""
              const regionNodeRef = graphData.nodes.find((n) => n.id === nodeId)!

              for (const [groupKey, groupCores] of effectiveGroupMap) {
                const displayKey =
                  effectiveRule.type === "folder"
                    ? groupKey === "/"
                      ? `📁 ${folderTitleMap.get("/") ?? "根目录"}`
                      : `📁 ${folderDisplay(groupKey)}`
                    : `${displayPrefix}${groupKey}`
                const subAggId =
                  `agg:region:${nodeId}:${effectiveRule.type}:${effectiveRule.field ?? ""}:${groupKey}` as SimpleSlug
                const collapsedR = Math.min(30, Math.max(16, 2 + Math.sqrt(groupCores.length)))
                const subAggNode: NodeData = {
                  id: subAggId,
                  text: displayKey,
                  tags: [],
                  isCore: false,
                  isAggregation: true,
                  edgeNodeCount: 0,
                  aggCollapsedRadius: collapsedR,
                  aggChildCount: groupCores.length,
                }

                const subAggLink: LinkData = {
                  source: subAggNode,
                  target: regionNodeRef,
                  sourceField:
                    effectiveRule.type === "folder"
                      ? "📁"
                      : (effectiveRule.field ?? effectiveRule.type),
                }

                aggToCoreMap.set(subAggId, nodeId)
                aggNodeToChildNodes.set(subAggId, groupCores)
                aggNodeToChildLinks.set(subAggId, [])
                aggNodeInfoMap.set(subAggId, {
                  node: subAggNode,
                  coreId: nodeId,
                  childNodes: groupCores,
                  childLinks: [],
                  remainingRules: remainingRulesAfter,
                  currentField:
                    effectiveRule.type === "folder"
                      ? "📁"
                      : (effectiveRule.field ?? effectiveRule.type),
                  rule: effectiveRule,
                  scope: commonFolderOf(groupCores.map((child) => String(child.id))),
                  groupKey,
                })

                nodesToAdd.push(subAggNode)
                linksToAdd.push(subAggLink)
              }
            } else {
              // 所有剩余规则都无效，回退到显示核心节点
              for (const core of childCores) {
                if (!graphData.nodes.some((n) => n.id === core.id)) {
                  nodesToAdd.push(core)
                }
                const regionNodeRef = graphData.nodes.find((n) => n.id === nodeId)!
                linksToAdd.push({
                  source: regionNodeRef,
                  target: core,
                })
              }
            }
          }
        } else {
          // 没有剩余规则，直接显示核心节点及其边缘节点
          for (const core of childCores) {
            if (!graphData.nodes.some((n) => n.id === core.id)) {
              nodesToAdd.push(core)
            }

            // 仅当 expandCoresOnRegionOpen 为 true 时才同时展开核心节点的边缘节点
            if (expandCoresOnRegionOpen) {
              prepareNeighbors(core.id)
              const coreEdgeNodes = nodeToEdgeNodes.get(core.id) ?? []
              for (const edge of coreEdgeNodes) {
                if (!graphData.nodes.some((n) => n.id === edge.id)) {
                  nodesToAdd.push(edge)
                }
              }

              const coreEdgeLinks = nodeToEdgeLinks.get(core.id) ?? []
              for (const l of coreEdgeLinks) {
                if (
                  !graphData.links.some(
                    (gl) => gl.source.id === l.source.id && gl.target.id === l.target.id,
                  )
                ) {
                  linksToAdd.push(l)
                }
              }
            }

            const regionNodeRef = graphData.nodes.find((n) => n.id === nodeId)!
            linksToAdd.push({
              source: regionNodeRef,
              target: core,
            })
          }
        }

        const page = expansionPages.open(nodeId, graphData.nodes, nodesToAdd, linksToAdd)
        expandedNodeIds.add(nodeId)
        nodesToAdd.splice(0, nodesToAdd.length, ...page.nodes)
        linksToAdd = page.links
        updateExpansionControls()
        if (nodesToAdd.length > 0 || linksToAdd.length > 0) {
          graphData.nodes.push(...nodesToAdd)
          graphData.links.push(...linksToAdd)

          // 给新节点设置初始位置（围绕大区节点）
          const regionNode = graphData.nodes.find((n) => n.id === nodeId)!
          const cx = regionNode.x ?? 0
          const cy = regionNode.y ?? 0
          for (let i = 0; i < nodesToAdd.length; i++) {
            const n = nodesToAdd[i]
            if (n.x == null) {
              const angle = (i / Math.max(nodesToAdd.length, 1)) * Math.PI * 2
              const dist = 60 + Math.random() * 40
              n.x = cx + Math.cos(angle) * dist
              n.y = cy + Math.sin(angle) * dist
            }
          }

          for (const n of nodesToAdd) {
            nodeRenderData.push(createNodeRenderObject(n))
          }
          for (const l of linksToAdd) {
            linkRenderData.push(createLinkRenderObject(l))
          }

          simulation.nodes(graphData.nodes)
          simulation.force("link", createGraphLinkForce(graphData.links, graphView, linkDistance))
          simulation.alpha(0.3).restart()
          updateVisibleCount()
        }

        return
      }

      const isAggNode = nodeId.startsWith("agg:")
      let edgeNodesToAdd: NodeData[] = []
      let edgeLinksToAdd: LinkData[] = []

      if (isAggNode) {
        const aggInfo = aggNodeInfoMap.get(nodeId)
        const rawChildren = aggNodeToChildNodes.get(nodeId) ?? []

        // 多级聚合：若还有 remainingRules，按规则顺序执行
        if (sharedAggregation && aggInfo) {
          edgeNodesToAdd = createSharedGroups(aggInfo.node, rawChildren, aggInfo.remainingRules)
          edgeLinksToAdd = edgeNodesToAdd.map(child => ({ source: aggInfo.node, target: child }))
          const visible = new Set([...graphData.nodes, ...edgeNodesToAdd].map(n => n.id))
          const expandedMembers = new Set(rawChildren.map(n => n.id))
          const activeOwners = [...aggNodeInfoMap].filter(([id]) => id === nodeId || expandedNodeIds.has(id))
            .map(([, info]) => {
              let root = info.coreId
              while (aggToCoreMap.has(root)) root = aggToCoreMap.get(root)!
              return { root, childIds: new Set(info.childNodes.map(n => n.id)) }
            })
          edgeLinksToAdd.push(...incidentLinks(expandedMembers).filter(l => {
            if (!visible.has(l.source.id) || !visible.has(l.target.id)) return false
            if (!expandedMembers.has(l.source.id) && !expandedMembers.has(l.target.id)) return false
            if (showAggregatedNodeLinks) return true
            return activeOwners.every(({ root, childIds }) =>
              showOriginalCenterLink(l.source.id, l.target.id, root, childIds, false))
          }))
        } else if (aggInfo && aggInfo.remainingRules.length > 0) {
          const childNodes = rawChildren.filter(
            (n) => !graphData.nodes.some((gn) => gn.id === n.id),
          )

          if (childNodes.length > 0) {
            // 按 remainingRules 顺序执行，找到第一个有效的规则
            let effectiveRuleIdx = -1
            let effectiveGroupMap: Map<string, NodeData[]> | null = null
            let effectiveRule: AggregationRule | null = null

            for (let i = 0; i < aggInfo.remainingRules.length; i++) {
              const rule = aggInfo.remainingRules[i]
              const groupMap = new Map<string, NodeData[]>()
              let hasValidValue = false

              for (const leaf of childNodes) {
                const details = contentData.get(leaf.id)
                let groupKey: string | null = null

                if (details) {
                  if (rule.type === "folder") {
                    const parts = String(leaf.id).split("/")
                    const depth = rule.depth ?? 1
                    if (parts.length > 1) {
                      const folderParts =
                        depth > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)) : [parts[0]]
                      groupKey = folderParts.join("/")
                    } else {
                      groupKey = "/"
                    }
                  } else if (rule.type === "field") {
                    const field = rule.field ?? ""
                    const rawValue = (details as any).frontmatter?.[field]
                    // 多级聚合中跳过数组字段
                    if (!Array.isArray(rawValue) && rawValue !== undefined && rawValue !== null) {
                      hasValidValue = true
                      groupKey = String(rawValue)
                    }
                  }
                }

                if (rule.type !== "folder" && !groupKey) {
                  groupKey = UNCLASSIFIED_KEY
                }
                if (groupKey !== null) {
                  const group = groupMap.get(groupKey) ?? []
                  group.push(leaf)
                  groupMap.set(groupKey, group)
                }
              }

              // folder 规则：单分组跳过；field/date 规则：没有有效值则跳过
              if (rule.type === "folder") {
                if (groupMap.size <= 1) continue
              } else {
                if (!hasValidValue || groupMap.size === 0) continue
              }

              effectiveRuleIdx = i
              effectiveGroupMap = groupMap
              effectiveRule = rule
              break
            }

            if (effectiveRuleIdx >= 0 && effectiveGroupMap && effectiveRule) {
              // 使用第一个有效规则创建子聚合节点
              const remainingRulesAfter = aggInfo.remainingRules.slice(effectiveRuleIdx + 1)
              const displayPrefix = effectiveRule.type === "folder" ? "📁 " : ""
              for (const [groupKey, groupLeaves] of effectiveGroupMap) {
                const displayKey =
                  effectiveRule.type === "folder"
                    ? groupKey === "/"
                      ? `📁 ${folderTitleMap.get("/") ?? "根目录"}`
                      : `📁 ${folderDisplay(groupKey)}`
                    : `${displayPrefix}${groupKey}`
                const subAggId =
                  `agg:sub:${nodeId}:${effectiveRule.type}:${effectiveRule.field ?? ""}:${groupKey}` as SimpleSlug
                const collapsedR = Math.min(24, Math.max(12, 2 + Math.sqrt(groupLeaves.length)))
                const subAggNode: NodeData = {
                  id: subAggId,
                  text: displayKey,
                  tags: [],
                  isCore: false,
                  isAggregation: true,
                  edgeNodeCount: 0,
                  aggCollapsedRadius: collapsedR,
                  aggChildCount: groupLeaves.length,
                }

                const subAggLink: LinkData = {
                  source: subAggNode,
                  target: aggInfo.node,
                  sourceField:
                    effectiveRule.type === "folder"
                      ? "📁"
                      : (effectiveRule.field ?? effectiveRule.type),
                }

                aggToCoreMap.set(subAggId, nodeId)
                aggNodeToChildNodes.set(subAggId, groupLeaves)
                aggNodeToChildLinks.set(subAggId, [])
                aggNodeInfoMap.set(subAggId, {
                  node: subAggNode,
                  coreId: nodeId,
                  childNodes: groupLeaves,
                  childLinks: [],
                  remainingRules: remainingRulesAfter,
                  currentField:
                    effectiveRule.type === "folder"
                      ? "📁"
                      : (effectiveRule.field ?? effectiveRule.type),
                  rule: effectiveRule,
                  scope: commonFolderOf(groupLeaves.map((child) => String(child.id))),
                  groupKey,
                })

                edgeNodesToAdd.push(subAggNode)
                edgeLinksToAdd.push(subAggLink)
              }
            } else {
              // 所有剩余规则都无效，直接显示原始叶子，并添加聚合节点到叶子的连线
              edgeNodesToAdd = childNodes
              const parentNodeRef = graphData.nodes.find((n) => n.id === nodeId)
              if (parentNodeRef) {
                for (const child of childNodes) {
                  edgeLinksToAdd.push({ source: parentNodeRef, target: child })
                }
              }
            }
          }
        } else {
          // 最后一级：直接展开原始叶子，并添加相关连线
          edgeNodesToAdd = rawChildren.filter((n) => !graphData.nodes.some((gn) => gn.id === n.id))

          // 添加聚合节点到叶子的连线
          const parentNodeRef = graphData.nodes.find((n) => n.id === nodeId)
          const coreId = aggToCoreMap.get(nodeId)
          if (parentNodeRef) {
            for (const child of edgeNodesToAdd) {
              edgeLinksToAdd.push({ source: parentNodeRef, target: child })
            }
          }

          // 添加叶子之间原有的连线，但过滤掉与所属核心节点的连线
          const childLinks = incidentLinks(rawChildren.map(node => node.id))
          const rawChildIds = new Set(rawChildren.map(n => n.id))
          const visibleOrAddingIds = new Set([
            ...graphData.nodes.map((n) => n.id),
            ...edgeNodesToAdd.map((n) => n.id),
          ])
          for (const l of childLinks) {
            if (coreId && !showOriginalCenterLink(l.source.id, l.target.id, coreId,
              rawChildIds, showAggregatedNodeLinks)) continue
            if (visibleOrAddingIds.has(l.source.id) && visibleOrAddingIds.has(l.target.id)) {
              edgeLinksToAdd.push(l)
            }
          }
        }
      } else {
        const plan = prepareNeighbors(nodeId)
        edgeNodesToAdd = plan.nodes
        edgeLinksToAdd = plan.links
      }

      {
        const page = expansionPages.open(nodeId, graphData.nodes, edgeNodesToAdd, edgeLinksToAdd,
          isAggNode ? expandBatchSize : loadBatchSize)
        edgeNodesToAdd = page.nodes
        edgeLinksToAdd = page.links
      }
      expandedNodeIds.add(nodeId)
      updateExpansionControls()
      const parentNode = graphData.nodes.find((n) => n.id === nodeId)

      // Keep the clicked aggregation anchored while its children settle around it.
      if (parentNode?.x !== undefined && parentNode?.y !== undefined) {
        if (isAggNode) {
          expansionPins.add(nodeId)
          parentNode.fx = parentNode.x
          parentNode.fy = parentNode.y
          parentNode.vx = 0
          parentNode.vy = 0
        }
        const newNodes = edgeNodesToAdd.filter(n => !graphData.nodes.some(existing => existing.id === n.id))
        // Expand away from the immediate aggregation parent (or the original core
        // at the first level). Only seed new positions; the simulation remains free.
        let outwardAngle = Math.atan2(parentNode.y, parentNode.x)
        if (isAggNode) {
          let ancestorId = aggToCoreMap.get(nodeId)
          const seen = new Set<string>([nodeId])
          while (ancestorId && !seen.has(ancestorId)) {
            seen.add(ancestorId)
            const ancestor = graphData.nodes.find(n => n.id === ancestorId)
            if (ancestor?.x !== undefined && ancestor?.y !== undefined) {
              const dx = parentNode.x - ancestor.x
              const dy = parentNode.y - ancestor.y
              if (Math.hypot(dx, dy) > 1) {
                outwardAngle = Math.atan2(dy, dx)
                break
              }
            }
            ancestorId = aggToCoreMap.get(ancestorId)
          }
        }
        const baseRadius = Math.max(40, Math.min(linkDistance, 100))
        const radius = isAggNode
          ? Math.min(180, Math.max(baseRadius, Math.sqrt(newNodes.length) * 24))
          : baseRadius
        const nestedLocal = graphView === "local" && isAggNode && aggToCoreMap.get(nodeId)?.startsWith("agg:") === true
        for (const [index, edgeNode] of newNodes.entries()) {
          const angle = isAggNode
            ? expansionSeedAngle(outwardAngle, index, newNodes.length, nestedLocal)
            : index * Math.PI * 2 / Math.max(1, newNodes.length)
          edgeNode.x = parentNode.x + Math.cos(angle) * radius
          edgeNode.y = parentNode.y + Math.sin(angle) * radius
          edgeNode.vx = 0
          edgeNode.vy = 0
        }
      }

      for (const edgeNode of edgeNodesToAdd) {
        if (graphData.nodes.some((n) => n.id === edgeNode.id)) continue
        graphData.nodes.push(edgeNode)
        nodeRenderData.push(createNodeRenderObject(edgeNode))
      }
      for (const link of edgeLinksToAdd) {
        if (
          graphData.links.some(
            (l) => l.source.id === link.source.id && l.target.id === link.target.id,
          )
        )
          continue
        graphData.links.push(link)
        linkRenderData.push(createLinkRenderObject(link))
      }

      expandedNodeIds.add(nodeId)

      if (isAggNode && edgeNodesToAdd.length > 0) {
        expandedAggChildren.set(nodeId, new Set(edgeNodesToAdd.map((n) => n.id)))
      }
      const nodeData = graphData.nodes.find((n) => n.id === nodeId)
      if (nodeData) {
        nodeData.isExpanded = true
        const rd = nodeRenderData.find((r) => r.simulationData.id === nodeId)
        if (rd) {
          if (rd.badge) rd.badge.visible = false
          if (rd.badgeText) rd.badgeText.visible = false
          if (rd.countLabel) rd.countLabel.visible = false
        }
      }

      for (const edgeNode of edgeNodesToAdd) {
        const rd = nodeRenderData.find((r) => r.simulationData.id === edgeNode.id)
        if (rd && !isAggNode) {
          rd.label.alpha = 1
          rd.label.style = { ...rd.label.style, fill: computedStyleMap["--darkgray"] }
        }
      }
      for (const link of edgeLinksToAdd) {
        const lrd = linkRenderData.find(
          (r) =>
            r.simulationData.source.id === link.source.id &&
            r.simulationData.target.id === link.target.id,
        )
        if (lrd?.label && !isAggNode) {
          lrd.label.alpha = 1
          lrd.label.style = { ...lrd.label.style, fill: computedStyleMap["--darkgray"] }
        }
      }

      syncLocalContext(loadBatchSize)
      renderLabels()

      simulation.nodes(graphData.nodes)
      simulation.force("link", createGraphLinkForce(graphData.links, graphView, linkDistance))
      simulation.alpha(isAggNode ? 0.12 : 0.3).restart()
      updateVisibleCount()
    }

    function collapseNode(nodeId: SimpleSlug) {
      if (!expandedNodeIds.has(nodeId)) return
      expansionPages.close(nodeId)
      // A collapse destroys Pixi objects. Stop tweens that may still reference them
      // before the next animation frame updates their positions or scale.
      tweens.forEach((tween) => tween.stop())
      tweens.clear()

      const targetNode = graphData.nodes.find((n) => n.id === nodeId)
      // [REGION] 大区节点收起：移除内部核心节点及其所有邻接边缘节点
      if (targetNode?.isRegion || regionNodeInfoMap.has(nodeId)) {
        const idsToRemove = new Set<string>()

        // 获取子核心节点列表（优先从 map 取，fallback 从节点属性恢复）
        let childCores: NodeData[]
        if (regionNodeInfoMap.has(nodeId)) {
          childCores = regionNodeInfoMap.get(nodeId)!.childCores
        } else if (targetNode?.regionChildIds) {
          childCores = targetNode.regionChildIds
            .map((id) => allNodes.find((n) => n.id === id)!)
            .filter(Boolean)
        } else {
          childCores = []
        }

        // [REGION] 收起区域节点的子聚合节点，并触发其内部核心节点的收起
        for (const [aggId, info] of aggNodeInfoMap.entries()) {
          if (info.coreId === nodeId) {
            // 先触发该聚合节点下所有核心节点的收起（清理其边缘节点）
            for (const core of info.childNodes) {
              if (expandedNodeIds.has(core.id)) {
                collapseNode(core.id)
              }
            }
            // 再处理聚合节点自身的展开状态
            if (expandedNodeIds.has(aggId)) {
              if (sharedAggregation || graphView === "folder" || graphView === "dimension") collapseNode(aggId)
              else {
                expandedNodeIds.delete(aggId)
                expandedAggChildren.delete(aggId)
              }
            }
            idsToRemove.add(aggId)
          }
        }

        for (const core of childCores) {
          idsToRemove.add(core.id)
          // 收集该核心节点的邻接边缘节点
          const coreEdgeNodes = nodeToEdgeNodes.get(core.id) ?? []
          for (const edge of coreEdgeNodes) {
            idsToRemove.add(edge.id)
          }
        }

        if (sharedAggregation) {
          // A file may remain visible through another expanded core/aggregation outside this region.
          for (const expandedId of expandedNodeIds) {
            if (expandedId === nodeId || idsToRemove.has(expandedId)) continue
            const children = expandedId.startsWith("agg:")
              ? expandedAggChildren.get(expandedId) ?? new Set()
              : new Set((nodeToEdgeNodes.get(expandedId) ?? []).map(n => n.id))
            for (const childId of children) idsToRemove.delete(childId)
          }
        }
        for (const node of graphData.nodes) {
          if (idsToRemove.has(node.id)) releaseExpansionPin(node)
        }
        graphData.nodes = graphData.nodes.filter((n) => !idsToRemove.has(n.id))
        graphData.links = graphData.links.filter(
          (l) => !idsToRemove.has(l.source.id) && !idsToRemove.has(l.target.id),
        )

        // 清理渲染数据（完整销毁节点关联的所有 Pixi 对象）
        for (let i = nodeRenderData.length - 1; i >= 0; i--) {
          const rd = nodeRenderData[i]
          if (idsToRemove.has(rd.simulationData.id)) {
            rd.gfx.destroy()
            rd.label.destroy()
            if (rd.badge) {
              rd.badge.destroy()
              rd.badge = undefined
            }
            if (rd.badgeText) {
              rd.badgeText.destroy()
              rd.badgeText = undefined
            }
            if (rd.countLabel) {
              rd.countLabel.destroy()
              rd.countLabel = undefined
            }
            if (rd.aggBg) {
              rd.aggBg.destroy()
              rd.aggBg = undefined
            }
            nodeRenderData.splice(i, 1)
          }
        }
        for (let i = linkRenderData.length - 1; i >= 0; i--) {
          const l = linkRenderData[i].simulationData
          if (idsToRemove.has(l.source.id) || idsToRemove.has(l.target.id)) {
            linkRenderData[i].gfx.destroy()
            if (linkRenderData[i].label) linkRenderData[i].label!.destroy()
            linkRenderData.splice(i, 1)
          }
        }

        expandedNodeIds.delete(nodeId)
        simulation.nodes(graphData.nodes)
        simulation.force("link", createGraphLinkForce(graphData.links, graphView, linkDistance))
        simulation.alpha(0.3).restart()
        updateVisibleCount()
        return
      }

      // 聚合节点：移除展开的子边缘节点，释放固定位置
      const isAggNode = nodeId.startsWith("agg:")
      const edgeNodesToRemove = isAggNode
        ? (aggNodeToChildNodes.get(nodeId) ?? [])
        : (nodeToEdgeNodes.get(nodeId) ?? [])

      // 收集需要移除的节点：先递归收起已展开的子节点，再收集所有可见后代
      const nodesToRemove = new Set<NodeData>()
      function collectDescendants(aggId: SimpleSlug) {
        const childIds = expandedAggChildren.get(aggId)
        if (!childIds) return
        for (const childId of childIds) {
          const child = graphData.nodes.find((n) => n.id === childId)
          if (!child) continue
          nodesToRemove.add(child)
          if (child.isAggregation && expandedNodeIds.has(childId)) {
            // 子聚合节点已展开：递归收集孙节点
            collectDescendants(childId)
            expandedNodeIds.delete(childId)
            expandedAggChildren.delete(childId)
          } else if (expandedNodeIds.has(childId)) {
            // [FIX] 核心/散点节点已展开：递归收起其子节点（聚合节点、边缘节点等）
            collapseNode(childId)
          }
        }
      }
      if (isAggNode) {
        collectDescendants(nodeId)
      }
      // 加入直接子节点，同时递归处理其中已展开的子节点
      for (const edgeNode of edgeNodesToRemove) {
        nodesToRemove.add(edgeNode)
        if (edgeNode.isAggregation && expandedNodeIds.has(edgeNode.id)) {
          collectDescendants(edgeNode.id)
          expandedNodeIds.delete(edgeNode.id)
          expandedAggChildren.delete(edgeNode.id)
        } else if (expandedNodeIds.has(edgeNode.id)) {
          // [FIX] 核心/散点节点已展开：递归收起其子节点
          collapseNode(edgeNode.id)
        }
      }

      // 辅助：清理聚合节点的展开状态（gfx 样式、aggBg、expanded 标记等）
      function cleanupAggNodeState(aggNodeData: NodeData) {
        if (!aggNodeData.isAggregation) return
        releaseExpansionPin(aggNodeData)
        aggNodeData.isExpanded = false
        aggNodeData.aggExpandedRadius = undefined
        expandedNodeIds.delete(aggNodeData.id)
        expandedAggChildren.delete(aggNodeData.id)
        const rd = nodeRenderData.find((r) => r.simulationData.id === aggNodeData.id)
        if (rd) {
          if (rd.aggBg) {
            rd.aggBg.destroy()
            rd.aggBg = undefined
            rd.aggExpandedRadius = undefined
          }
          rd.gfx.clear()
          const r = aggNodeData.aggCollapsedRadius ?? 14
          rd.gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
          rd.gfx
            .circle(0, 0, r)
            .stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
          rd.gfx
            .circle(0, 0, r - 4)
            .stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
          rd.gfx.hitArea = new Circle(0, 0, r + 8)
        }
      }

      for (const edgeNode of nodesToRemove) {
        let stillReferenced = false
        for (const expandedId of expandedNodeIds) {
          if (expandedId === nodeId) continue
          const otherChildren = expandedId.startsWith("agg:")
            ? (expandedAggChildren.get(expandedId) ?? new Set())
            : new Set((nodeToEdgeNodes.get(expandedId) ?? []).map((n) => n.id))
          if (otherChildren.has(edgeNode.id)) {
            stillReferenced = true
            break
          }
        }
        if (stillReferenced) continue

        // 若移除的是聚合节点，先清理其展开状态
        cleanupAggNodeState(edgeNode)

        const renderIdx = nodeRenderData.findIndex((r) => r.simulationData.id === edgeNode.id)
        if (renderIdx !== -1) {
          const rd = nodeRenderData[renderIdx]
          graphicsPool.release(rd.gfx)
          textPool.release(rd.label)
          if (rd.badge) {
            rd.badge.destroy()
            rd.badge = undefined
          }
          if (rd.badgeText) {
            rd.badgeText.destroy()
            rd.badgeText = undefined
          }
          if (rd.countLabel) {
            rd.countLabel.destroy()
            rd.countLabel = undefined
          }
          // 若子节点是聚合节点，销毁其 aggBg
          if (rd.aggBg) {
            rd.aggBg.destroy()
            rd.aggBg = undefined
            rd.aggExpandedRadius = undefined
          }
          nodeRenderData.splice(renderIdx, 1)
        }

        for (let i = linkRenderData.length - 1; i >= 0; i--) {
          const link = linkRenderData[i].simulationData
          if (link.source.id === edgeNode.id || link.target.id === edgeNode.id) {
            linkGraphicsPool.release(linkRenderData[i].gfx)
            if (linkRenderData[i].label) {
              linkRenderData[i].label!.destroy()
            }
            linkRenderData.splice(i, 1)
          }
        }

        const nodeIdx = graphData.nodes.findIndex((n) => n.id === edgeNode.id)
        if (nodeIdx !== -1) graphData.nodes.splice(nodeIdx, 1)
        edgeNode.aggTargetOffset = undefined
        graphData.links = graphData.links.filter(
          (l) => l.source.id !== edgeNode.id && l.target.id !== edgeNode.id,
        )
      }

      if (sharedAggregation && isAggNode) {
        // Shared children may survive via another center; remove this parent's
        // expansion edges even when their endpoint nodes remain visible.
        const children = expandedAggChildren.get(nodeId) ?? new Set()
        const belongsToExpansion = (link: LinkData) =>
          (link.source.id === nodeId && children.has(link.target.id)) ||
          (link.target.id === nodeId && children.has(link.source.id))
        graphData.links = graphData.links.filter(link => !belongsToExpansion(link))
        for (let i = linkRenderData.length - 1; i >= 0; i--) {
          if (!belongsToExpansion(linkRenderData[i].simulationData)) continue
          linkGraphicsPool.release(linkRenderData[i].gfx)
          linkRenderData[i].label?.destroy()
          linkRenderData.splice(i, 1)
        }
      }
      expandedNodeIds.delete(nodeId)
      expandedAggChildren.delete(nodeId)
      // 收起时把该节点尚未加载的溢出成员一并移出「+N」队列

      const nodeData = graphData.nodes.find((n) => n.id === nodeId)
      if (nodeData) {
        nodeData.isExpanded = false
        releaseExpansionPin(nodeData)
        const rd = nodeRenderData.find((r) => r.simulationData.id === nodeId)
        if (rd) {
          // 聚合节点：销毁背景圆圈（若存在），恢复原始样式
          if (isAggNode) {
            if (rd.aggBg) {
              rd.aggBg.destroy()
              rd.aggBg = undefined
              rd.aggExpandedRadius = undefined
            }
            rd.gfx.clear()
            const r = nodeData.aggCollapsedRadius ?? 14
            rd.gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
            rd.gfx
              .circle(0, 0, r)
              .stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
            rd.gfx
              .circle(0, 0, r - 4)
              .stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
            rd.gfx.hitArea = new Circle(0, 0, r + 8)
            nodeData.aggExpandedRadius = undefined // 恢复碰撞半径
          }
          if (rd.badge) rd.badge.visible = true
          if (rd.badgeText) rd.badgeText.visible = true
          if (rd.countLabel) rd.countLabel.visible = true
        }
      }

      syncLocalContext()
      renderLabels()
      simulation.nodes(graphData.nodes)
      simulation.force("link", createGraphLinkForce(graphData.links, graphView, linkDistance))
      // 收起时用较高 alpha 重新收敛，避免节点停留在展开时的远距离位置
      simulation.alpha(0.3).restart()
      updateVisibleCount()
    }

    function toggleNodeExpansion(nodeId: SimpleSlug) {
      if (!expandedNodeIds.has(nodeId)) pagination.select(nodeId)
      expandedNodeIds.has(nodeId) ? collapseNode(nodeId) : expandNode(nodeId)
      updateExpansionControls()
    }

    // 操作区固定在画布外，不参与力导向模拟。
    const pagination = createExpansionControls(id => loadExpansionPage(id as SimpleSlug), id => {
      updateHoverInfo(id === initialPageId ? null : id)
      renderPixiFromD3()
    })
    const expansionControls = pagination.element
    const controlsAnchor = graph.closest(".graph-outer") ?? graph
    controlsAnchor.insertAdjacentElement("afterend", expansionControls)
    function updateExpansionControls() {
      const visible = new Set(graphData.nodes.map(node => String(node.id)))
      const items: ExpansionControlItem[] = []
      for (const [id, progress] of expansionPages.entries()) {
        const rootQueue = id === initialPageId || id === localContextPageId
        if (!rootQueue && (!visible.has(id) || !expandedNodeIds.has(id as SimpleSlug))) {
          expansionPages.close(id)
          continue
        }
        const parent = graphData.nodes.find(node => node.id === id)
        if (id !== initialPageId && progress.total <= (parent?.isAggregation || parent?.isRegion ? expandBatchSize : loadBatchSize) && progress.loaded === progress.total) continue
        const ancestors: string[] = []
        let ancestorId = aggToCoreMap.get(id as SimpleSlug)
        const seen = new Set<string>([id])
        while (ancestorId && !seen.has(ancestorId)) {
          seen.add(ancestorId)
          const ancestor = graphData.nodes.find(node => node.id === ancestorId)
          if (ancestor) ancestors.unshift(ancestor.text)
          ancestorId = aggToCoreMap.get(ancestorId)
        }
        const fullLabel = id === initialPageId ? "当前图谱" : id === localContextPageId ? "关联节点" : parent?.text ?? id
        const label = aggNodeInfoMap.get(id as SimpleSlug)?.groupKey
          || fullLabel.replace(/^[^:：]+[:：]\s*/, "")
        items.push({ id, label, path: [...ancestors, fullLabel].join(" / "),
          color: parent?.isAggregation ? computedStyleMap["--secondary"]
            : parent ? String(color(parent)) : computedStyleMap["--secondary"], ...progress })
      }
      pagination.update(items, graphData.nodes.length, initialNodeLimit)
    }
    function loadExpansionPage(id: SimpleSlug) {
      const parent = graphData.nodes.find(node => node.id === (id === localContextPageId ? slug : id))
      if (id !== initialPageId && id !== localContextPageId && (!parent || !expandedNodeIds.has(id))) return
      const page = expansionPages.next(id, graphData.nodes)
      for (const [index, node] of page.nodes.entries()) {
        contextPendingInInitialPage.delete(node.id)
        const angle = index * Math.PI * 2 / Math.max(1, page.nodes.length)
        node.x = (parent?.x ?? 0) + Math.cos(angle) * 80
        node.y = (parent?.y ?? 0) + Math.sin(angle) * 80
        node.vx = node.vy = 0
        graphData.nodes.push(node)
        nodeRenderData.push(createNodeRenderObject(node))
      }
      const edgeKeys = new Set(graphData.links.map(link => JSON.stringify([link.source.id, link.target.id, link.sourceField])))
      for (const link of page.links) {
        const key = JSON.stringify([link.source.id, link.target.id, link.sourceField])
        if (edgeKeys.has(key)) continue
        edgeKeys.add(key)
        graphData.links.push(link)
        linkRenderData.push(createLinkRenderObject(link))
      }
      if (parent?.isAggregation) {
        const children = expandedAggChildren.get(id) ?? new Set<SimpleSlug>()
        for (const child of page.nodes) children.add(child.id)
        expandedAggChildren.set(id, children)
      }
      syncLocalContext(id === localContextPageId ? 0 : loadBatchSize)
      renderLabels()
      simulation.nodes(graphData.nodes)
      simulation.force("link", createGraphLinkForce(graphData.links, graphView, linkDistance))
      simulation.alpha(0.12).restart()
      updateExpansionControls()
      updateVisibleCount()
    }
    syncLocalContext()
    updateExpansionControls()
    updateVisibleCount()

    // ===== 拖拽和缩放 =====
    let currentTransform = zoomIdentity
    let lastClickTime = 0
    let lastClickedNodeId: SimpleSlug | null = null

    let appDestroyed = false
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
    function scheduleTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        if (!appDestroyed && isCurrent()) callback()
      }, delay)
      pendingTimers.add(timer)
      return timer
    }

    if (enableDrag) {
      select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
        drag<HTMLCanvasElement, NodeData | undefined>()
          .container(() => app.canvas)
          .subject(() => graphData.nodes.find((n) => n.id === hoveredNodeId))
          .on("start", function dragstarted(event) {
            // 文件夹分区与全局大区复用同一交互加热参数。
            if (!event.active) {
              simulation.alphaTarget(dynamics.dragAlpha).restart()
            }
            event.subject.fx = event.subject.x
            event.subject.fy = event.subject.y
            event.subject.__initialDragPos = {
              x: event.subject.x,
              y: event.subject.y,
              fx: event.subject.fx,
              fy: event.subject.fy,
            }
            dragStartTime = Date.now()
            dragging = true
          })
          .on("drag", function dragged(event) {
            const initPos = event.subject.__initialDragPos
            event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
            event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
          })
          .on("end", function dragended(event) {
            dragging = false

            if (dynamics.dragReleaseMs > 0) {
              // 总览图短暂延迟释放拖拽位置，让新加入的节点先开始排布。
              scheduleTimeout(() => {
                if (expansionPins.has(event.subject.id)) return
                event.subject.fx = null
                event.subject.fy = null
              }, dynamics.dragReleaseMs)
            } else if (!expansionPins.has(event.subject.id)) {
              // 局部图谱立即释放
              event.subject.fx = null
              event.subject.fy = null
            }

            // 短暂加热后归零，径向力/连线力与斥力重新平衡。
            // forceCenter 仅平移质心，本身不负责收拢无连线的分区。
            if (!event.active) {
              simulation.alphaTarget(dynamics.dragAlpha).restart()
              scheduleTimeout(() => simulation.alphaTarget(0), dynamics.reheatMs)
            }

            if (Date.now() - dragStartTime < 300) {
              const nodeId = event.subject.id as SimpleSlug
              const now = Date.now()
              if (isGlobalGraph) {
                if (lastClickedNodeId === nodeId && now - lastClickTime < DOUBLE_CLICK_DELAY) {
                  lastClickedNodeId = null
                  lastClickTime = 0
                  navigateToNode(nodeId, fullSlug)
                } else {
                  lastClickedNodeId = nodeId
                  lastClickTime = now
                  toggleNodeExpansion(nodeId)
                }
              } else {
                // 文件夹/值页核心和聚合节点单击展开，双击打开文件。
                if (isExpandableCollectionNode(graphView, event.subject)) {
                  if (lastClickedNodeId === nodeId && now - lastClickTime < DOUBLE_CLICK_DELAY) {
                    lastClickedNodeId = null
                    lastClickTime = 0
                    if (!event.subject.isRegion) navigateToNode(nodeId, fullSlug)
                  } else {
                    lastClickedNodeId = nodeId
                    lastClickTime = now
                    toggleNodeExpansion(nodeId)
                  }
                } else {
                  navigateToNode(nodeId, fullSlug)
                }
              }
            }
          }),
      )
    } else {
      for (const node of nodeRenderData) {
        let clickTimeout: ReturnType<typeof setTimeout> | null = null
        node.gfx.on("click", () => {
          const nodeId = node.simulationData.id
          if (isGlobalGraph) {
            if (clickTimeout) {
              clearTimeout(clickTimeout)
              clickTimeout = null
              navigateToNode(nodeId, fullSlug)
            } else {
              clickTimeout = scheduleTimeout(() => {
                clickTimeout = null
                toggleNodeExpansion(nodeId)
              }, DOUBLE_CLICK_DELAY)
            }
          } else {
            // 文件夹/值页核心和聚合节点单击展开，双击打开文件。
            if (isExpandableCollectionNode(graphView, node.simulationData)) {
              if (clickTimeout) {
                clearTimeout(clickTimeout)
                clickTimeout = null
                if (!node.simulationData.isRegion) navigateToNode(nodeId, fullSlug)
              } else {
                clickTimeout = scheduleTimeout(() => {
                  clickTimeout = null
                  toggleNodeExpansion(nodeId)
                }, DOUBLE_CLICK_DELAY)
              }
            } else {
              navigateToNode(nodeId, fullSlug)
            }
          }
        })
      }
    }

    if (enableZoom) {
      const graphZoom = zoom<HTMLCanvasElement, NodeData>()
        .extent([
          [0, 0],
          [width, height],
        ])
        .scaleExtent([0.25, 4])
        .on("zoom", ({ transform }) => {
          if (appDestroyed) return
          currentTransform = transform
          stage.scale.set(transform.k, transform.k)
          stage.position.set(transform.x, transform.y)

          const s = transform.k * opacityScale
          const scaleOpacity = Math.max((s - 1) / 3.75, 0)
          edgeLabelDefaultAlpha = scaleOpacity
          const activeNodeLabels = new Set(
            nodeRenderData.filter((n) => n.active).map((n) => n.label),
          )
          const badgeTexts = new Set(
            nodeRenderData.flatMap((n) => (n.badgeText ? [n.badgeText] : [])),
          )
          const countLabels = new Set(
            nodeRenderData.flatMap((n) => (n.countLabel ? [n.countLabel] : [])),
          )
          const regionLabels = new Set(
            nodeRenderData.filter((n) => n.simulationData.isRegion).map((n) => n.label),
          )

          for (const label of labelsContainer.children) {
            if (badgeTexts.has(label)) continue
            if (countLabels.has(label)) continue
            if (regionLabels.has(label)) continue
            if (!activeNodeLabels.has(label)) label.alpha = scaleOpacity
          }
          for (const label of edgeLabelsContainer.children) {
            label.alpha = scaleOpacity
          }
        })
      const canvasSelection = select<HTMLCanvasElement, NodeData>(app.canvas)
      canvasSelection.call(graphZoom)
      // Disable D3's double-click (and double-tap) zoom without changing node navigation.
      canvasSelection.on("dblclick.zoom", null)
      // 弹窗局部图谱以中心为基准放大 25%，并同步 D3 状态，避免首次滚轮缩放跳变。
      if (!isGlobalGraph && graph.classList.contains("global-graph-container")) {
        canvasSelection.call(graphZoom.scaleTo, 1.25, [width / 2, height / 2])
      }
    }

    let animationId: number | null = null
    let firstFrame = true

    // 虚线绘制辅助函数（用于聚合边）
    function drawDashedLine(gfx: Graphics, x1: number, y1: number, x2: number, y2: number) {
      const dx = x2 - x1
      const dy = y2 - y1
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return
      const ux = dx / dist
      const uy = dy / dist
      const dashLen = 6
      const gapLen = 5
      let pos = 0
      while (pos < dist) {
        const segLen = Math.min(dashLen, dist - pos)
        gfx.moveTo(x1 + ux * pos, y1 + uy * pos)
        gfx.lineTo(x1 + ux * (pos + segLen), y1 + uy * (pos + segLen))
        pos += dashLen + gapLen
      }
    }

    function animate(time: number) {
      if (appDestroyed || !isCurrent()) return

      for (const n of nodeRenderData) {
        const { x, y } = n.simulationData
        if (x === undefined || y === undefined) continue
        const posX = x + width / 2
        const posY = y + height / 2
        n.gfx.position.set(posX, posY)
        if (n.label) {
          if (n.isAggregation || n.simulationData.isRegion) {
            // 聚合节点 / 大区节点标签显示在节点上方
            const r = nodeRadius(n.simulationData)
            n.label.position.set(posX, posY - r - 16)
          } else {
            // 普通标签也放在圆外；主节点按外环半径留白，避免文字压住外环。
            const r = n.simulationData.isFocus
              ? focusOuterRadius(n.simulationData)
              : nodeRadius(n.simulationData)
            n.label.position.set(posX, posY - r - 2)
          }
        }
        // 聚合节点展开背景圆圈跟随移动
        if (n.aggBg) n.aggBg.position.set(posX, posY)
        if (n.badge) {
          const r = nodeRadius(n.simulationData)
          n.badge.position.set(posX + r + 4, posY - r - 4)
        }
        if (n.badgeText) {
          const r = nodeRadius(n.simulationData)
          n.badgeText.position.set(posX + r + 4, posY - r - 4)
        }
        if (n.countLabel) {
          n.countLabel.position.set(posX, posY)
        }
      }

      for (const l of linkRenderData) {
        const ld = l.simulationData
        const sx = ld.source.x
        const sy = ld.source.y
        const tx = ld.target.x
        const ty = ld.target.y

        if (sx === undefined || sy === undefined || tx === undefined || ty === undefined) {
          l.gfx.visible = false
          continue
        }
        l.gfx.visible = true
        l.gfx.clear()
        if (l.label) l.label.visible = true

        const x1 = sx + width / 2
        const y1 = sy + height / 2
        const x2 = tx + width / 2
        const y2 = ty + height / 2
        const isAgg = l.isAggregation
        const lineW = isAgg ? 0.6 : 1

        // 聚合节点 / 大区节点：连线从圆圈边缘发出/结束，避免穿入节点内部
        let lineX1 = x1,
          lineY1 = y1,
          lineX2 = x2,
          lineY2 = y2

        // source 端裁剪
        if (ld.source.isRegion && ld.source.aggCollapsedRadius) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * ld.source.aggCollapsedRadius
          lineY1 = y1 + (dy / dist) * ld.source.aggCollapsedRadius
        } else if (isAgg && ld.source.aggExpandedRadius) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * ld.source.aggExpandedRadius
          lineY1 = y1 + (dy / dist) * ld.source.aggExpandedRadius
        } else if (isAgg && ld.source.aggCollapsedRadius) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * ld.source.aggCollapsedRadius
          lineY1 = y1 + (dy / dist) * ld.source.aggCollapsedRadius
        } else if (ld.source.isFocus) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * focusOuterRadius(ld.source)
          lineY1 = y1 + (dy / dist) * focusOuterRadius(ld.source)
        }

        // target 端裁剪（大区节点）
        if (ld.target.isRegion && ld.target.aggCollapsedRadius) {
          const dx = x1 - x2
          const dy = y1 - y2
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX2 = x2 + (dx / dist) * ld.target.aggCollapsedRadius
          lineY2 = y2 + (dy / dist) * ld.target.aggCollapsedRadius
        } else if (ld.target.isFocus) {
          const dx = x1 - x2
          const dy = y1 - y2
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX2 = x2 + (dx / dist) * focusOuterRadius(ld.target)
          lineY2 = y2 + (dy / dist) * focusOuterRadius(ld.target)
        }

        if (showArrows) {
          const targetR = ld.target.isRegion || ld.target.isFocus ? 0 : nodeRadius(ld.target)
          const dx = lineX2 - lineX1
          const dy = lineY2 - lineY1
          const len = Math.sqrt(dx * dx + dy * dy)
          const arrowSize = isAgg ? 4 : 5
          if (len > targetR + arrowSize) {
            const ratio = (len - targetR) / len
            const arrowX = lineX1 + dx * ratio
            const arrowY = lineY1 + dy * ratio
            if (isAgg) {
              drawDashedLine(l.gfx, lineX1, lineY1, arrowX, arrowY)
            } else {
              l.gfx.moveTo(lineX1, lineY1).lineTo(arrowX, arrowY)
            }
            l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
            const angle = Math.atan2(dy, dx)
            l.gfx.moveTo(arrowX, arrowY)
            l.gfx.lineTo(
              arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
              arrowY - arrowSize * Math.sin(angle - Math.PI / 6),
            )
            l.gfx.lineTo(
              arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
              arrowY - arrowSize * Math.sin(angle + Math.PI / 6),
            )
            l.gfx.lineTo(arrowX, arrowY)
            l.gfx.fill({ color: l.color })
          } else {
            if (isAgg) {
              drawDashedLine(l.gfx, lineX1, lineY1, lineX2, lineY2)
            } else {
              l.gfx.moveTo(lineX1, lineY1).lineTo(lineX2, lineY2)
            }
            l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
          }
        } else {
          if (isAgg) {
            drawDashedLine(l.gfx, lineX1, lineY1, lineX2, lineY2)
          } else {
            l.gfx.moveTo(lineX1, lineY1).lineTo(lineX2, lineY2)
          }
          l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
        }

        if (l.label) {
          l.label.position.set((lineX1 + lineX2) / 2, (lineY1 + lineY2) / 2)
        }
      }

      tweens.forEach((t) => t.update(time))
      app.renderer.render(stage)
      if (firstFrame) {
        firstFrame = false
        markPhase("createObjectsAndFirstRender")
        timings.total = Math.round((performance.now() - startedAt) * 10) / 10
        graph.dataset.graphTimings = JSON.stringify(timings)
        console.debug(`[GraphTiming] ${slug} (${graphView})`, {
          milliseconds: timings,
          rawNodes: Number(graph.dataset.rawNodeCount),
          visibleNodes: graphData.nodes.length,
          visibleEdges: graphData.links.length,
        })
      }
      animationId = requestAnimationFrame(animate)
    }

    console.log("[DEBUG] 启动动画循环")
    animationId = requestAnimationFrame(animate)
    console.debug(
      `[Graph] Rendered graph for ${slug}. Containers: ${document.getElementsByClassName("graph-container").length}`,
    )
    console.log("[DEBUG] renderGraph 函数即将返回")

    return () => {
      if (appDestroyed) return
      console.debug(`[Graph] Tearing down graph for ${slug}`)
      appDestroyed = true
      pendingTimers.forEach(clearTimeout)
      pendingTimers.clear()
      if (animationId !== null) {
        cancelAnimationFrame(animationId)
        animationId = null
      }
      expansionControls.remove()
      simulation.stop()
      tweens.forEach((t) => t.stop())
      tweens.clear()
      select(app.canvas).on(".zoom", null).on(".drag", null)
      graphicsPool.clear()
      textPool.clear()
      linkGraphicsPool.clear()
      // Application owns the stage. Destroy it once and leave shared textures
      // under Pixi's ownership; destroy the graph's Graphics contexts explicitly.
      app.destroy({ removeView: true }, { children: true, context: true })
      console.debug(`[Graph] Pixi app and resources destroyed for ${slug}`)
    }
  }

  // ============ 导航生命周期管理 ============
  let localGraphCleanups: (() => void)[] = []
  const globalRenderScope = createGraphRenderScope()

  function cleanupLocalGraphs() {
    renderGeneration++ // 递增世代，废弃进行中的旧渲染
    const count = localGraphCleanups.length
    if (count > 0) console.debug(`[Graph] Cleaning up ${count} local graphs`)
    for (const cleanup of localGraphCleanups) cleanup()
    localGraphCleanups = []
  }

  function cleanupGlobalGraphs() {
    // Invalidate pending fetch/Pixi work as well as destroying an already visible canvas.
    globalRenderScope.clear()
  }

  // prenav：提前清理，缩短竞态窗口
  document.addEventListener("prenav", () => {
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })

  /**
   * 维度值页的容器（由 aggregation-page-pro 生成）只声明 `data-dimension-graph` + 产物地址，
   * 这里补齐 graph-pro 接管所需的 class 与 dataset；调参用本插件默认值，避免两插件强耦合。
   */
  function prepareDimensionContainers() {
    const containers = document.querySelectorAll<HTMLElement>("[data-dimension-graph]")
    const config = document.querySelector<HTMLElement>(".graph-overlay-host")?.dataset.dimensionCfg
    if (!config && containers.length) throw new Error("[Graph] dimension configuration host is missing")
    for (const container of containers) {
      if (container.classList.contains("graph-container")) continue
      const overrideUrl =
        container.dataset["dimensionGraphUrl"] || container.dataset["localGraphUrl"]
      container.classList.add("graph-container")
      container.dataset["basepath"] = document.body?.dataset?.basepath ?? ""
      container.dataset["cfg"] = config!
      container.dataset["precomputeDepth"] = "1"
      container.dataset["sharedAggregation"] = "true"
      if (overrideUrl) container.dataset["localGraphUrl"] = overrideUrl
      console.log("[Graph] 维度值页图谱容器已就绪:", overrideUrl)
    }
  }

  /** 维度值页切换 scope 后（我们的列表脚本派发事件）：只重建维度子图 */
  async function rerenderDimensionGraphs() {
    const containers = [...document.querySelectorAll<HTMLElement>("[data-dimension-graph]")]
    if (containers.length === 0) return
    cleanupLocalGraphs()
    const thisGeneration = renderGeneration
    for (const container of containers) {
      const cleanup = await renderGraph(container, getFullSlug(window), thisGeneration)
      if (cleanup) {
        if (thisGeneration === renderGeneration) localGraphCleanups.push(cleanup)
        else cleanup()
      }
    }
  }

  document.addEventListener("aggregation-scope-changed", () => {
    void rerenderDimensionGraphs()
  })

  document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
    const slug = e.detail.url
    // prescript.js 在 <head> 中执行，此时 body 的 data-slug 可能尚未解析
    if (!slug) return
    const navigationGeneration = renderGeneration
    addToVisited(simplifySlug(slug))
    ensureFetchData()

    // ===== 全局图谱交互：先接上，避免被局部图谱渲染（fetch + pixi）拖后 =====
    // 按钮与覆盖层都由 `GlobalGraphOverlay` 组件在**构建期**渲染：与阅读模式按钮一样常驻，
    // 不会出现"先空、加载后才冒出来"的闪烁。脚本只负责绑定交互。
    const toggleButtons = [...document.getElementsByClassName("graph-toggle")] as HTMLElement[]
    for (const btn of toggleButtons) {
      const onToggleClick = (e: MouseEvent) => {
        e.preventDefault()
        const anyOpen = globalContainers().some((c) => c.classList.contains("active"))
        if (anyOpen) {
          hideGlobalGraph()
        } else {
          renderGlobalGraph()
        }
      }
      btn.addEventListener("click", onToggleClick)
      window.addCleanup(() => btn.removeEventListener("click", onToggleClick))
    }

    // 侧栏「放大局部图谱」图标（Graph 组件渲染）→ 复用局部配置打开全局图谱
    const containerIcons = document.getElementsByClassName("global-graph-icon")
    Array.from(containerIcons).forEach((icon) => {
      const expandLocalGraph = () => renderGlobalGraph(true)
      icon.addEventListener("click", expandLocalGraph)
      window.addCleanup(() => icon.removeEventListener("click", expandLocalGraph))
    })

    // 维度值页「放大维度图谱」按钮 → 用维度子图数据打开全屏 overlay（复用全局图谱容器）
    const dimensionExpandButtons = document.getElementsByClassName("dimension-expand")
    Array.from(dimensionExpandButtons).forEach((btn) => {
      const expandDimensionGraph = () => renderDimensionGraphExpanded()
      btn.addEventListener("click", expandDimensionGraph)
      window.addCleanup(() => btn.removeEventListener("click", expandDimensionGraph))
    })

    document.addEventListener("keydown", shortcutHandler)
    window.addCleanup(() => {
      document.removeEventListener("keydown", shortcutHandler)
      cleanupLocalGraphs()
      cleanupGlobalGraphs()
    })

    async function renderLocalGraph() {
      const thisGeneration = renderGeneration
      prepareDimensionContainers()
      const localGraphContainers = document.getElementsByClassName("graph-container")
      for (const container of localGraphContainers) {
        const cleanup = await renderGraph(container as HTMLElement, slug, thisGeneration)
        if (cleanup) {
          if (thisGeneration === renderGeneration) {
            localGraphCleanups.push(cleanup)
          } else {
            console.log(
              `[Graph] 渲染完成后发现世代已过期 (${thisGeneration} !== ${renderGeneration})，立即执行 cleanup 避免泄漏`,
            )
            cleanup()
          }
        }
      }
    }

    await renderLocalGraph()
    if (!checkGeneration(navigationGeneration)) return
    console.log("[DEBUG] renderLocalGraph 执行完成，所有本地图谱已渲染")

    const handleThemeChange = () => {
      onDimensionOrderChanged()
    }
    document.addEventListener("themechange", handleThemeChange)
    window.addCleanup(() => document.removeEventListener("themechange", handleThemeChange))

    const onDimensionOrderChanged = () => {
      cleanupLocalGraphs()
      const activeOverlays = globalContainers().filter((container) => container.classList.contains("active"))
      if (activeOverlays.length > 0) {
        const graphContainer = activeOverlays[0]?.querySelector<HTMLElement>(".global-graph-container")
        const view = graphContainer?.dataset.graphView
        cleanupGlobalGraphs()
        if (view === "global") void renderGlobalGraph()
        else if (graphContainer?.dataset.dimensionGraph === "true") void renderDimensionGraphExpanded()
        else void renderGlobalGraph(true)
      }
      void renderLocalGraph()
    }
    document.addEventListener("aggregation-order-changed", onDimensionOrderChanged)
    window.addCleanup(() => document.removeEventListener("aggregation-order-changed", onDimensionOrderChanged))

    // 动态查询全局图谱容器：容器由 GlobalGraphOverlay 组件渲染（layout 放在 header，任何页面类型都在），
    // 这里按需查询而不是快照，SPA 导航后无需重建引用
    function globalContainers(): HTMLElement[] {
      return [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
    }

    async function renderGlobalGraph(local = false) {
      const request = globalRenderScope.start()
      const thisGeneration = renderGeneration
      const currentSlug = getFullSlug(window)
      for (const container of globalContainers()) {
        if (!request.isCurrent() || !checkGeneration(thisGeneration)) return
        container.classList.add("active")
        const sidebar = container.closest(".sidebar") as HTMLElement
        if (sidebar) sidebar.style.zIndex = "1"
        const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
        registerEscapeHandler(container, hideGlobalGraph)
        if (graphContainer) {
          // 清除维度子图放大的残留标记（本函数渲染全局/侧栏图谱，均非维度子图）
          delete graphContainer.dataset.dimensionGraph
          delete graphContainer.dataset.localGraphUrl
          graphContainer.dataset.graphView = local ? (document.querySelector<HTMLElement>(".graph .graph-container")?.dataset.graphView ?? "local") : "global"
          // 放大按钮复用当前页面的局部配置；快捷键仍可打开全局图谱。
          // 覆盖层容器现在挂在 header（不一定是局部图谱的兄弟节点），所以按全页查询局部图谱容器
          const localContainer = document.querySelector<HTMLElement>(".graph .graph-container")
          if (local) {
            // 优先取局部容器上的声明；无局部图谱的页面（注入宿主）沿用宿主自带的站点级声明
            graphContainer.dataset.sharedAggregation =
              localContainer?.dataset.sharedAggregation ??
              graphContainer.dataset.sharedAggregation ??
              "false"
            const localConfig = JSON.parse(
              localContainer?.dataset.cfg ?? graphContainer.dataset.globalCfg ?? "{}",
            ) as D3Config
            // 弹窗面积更大，局部图谱标签相应放大 25%，侧栏小图保持原样。
            graphContainer.dataset.cfg = JSON.stringify({
              ...localConfig,
              fontSize: (localConfig.fontSize ?? 0.6) * 1.25,
            })
          } else {
            graphContainer.dataset.sharedAggregation =
              localContainer?.dataset.sharedAggregation ??
              graphContainer.dataset.sharedAggregation ??
              "false"
            graphContainer.dataset.cfg = graphContainer.dataset.globalCfg
          }
          const cleanup = await renderGraph(graphContainer, currentSlug, thisGeneration, request.isCurrent)
          if (cleanup) {
            if (thisGeneration === renderGeneration) {
              request.add(cleanup)
            } else {
              console.log(`[Graph] 全局渲染完成后发现世代已过期，立即执行 cleanup 避免泄漏`)
              cleanup()
            }
          }
        }
      }
    }

    /** 维度值页「放大」：把维度子图渲染到全屏 overlay（复用全局图谱容器，数据源=维度子图产物） */
    async function renderDimensionGraphExpanded() {
      const dimContainer = document.querySelector<HTMLElement>("[data-dimension-graph]")
      if (!dimContainer) return
      const url = dimContainer.dataset["dimensionGraphUrl"] || dimContainer.dataset["localGraphUrl"]
      if (!url) return
      const request = globalRenderScope.start()
      const thisGeneration = renderGeneration
      const currentSlug = getFullSlug(window)
      for (const container of globalContainers()) {
        if (!request.isCurrent() || !checkGeneration(thisGeneration)) return
        container.classList.add("active")
        const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
        registerEscapeHandler(container, hideGlobalGraph)
        if (!graphContainer) continue
        // 数据源切换为维度子图：renderGraph 据此走「维度裁剪」路径（scope/context/filter 都从当前 URL 读）
        graphContainer.dataset.graphView = "dimension"
        graphContainer.dataset["dimensionGraph"] = "true"
        graphContainer.dataset["localGraphUrl"] = url
        graphContainer.dataset["sharedAggregation"] = "true"
        const cfg = JSON.parse(dimContainer.dataset.cfg ?? "{}") as D3Config
        graphContainer.dataset.cfg = JSON.stringify({
          ...cfg,
          fontSize: (cfg.fontSize ?? 0.6) * 1.25,
        })
        const cleanup = await renderGraph(graphContainer, currentSlug, thisGeneration, request.isCurrent)
        if (cleanup) {
          if (thisGeneration === renderGeneration) {
            request.add(cleanup)
          } else {
            cleanup()
          }
        }
      }
    }

    function hideGlobalGraph() {
      cleanupGlobalGraphs()
      for (const container of globalContainers()) {
        container.classList.remove("active")
        const sidebar = container.closest(".sidebar") as HTMLElement
        if (sidebar) sidebar.style.zIndex = ""
      }
    }

    async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
      if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        const anyOpen = globalContainers().some((c) => c.classList.contains("active"))
        anyOpen ? hideGlobalGraph() : renderGlobalGraph()
      }
    }

    console.log("[DEBUG] nav 事件处理完成，图谱初始化全部完成")
  })
}
