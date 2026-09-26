import { describe, expect, it } from "vitest"
import { expansionSeedAngle } from "../src/components/scripts/expansionLayout"

describe("aggregation expansion seeding", () => {
  it("retains the outward sector for first-level aggregation", () => {
    expect(expansionSeedAngle(0, 0, 3, false)).toBeCloseTo(-Math.PI / 3)
    expect(expansionSeedAngle(0, 2, 3, false)).toBeCloseTo(Math.PI / 3)
  })

  it("distributes nested local children around their parent without an upward bias", () => {
    const angles = [0, 1, 2, 3].map(index => expansionSeedAngle(-Math.PI / 2, index, 4, true))
    expect(angles.reduce((sum, angle) => sum + Math.cos(angle), 0)).toBeCloseTo(0)
    expect(angles.reduce((sum, angle) => sum + Math.sin(angle), 0)).toBeCloseTo(0)
  })
})
