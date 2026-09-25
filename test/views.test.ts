import { describe, expect, it } from "vitest";
import {
  focusNodeIds,
  graphViewOf,
  isExpandableLocalGroup,
  selectCoreNodes,
  type GraphView,
} from "../src/components/scripts/views";

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

  it("preserves legacy local/dimension core thresholds", () => {
    expect(coreIds("local", false)).toEqual(["项目/index", "项目/b"]);
    expect(coreIds("dimension", false)).toEqual(["项目/index", "项目/b"]);
  });

  it("preserves the single center when shared aggregation is active", () => {
    for (const view of ["local", "dimension"] as const) {
      expect(coreIds(view, true)).toEqual(["项目/index"]);
    }
  });

  it("uses all direct real files as folder cores, never the folder anchor or neighbors", () => {
    const nodes = ["项目/", "项目/a", "项目/b", "项目/子目录/c", "人员/p"].map((id) => ({
      id,
      isCore: false,
    }));
    const contentData = new Map(
      nodes.map((node) => [node.id, { filePath: node.id === "项目/b" ? "" : `${node.id}.md` }]),
    );
    selectCoreNodes({
      view: "folder",
      nodes,
      nodeLinkCount: new Map(),
      contentData: contentData as never,
      slug: "项目/",
      sharedAggregation: true,
      hasRegionRules: false,
    });
    expect(nodes.filter((node) => node.isCore).map((node) => node.id)).toEqual(["项目/a"]);
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

  it("marks the current content node in a local graph without using link degree", () => {
    const nodes = [{ id: "项目/a" }, { id: "项目/b", isCore: true }];
    expect([...focusNodeIds("local", nodes, "项目/a")]).toEqual(["项目/a"]);
  });

  it("marks only direct real files in a folder graph", () => {
    const nodes = [
      { id: "项目/index" },
      { id: "项目/a" },
      { id: "项目/b" },
      { id: "项目/子目录/c" },
      { id: "人员/p" },
    ];
    expect([...focusNodeIds("folder", nodes, "项目/index", [], (id) => id !== "项目/b")]).toEqual([
      "项目/a",
    ]);
  });

  it("uses filtered dimension matches, not neighbor degree", () => {
    const nodes = [{ id: "项目/a" }, { id: "项目/b" }, { id: "人员/p", isCore: true }];
    expect([
      ...focusNodeIds("dimension", nodes, "_dimensions/阶段/规划中", [{ slug: "项目/a" }]),
    ]).toEqual(["项目/a"]);
  });

  it("marks global core content but not synthetic regions", () => {
    const nodes = [
      { id: "项目/a", isCore: true },
      { id: "人员/p", isCore: false },
      { id: "__region", isCore: true, isRegion: true },
    ];
    expect([...focusNodeIds("global", nodes, "项目/a")]).toEqual(["项目/a"]);
  });

  it("treats local region nodes as expandable, not ordinary navigation targets", () => {
    expect(isExpandableLocalGroup({ id: "region:folder:阶段:计划", isRegion: true })).toBe(true);
    expect(isExpandableLocalGroup({ id: "agg:shared:计划" })).toBe(true);
    expect(isExpandableLocalGroup({ id: "项目/proj-00017" })).toBe(false);
  });

});
