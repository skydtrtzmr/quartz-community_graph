export interface ExpansionControlItem {
  id: string;
  label: string;
  path: string;
  color: string;
  loaded: number;
  total: number;
  size: number;
}

/** DOM controls stay outside Pixi and never join the simulation. */
export function createExpansionControls(onLoad: (id: string) => void, onHighlight: (id: string | null) => void) {
  const element = document.createElement("section");
  element.className = "graph-expansion-controls";
  element.setAttribute("aria-label", "图谱分批加载");
  let selected: string | undefined;
  let items: ExpansionControlItem[] = [];
  let visible = 0;
  let initialLimit = 0;
  element.addEventListener("pointerleave", () => onHighlight(null));

  const el = (tag: string, cls: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function render() {
    const focused = element.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.controlKey : undefined;
    element.replaceChildren();
    element.hidden = items.length === 0;
    if (!items.length) return;
    if (!items.some(item => item.id === selected)) selected = items[0].id;
    const current = items.find(item => item.id === selected)!;
    const heading = el("div", "graph-expansion-heading");
    heading.append(el("span", "", "继续展开"), el("span", "graph-expansion-muted", `图中 ${visible} 个节点 · 首屏 ${initialLimit}`));
    const chips = el("div", "graph-expansion-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "选择要继续展开的分类");
    for (const item of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "graph-expansion-chip";
      chip.dataset.expansionParent = item.id;
      chip.dataset.controlKey = item.id;
      chip.setAttribute("aria-pressed", String(item.id === selected));
      chip.title = item.path;
      const swatch = el("span", "graph-expansion-swatch");
      swatch.style.backgroundColor = item.color;
      chip.append(swatch, el("span", "graph-expansion-name", item.label),
        el("span", "graph-expansion-progress", `${item.loaded}/${item.total}`));
      chip.addEventListener("click", () => { selected = item.id; render(); onHighlight(item.id); });
      chip.addEventListener("pointerenter", () => onHighlight(item.id));
      chip.addEventListener("pointerleave", () => onHighlight(selected ?? null));
      chip.addEventListener("focus", () => onHighlight(item.id));
      chips.append(chip);
    }
    const remaining = current.total - current.loaded;
    const row = el("div", "graph-expansion-action");
    const message = el("span", "graph-expansion-muted", remaining === 0 ? "已全部显示"
      : `${current.path} · 还有 ${remaining} 项`);
    message.setAttribute("role", "status");
    const load = document.createElement("button");
    load.type = "button";
    load.className = "graph-expansion-load";
    load.dataset.controlKey = "load";
    load.dataset.expansionParent = current.id;
    load.disabled = remaining === 0;
    load.textContent = remaining === 0 ? "已全部显示"
      : `${current.label} · 再加载 ${Math.min(current.size, remaining)} 项`;
    load.addEventListener("click", () => onLoad(current.id));
    row.append(message, load);
    element.append(heading, chips, row);
    if (focused) {
      const target = Array.from(element.querySelectorAll<HTMLElement>("[data-control-key]"))
        .find(node => node.dataset.controlKey === focused);
      target?.focus({ preventScroll: true });
    }
  }
  return {
    element,
    update(next: ExpansionControlItem[], count: number, limit: number) {
      items = next; visible = count; initialLimit = limit; render();
    },
    select(id: string) { selected = id; },
  };
}
