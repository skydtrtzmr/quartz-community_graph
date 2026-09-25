import { describe, expect, it } from "vitest";
import { forceLink, type SimulationNodeDatum } from "d3";
import { createAggAwareCollide, createGraphSimulation, simulationSettings } from "../src/components/scripts/graphSimulation";

interface Node extends SimulationNodeDatum {
  id: string;
  radius: number;
}
const config = { repelForce: 1.5, centerForce: 0.4, linkDistance: 150, enableRadial: true };

function fixture(view: "folder" | "global" | "local", options = config) {
  const regions: Node[] = Array.from({ length: 6 }, (_, i) => ({ id: `region:${i}`, radius: 25 }));
  let dragging = false;
  const simulation = createGraphSimulation<Node, { source: Node; target: Node }>(
    regions, [], view, options, 734, 250,
    createAggAwareCollide<Node>((node) => node.radius, new Map(), () => dragging, view === "folder"),
  ).stop();
  function settle() {
    for (let i = 0; i < 1000 && simulation.alpha() >= simulation.alphaMin(); i++) simulation.tick();
  }
  function clickAndSettle(node: Node) {
    const dynamics = simulationSettings(view);
    dragging = true;
    node.fx = node.x;
    node.fy = node.y;
    simulation.alphaTarget(dynamics.dragAlpha).tick();
    dragging = false;
    simulation.tick(Math.round(dynamics.dragReleaseMs / (1000 / 60)));
    node.fx = null;
    node.fy = null;
    simulation.tick(Math.max(0, Math.round((dynamics.reheatMs - dynamics.dragReleaseMs) / (1000 / 60))));
    simulation.alphaTarget(0);
    settle();
  }
  function cycle(index: number) {
    const parent = regions[index % regions.length];
    const children: Node[] = Array.from({ length: 4 }, (_, i) => ({
      id: `child:${i}`, radius: 16,
      x: parent.x! + Math.cos(i * Math.PI / 2) * 80,
      y: parent.y! + Math.sin(i * Math.PI / 2) * 80,
    }));
    simulation.nodes([...regions, ...children]);
    simulation.force("link", forceLink(children.map((child) => ({ source: parent, target: child }))).distance(options.linkDistance));
    simulation.alpha(0.3);
    clickAndSettle(parent);
    simulation.nodes(regions);
    simulation.force("link", forceLink<Node, { source: Node; target: Node }>([]).distance(options.linkDistance));
    simulation.alpha(0.3);
    clickAndSettle(parent);
  }
  function diameter() {
    return Math.max(...regions.flatMap((a) => regions.map((b) => Math.hypot(a.x! - b.x!, a.y! - b.y!))));
  }
  settle();
  return { regions, simulation, cycle, diameter };
}

describe("folder partition force layout", () => {
  it("reproduces the legacy disconnected-partition drift", () => {
    const old = fixture("local", { repelForce: 0.6, centerForce: 0.3, linkDistance: 70, enableRadial: false });
    const initial = old.diameter();
    for (let i = 0; i < 8; i++) old.cycle(i);
    console.log("legacy partition diameter", initial.toFixed(1), "->", old.diameter().toFixed(1));
    expect(old.diameter()).toBeGreaterThan(initial * 1.1);
  });

  it("keeps the same radial force through eight expand/collapse cycles without cumulative drift", () => {
    const graph = fixture("folder");
    const radial = graph.simulation.force("radial");
    const initial = graph.diameter();
    // The old low-damping/no-radial folder path starts above 1200 on this fixture.
    expect(initial).toBeLessThan(400);
    const diameters: number[] = [];
    for (let i = 0; i < 8; i++) {
      graph.cycle(i);
      diameters.push(graph.diameter());
      expect(graph.simulation.force("radial")).toBe(radial);
      expect(graph.regions.every((node) => node.fx == null && node.fy == null)).toBe(true);
    }
    console.log("folder partition diameter", initial.toFixed(1), "->", diameters.map((d) => d.toFixed(1)).join(", "));
    expect(Math.max(...diameters)).toBeLessThan(initial * 1.2);
    expect(Math.min(...diameters)).toBeGreaterThan(initial * 0.8);
  });

  it("matches global physics for the same nodes, parameters and canvas", () => {
    const folder = fixture("folder");
    const global = fixture("global");
    for (let i = 0; i < 4; i++) {
      folder.cycle(i);
      global.cycle(i);
      for (let n = 0; n < folder.regions.length; n++) {
        expect(folder.regions[n].x).toBeCloseTo(global.regions[n].x!, 8);
        expect(folder.regions[n].y).toBeCloseTo(global.regions[n].y!, 8);
      }
    }
  });
});
