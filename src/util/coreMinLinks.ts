/** Minimum real-link count shared by global, folder and dimension cores; zero also keeps isolated content nodes. */
import { isFolderIndexSlug } from "./aggregation"

export const DEFAULT_CORE_MIN_LINKS = 0

export function resolveCoreMinLinks(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_MIN_LINKS
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("[Graph] graph.coreMinLinks must be a non-negative integer")
  }
  return value
}

export function qualifiesAsGlobalCore(id: string, links: number, minLinks: number, hasContent: boolean): boolean {
  return hasContent && !id.startsWith("tags/") && !id.startsWith("_dimensions/") && !isFolderIndexSlug(id) && links >= minLinks
}

/** Domain-wide degree: real file links only, deduplicated per direction, no self links. */
export function realLinkCounts(index: Record<string, { links?: string[]; filePath?: string }>): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  const real = new Set(Object.entries(index).filter(([id, item]) =>
    qualifiesAsGlobalCore(id, 0, 0, !!item.filePath) && !/(^|[\\/])index\.md$/.test(item.filePath ?? "")
  ).map(([id]) => id))
  for (const id of real) counts[id] = 0
  for (const id of real) {
    for (const target of new Set(index[id].links ?? [])) {
      if (target === id || !real.has(target)) continue
      counts[id]++
      counts[target]++
    }
  }
  return counts
}
export interface GraphSelection {
  version: 1
  coreMinLinks: number
  linkCounts: Record<string, number>
}
/** Retain qualifying subjects and direct neighbors without changing list data. */
export function selectScope(candidates: Set<string>, counts: Record<string, number>, minimum: number,
  links: Array<{ source: string; target: string }>) {
  const coreIds = new Set([...candidates].filter(id => Object.hasOwn(counts, id) && counts[id] >= minimum))
  const retainedIds = new Set(coreIds)
  for (const { source, target } of links) {
    if (coreIds.has(source)) retainedIds.add(target)
    if (coreIds.has(target)) retainedIds.add(source)
  }
  return { coreIds, retainedIds }
}
