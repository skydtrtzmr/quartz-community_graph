export function resolveExpandBatchSize(value: unknown): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.expandBatchSize must be a positive integer");
  }
  return value as number;
}

type Node = { id: string };
type Edge<N> = { source: N; target: N };

/** Historical config name: maxVisibleNodes now limits only the initial screen. */
export function resolveMaxVisibleNodes(value: unknown): number {
  if (value === undefined) return 500;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.maxVisibleNodes must be a positive integer");
  }
  return value as number;
}

export function resolveLoadBatchSize(value: unknown): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.loadBatchSize must be a positive integer");
  }
  return value as number;
}

/** Independent queues; only open()'s initialSize limits the first screen. */
export class ExpansionPages<N extends Node, L extends Edge<N>> {
  private plans = new Map<string, { nodes: N[]; links: L[]; loaded: number; size: number }>();
  constructor(
    private size: number,
    private compare: (a: N, b: N) => number,
  ) {}

  open(id: string, existing: readonly N[], proposed: readonly N[], links: L[], size = this.size, initialSize = size) {
    const nodes = [...new Map(proposed.map((node) => [node.id, node])).values()].sort(this.compare);
    this.plans.set(id, { nodes, links, loaded: 0, size });
    return this.next(id, existing, initialSize);
  }

  next(id: string, existing: readonly N[], size?: number): { nodes: N[]; links: L[] } {
    const plan = this.plans.get(id);
    if (!plan) return { nodes: [], links: [] };
    const visible = new Set(existing.map((node) => node.id));
    const nodes: N[] = [];
    let consumed = 0;
    while (plan.loaded < plan.nodes.length && consumed < (size ?? plan.size)) {
      const node = plan.nodes[plan.loaded];
      if (!visible.has(node.id)) {
        nodes.push(node);
        visible.add(node.id);
      }
      plan.loaded++;
      consumed++;
    }
    return {
      nodes,
      links: plan.links.filter(
        (link) => visible.has(link.source.id) && visible.has(link.target.id),
      ),
    };
  }

  close(id: string) {
    this.plans.delete(id);
  }

  entries() {
    return [...this.plans].map(([id, plan]) => [id, {
      loaded: plan.loaded, total: plan.nodes.length, size: plan.size,
    }] as const);
  }


  pending() {
    return [...this.plans]
      .filter(([, plan]) => plan.loaded < plan.nodes.length)
      .map(([id, plan]) => [id, { loaded: plan.loaded, total: plan.nodes.length }] as const);
  }
}
