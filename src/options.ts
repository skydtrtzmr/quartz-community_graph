/** graph-pro 内部注入参数及统一解析规则。用户 YAML 只配置 configuration.graph，加载器转换为本类型。 */
import { DEFAULT_CORE_AGGREGATION_MAX_LEVELS } from "./util/sharedAggregation"

export interface GraphProOptions {
  graphDefaults?: Partial<GraphCommonConfig>
  /** 构建期是否预计算局部图谱；深度统一取 localGraph.depth。 */
  graph?: { precomputeLocal?: boolean }

  /** 文件页局部图谱。 */
  localGraph?: Partial<GraphLocalConfig>

  /** 文件夹页图谱；不继承其他视图。 */
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
  const defaults = view === "dimension" ? DEFAULT_DIMENSION_GRAPH_CFG
    : view === "global" ? DEFAULT_GLOBAL_GRAPH_CFG : DEFAULT_LOCAL_GRAPH_CFG
  const viewOptions = view === "local" ? options.localGraph
    : view === "folder" ? options.folderGraph
    : view === "dimension" ? options.dimensionGraph : options.globalGraph
  const resolved = { ...defaults, ...options.graphDefaults, ...viewOptions } as GraphViewConfig
  if (view === "global") resolved.depth = -1
  if (view === "folder" || view === "dimension") resolved.depth = 1
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
