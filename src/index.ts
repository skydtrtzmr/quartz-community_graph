// graph-pro 主入口。
//
// 第一步（当前）：只提供构建期预计算 emitter（局部图谱 + 全局图谱）。
//   → v5 插件加载器用 `findFactory(module, "emitter")` 取到本文件的 default 导出。
// 第二步：再补上 v4 的 graph3 交互层组件（届时 manifest 加回 components 并把
//   category 改为 ["component","emitter"]，同时禁用社区版 graph）。

export { default } from "./emitters/index"
export { GraphLocalEmitter } from "./emitters/graphLocal"
export { GraphGlobalEmitter } from "./emitters/graphGlobal"
export type { LocalGraphData, LocalGraphEdge } from "./emitters/graphLocal"
export type { GlobalGraphPrecomputed } from "./emitters/graphGlobal"
export type { GraphProOptions } from "./options"
export type {
  AggregationConfig,
  AggregationRule,
  CoreNodeFilterConfig,
  CoreNodeFilterRule,
} from "./util/aggregation"

// 社区版组件（第二步会被 v4 交互层替换，暂不写入 manifest.components）
export { default as Graph } from "./components/Graph"
export type { GraphOptions, D3Config } from "./components/Graph"
