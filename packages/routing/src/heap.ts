/** Minimal binary min-heap keyed by a number. */
export class MinHeap<T> {
  private keys: number[] = [];
  private values: T[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: T): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, T] | undefined {
    if (this.keys.length === 0) return undefined;
    const top: [number, T] = [this.keys[0]!, this.values[0]!];
    const lastKey = this.keys.pop()!;
    const lastVal = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
  }
}
