import type { AggregationRule, CoreNodeFilterConfig } from "./util/aggregation"

/**
 * graph-pro 的 YAML 配置结构。
 *
 * 键名刻意与 v4 的两份 per-domain 配置对齐，便于将来把
 * `settings/<domain>/quartz.config.json` 与 `settings/<domain>/quartz.layout.json`
 * 的 `graph` 段直接合并进来（无需再改插件代码）：
 *
 * - `graph`       ← settings/<domain>/quartz.config.json 的 `graph` 段（构建期）
 * - `localGraph`  ← settings/<domain>/quartz.layout.json 的 `graph` 段（局部图谱，第二步使用）
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
    /** 边缘叶子节点聚合规则（运行时按目录/字段分组为聚合节点，带数字徽标） */
    aggregation?: AggregationRule[]
    /** 其余为组件侧 D3Config 参数（drag/zoom/depth/...） */
    [key: string]: unknown
  }

  /** 交互期 + 全局图谱预计算参数 */
  globalGraph?: {
    showAggregatedNodeLinks?: boolean
    /** 是否生成 graph/global/graphGlobal.json（默认 true） */
    enabled?: boolean
    /** 边缘节点聚合规则 */
    aggregation?: AggregationRule[]
    /** 大区聚合规则（不配置则走"普通收起模式"） */
    regionRules?: AggregationRule[]
    /** 核心节点过滤规则 */
    coreNodeFilter?: CoreNodeFilterConfig
    /** 核心节点数量硬上限（未配置 regionRules 时生效） */
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
