/**
 * Splits a total amount in cents among `n` members.
 * - Base share: Math.floor(total / n)
 * - Remainder: total % n
 * - The first `remainder` members receive (base + 1) cents, ensuring:
 *   1. The sum of all shares strictly equals `total`.
 *   2. The extra cents are allocated in member order.
 */
export function splitCents(total: number, n: number): number[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Member count must be a positive integer')
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('Total cents must be a non-negative integer')
  }

  const base = Math.floor(total / n)
  const remainder = total % n

  const shares: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    shares[i] = i < remainder ? base + 1 : base
  }

  return shares
}
