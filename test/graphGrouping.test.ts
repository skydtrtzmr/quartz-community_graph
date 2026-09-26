import { describe, expect, it } from "vitest";
import { resolveGraphGrouping } from "../src/util/graphGrouping";

const region = (depth = 1) => [{ type: "folder", depth }];

describe("图谱分组合成（配置层的唯一入口）", () => {
  it("未配主体白名单：按文件夹分组 + 按文件夹分大区 + 不做核心过滤", () => {
    expect(resolveGraphGrouping()).toEqual({
      aggregation: [{ type: "folder", depth: 1 }],
      regionRules: region(),
      coreNodeFilter: [],
    });
  });

  it("单一主体文件夹：核心 = 该文件夹，首屏仍保留文件夹大区这一层", () => {
    const g = resolveGraphGrouping({ folders: ["项目"], folderDepth: 2 });
    expect(g.aggregation).toEqual([{ type: "folder", depth: 2 }]);
    expect(g.regionRules).toEqual(region(2));
    expect(g.coreNodeFilter).toEqual([{ type: "folder", depth: 2, values: ["项目"] }]);
  });

  it("多主体文件夹：白名单去斜杠 / 去重", () => {
    const g = resolveGraphGrouping({ folders: ["/项目/", "任务", "任务", ""] });
    expect(g.coreNodeFilter).toEqual([{ type: "folder", depth: 1, values: ["项目", "任务"] }]);
    expect(g.regionRules).toEqual(region());
  });

  it("非法 folderDepth 回落到 1", () => {
    expect(resolveGraphGrouping({ folderDepth: 0 }).aggregation).toEqual([
      { type: "folder", depth: 1 },
    ]);
    expect(resolveGraphGrouping({ folderDepth: 1.5 }).aggregation).toEqual([
      { type: "folder", depth: 1 },
    ]);
  });
});
