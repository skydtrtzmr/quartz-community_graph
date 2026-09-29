import { describe, expect, it } from "vitest"
import { showOriginalCenterLink } from "../src/util/aggregatedLinks"

describe("aggregated child links", () => {
  const children = new Set(["child", "other-child"])

  it("hides either direction of the center-to-child link when disabled", () => {
    expect(showOriginalCenterLink("center", "child", "center", children, false)).toBe(false)
    expect(showOriginalCenterLink("child", "center", "center", children, false)).toBe(false)
    expect(showOriginalCenterLink("child", "other-child", "center", children, false)).toBe(true)
    expect(showOriginalCenterLink("center", "unrelated", "center", children, false)).toBe(true)
  })

  it("keeps the original link when enabled", () => {
    expect(showOriginalCenterLink("center", "child", "center", children, true)).toBe(true)
  })
})
