import { isFolderIndexSlug, type AggregationRule } from "./aggregation";

/** Consumer view of aggregation.json v1. Inheritance is resolved by aggregation-pro. */
export interface SharedAggregation {
  version: 1;
  configHash: string;
  minGroupSize: number;
  root: AggregationRule & { type: "folder"; depth: number };
  resolved: Record<string, AggregationRule[]>;
}

export function readSharedAggregation(value: unknown): SharedAggregation {
  const a = value as SharedAggregation | null;
  const validRule = (r: AggregationRule): boolean =>
    !!r &&
    (r.type === "folder"
      ? Number.isInteger(r.depth ?? 1) && (r.depth ?? 1) > 0
      : r.type === "field" && typeof r.field === "string" && r.field.trim().length > 0);
  if (
    !a ||
    a.version !== 1 ||
    typeof a.configHash !== "string" ||
    !Number.isInteger(a.minGroupSize) ||
    a.minGroupSize < 1 ||
    a.root?.type !== "folder" ||
    !validRule(a.root) ||
    !a.resolved ||
    typeof a.resolved !== "object" ||
    Array.isArray(a.resolved) ||
    !Object.values(a.resolved).every((rules) => Array.isArray(rules) && rules.every(validRule))
  ) {
    throw new Error("[Graph] Invalid aggregation.json v1; rebuild with --reset");
  }
  return a;
}

export interface AggregationItem {
  slug: string;
  frontmatter?: Record<string, unknown>;
}

export interface SharedGroup<T> {
  key: string;
  rule: AggregationRule;
  members: T[];
  remainingRules: AggregationRule[];
}

export const DEFAULT_CORE_AGGREGATION_MAX_LEVELS = 2;

/** Select the prefix before grouping: skipped fields must not pull later fields into view. */
export function globalCoreRules(
  artifact: SharedAggregation, folder: string,
  maxLevels = DEFAULT_CORE_AGGREGATION_MAX_LEVELS,
): AggregationRule[] {
  if (!Number.isInteger(maxLevels) || maxLevels < 1) {
    throw new Error("[Graph] globalGraph.coreAggregationMaxLevels must be a positive integer");
  }
  if (!Object.hasOwn(artifact.resolved, folder)) {
    throw new Error(`[Graph] aggregation.json missing context ${folder}; rebuild with --reset`);
  }
  return artifact.resolved[folder].slice(0, maxLevels);
}

/** Global non-core neighbors stop at folders, even when only one folder is present. */
export function groupGlobalNeighbors<T>(
  items: T[], artifact: SharedAggregation, describe: (item: T) => AggregationItem,
): { groups: SharedGroup<T>[]; leaves: T[] } {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(describe(item), artifact.root);
    if (key === null) continue; // 文件夹索引页不作为任何文件夹的成员
    const members = buckets.get(key) ?? [];
    members.push(item);
    buckets.set(key, members);
  }
  if (![...buckets.values()].some(members => members.length >= artifact.minGroupSize)) {
    return { groups: [], leaves: [...items] };
  }
  return {
    groups: [...buckets].map(([key, members]) => ({ key, members, rule: artifact.root, remainingRules: [] })),
    leaves: [],
  };
}

function firstValue(value: unknown): unknown {
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return Array.isArray(value) ? value.find(present) : present(value) ? value : undefined;
}

/**
 * 把 `[[target]]` / `[[target|display]]` 剥离为纯文本（display 优先，否则 target）。
 * 让 wikilink 型字段（如「负责人」）用于聚合时显示为纯文本，而不是 `[[...]]`。
 */
function stripWikilink(value: string): string {
  const match = value.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (!match) return value;
  const target = match[1] ?? "";
  const display = match[2] ?? "";
  return display.trim() || target.trim();
}

function keyFor(item: AggregationItem, rule: AggregationRule): string | null {
  if (rule.type === "folder") {
    // 文件夹索引页不是任何文件夹的成员（它是文件夹自身的门面）
    if (isFolderIndexSlug(item.slug)) return null;
    // Use the full source slug: simplified folder/index slugs lose the last component.
    return (
      item.slug
        .split("/")
        .slice(0, -1)
        .slice(0, rule.depth ?? 1)
        .join("/") || "/"
    );
  }
  if (rule.type !== "field") return null;
  const raw = firstValue(item.frontmatter?.[rule.field!]);
  if (raw === undefined) return null;
  return stripWikilink(String(raw));
}

/** One level shared by build and runtime. Each directory/branch groups all categories or none. */
export function groupShared<T>(
  items: T[],
  artifact: SharedAggregation,
  describe: (item: T) => AggregationItem,
  rules?: AggregationRule[],
): { groups: SharedGroup<T>[]; leaves: T[] } {
  const eligible = items;
  const leaves: T[] = [];
  if (rules === undefined) {
    const contexts = new Map<string, T[]>();
    for (const item of eligible) {
      const context = keyFor(describe(item), artifact.root);
      if (context === null) continue; // 文件夹索引页不归属任何文件夹上下文
      const members = contexts.get(context) ?? [];
      members.push(item);
      contexts.set(context, members);
    }
    const groups: SharedGroup<T>[] = [];
    for (const [context, members] of contexts) {
      if (!Object.hasOwn(artifact.resolved, context)) {
        throw new Error(
          `[Graph] aggregation.json missing context ${context}; rebuild with --reset`,
        );
      }
      const chain = artifact.resolved[context];
      if (contexts.size > 1 && members.length >= artifact.minGroupSize) {
        groups.push({ key: context, rule: artifact.root, members, remainingRules: chain });
      } else if (contexts.size === 1) {
        // A single directory need not add an extra click, but still selects its own branch.
        const next = groupShared(members, artifact, describe, chain);
        groups.push(...next.groups);
        leaves.push(...next.leaves);
      } else leaves.push(...members);
    }
    return { groups, leaves };
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const keys = eligible.map((item) => keyFor(describe(item), rule));
    if (keys.every((key) => key === null)) continue;
    const buckets = new Map<string, T[]>();
    eligible.forEach((item, index) => {
      const key = keys[index];
      // folder 规则下 null = 文件夹索引页（不是成员，直接跳过，不落「未设置」）；
      // field 规则下 null = 字段缺值，仍归入「未设置」
      if (key === null && rule.type === "folder") return;
      const bucketKey = key ?? "未设置";
      const members = buckets.get(bucketKey) ?? [];
      members.push(item);
      buckets.set(bucketKey, members);
    });
    if (rule.type === "folder" && buckets.size <= 1) continue;
    if (![...buckets.values()].some(members => members.length >= artifact.minGroupSize)) continue;
    const groups: SharedGroup<T>[] = [];
    for (const [key, members] of buckets) {
      groups.push({ key, rule, members, remainingRules: rules.slice(i + 1) });
    }
    return { groups, leaves };
  }
  return { groups: [], leaves: [...leaves, ...eligible] };
}
