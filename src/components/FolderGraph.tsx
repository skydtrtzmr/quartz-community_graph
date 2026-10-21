import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types"
import Graph, { type GraphOptions } from "./Graph"
import { DEFAULT_GLOBAL_GRAPH_CFG } from "../options"

/** 系统目录：这些「目录页」不展示文件夹图谱 */
const SYSTEM_FOLDERS = ["_dimensions", "tags"]

/**
 * 文件夹页正文的局部图谱。
 *
 * 与侧栏的 `Graph` 是**同一套渲染**（标题 + 图谱容器 + 放大按钮），差别只在：
 * - 只在**文件夹页**渲染（slug 以 `/index` 结尾，且排除系统目录），其它页型返回 null
 * - 挂在 `layout` 的 `beforeBody` → 出现在**正文里**（而不是右栏）
 *
 * 数据来源：graphFolder 构建目录成员集合及其直接关联，不使用文件局部图谱的 BFS 深度。
 * 暂沿用 graph/local 的产物地址，由 view: folder 区分协议，便于已有站点迁移。
 */
export default ((userOpts?: Partial<GraphOptions>) => {
  const globalLayout = { ...DEFAULT_GLOBAL_GRAPH_CFG, ...userOpts?.globalGraph }
  // 分区和全局大区都可能互不相连，复用全局的力布局配置。
  // 仅拷贝力参数：depth、核心筛选与聚合规则仍使用文件夹自己的数据路径。
  const inner = Graph({
    ...userOpts,
    localGraph: {
      ...userOpts?.localGraph,
      repelForce: globalLayout.repelForce as number,
      centerForce: globalLayout.centerForce as number,
      linkDistance: userOpts?.folderGraph?.linkDistance ?? globalLayout.linkDistance as number,
      enableRadial: globalLayout.enableRadial as boolean,
    },
  }, "folder")
  const FolderGraph: QuartzComponent = (props: QuartzComponentProps) => {
    const slug = (props.fileData.slug ?? "") as string
    // 与 folder-page 同一套匹配口径：目录页 slug 以 `/index` 结尾
    if (!slug.endsWith("/index")) return null
    const folder = slug.slice(0, -"/index".length)
    if (folder.length === 0) return null
    if (SYSTEM_FOLDERS.some((prefix) => folder === prefix || folder.startsWith(`${prefix}/`))) {
      return null
    }
    return inner(props)
  }
  FolderGraph.css = inner.css
  ;(FolderGraph as typeof FolderGraph & { afterPageIntroduction?: boolean }).afterPageIntroduction = true
  return FolderGraph
}) satisfies QuartzComponentConstructor<Partial<GraphOptions>>
