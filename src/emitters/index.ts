import type {
  BuildCtx,
  ChangeEvent,
  FilePath,
  ProcessedContent,
  QuartzEmitterPluginInstance,
  StaticResources,
} from "@quartz-community/types"
import { emitGraphSelection } from "./graphSelection"
import { GraphLocalEmitter } from "./graphLocal"
import { GraphGlobalEmitter } from "./graphGlobal"
import { resolveGraphViewConfig, type GraphProOptions } from "../options"

/** 把 `Promise<FilePath[]> | AsyncGenerator<FilePath>` 统一成可 yield* 的异步迭代器 */
async function* drain(
  result: Promise<FilePath[]> | AsyncGenerator<FilePath>,
): AsyncGenerator<FilePath> {
  const value = await result
  if (value && typeof (value as AsyncGenerator<FilePath>)[Symbol.asyncIterator] === "function") {
    yield* value as AsyncGenerator<FilePath>
  } else if (Array.isArray(value)) {
    yield* value
  }
}

/**
 * graph-pro 的复合 emitter：一个插件条目里按顺序执行
 * ① GraphLocal（每页局部图谱 JSON）② GraphGlobal（全局图谱单文件 JSON）。
 *
 * 两个子 emitter 共用同一份 YAML options：
 * - `options.graph.precomputeLocal` 与 `options.localGraph.depth` → GraphLocal
 * - `options.globalGraph.*`                     → GraphGlobal
 */
export default function graphProEmitter(
  options: GraphProOptions = {},
): QuartzEmitterPluginInstance {
  const local = GraphLocalEmitter({
    precomputeLocal: options.graph?.precomputeLocal ?? true,
    localDepth: resolveGraphViewConfig(options, "local").depth,
  })

  const globalOpts = resolveGraphViewConfig(options, "global")
  const global = GraphGlobalEmitter({
    // 与组件使用相同的 defaults → global 解析结果。
    ...globalOpts,
    enabled: globalOpts.enabled ?? true,
  })

  return {
    name: "GraphPro",

    async *emit(ctx: BuildCtx, content: ProcessedContent[], resources: StaticResources) {
      yield await emitGraphSelection(ctx, resolveGraphViewConfig(options, "global").coreMinLinks)
      // 局部图谱在前、全局图谱在后：与 v4 的 emitter 顺序保持一致
      yield* drain(local.emit(ctx, content, resources))
      yield* drain(global.emit(ctx, content, resources))
    },

    async *partialEmit(
      ctx: BuildCtx,
      content: ProcessedContent[],
      resources: StaticResources,
      changeEvents: ChangeEvent[],
    ) {
      yield await emitGraphSelection(ctx, resolveGraphViewConfig(options, "global").coreMinLinks)
      const localResult = local.partialEmit?.(ctx, content, resources, changeEvents)
      if (localResult) {
        yield* drain(localResult)
      }
      const globalResult = global.partialEmit?.(ctx, content, resources, changeEvents)
      if (globalResult) {
        yield* drain(globalResult)
      }
    },
  }
}
