/**
 * 图谱的「分组」在配置层的唯一入口。
 *
 * 背景（2026-09-26 统一简化）：图谱内部的分组机制（`aggregation` / `regionRules` /
 * `coreNodeFilter`）保持不变，但**不再作为用户配置项暴露** ——
 * 用户只配一个 `globalGraph.folders`（主体文件夹白名单），
 * 其余三值由本函数在解析层**合成**出来：
 *
 * - `aggregation`：邻居分组。有 `configuration.aggregation` 时由 `sharedAggregation`（`groupShared`）
 *   接管；没有时用这里合成的「仅按文件夹」兜底，保证无聚合配置的域也有稳定的 📁 分组。
 * - `regionRules`：全局图谱首屏大区 = **按文件夹**分组（不再是按字段），**恒开启** ——
 *   保持「首屏 = 文件夹大区 → 点开 = 主体节点 → 点开 = 邻居分组」这条固定层级，
 *   即使只选了一个主体文件夹也保留这一层（否则首屏会一次铺出上百个单节点）。
 * - `coreNodeFilter`：主体文件夹白名单 → 「这些文件夹下的节点即核心」。
 *   未配白名单时留空，运行时回落到「连接数阈值」的启发式。
 */
import type { AggregationRule, CoreNodeFilterConfig } from "./aggregation"

export interface GraphGroupingInput {
  /** 主体文件夹白名单（YAML: `globalGraph.folders`）；空 / 缺省 = 全部文件夹 */
  folders?: string[]
  /** 文件夹层数（默认 1）；通常传 `configuration.aggregation.root.depth` 以与聚合保持一致 */
  folderDepth?: number
}

export interface GraphGrouping {
  aggregation: AggregationRule[]
  regionRules: AggregationRule[]
  coreNodeFilter: CoreNodeFilterConfig
}

export const DEFAULT_FOLDER_DEPTH = 1

/** 归一化文件夹白名单：去首尾斜杠、丢空项、去重 */
function normalizeFolders(folders: string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of folders ?? []) {
    const key = String(raw).replace(/^\/+|\/+$/g, "")
    if (key.length > 0 && !out.includes(key)) out.push(key)
  }
  return out
}

export function resolveGraphGrouping(input: GraphGroupingInput = {}): GraphGrouping {
  const rawDepth = input.folderDepth
  const depth =
    typeof rawDepth === "number" && Number.isInteger(rawDepth) && rawDepth > 0
      ? rawDepth
      : DEFAULT_FOLDER_DEPTH
  const folders = normalizeFolders(input.folders)

  return {
    // 兜底分组：仅按文件夹（各节点按自身目录归属）
    aggregation: [{ type: "folder", depth }],
    // 首屏大区 = 按文件夹（恒开启）
    regionRules: [{ type: "folder", depth }],
    // 主体 = 白名单里的文件夹；空则交给运行时的连接数阈值
    coreNodeFilter: folders.length > 0 ? [{ type: "folder", depth, values: folders }] : [],
  }
}
