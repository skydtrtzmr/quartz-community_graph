/** graph-pro YAML options. Version 2 resolves all four views independently.
 * Unversioned configs use the historic inheritance in this module only.
 */
import { DEFAULT_CORE_AGGREGATION_MAX_LEVELS } from "./util/sharedAggregation"

export interface GraphProOptions {
  /** 2 表示四种视图独立配置；缺省时兼容旧的跨视图继承。 */
  configVersion?: 2
  graphDefaults?: Partial<GraphCommonConfig>
  /** 构建期选项；深度和交互预算是旧版 YAML 的兼容键。 */
  graph?: {
    /** 是否在构建期预计算每个页面的局部图谱（默认 true） */
    precomputeLocal?: boolean
    /** 局部图谱展开深度（默认 1） */
    localDepth?: number
    /** 旧版共享连接数门槛；新版使用 graphDefaults / 视图段。 */
    coreMinLinks?: number
    /** 每个聚合节点首次展开及继续加载的子节点数量，默认 20 */
    expandBatchSize?: number
    /** 首屏可见节点预算（包含聚合和大区），默认 500；后续可主动分批加载。 */
    maxVisibleNodes?: number
    /** 非聚合展开队列的批次，默认 100。 */
    loadBatchSize?: number
  }

  /** 文件页局部图谱；新版 depth 同时用于构建期预计算。 */
  localGraph?: Partial<GraphLocalConfig>

  /** 文件夹页图谱；旧版缺省项按旧规则继承。 */
  folderGraph?: Partial<GraphCollectionConfig>

  dimensionGraph?: Partial<GraphCollectionConfig>

  /** 全局图谱显示与主体预计算参数。 */
  globalGraph?: Partial<GraphViewConfig>
}

export interface GraphViewConfig {
  drag: boolean
  zoom: boolean
  depth: number
  scale: number
  repelForce: number
  centerForce: number
  linkDistance: number
  fontSize: number
  opacityScale: number
  showTags: boolean
  removeTags: string[]
  focusOnHover: boolean
  enableRadial: boolean
  showAggregatedNodeLinks: boolean
  showArrows: boolean
  showBadge: boolean
  startCollapsed: boolean
  countLabelMaxDisplay: number
  coreMinLinks: number
  expandBatchSize: number
  maxVisibleNodes: number
  loadBatchSize: number
  enabled?: boolean
  folders?: string[]
  coreNodeLimit?: number
  coreAggregationMaxLevels?: number
  expandCoresOnRegionOpen?: boolean
  filterNonCoreNodes?: boolean
  colorBy?: string
  countLabelMin?: number
}

type GraphGlobalOnly = "enabled" | "folders" | "coreNodeLimit" |
  "coreAggregationMaxLevels" | "expandCoresOnRegionOpen" |
  "filterNonCoreNodes" | "colorBy" | "countLabelMin"
export type GraphCommonConfig = Omit<GraphViewConfig, GraphGlobalOnly | "depth">
export type GraphLocalConfig = Omit<GraphViewConfig, GraphGlobalOnly>
export type GraphCollectionConfig = Omit<GraphViewConfig, GraphGlobalOnly | "depth">

export const DEFAULT_LOCAL_GRAPH_CFG: GraphViewConfig = {
  drag: true, zoom: true, depth: 1, scale: 1.1, repelForce: 0.5,
  centerForce: 0.3, linkDistance: 30, fontSize: 0.6, opacityScale: 1,
  showTags: true, removeTags: [], focusOnHover: false, enableRadial: false,
  showAggregatedNodeLinks: false, showArrows: true, showBadge: false,
  startCollapsed: false, countLabelMaxDisplay: 120, coreMinLinks: 0,
  expandBatchSize: 20, maxVisibleNodes: 500, loadBatchSize: 100,
}

export const DEFAULT_DIMENSION_GRAPH_CFG: GraphViewConfig = {
  ...DEFAULT_LOCAL_GRAPH_CFG, repelForce: 0.38, linkDistance: 72,
  fontSize: 0.75, showTags: false, enableRadial: true,
}

export type GraphViewName = "local" | "folder" | "dimension" | "global"

/** One source of effective configuration for emitters, components and injected pages. */
export function resolveGraphViewConfig(options: GraphProOptions = {}, view: GraphViewName): GraphViewConfig {
  const legacy = options.configVersion !== 2
  const globalBase = { ...DEFAULT_GLOBAL_GRAPH_CFG, ...options.globalGraph }
  const defaults = view === "local" ? DEFAULT_LOCAL_GRAPH_CFG
    : view === "dimension" ? DEFAULT_DIMENSION_GRAPH_CFG
    : view === "global" ? DEFAULT_GLOBAL_GRAPH_CFG
    : legacy ? {
      ...DEFAULT_LOCAL_GRAPH_CFG, ...options.localGraph,
      repelForce: globalBase.repelForce,
      centerForce: globalBase.centerForce,
      linkDistance: globalBase.linkDistance,
      enableRadial: globalBase.enableRadial,
    } as GraphViewConfig : DEFAULT_LOCAL_GRAPH_CFG
  const legacyPaging = {
    coreMinLinks: options.graph?.coreMinLinks ?? 0,
    expandBatchSize: options.graph?.expandBatchSize ?? 20,
    maxVisibleNodes: options.graph?.maxVisibleNodes ?? 500,
    loadBatchSize: options.graph?.loadBatchSize ?? 100,
  }
  const viewOptions = view === "local" ? options.localGraph
    : view === "folder" ? options.folderGraph
    : view === "dimension" ? options.dimensionGraph : options.globalGraph
  const resolved = {
    ...defaults,
    ...(legacy ? legacyPaging : {}),
    ...options.graphDefaults,
    ...viewOptions,
  } as GraphViewConfig
  // Historic dimension pages inherited only paging from the global host.
  if (legacy && view === "dimension") {
    for (const key of ["expandBatchSize", "maxVisibleNodes", "loadBatchSize"] as const) {
      const value = options.globalGraph?.[key] ?? options.graph?.[key]
      if (typeof value === "number" && options.graphDefaults?.[key] === undefined && options.dimensionGraph?.[key] === undefined) resolved[key] = value
    }
  }
  if (legacy && view === "folder" && options.folderGraph?.linkDistance === undefined) resolved.linkDistance = globalBase.linkDistance
  if (view === "global") resolved.depth = -1
  if (view === "folder") resolved.depth = legacy
    ? options.localGraph?.depth as number ?? DEFAULT_LOCAL_GRAPH_CFG.depth : 1
  if (view === "dimension") resolved.depth = 1
  return resolved
}

/**
 * 全局图谱的组件侧默认调参，经 resolveGraphViewConfig 注入容器及 emitter。
 */
export const DEFAULT_GLOBAL_GRAPH_CFG: GraphViewConfig = {
  drag: true,
  zoom: true,
  depth: -1,
  scale: 0.9,
  repelForce: 0.5,
  centerForce: 0.2,
  linkDistance: 30,
  fontSize: 0.6,
  opacityScale: 1,
  showTags: true,
  removeTags: [],
  focusOnHover: true,
  enableRadial: true,
  showAggregatedNodeLinks: false,
  showArrows: true,
  showBadge: false,
  coreMinLinks: 0,
  expandBatchSize: 20,
  maxVisibleNodes: 500,
  loadBatchSize: 100,
  startCollapsed: true,
  countLabelMin: 7,
  countLabelMaxDisplay: 120,
  coreNodeLimit: 100,
  coreAggregationMaxLevels: DEFAULT_CORE_AGGREGATION_MAX_LEVELS,
  filterNonCoreNodes: true,
  expandCoresOnRegionOpen: false,
}
