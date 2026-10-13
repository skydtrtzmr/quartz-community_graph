/** Per-render cache: construction never computes hidden branches. */
export function createOnDemandCache<K, V>(compute: (key: K) => V) {
  const values = new Map<K, V>()
  return {
    get size() { return values.size },
    get(key: K): V {
      if (!values.has(key)) values.set(key, compute(key))
      return values.get(key)!
    },
  }
}
