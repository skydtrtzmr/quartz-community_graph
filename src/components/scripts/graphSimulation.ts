import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type Force,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3";
import type { D3Config } from "../Graph";
import type { GraphView } from "./views";

/** Multi-center views need stronger damping and gentler drag reheating. */
export function simulationSettings(view: GraphView) {
  const overview = view === "global" || view === "folder" || view === "dimension";
  return {
    alphaMin: overview ? 0.001 : 0.002,
    alphaDecay: overview ? 1 - Math.pow(0.001, 1 / 300) : 0.05,
    velocityDecay: overview ? 0.75 : 0.4,
    dragAlpha: overview ? 0.1 : 0.3,
    dragReleaseMs: overview ? 300 : 0,
    reheatMs: overview ? 300 : 500,
  };
}

export function createGraphSimulation<
  N extends SimulationNodeDatum,
  L extends SimulationLinkDatum<N>,
>(
  nodes: N[],
  links: L[],
  view: GraphView,
  config: Pick<D3Config, "repelForce" | "centerForce" | "linkDistance" | "enableRadial">,
  width: number,
  height: number,
  collide: Force<N, L>,
) {
  const settings = simulationSettings(view);
  const simulation = forceSimulation<N>(nodes)
    .force("charge", forceManyBody<N>().strength(-100 * config.repelForce))
    .force("center", forceCenter<N>().strength(config.centerForce))
    .force("link", forceLink<N, L>(links).distance(config.linkDistance))
    .force("collide", collide)
    .alphaMin(settings.alphaMin)
    .alphaDecay(settings.alphaDecay)
    .velocityDecay(settings.velocityDecay);

  // Nonzero-radius radial force stays installed throughout expansion/collapse.
  // It balances repulsion without changing modes or pinning any node position.
  if (config.enableRadial) {
    const radius = (Math.min(width, height) / 2) * 0.8;
    simulation.force("radial", forceRadial<N>(radius).strength(0.05));
  }
  return simulation;
}

/** Existing aggregation-aware collision calculation, shared with numeric regressions. */
export function createAggAwareCollide<N extends SimulationNodeDatum & { id: string; aggExpandedRadius?: number }>(
  radius: (node: N) => number,
  expandedChildren: ReadonlyMap<N["id"], ReadonlySet<N["id"]>>,
  isDragging: () => boolean,
  skipLargeGraph: boolean,
) {
  let nodes: N[] = [];
  function force() {
    if (isDragging() || (skipLargeGraph && nodes.length > 250)) return;
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < nodes.length; i++) {
        const ni = nodes[i];
        if (ni.x == null || ni.y == null) continue;
        const ri = radius(ni) + 8;
        for (let j = i + 1; j < nodes.length; j++) {
          const nj = nodes[j];
          if (nj.x == null || nj.y == null) continue;
          if (ni.aggExpandedRadius && expandedChildren.get(ni.id)?.has(nj.id)) continue;
          if (nj.aggExpandedRadius && expandedChildren.get(nj.id)?.has(ni.id)) continue;
          const dx = ni.x - nj.x;
          const dy = ni.y - nj.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const minimum = ri + radius(nj) + 12;
          if (distance < minimum) {
            const push = ((minimum - distance) / distance) * 0.8;
            ni.vx = (ni.vx ?? 0) + dx * push;
            ni.vy = (ni.vy ?? 0) + dy * push;
            nj.vx = (nj.vx ?? 0) - dx * push;
            nj.vy = (nj.vy ?? 0) - dy * push;
          }
        }
      }
    }
  }
  force.initialize = (value: N[]) => { nodes = value; };
  return force;
}
