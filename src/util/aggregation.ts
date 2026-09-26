/**
 * 聚合配置公共类型和工具函数（自 v4 client/quartz/util/aggregation.ts 整体移植）
 *
 * 设计原则：
 * - folder、field 都是聚合维度，统一为规则列表
 * - 按 order 排序后顺序执行
 * - 每条规则独立配置，fallback 行为内聚在规则内部
 */

export type AggregationType = "folder" | "field"

export interface AggregationRule {
  /** 聚合维度类型 */
  type: AggregationType

  /** 字段名（field 用，folder 可省略） */
  field?: string

  /** 文件夹截取深度（仅 folder 有效） */
  depth?: number
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
 * 文件夹索引页（`Index.md` / 目录页）判定。
 *
 * 这类 slug 代表「文件夹自身」而不是文件夹里的内容实体，可能的形式：
 * - `项目/`（`simplifySlug` 的结果，带尾斜杠）
 * - `项目/index`（完整 slug）
 * - 根目录的 `index` / `/` / ``（空串）
 *
 * ⚠️ 文件夹归属判定（核心节点 / 大区分组 / 邻居分组 / scope）必须排除它：
 * 它的角色是「文件夹门面 / 大区显示名（`folderTitles`）」，若同时被算作该文件夹的成员，
 * 就会在文件夹里凭空多出一条「文件夹自己」的节点，与目录树（trie 把 `folder/index.md`
 * 折进文件夹节点、不单列）的口径也不一致。
 */
export function isFolderIndexSlug(slug: string | undefined | null): boolean {
  const s = slug ?? ""
  if (s === "" || s === "/" || s === "index") return true
  if (s.endsWith("/")) return true
  return s.endsWith("/index")
}

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
      // 文件夹索引页不代表文件夹内的内容实体，不作为该文件夹的核心成员
      if (isFolderIndexSlug(slug)) continue
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
 * 由一组节点 slug 推「共同目录」：各自去掉末段文件名后取公共前缀；无公共目录时返回 ""。
 *
 * 用途：给聚合节点标注它所属的目录上下文（跳转维度值页时作为 `?scope=`）。
 * 不做「更深一层也算同目录」的推断 —— 只有同一个目录里的成员才有确定的 scope。
 */
export function commonFolderOf(slugs: string[]): string {
  const dirs = slugs.map((slug) => slug.split("/").slice(0, -1))
  const first = dirs[0]
  if (!first) return ""
  let common = first.slice()
  for (const dir of dirs.slice(1)) {
    let index = 0
    while (index < common.length && index < dir.length && common[index] === dir[index]) index++
    common = common.slice(0, index)
    if (common.length === 0) break
  }
  return common.join("/")
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
      // 文件夹索引页不归属任何文件夹分组（它是文件夹自身的门面）
      if (isFolderIndexSlug(item.slug)) return null
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
