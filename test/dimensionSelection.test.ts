import { describe, expect, it } from "vitest";
import { selectSharedRules, selectedRules } from "../src/util/dimensionSelection";
import type { SharedAggregation } from "../src/util/sharedAggregation";

const artifact: SharedAggregation = {
  version: 1,
  configHash: "test",
  minGroupSize: 1,
  root: { type: "folder", depth: 1 },
  resolved: {
    项目: [
      { type: "field", field: "阶段" },
      { type: "field", field: "类型" },
      { type: "field", field: "状态" },
    ],
    任务: [{ type: "field", field: "负责人" }],
  },
};

describe("graph dimension selection", () => {
  it("uses the panel order and only its active levels", () => {
    expect(selectedRules(artifact.resolved.项目, ["状态", "不存在", "阶段"], 2)).toEqual([
      { type: "field", field: "状态" },
      { type: "field", field: "阶段" },
    ]);
    expect(selectedRules(artifact.resolved.项目, [], 2)).toEqual(
      artifact.resolved.项目.slice(0, 2),
    );
  });

  it("keeps other contexts and the build artifact unchanged", () => {
    const selected = selectSharedRules(
      artifact,
      (folder) => (folder === "项目" ? ["状态"] : []),
      2,
    );
    expect(selected.resolved.项目.map((rule) => rule.field)).toEqual(["状态", "阶段"]);
    expect(selected.resolved.任务).toEqual(artifact.resolved.任务);
    expect(artifact.resolved.项目[0].field).toBe("阶段");
  });

  it("uses a nested folder's panel choice for its local graph", () => {
    const selected = selectSharedRules(
      artifact,
      (folder) => (folder === "项目/子目录" ? ["类型"] : []),
      2,
      "项目/子目录",
    );
    expect(selected.resolved.项目.map((rule) => rule.field)).toEqual(["类型", "阶段"]);
  });
});
