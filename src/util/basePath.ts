/**
 * 从 baseUrl 提取子路径（与 explorer-pro / v4 Graph.tsx 同一实现）。
 *
 * 约定：**不带前导斜杠**（`"localhost/demo-region"` → `"demo-region"`）。
 * 运行时拼产物 URL 时统一按 `/${basePath}/graph/...` 使用，因此这里与
 * `graph.inline.ts` 里读 `data-basepath` 时的裁剪保持一致。
 */
export function getBasePath(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  // 如果已经是完整 URL（含协议），直接解析提取 pathname
  if (baseUrl.includes("://")) {
    try {
      const url = new URL(baseUrl);
      return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "");
    } catch {
      return "";
    }
  }
  // 不含协议但含 /（如 "localhost/demo-region"），补全 https:// 后用 URL 解析
  if (baseUrl.includes("/")) {
    try {
      const url = new URL(`https://${baseUrl}`);
      return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "");
    } catch {
      // 解析失败，fall through
    }
  }
  // 否则作为纯路径返回（去掉开头和结尾的 /）
  return baseUrl.replace(/^\//, "").replace(/\/$/, "");
}
