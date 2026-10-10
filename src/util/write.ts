import path from "node:path"
import fs from "node:fs/promises"
import { joinSegments } from "@quartz-community/types"
import type { BuildCtx, FilePath, FullSlug } from "@quartz-community/types"

type WriteOptions = {
  ctx: BuildCtx
  slug: FullSlug
  ext: `.${string}` | ""
  content: string | Buffer
}

/**
 * 写入助手：与 v4 `quartz/plugins/emitters/helpers.ts` 等价（自包含实现，插件不依赖主仓）。
 */
export const write = async ({ ctx, slug, ext, content }: WriteOptions): Promise<FilePath> => {
  const pathToPage = joinSegments(ctx.argv.output, slug + ext) as FilePath
  const dir = path.dirname(pathToPage)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(pathToPage, content)
  return pathToPage
}
