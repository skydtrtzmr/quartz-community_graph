import type {
  BuildCtx,
  ChangeEvent,
  FilePath,
  ProcessedContent,
  QuartzEmitterPluginInstance,
  StaticResources,
} from "@quartz-community/types"
import { GraphLocalEmitter } from "./graphLocal"
import { GraphGlobalEmitter } from "./graphGlobal"
import type { GraphProOptions } from "../options"

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
 * - `options.graph.{precomputeLocal,localDepth}` → GraphLocal
 * - `options.globalGraph.*`                     → GraphGlobal
 */
export default function graphProEmitter(
  options: GraphProOptions = {},
): QuartzEmitterPluginInstance {
  const local = GraphLocalEmitter({
    precomputeLocal: options.graph?.precomputeLocal ?? true,
    localDepth: options.graph?.localDepth ?? 1,
  })

  const globalOpts = options.globalGraph ?? {}
  const global = GraphGlobalEmitter({
    // 显式排除掉纯组件侧字段不必要，GraphGlobal 只读取自己认识的键
    ...globalOpts,
    enabled: globalOpts.enabled ?? true,
  })

  return {
    name: "GraphPro",

    async *emit(ctx: BuildCtx, content: ProcessedContent[], resources: StaticResources) {
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
