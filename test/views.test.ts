import { describe, expect, it } from "vitest";
import { graphViewOf, selectCoreNodes, type GraphView } from "../src/components/scripts/views";

describe("graph view selection", () => {
  it("distinguishes the four graph views", () => {
    expect(graphViewOf(-1, false)).toBe("global");
    expect(graphViewOf(1, false)).toBe("local");
    expect(graphViewOf(1, false, "folder")).toBe("folder");
    expect(graphViewOf(1, true, "folder")).toBe("dimension");
  });

  function coreIds(view: GraphView, sharedAggregation: boolean) {
    const nodes = ["项目/index", "项目/a", "项目/b"].map((id) => ({ id, isCore: false }));
    selectCoreNodes({
      view,
      nodes,
      nodeLinkCount: new Map([
        ["项目/index", 2],
        ["项目/a", 1],
        ["项目/b", 3],
      ]),
      contentData: new Map(),
      slug: "项目/index",
      sharedAggregation,
      hasRegionRules: false,
    });
    return nodes.filter((node) => node.isCore).map((node) => node.id);
  }

  it("preserves legacy local/folder/dimension core thresholds", () => {
    expect(coreIds("local", false)).toEqual(["项目/index", "项目/b"]);
    expect(coreIds("folder", false)).toEqual(["项目/index", "项目/b"]);
    expect(coreIds("dimension", false)).toEqual(["项目/index", "项目/b"]);
  });

  it("preserves the single center when shared aggregation is active", () => {
    for (const view of ["local", "folder", "dimension"] as const) {
      expect(coreIds(view, true)).toEqual(["项目/index"]);
    }
  });

  it("preserves the global degree threshold", () => {
    expect(coreIds("global", false)).toEqual(["项目/b"]);
  });

  it("preserves the global core limit and region-rule exception", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ id, isCore: false }));
    const selection = {
      view: "global" as const,
      nodes,
      nodeLinkCount: new Map([
        ["a", 3],
        ["b", 5],
        ["c", 4],
      ]),
      contentData: new Map(),
      slug: "a",
      sharedAggregation: false,
      coreNodeLimit: 2,
      hasRegionRules: false,
    };
    selectCoreNodes(selection);
    expect(nodes.filter((node) => node.isCore).map((node) => node.id)).toEqual(["b", "c"]);
    selectCoreNodes({ ...selection, hasRegionRules: true });
    expect(nodes.filter((node) => node.isCore).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });
});
