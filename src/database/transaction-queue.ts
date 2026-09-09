/** Serializes complete operations on one transaction-owned client, including scope changes. */
export class TransactionQueue {
  private accepting = true
  private failed = false
  private failure: unknown
  private tail: Promise<void> = Promise.resolve()
  private pending = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  assertOpen(): void {
    if (!this.accepting) throw Object.assign(new Error('The workflow transaction is closed.'), { code: 'workflow_transaction_closed' })
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    const result = this.tail.then(() => {
      if (this.failed) throw this.failure
      return operation()
    })
    this.pending.add(result)
    this.tail = result.then(() => { this.pending.delete(result) }, error => {
      this.pending.delete(result)
      if (!this.failed) { this.failed = true; this.failure = error }
    })
    return result
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false
    const incomplete = this.pending.size > 0
    this.closing = (async () => {
      await this.tail
      if (this.failed) throw this.failure
      if (incomplete) throw Object.assign(new Error('Every workflow transaction operation must be awaited.'), { code: 'workflow_transaction_incomplete' })
    })()
    return this.closing
  }
}
