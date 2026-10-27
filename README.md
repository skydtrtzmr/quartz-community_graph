# @quartz-community/graph

The Graph View component for Quartz - visualize your digital garden as an interactive network graph.

## 共享聚合规则

图谱只在初始化时准备首屏分组。展开大区、维度聚合或主体文件后，才计算该节点的下一层和相关边；收起再展开复用当前图谱实例内的结果，切换分类配置后重新计算。文件页局部图谱的中心邻居属于首屏，仍在初始化时准备。

`graphGlobal.json` 的 `expansionMode: "on-demand"` 表示只预计算首屏大区，保留原始节点、边和邻接表，不预生成隐藏主体的邻居聚合。各类图谱目前仍加载完整数据 JSON，按需计算不等于分片下载；页面切换后会创建新的计算缓存。

`graph/selection.json` 提供业务域真实文件连接数。`coreMinLinks` 在全局 `configuration.graph.defaults` 设置，由 `configuration.graph.folder/dimension/global` 分别覆盖。低于门槛的文件仍可作为合格主体的直接邻居出现，列表及分类总数保留全量数据。全局构建与渲染使用同一解析结果。

全局图谱：首屏仍为核心文件夹分区；分区内的核心集合按 `aggregation.json.resolved[目录]`
取前 N 项逐级聚合。`configuration.graph.global.coreAggregationMaxLevels` 为正整数，默认 2，
不计首屏文件夹层；在分组前截取，即使前两项缺值也不会补用第三项。
此选项仅影响全局图谱。字段候选来自共享产物；运行时按右上角目录聚合面板保存的顺序选择前 N 级，未设置时使用产物默认顺序。全局图谱按文件夹大区分别取配置，局部图谱和文件夹页图谱按当前目录取配置；面板调整后当前图谱立即重绘。
实际核心节点展开后，其非核心邻居只按共享 `root` 的文件夹层级分组，
不再细分字段（只有一个邻居文件夹也保留该组，仍遵循共享的最小分组阈值）。
核心间真实边在两端可见时恢复，不生成重复核心或代理边。局部/文件夹/维度图谱规则不变。

配置了 `configuration.aggregation` 时，侧栏局部图及放大局部图读取
`static/aggregation.json`，以当前页面为中心，合并入链、出链邻居后分组。
规则值只来自该产物，graph-pro 不解析目录继承规则。
全局图谱的构建期预计算及运行时展开也使用该规则；仅核心节点建立聚合，
核心之间保留原始关系，大区仍由 regionRules 控制。每个中心独立记录成员归属。

首层按 root 目录分组，展开后使用该目录的 resolved 规则链；只有一个目录时
直接执行其后续规则。目录链不会为空：空数组在 aggregation-pro 归一化时即视为
未配置并逐层向上继承，所以不存在「显式停止聚合」这一态。同一目录分支当前层
只要有一类达到 minGroupSize，所有类别统一显示聚合节点（含单成员类别）；全部
未达阈值则尝试下一条规则，最终整体散开。首层的小目录仍按目录人数决定是否折叠。
字段数组取首个非空值，部分缺值显示“未分类”，全部缺值跳过当前规则。
日期只读取指定字段，以 UTC 年/月/季度分组。
展开时聚合节点固定在点击位置，仍可拖动；收起后明确释放固定位置。
关闭双击画布缩放，保留滚轮缩放及节点导航。
新增子节点沿“上一级父节点→当前聚合”的方向在向外 120° 扇形内初始化，
人数较多时适度增加半径；已可见的共享节点不移动。仅调整初始位置，
不施加持续方向约束，并降低布局重启力度以减少展开时的位置跳动。

本阶段不增加虚拟页识别或特殊过滤。未配置
共享聚合的业务域也沿用旧逻辑。共享 JSON 加载失败会提示错误，不静默回退。
插件代码或配置更新后先执行插件 build，再对站点执行一次 `--reset` 构建。

`options.localGraph.showAggregatedNodeLinks` 和
`options.globalGraph.showAggregatedNodeLinks`（默认 false）控制聚合展开后，
是否显示文件与原中心的真实连线。设为 false 时仍保留聚合父子连线及其他关系；
多级展开中的“原中心”一直指最初的页面/核心节点，而非中间聚合节点。

## 文件夹页图谱布局

文件夹图谱由 `emitters/graphFolder.ts` 构建，主体是目录子树内的真实内容文件。
第一阶段保留成员间关系以及成员的直接入链、出链、标签，不继续递归遍历外部邻居；
不再使用文件页的 `localGraph.depth` 或人工目录中心边。正文不写入文件夹产物，
分类字段保留，以支持右上角动态分类。直接关联目前仍随基础 JSON 一起加载，分块按需获取待后续阶段实现。

暂沿用 `graph/local/**` 地址，JSON 以 `view: "folder"` 标明集合语义；升级后应完整重建业务域，
以替换旧 BFS 产物和页面脚本。未重建的其他业务域仍使用原有资源。
控制台 `[GraphTiming]` 和图谱容器的 `data-graph-timings` 记录各初始化阶段毫秒数，
同时记录原始节点数与首屏可见节点数。阶段时间包含主线程等待；首次 render 调用完成不等于 GPU 已完成呈现。

后续待办：文件夹页的核心字段层数统一设计另行实施；`aggregation.json` 的字段对象
改为字符串数组也单独迁移（需版本升级及各消费插件同步）。当前对象格式保留是兼容选择。

`FolderGraph` 的力参数由 `configuration.graph.folder` 独立决定；未显式写出的值只取内置默认值或 `configuration.graph.defaults`，不继承其他视图。全部图谱参数集中到全局配置，插件条目不再填写 options。
缺少版本标记的旧 YAML 仍保留文件夹继承全局力参数、其他显示项继承局部图的兼容行为。
成员范围来自文件夹集合 JSON，聚合关系来自共享聚合规则。
径向力的目标半径随画布尺寸计算，并在展开、收起全过程持续启用；不固定分区坐标。
普通内容页的 `localGraph` 参数独立生效。

力计算集中在 `components/scripts/graphSimulation.ts`；数值回归使用实际碰撞与 D3 力，
覆盖首屏、连续 8 次展开/收起以及同一画布下文件夹/全局布局的一致性。

## Features

- 🕸️ **Interactive Network Graph** - Visualize connections between your pages
- 🎨 **Local & Global Views** - See connections to current page or explore the entire graph
- ⚡ **Smooth Animations** - Built with D3 force simulation and PixiJS rendering
- 🏷️ **Tag Support** - Visualize tags as nodes in the graph
- 🖱️ **Interactive Controls** - Drag, zoom, and pan around the graph
- 💾 **Visited Tracking** - Highlights pages you've already visited
- ⌨️ **Keyboard Shortcuts** - Press `Ctrl/Cmd + G` to toggle the global graph

## Installation

```bash
npx quartz plugin add github:quartz-community/graph
```

## Usage

```yaml title="quartz.config.yaml"
plugins:
  - source: github:quartz-community/graph
    enabled: true
    layout:
      position: right
      priority: 10
```

For advanced use cases, you can override in TypeScript:

```ts title="quartz.ts (override)"
import * as ExternalPlugin from "./.quartz/plugins";

ExternalPlugin.Graph({
  localGraph: {
    drag: true,
    zoom: true,
    depth: 1,
  },
  globalGraph: {
    drag: true,
    zoom: true,
    depth: -1,
  },
});
```

## Configuration Options

```typescript
interface D3Config {
  /** Enable node dragging */
  drag: boolean;
  /** Enable zooming */
  zoom: boolean;
  /** Depth of connections to show (-1 for all) */
  depth: number;
  /** Graph scale factor */
  scale: number;
  /** Force repelling strength */
  repelForce: number;
  /** Center force strength */
  centerForce: number;
  /** Distance between linked nodes */
  linkDistance: number;
  /** Label font size */
  fontSize: number;
  /** Opacity multiplier */
  opacityScale: number;
  /** Tags to exclude */
  removeTags: string[];
  /** Show tags as nodes */
  showTags: boolean;
  /** Dim non-hovered nodes on hover */
  focusOnHover?: boolean;
  /** Enable radial layout */
  enableRadial?: boolean;
}

// 加载器传给插件的内部参数；YAML 只配置 configuration.graph。
interface GraphOptions {
  graphDefaults?: Partial<D3Config>; // Common interaction defaults
  localGraph?: Partial<D3Config>; // File page
  folderGraph?: Partial<D3Config>; // Folder collection
  dimensionGraph?: Partial<D3Config>; // Dimension value collection
  globalGraph?: Partial<D3Config>; // Global collection
}
```

## Default Behavior

### Local Graph

By default, the local graph:

- Shows 1 level of connections (direct links only)
- Dragging enabled
- Zoom enabled
- Tags shown as nodes
- 250px height
- Displays on the right side of pages

### Global Graph

By default, the global graph:

- Shows all connections (depth: -1)
- Opens in fullscreen modal when clicking the graph icon
- Keyboard shortcut: `Ctrl/Cmd + G`
- Focus on hover enabled (dims non-connected nodes)
- Radial layout enabled
- Click outside or press Escape to close

## How It Works

The Graph component fetches connection data from `/static/contentIndex.json` (generated by the ContentIndex emitter) and renders it using:

- **D3** for physics simulation (force-directed layout)
- **PixiJS** for high-performance WebGL rendering

External libraries are loaded from CDN when the graph is first rendered.

> [!info]
> Graph View requires the `ContentIndex` emitter plugin to be present in your Quartz configuration.

## Development

### 分批展开与整体上限

配置只保留一套规则。批次默认值放在全局 `configuration.graph.defaults`，四种视图可以各自覆盖。插件中的 `graphDefaults` 是加载器注入的内部选项，不直接写入 YAML：

```yaml
configuration:
  graph:
    defaults:
      maxVisibleNodes: 500
      expandBatchSize: 20
      loadBatchSize: 100
      coreMinLinks: 0
    precomputeLocal: true
    local: {maxVisibleNodes: 500, depth: 2}
    folder: {maxVisibleNodes: 500, linkDistance: 125}
    dimension: {maxVisibleNodes: 500, linkDistance: 72}
    global: {maxVisibleNodes: 500, linkDistance: 150}
plugins:
  - source: ../plugins-local/graph-pro
    enabled: true
```

- `maxVisibleNodes` 沿用已有配置名，现表示**首屏节点预算**，包含文件、聚合、大区。首屏在创建 Pixi 对象和力导向模拟前截断；用户后续主动展开、加载更多可以超过这个数量。
- `expandBatchSize` 控制每个聚合/大区自己的展开批次；各分类进度独立。
- `loadBatchSize` 控制普通节点及首屏溢出队列的后续批次。
- 底部分类条显示分类名和进度。选择分类后，唯一的加载按钮明确标注目标分类。完整路径在提示中显示。
- 无聚合时通过“当前图谱”继续加载，每次 `loadBatchSize` 项；有聚合时按选中的分类独立加载，每次 `expandBatchSize` 项。仅在该队列全部加载完成时禁用按钮。
- 首屏预算不是绝对硬上限；连续主动加载会增加总可见数量。当前没有另外设置绝对硬上限。

项目内演示：`node scripts/create-graph-pagination-domain.mjs [每组成员数=200]`，生成 `graph-demo` 业务域的 `grouped` 和 `plain` 两个等量目录。演示域首屏预算 40，聚合每批 5 项，无聚合后续每批 10 项，便于观察超过首屏预算后的加载与收起行为。

This is a first-party Quartz community plugin. It serves as both:

1. A production-ready Graph View component
2. A reference implementation for building Quartz community plugins

To build locally:

```bash
npm install
npm run build
```

The `prepare` script automatically builds during installation.

## Documentation

See the [Quartz documentation](https://quartz.jzhao.xyz/features/graph%20view) for more information.

## License

MIT
