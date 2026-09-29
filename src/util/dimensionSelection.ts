import type { AggregationRule } from "./aggregation";
import type { SharedAggregation } from "./sharedAggregation";

/** The panel stores one order per folder; only fields in the build artifact are selectable. */
export function selectedRules(
  rules: AggregationRule[],
  storedOrder: readonly string[],
  maxLevels: number,
): AggregationRule[] {
  const fields = rules.filter((rule) => rule.type === "field" && !!rule.field);
  const byName = new Map(fields.map((rule) => [rule.field!, rule]));
  const selected: AggregationRule[] = [];
  for (const name of storedOrder) {
    const rule = byName.get(name);
    if (rule && !selected.includes(rule)) selected.push(rule);
  }
  for (const rule of fields) if (!selected.includes(rule)) selected.push(rule);
  return selected.slice(0, Math.max(1, Math.floor(maxLevels)));
}

export function selectSharedRules(
  artifact: SharedAggregation,
  readOrder: (folder: string) => string[],
  maxLevels: number,
  focusedFolder?: string,
): SharedAggregation {
  const resolved: SharedAggregation["resolved"] = {};
  for (const [context, rules] of Object.entries(artifact.resolved)) {
    const folder =
      focusedFolder && (focusedFolder === context || focusedFolder.startsWith(`${context}/`))
        ? focusedFolder
        : context;
    resolved[context] = selectedRules(rules, readOrder(folder), maxLevels);
  }
  return { ...artifact, resolved };
}
