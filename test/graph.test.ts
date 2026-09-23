import { describe, expect, it } from "vitest";
import Graph from "../src/components/Graph";
import GlobalGraphOverlay from "../src/components/GlobalGraphOverlay";

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
});
