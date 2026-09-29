/** 聚合子节点展开时，是否保留它与原中心的真实连线。 */
export function showOriginalCenterLink(
  sourceId: string,
  targetId: string,
  centerId: string,
  childIds: ReadonlySet<string>,
  showAggregatedNodeLinks: boolean,
): boolean {
  return showAggregatedNodeLinks || !(
    (sourceId === centerId && childIds.has(targetId)) ||
    (targetId === centerId && childIds.has(sourceId))
  )
}
