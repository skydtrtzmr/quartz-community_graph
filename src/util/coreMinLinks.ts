/** Minimum real-link count for global cores; zero also keeps isolated content nodes. */
import { isFolderIndexSlug } from "./aggregation"

export const DEFAULT_GLOBAL_CORE_MIN_LINKS = 3

export function resolveCoreMinLinks(value: number | undefined, hasFolderWhitelist = false): number {
  // Preserve the old whitelist behavior (all connected matches) and empty-list degree rule.
  if (value === undefined) return hasFolderWhitelist ? 1 : DEFAULT_GLOBAL_CORE_MIN_LINKS
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("[Graph] globalGraph.coreMinLinks must be a non-negative integer")
  }
  return value
}

export function qualifiesAsGlobalCore(id: string, links: number, minLinks: number, hasContent: boolean): boolean {
  return hasContent && !id.startsWith("tags/") && !isFolderIndexSlug(id) && links >= minLinks
}
