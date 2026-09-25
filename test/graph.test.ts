import { describe, expect, it } from "vitest";
import Graph from "../src/components/Graph";
import GlobalGraphOverlay from "../src/components/GlobalGraphOverlay";
import FolderGraph from "../src/components/FolderGraph";
import type { GraphOptions, D3Config } from "../src/components/Graph";
import type { QuartzComponentProps } from "@quartz-community/types";

function emittedConfig(node: unknown): Partial<D3Config> | undefined {
  if (Array.isArray(node)) return node.map(emittedConfig).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const props = node.props as Record<string, unknown>;
  if (typeof props["data-cfg"] === "string") return JSON.parse(props["data-cfg"]);
  return emittedConfig(props.children);
}

describe("Graph Component", () => {
  it("should create a Graph component with default options", () => {
    const component = Graph({});

    expect(component).toBeDefined();
    expect(typeof component).toBe("function");
  });

  it("should create a Graph component with custom options", () => {
    const component = Graph({
      localGraph: {
        depth: 2,
        drag: false,
        zoom: true,
      },
      globalGraph: {
        depth: -1,
        focusOnHover: true,
      },
    });

    expect(component).toBeDefined();
    expect(typeof component).toBe("function");
  });

  it("should export component with css property", () => {
    const component = Graph({});

    expect(component.css).toBeDefined();
    expect(typeof component.css).toBe("string");
  });

  it("局部图谱组件不再自带脚本（脚本随全局图谱宿主）", () => {
    const component = Graph({});

    expect(component.afterDOMLoaded).toBeUndefined();
  });

  it("全局图谱宿主带 css 与 afterDOMLoaded 脚本", () => {
    const overlay = GlobalGraphOverlay({});

    expect(overlay.css).toBeDefined();
    expect(typeof overlay.css).toBe("string");
    // 脚本必须挂在宿主上：文件夹页/维度页没有局部图谱组件，但也要能执行图谱脚本
    expect(overlay.afterDOMLoaded).toBeDefined();
    expect(typeof overlay.afterDOMLoaded).toBe("string");
  });

  it("文件夹画布复用全局力参数，仍读取目录局部 JSON 并保留自身聚合语义", () => {
    const options: GraphOptions = {
      graph: { localDepth: 1 },
      localGraph: { depth: 1, repelForce: 0.6, centerForce: 0.3, linkDistance: 70, enableRadial: false, showAggregatedNodeLinks: false },
      globalGraph: { depth: -1, repelForce: 1.5, centerForce: 0.4, linkDistance: 150, enableRadial: true, showAggregatedNodeLinks: true, coreNodeLimit: 50 },
    };
    const props = { fileData: { slug: "项目/index" }, cfg: { baseUrl: "127.0.0.1:9766/demo", locale: "zh-CN" } } as QuartzComponentProps;
    const folder = emittedConfig(FolderGraph(options)(props))!;
    const global = emittedConfig(GlobalGraphOverlay(options)(props))!;
    const local = emittedConfig(Graph(options)(props))!;
    for (const key of ["repelForce", "centerForce", "linkDistance", "enableRadial"] as const) {
      expect(folder[key]).toBe(global[key]);
    }
    expect(folder.depth).toBe(1);
    expect(folder.showAggregatedNodeLinks).toBe(false);
    expect(folder.coreNodeLimit).toBeUndefined();
    expect(local.enableRadial).toBe(false);
    expect(local.repelForce).toBe(0.6);
  });
});
