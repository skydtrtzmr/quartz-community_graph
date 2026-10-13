import { expect, it, vi } from "vitest"
import { createOnDemandCache } from "../src/components/scripts/onDemandCache"

it("does not prepare hidden branches, computes only the opened branch and reuses it on reopen", () => {
  const compute = vi.fn((id: string) => ({ members: [id] }))
  const branches = createOnDemandCache(compute)
  expect(branches.size).toBe(0)
  expect(compute).not.toHaveBeenCalled()
  const first = branches.get("设备/A")
  expect(compute.mock.calls).toEqual([["设备/A"]])
  expect(branches.get("设备/A")).toBe(first)
  branches.get("设备/B")
  expect(compute.mock.calls).toEqual([["设备/A"], ["设备/B"]])
  expect(branches.size).toBe(2)
})
