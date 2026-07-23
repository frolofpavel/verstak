export class IdempotencyCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>()
  constructor(private readonly ttlMs = 10 * 60_000, private readonly maxSize = 1_000) {}
  get(id: string): T | undefined {
    const hit = this.values.get(id)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) { this.values.delete(id); return undefined }
    return hit.value
  }
  set(id: string, value: T): void {
    this.values.set(id, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.values.size > this.maxSize) this.values.delete(this.values.keys().next().value!)
  }
}
