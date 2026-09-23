import { describe, expect, it } from "vitest";
import { groupShared, readSharedAggregation } from "../src/util/sharedAggregation";
import type { AggregationItem, SharedAggregation } from "../src/util/sharedAggregation";

const artifact: SharedAggregation = {
  version: 1,
  configHash: "test",
  minGroupSize: 2,
  root: { type: "folder", depth: 1 },
  resolved: {
    任务: [
      { type: "field", field: "status" },
      { type: "field", field: "date" },
    ],
    问答: [],
  },
};
const note = (slug: string, frontmatter = {}): AggregationItem => ({
  slug,
  frontmatter,
});
const identity = (item: AggregationItem) => item;

describe("shared local aggregation", () => {
  it("keeps independent memberships for two centers sharing a neighbor", () => {
    const shared = note("任务/shared", { status: "完成" });
    const first = groupShared([shared, note("任务/a", { status: "完成" })], artifact, identity);
    const second = groupShared([shared, note("任务/b", { status: "完成" })], artifact, identity);
    expect(first.groups[0].members).toContain(shared);
    expect(second.groups[0].members).toContain(shared);
    expect(first.groups[0].members).toHaveLength(2);
  });
  it("selects directory branches and honors explicit stop on expansion", () => {
    const tasks = [note("任务/a", { status: "完成" }), note("任务/b", { status: "完成" })];
    const questions = [note("问答/a"), note("问答/b")];
    const first = groupShared([...tasks, ...questions], artifact, identity);
    expect(first.groups.map((g) => g.key)).toEqual(["任务", "问答"]);
    const taskGroup = first.groups[0];
    expect(
      groupShared(taskGroup.members, artifact, identity, taskGroup.remainingRules).groups[0].key,
    ).toBe("完成");
    expect(groupShared(questions, artifact, identity, first.groups[1].remainingRules)).toEqual({
      groups: [],
      leaves: questions,
    });
  });

  it("groups every category in the branch once any category reaches the threshold", () => {
    const items = [
      note("任务/a", { status: "完成" }),
      note("任务/b", { status: "完成" }),
      note("任务/c", { status: "待办" }),
    ];
    const result = groupShared(items, artifact, identity);
    expect(result.groups.map((g) => g.key)).toEqual(["完成", "待办"]);
    expect(result.groups.map((g) => g.members.length)).toEqual([2, 1]);
    expect(result.leaves).toEqual([]);
    expect(groupShared(items, { ...artifact, minGroupSize: 3 }, identity).groups).toEqual([]);
  });

  it("takes first effective array value and puts partial missing values in 未设置", () => {
    const result = groupShared(
      [
        note("任务/a", { status: [null, "", "完成", "待办"] }),
        note("任务/b", { status: "完成" }),
        note("任务/c"),
        note("任务/d", { status: [] }),
      ],
      artifact,
      identity,
    );
    expect(result.groups.map((g) => [g.key, g.members.length])).toEqual([
      ["完成", 2],
      ["未设置", 2],
    ]);
  });

  it("groups by raw field value with no implicit date formatting", () => {
    const items = [
      note("任务/a", { date: ["2026-09-01"] }),
      note("任务/b", { date: "2026-09-02" }),
    ];
    // 日期不再有隐式粒度：原值即分组键，两个不同取值各成一组、未达阈值 → 整层不聚合
    expect(
      groupShared(items, artifact, identity, [{ type: "field", field: "date" }]).groups,
    ).toEqual([]);
    // 同值两项达到阈值 → 按原值成组
    expect(
      groupShared(
        [note("任务/a", { date: "2026年9月" }), note("任务/b", { date: "2026年9月" })],
        artifact,
        identity,
        [{ type: "field", field: "date" }],
      ).groups.map((g) => g.key),
    ).toEqual(["2026年9月"]);
    // 字段缺失时规则不产生分组
    expect(groupShared([note("任务/a"), note("任务/b")], artifact, identity).groups).toEqual([]);
  });

  it("preserves source index directory context", () => {
    const items = [
      note("任务/index", { status: "完成" }),
      note("任务/b", { status: "完成" }),
    ];
    const result = groupShared(items, artifact, identity);
    expect(result.groups[0].members).toHaveLength(2);
    expect(result.leaves).toEqual([]);
  });

  it("fails on missing resolved context rather than duplicating inheritance", () => {
    expect(() => groupShared([note("未知/a")], artifact, identity)).toThrow("missing context");
  });

  it("rejects bad protocols instead of silently using legacy options", () => {
    expect(readSharedAggregation(artifact)).toBe(artifact);
    // minGroupSize 允许 1（每个取值都成组），0 仍非法
    expect(readSharedAggregation({ ...artifact, minGroupSize: 1 }).minGroupSize).toBe(1);
    for (const bad of [
      null,
      { ...artifact, version: 2 },
      { ...artifact, minGroupSize: 0 },
      { ...artifact, resolved: { 任务: null } },
    ]) {
      expect(() => readSharedAggregation(bad)).toThrow("Invalid aggregation.json");
    }
  });
});
