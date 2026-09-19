/**
 * 聚合配置公共类型和工具函数（自 v4 client/quartz/util/aggregation.ts 整体移植）
 *
 * 设计原则：
 * - folder、field、date 都是聚合维度，统一为规则列表
 * - 按 order 排序后顺序执行
 * - 每条规则独立配置，fallback 行为内聚在规则内部
 */

export type AggregationType = "folder" | "field" | "date"

export interface AggregationRule {
  /** 聚合维度类型 */
  type: AggregationType

  /** 字段名（field/date 用，folder 可省略） */
  field?: string

  /** 文件夹截取深度（仅 folder 有效） */
  depth?: number

  /** 日期粒度（仅 date 有效） */
  granularity?: "year" | "month" | "quarter"
}

/** 聚合配置：规则列表 */
export type AggregationConfig = AggregationRule[]

// ===== 核心节点过滤规则 =====

export interface CoreNodeFilterRule {
  /** 过滤维度类型 */
  type: "folder" | "field"

  /** 字段名（field 用，folder 可省略） */
  field?: string

  /** 文件夹截取深度（仅 folder 有效） */
  depth?: number

  /** 精确匹配值列表（满足任一值即命中） */
  values?: string[]
}

/** 核心节点过滤配置：规则列表，满足任一规则即为核心节点（OR 关系） */
export type CoreNodeFilterConfig = CoreNodeFilterRule[]

/**
 * 判断节点是否匹配核心节点过滤规则
 * @param slug 节点 slug
 * @param frontmatter 节点 frontmatter
 * @param rules 过滤规则列表
 * @returns 是否匹配（OR 关系）
 */
export function matchCoreNodeFilter(
  slug: string,
  frontmatter: Record<string, unknown> | undefined,
  rules: CoreNodeFilterConfig | undefined,
): boolean {
  if (!rules || rules.length === 0) return false

  for (const rule of rules) {
    if (rule.type === "folder") {
      const parts = slug.split("/")
      if (parts.length <= 1) continue
      const depth = rule.depth ?? 1
      const folderParts =
        depth > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)) : [parts[0]]
      const folderKey = folderParts.join("/")
      if (rule.values?.includes(folderKey)) return true
    } else if (rule.type === "field") {
      const field = rule.field ?? ""
      const raw = frontmatter?.[field]
      if (raw === undefined || raw === null) continue
      const value = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw)
      if (rule.values?.includes(value)) return true
    }
  }

  return false
}

// ===== 公共工具函数 =====

/**
 * 按 granularity 格式化日期值
 * 返回统一格式字符串，供聚合分组键使用
 */
export function formatDateKey(value: unknown, granularity?: string): string {
  if (!granularity) return String(value ?? "(无)")

  let date: Date | null = null
  if (typeof value === "string" || typeof value === "number") {
    date = new Date(value)
  }
  if (!date || isNaN(date.getTime())) return String(value ?? "(无)")

  const y = date.getFullYear()
  const m = date.getMonth() + 1

  switch (granularity) {
    case "year":
      return `${y}年`
    case "month":
      return `${y}年${m}月`
    case "quarter":
      return `${y}-Q${Math.ceil(m / 3)}`
    default:
      return String(value ?? "(无)")
  }
}

/**
 * 从 item 中提取聚合键值
 * @param item 数据项（需有 slug / frontmatter）
 * @param rule 聚合规则
 * @returns 聚合键，若无法提取返回 null
 */
export function extractGroupKey(
  item: { slug?: string; frontmatter?: Record<string, unknown> },
  rule: AggregationRule,
): string | null {
  switch (rule.type) {
    case "folder": {
      const parts = (item.slug ?? "").split("/")
      if (parts.length <= 1) return "/"
      const depth = rule.depth ?? 1
      const folderParts =
        depth > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)) : [parts[0]]
      return folderParts.join("/")
    }

    case "field": {
      const field = rule.field ?? ""
      const raw = item.frontmatter?.[field]
      if (raw === undefined || raw === null) return null
      if (Array.isArray(raw)) {
        // 数组取第一个有效值
        const first = raw.find((v) => v !== undefined && v !== null)
        return first !== undefined ? String(first) : null
      }
      return String(raw)
    }

    case "date": {
      const field = rule.field || "date"
      let raw = item.frontmatter?.[field]
      // fallback: 若指定字段不存在，尝试通用 date / modified
      if ((raw === undefined || raw === null) && field !== "date") {
        raw = item.frontmatter?.["date"]
      }
      if (raw === undefined || raw === null) return null
      return formatDateKey(raw, rule.granularity)
    }

    default:
      return null
  }
}

/**
 * 判断规则是否产生有效分组
 * 若全部分组键都是 null（即字段不存在），视为无效
 */
export function isRuleEffective<
  T extends { slug?: string; frontmatter?: Record<string, unknown> },
>(items: T[], rule: AggregationRule): boolean {
  let hasValid = false
  for (const item of items) {
    const key = extractGroupKey(item, rule)
    if (key !== null) {
      hasValid = true
      break
    }
  }
  return hasValid
}

/**
 * 执行单条聚合规则，返回分组 Map
 */
export function applyAggregationRule<
  T extends { slug?: string; frontmatter?: Record<string, unknown> },
>(items: T[], rule: AggregationRule): Map<string, T[]> {
  const groups = new Map<string, T[]>()

  for (const item of items) {
    const key = extractGroupKey(item, rule) ?? "(无)"
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  return groups
}
