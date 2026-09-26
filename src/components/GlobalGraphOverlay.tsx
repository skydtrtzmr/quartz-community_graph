import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import { getBasePath } from "../util/basePath";
import { DEFAULT_GLOBAL_GRAPH_CFG } from "../options";
import type { GraphOptions } from "./Graph";
import { resolveGraphGrouping } from "../util/graphGrouping";
import style from "./styles/global-graph-overlay.scss";
// @ts-expect-error - inline script imported as string by esbuild loader
import script from "./scripts/graph.inline.ts";

/**
 * 全局图谱宿主（`GlobalGraphOverlay`）。
 *
 * ## 为什么单独成一个组件
 * 全局图谱（Ctrl/⌘+G 或右上角地球按钮）需要一个 `.global-graph-outer` 覆盖层容器。
 * 该容器过去寄生在 `Graph`（侧栏局部图谱）组件里，而侧栏组件在**文件夹页 / 维度页是被移除的**
 * （这些页 `layout.byPageType.*.positions.right = []`）→ 那两页右上角按钮点了没反应。
 *
 * 因此把覆盖层拆出来单独渲染，并用 `layout: { position: header, component: GlobalGraphOverlay }`
 * 放到 **header**——与阅读模式 / 深色模式按钮同级，任何页面类型都不会被清空。
 * 局部图谱是否显示与该组件无关：不想要侧栏图谱就清空 `positions.right`。
 *
 * ## 与局部图谱的关系
 * - 宿主只管覆盖层容器；容器上的 `data-cfg` 就是**全局**图谱配置
 * - 「放大局部图谱」按钮（`.global-graph-icon`）仍由 `Graph` 渲染，运行时向本容器取证（见 graph.inline.ts）
 * - DOM 只有一个覆盖层容器，不存在重复渲染
 *
 * ⚠️ inline 脚本挂在**本组件**上：它必须在不含局部图谱的页面（文件夹页/维度页）也执行。
 */
export default ((userOpts?: Partial<GraphOptions>) => {
  const GlobalGraphOverlay: QuartzComponent = ({ cfg }: QuartzComponentProps) => {
    const userGlobal = userOpts?.globalGraph;
    // 内部分组值从「主体文件夹白名单 + 站点聚合上下文」合成（与 graphGlobal emitter 同一套规则）
    const grouping = resolveGraphGrouping({
      folders: userGlobal?.folders,
      folderDepth: (cfg as unknown as { aggregation?: { root?: { depth?: number } } }).aggregation?.root
        ?.depth,
    });
    const globalGraph = { ...DEFAULT_GLOBAL_GRAPH_CFG, ...grouping, ...userGlobal };
    // 传给 inline 脚本用于拼预计算 JSON 路径（与 Graph 组件同一套规则）
    const basePath = getBasePath(cfg.baseUrl);
    // 运行时判定 usePrecomputed 需要；全局图谱 depth < 0 恒为预计算产物，这里与实际值保持一致
    const precomputeDepth = userOpts?.graph?.localDepth ?? 1;

    return (
      <div class="graph-overlay-host">
        {/* 右上角「全局图谱」按钮：与阅读模式一样**构建期渲染**，常驻不闪（图标用地球，描边风格，
            与侧栏实心节点网络图标区分）。点击等价 Ctrl/⌘+G，交互由 graph.inline.ts 绑定。 */}
        <button class="graph-toggle" type="button" aria-label="全局图谱" title="全局图谱（Ctrl/⌘+G）">
          <svg
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4.2" ry="9" />
            <path d="M3.4 9h17.2M3.4 15h17.2" />
          </svg>
        </button>
        <div class="global-graph-outer">
          <div
            class="global-graph-container"
            data-basepath={basePath}
            data-cfg={JSON.stringify(globalGraph)}
            data-global-cfg={JSON.stringify(globalGraph)}
            data-shared-aggregation={String((cfg as unknown as { aggregation?: unknown }).aggregation !== undefined)}
            data-precompute-depth={String(precomputeDepth)}
          ></div>
        </div>
      </div>
    );
  };

  GlobalGraphOverlay.css = style;
  GlobalGraphOverlay.afterDOMLoaded = script;

  return GlobalGraphOverlay;
}) satisfies QuartzComponentConstructor;
