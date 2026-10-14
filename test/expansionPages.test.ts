import { describe, expect, it } from "vitest";
import { ExpansionPages, resolveExpandBatchSize, resolveMaxVisibleNodes, resolveLoadBatchSize } from "../src/components/scripts/expansionPages";

type Node = { id: string };
type Link = { source: Node; target: Node };
const compare = (a: Node, b: Node) => a.id.localeCompare(b.id, undefined, { numeric: true });

describe("per aggregation expansion pages", () => {
  it("loads 128 children in independent batches even with 600 nodes already visible", () => {
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

  it("limits an ungrouped 10,000-node first screen before rendering and retains overflow", () => {
    const pages = new ExpansionPages<Node, Link>(20, compare);
    const all = Array.from({ length: 10000 }, (_, i) => ({ id: `file${i}` }));
    const links = all.slice(1).map(node => ({ source: all[0], target: node }));
    const first = pages.open("initial", [], all, links, 100, 500);
    expect(first.nodes).toHaveLength(500);
    expect(first.links).toHaveLength(499);
    expect(pages.pending()).toEqual([["initial", { loaded: 500, total: 10000 }]]);
    // User-triggered loading can exceed the initial budget without dropping a page.
    const next = pages.next("initial", first.nodes);
    expect(next.nodes).toHaveLength(100);
    expect(next.nodes[0].id).toBe("file500");
    expect(next.links).toHaveLength(599);
    const visibleIds = new Set([...first.nodes, ...next.nodes].map(node => node.id));
    expect(next.links.every(link => visibleIds.has(link.source.id) && visibleIds.has(link.target.id))).toBe(true);
    const third = pages.next("initial", [...first.nodes, ...next.nodes]);
    expect(third.nodes).toHaveLength(100);
    expect(third.nodes[0].id).toBe("file600");
    expect(pages.pending()).toEqual([["initial", { loaded: 700, total: 10000 }]]);
  });

  it("keeps five queues independent after total visible nodes exceed the initial budget", () => {
    const pages = new ExpansionPages<Node, Link>(5, compare);
    let visible = Array.from({ length: 5 }, (_, i) => ({ id: `agg${i}` }));
    const parents = [...visible];
    for (const parent of parents) {
      const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `${parent.id}-child${i}` }));
      const page = pages.open(parent.id, visible, nodes, nodes.map(node => ({ source: parent, target: node })));
      visible.push(...page.nodes);
      expect(page.links.every(link => visible.includes(link.source) && visible.includes(link.target))).toBe(true);
    }
    expect(visible).toHaveLength(30);
    expect(pages.pending().map(([, p]) => p.loaded)).toEqual([5, 5, 5, 5, 5]);
    for (let index = 0; index < 3; index++) {
      const page = pages.next("agg1", visible);
      visible.push(...page.nodes);
      expect(page.nodes).toHaveLength([5, 2, 0][index]);
      expect(new Set(visible.map(node => node.id)).size).toBe(visible.length);
    }
    expect(visible).toHaveLength(37);
    expect(pages.entries().map(([, p]) => p.loaded)).toEqual([5, 12, 5, 5, 5]);
    // Collapse agg0, preserving the progress of all other queues.
    visible = visible.filter(node => !node.id.startsWith("agg0-child"));
    pages.close("agg0");
    const next = pages.next("agg2", visible);
    expect(next.nodes).toHaveLength(5);
    expect(next.nodes[0].id).toBe("agg2-child5");
    expect(pages.pending().map(([, p]) => p.loaded)).toEqual([10, 5, 5]);
    const reopened = pages.open("agg0", visible, Array.from({ length: 12 }, (_, i) => ({ id: `agg0-child${i}` })), []);
    expect(reopened.nodes).toHaveLength(5);
    expect(pages.entries().find(([id]) => id === "agg1")?.[1].loaded).toBe(12);
  });

  it("does not duplicate children shared with another visible branch", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const pages = new ExpansionPages<Node, Link>(5, compare);
    expect(pages.open("group", [a, b], [a, b, c], []).nodes).toEqual([c]);
    expect(pages.pending()).toEqual([]);
    expect(pages.next("group", [a, b, c]).nodes).toEqual([]);
  });

  it("validates shared graph limits", () => {
    expect(resolveMaxVisibleNodes(undefined)).toBe(500);
    expect(resolveLoadBatchSize(undefined)).toBe(100);
    for (const value of [0, -1, 1.5, "500", null]) {
      expect(() => resolveMaxVisibleNodes(value)).toThrow();
      expect(() => resolveLoadBatchSize(value)).toThrow();
    }
  });
});
