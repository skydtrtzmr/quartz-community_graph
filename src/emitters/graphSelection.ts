import { readFile } from "node:fs/promises"
import { joinSegments } from "@quartz-community/types"
import type { BuildCtx, FullSlug } from "@quartz-community/types"
import { realLinkCounts, resolveCoreMinLinks, type GraphSelection } from "../util/coreMinLinks"
import { write } from "../util/write"
export async function emitGraphSelection(ctx: BuildCtx, minimum?: number) {
  const index = JSON.parse(await readFile(joinSegments(ctx.argv.output, "static", "contentIndex.json"), "utf8"))
  const selection: GraphSelection = { version: 1, coreMinLinks: resolveCoreMinLinks(minimum), linkCounts: realLinkCounts(index) }
  return write({ ctx, slug: "graph/selection" as FullSlug, ext: ".json", content: JSON.stringify(selection) })
}
