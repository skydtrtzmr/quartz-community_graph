/**
 * graph-pro 的 YAML 配置结构。
 *
 * 键名刻意与 v4 的两份 per-domain 配置对齐，便于将来把
 * `settings/<domain>/quartz.config.json` 与 `settings/<domain>/quartz.layout.json`
 * 的 `graph` 段直接合并进来（无需再改插件代码）：
 *
 * - `graph`       ← settings/<domain>/quartz.config.json 的 `graph` 段（构建期）
 * - `localGraph`  ← settings/<domain>/quartz.layout.json 的 `graph` 段（局部图谱）
 * - `globalGraph` ← settings/<domain>/quartz.layout.json 的 `graph` 段（全局图谱 + 预计算参数）
 */
export interface GraphProOptions {
  /** 构建期：本地图谱预计算（对齐 settings 的 graph.precomputeLocal / localDepth） */
  graph?: {
    /** 是否在构建期预计算每个页面的局部图谱（默认 true） */
    precomputeLocal?: boolean
    /** 局部图谱展开深度（默认 1） */
    localDepth?: number
  }

  /** 交互期：局部图谱参数（第二步接入组件时使用，构建期不使用） */
  localGraph?: {
    showAggregatedNodeLinks?: boolean
    /** 其余为组件侧 D3Config 参数（drag/zoom/depth/...） */
    [key: string]: unknown
  }

  /** 交互期 + 全局图谱预计算参数 */
  globalGraph?: {
    showAggregatedNodeLinks?: boolean
    /** 是否生成 graph/global/graphGlobal.json（默认 true） */
    enabled?: boolean
    /**
     * 主体文件夹白名单（全局图谱首屏的大区 = 这些文件夹；空 / 缺省 = 全部文件夹）。
     * 邻居分组统一复用 `configuration.aggregation`，无该配置时按文件夹兜底。
     */
    folders?: string[]
    /** 核心节点数量硬上限（未配主体白名单时生效） */
    coreNodeLimit?: number
    /** 首屏是否只显示核心节点（默认 true） */
    startCollapsed?: boolean
    /** 大区展开后是否同时展开内部核心节点（默认 false；false 时核心节点保持收起） */
    expandCoresOnRegionOpen?: boolean
    /** 是否过滤孤儿节点（默认 true） */
    filterOrphans?: boolean
    /** 是否过滤非核心节点（默认 true） */
    filterNonCoreNodes?: boolean
    /** 按 frontmatter 字段为节点分配分类颜色，例如 `type` */
    colorBy?: string
    /** 节点中心数字显示上限，超出显示为 `${上限}+`（默认 120） */
    countLabelMaxDisplay?: number
    /** 是否把标签作为节点（默认 true） */
    showTags?: boolean
    /** 要移除的标签 */
    removeTags?: string[]
    /** 其余为组件侧 D3Config 参数（drag/zoom/depth/...），构建期忽略 */
    [key: string]: unknown
  }
}

/**
 * 全局图谱的组件侧默认调参，由 `components/GlobalGraphOverlay.tsx` 写入
 * `.global-graph-container` 的 `data-cfg` / `data-global-cfg`（全局图谱调参的单一来源）。
 */
export const DEFAULT_GLOBAL_GRAPH_CFG: Record<string, unknown> = {
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
  showArrows: true,
  filterOrphans: true,
  startCollapsed: true,
  countLabelMin: 7,
  countLabelMaxDisplay: 120,
  coreNodeLimit: 100,
  filterNonCoreNodes: true,
  expandCoresOnRegionOpen: false,
}
