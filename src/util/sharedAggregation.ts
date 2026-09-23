import type { AggregationRule } from "./aggregation";

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

function firstValue(value: unknown): unknown {
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return Array.isArray(value) ? value.find(present) : present(value) ? value : undefined;
}

function keyFor(item: AggregationItem, rule: AggregationRule): string | null {
  if (rule.type === "folder") {
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
  return String(raw);
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
      const context = keyFor(describe(item), artifact.root)!;
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
      const key = keys[index] ?? "未设置";
      const members = buckets.get(key) ?? [];
      members.push(item);
      buckets.set(key, members);
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
