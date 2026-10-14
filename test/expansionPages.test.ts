import { describe, expect, it } from "vitest";
import { ExpansionPages, resolveExpandBatchSize } from "../src/components/scripts/expansionPages";

type Node = { id: string };
type Link = { source: Node; target: Node };
const compare = (a: Node, b: Node) => a.id.localeCompare(b.id, undefined, { numeric: true });

describe("per aggregation expansion pages", () => {
  it("loads 128 children in independent batches with no whole graph ceiling", () => {
    const pages = new ExpansionPages<Node, Link>(20, compare);
    const parent = { id: "group" };
    const children = Array.from({ length: 128 }, (_, i) => ({ id: `child${i}` })).reverse();
    const edges = children.map((child) => ({ source: parent, target: child }));
    const existing = [parent, ...Array.from({ length: 600 }, (_, i) => ({ id: `existing${i}` }))];
    const first = pages.open(parent.id, existing, children, edges);
    expect(first.nodes).toHaveLength(20);
    expect(first.nodes[0].id).toBe("child0");
    expect(first.links).toHaveLength(20);
    expect(pages.pending()).toEqual([["group", { loaded: 20, total: 128 }]]);
    const second = pages.next("group", [...existing, ...first.nodes]);
    expect(second.nodes).toHaveLength(20);
    expect(second.nodes[0].id).toBe("child20");
    expect(second.links).toHaveLength(40);
    pages.open("other", existing, children, edges);
    expect(pages.pending().map(([, value]) => value.loaded)).toEqual([40, 20]);
    pages.close("group");
    expect(pages.next("group", existing).nodes).toHaveLength(0);
    expect(pages.open("group", existing, children, edges).nodes).toHaveLength(20);
  });

  it("pages synthetic child groups too, deduplicates nodes and defers cross-batch edges", () => {
    const pages = new ExpansionPages<Node, Link>(1, compare);
    const a = { id: "agg:a" },
      b = { id: "agg:b" },
      parent = { id: "parent" };
    const links = [{ source: a, target: b }];
    const first = pages.open("parent", [parent], [b, a, a], links);
    expect(first.nodes).toEqual([a]);
    expect(first.links).toEqual([]);
    const last = pages.next("parent", [parent, a]);
    expect(last.nodes).toEqual([b]);
    expect(last.links).toEqual(links);
    expect(pages.pending()).toEqual([]);
  });

  it("defaults to 20 and rejects invalid sizes", () => {
    expect(resolveExpandBatchSize(undefined)).toBe(20);
    expect(resolveExpandBatchSize(5)).toBe(5);
    for (const value of [0, -1, 1.5, "20", null])
      expect(() => resolveExpandBatchSize(value)).toThrow();
  });
});
