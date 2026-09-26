/** 第二层局部聚合围绕自身均匀展开，避免每一层都沿同一外向扇区偏移。 */
export function expansionSeedAngle(
  outwardAngle: number,
  index: number,
  count: number,
  nestedLocal: boolean,
): number {
  if (count <= 1) return outwardAngle
  return nestedLocal
    ? outwardAngle + ((index + 0.5) / count - 0.5) * Math.PI * 2
    : outwardAngle + (index / (count - 1) - 0.5) * Math.PI * 2 / 3
}
