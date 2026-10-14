export function resolveExpandBatchSize(value: unknown): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("[Graph] graph.expandBatchSize must be a positive integer");
  }
  return value as number;
}

type Node = { id: string };
type Edge<N> = { source: N; target: N };

/** Independent direct-child queues. There is deliberately no whole-graph budget. */
export class ExpansionPages<N extends Node, L extends Edge<N>> {
  private plans = new Map<string, { nodes: N[]; links: L[]; loaded: number }>();
  constructor(
    private size: number,
    private compare: (a: N, b: N) => number,
  ) {}

  open(id: string, existing: readonly N[], proposed: readonly N[], links: L[]) {
    const nodes = [...new Map(proposed.map((node) => [node.id, node])).values()].sort(this.compare);
    this.plans.set(id, { nodes, links, loaded: 0 });
    return this.next(id, existing);
  }

  next(id: string, existing: readonly N[]): { nodes: N[]; links: L[] } {
    const plan = this.plans.get(id);
    if (!plan) return { nodes: [], links: [] };
    const selected = plan.nodes.slice(plan.loaded, plan.loaded + this.size);
    plan.loaded += selected.length;
    const visible = new Set(existing.map((node) => node.id));
    const nodes = selected.filter((node) => !visible.has(node.id));
    for (const node of nodes) visible.add(node.id);
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


  pending() {
    return [...this.plans]
      .filter(([, plan]) => plan.loaded < plan.nodes.length)
      .map(([id, plan]) => [id, { loaded: plan.loaded, total: plan.nodes.length }] as const);
  }
}
