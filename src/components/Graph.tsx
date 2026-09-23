import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import { classNames } from "../util/lang";
import { i18n } from "../i18n";
import { getBasePath } from "../util/basePath";
import style from "./styles/graph.scss";
import type { AggregationRule, CoreNodeFilterConfig } from "../util/aggregation";

export interface D3Config {
  drag: boolean;
  zoom: boolean;
  depth: number;
  scale: number;
  repelForce: number;
  centerForce: number;
  linkDistance: number;
  fontSize: number;
  opacityScale: number;
  removeTags: string[];
  showTags: boolean;
  focusOnHover?: boolean;
  enableRadial?: boolean;
  // ===== 以下为 v4 graph3 交互层读取的扩展键（预计算 / 聚合 / 大区 / 徽标）=====
  /** 是否显示连线箭头 */
  showArrows?: boolean;
  /** 是否在节点上显示徽标 */
  showBadge?: boolean;
  /** 是否过滤孤儿节点 */
  filterOrphans?: boolean;
  /** 首屏是否折叠（全局图谱） */
  startCollapsed?: boolean;
  /** 节点中心数字显示下限（仅全局图谱核心节点） */
  countLabelMin?: number;
  /** 节点中心数字显示上限，超出显示为 `${上限}+` */
  countLabelMaxDisplay?: number;
  /** 边缘节点聚合规则（按字段把叶子分组为聚合节点） */
  aggregation?: AggregationRule[];
  /** 展开聚合后保留子节点与原中心的真实连线，默认 true。 */
  showAggregatedNodeLinks?: boolean;
  /** 核心节点过滤规则（满足任一规则即为核心节点） */
  coreNodeFilter?: CoreNodeFilterConfig;
  /** 核心节点数量硬上限（未配置 regionRules 时生效） */
  coreNodeLimit?: number;
  /** 大区聚合规则（配置后首屏显示大区节点，点击展开） */
  regionRules?: AggregationRule[];
  /** 展开大区时是否连带展开内部核心节点 */
  expandCoresOnRegionOpen?: boolean;
  /** 首屏是否过滤非核心节点（配置了 coreNodeFilter 时生效） */
  filterNonCoreNodes?: boolean;
  /** 按 frontmatter 字段为节点分配分类颜色，例如 `type` */
  colorBy?: string;
}

export interface GraphOptions {
  /** 构建期预计算开关（由 emitter 消费；localDepth 同时决定运行时的 usePrecomputed 判定） */
  graph?: {
    precomputeLocal?: boolean;
    localDepth?: number;
  };
  localGraph?: Partial<D3Config>;
  globalGraph?: Partial<D3Config>;
}

const defaultOptions: GraphOptions = {
  graph: {
    precomputeLocal: true,
    localDepth: 1,
  },
  localGraph: {
    drag: true,
    zoom: true,
    depth: 1,
    scale: 1.1,
    repelForce: 0.5,
    centerForce: 0.3,
    linkDistance: 30,
    fontSize: 0.6,
    opacityScale: 1,
    showTags: true,
    removeTags: [],
    focusOnHover: false,
    enableRadial: false,
    showArrows: true,
    showBadge: false,
    filterOrphans: false,
    startCollapsed: false,
    countLabelMaxDisplay: 120,
  },
};

export default ((userOpts?: Partial<GraphOptions>) => {
  const Graph: QuartzComponent = ({ displayClass, cfg }: QuartzComponentProps) => {
    const localGraph = { ...defaultOptions.localGraph, ...userOpts?.localGraph };
    // 传给 inline 脚本用于拼预计算 JSON 路径
    const basePath = getBasePath(cfg.baseUrl);
    // 运行时判定 usePrecomputed = depth > 0 && depth <= precomputeDepth，
    // 必须与 emitter 的 options.graph.localDepth 保持一致
    const precomputeDepth = userOpts?.graph?.localDepth ?? localGraph.depth ?? 1;

    return (
      <div class={classNames(displayClass, "graph")}>
        <h3>{i18n(cfg.locale ?? "en-US").components.graph.title}</h3>
        <div class="graph-outer">
          <div
            class="graph-container"
            data-basepath={basePath}
            data-cfg={JSON.stringify(localGraph)}
            data-precompute-depth={String(precomputeDepth)}
            data-shared-aggregation={String((cfg as unknown as { aggregation?: unknown }).aggregation !== undefined)}
          ></div>
          <button class="global-graph-icon" aria-label="Expand Local Graph" title="放大局部图谱">
            <svg
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              xmlnsXlink="http://www.w3.org/1999/xlink"
              x="0px"
              y="0px"
              viewBox="0 0 55 55"
              fill="currentColor"
              xmlSpace="preserve"
            >
              <path
                d="M49,0c-3.309,0-6,2.691-6,6c0,1.035,0.263,2.009,0.726,2.86l-9.829,9.829C32.542,17.634,30.846,17,29,17
                s-3.542,0.634-4.898,1.688l-7.669-7.669C16.785,10.424,17,9.74,17,9c0-2.206-1.794-4-4-4S9,6.794,9,9s1.794,4,4,4
                c0.74,0,1.424-0.215,2.019-0.567l7.669,7.669C21.634,21.458,21,23.154,21,25s0.634,3.542,1.688,4.897L10.024,42.562
                C8.958,41.595,7.549,41,6,41c-3.309,0-6,2.691-6,6s2.691,6,6,6s6-2.691,6-6c0-1.035-0.263-2.009-0.726-2.86l12.829-12.829
                c1.106,0.86,2.44,1.436,3.898,1.619v10.16c-2.833,0.478-5,2.942-5,5.91c0,3.309,2.691,6,6,6s6-2.691,6-6c0-2.967-2.167-5.431-5-5.91
                v-10.16c1.458-0.183,2.792-0.759,3.898-1.619l7.669,7.669C41.215,39.576,41,40.26,41,41c0,2.206,1.794,4,4,4s4-1.794,4-4
                s-1.794-4-4-4c-0.74,0-1.424,0.215-2.019,0.567l-7.669-7.669C36.366,28.542,37,26.846,37,25s-0.634-3.542-1.688-4.897l9.665-9.665
                C46.042,11.405,47.451,12,49,12c3.309,0,6-2.691,6-6S52.309,0,49,0z M11,9c0-1.103,0.897-2,2-2s2,0.897,2,2s-0.897,2-2,2
                S11,10.103,11,9z M6,51c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S8.206,51,6,51z M33,49c0,2.206-1.794,4-4,4s-4-1.794-4-4
                s1.794-4,4-4S33,46.794,33,49z M29,31c-3.309,0-6-2.691-6-6s2.691-6,6-6s6,2.691,6,6S32.309,31,29,31z M47,41c0,1.103-0.897,2-2,2
                s-2-0.897-2-2s0.897-2,2-2S47,39.897,47,41z M49,10c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S51.206,10,49,10z"
              />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  Graph.css = style;

  return Graph;
}) satisfies QuartzComponentConstructor;
