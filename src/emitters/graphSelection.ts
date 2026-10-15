import { readFile } from "node:fs/promises"
import { joinSegments } from "@quartz-community/types"
import type { BuildCtx, FullSlug } from "@quartz-community/types"
import { realLinkCounts, resolveCoreMinLinks, type GraphSelection } from "../util/coreMinLinks"
import { write } from "../util/write"
import { filterGraphContent, type ContentDetails } from "../util/contentIndex"
export async function emitGraphSelection(ctx: BuildCtx, minimum?: number) {
  const index = JSON.parse(await readFile(joinSegments(ctx.argv.output, "static", "contentIndex.json"), "utf8"))
  const visibleIndex = Object.fromEntries(filterGraphContent(new Map(Object.entries(index as Record<string, ContentDetails>))))
  const selection: GraphSelection = { version: 1, coreMinLinks: resolveCoreMinLinks(minimum), linkCounts: realLinkCounts(visibleIndex) }
  return write({ ctx, slug: "graph/selection" as FullSlug, ext: ".json", content: JSON.stringify(selection) })
}
