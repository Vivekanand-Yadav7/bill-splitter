import { describe, expect, it } from 'vitest'
import { splitCents } from './split'

describe('splitCents', () => {
  it('splits 1000 cents among 3 members into 334, 333, 333', () => {
    const result = splitCents(1000, 3)
    expect(result).toEqual([334, 333, 333])
  })

  it('handles total smaller than n', () => {
    expect(splitCents(2, 5)).toEqual([1, 1, 0, 0, 0])
    expect(splitCents(1, 3)).toEqual([1, 0, 0])
  })

  it('handles n = 1', () => {
    expect(splitCents(4999, 1)).toEqual([4999])
    expect(splitCents(100, 1)).toEqual([100])
    expect(splitCents(0, 1)).toEqual([0])
  })

  it('splits even amounts equally', () => {
    expect(splitCents(3000, 3)).toEqual([1000, 1000, 1000])
  })

  it('ensures the sum of shares always equals the total', () => {
    const total = 100001
    const n = 7
    const shares = splitCents(total, n)
    const sum = shares.reduce((acc, curr) => acc + curr, 0)
    expect(sum).toBe(total)
    expect(shares.length).toBe(n)
  })

  it('throws an error for non-positive or non-integer member counts', () => {
    expect(() => splitCents(100, 0)).toThrow('Member count must be a positive integer')
    expect(() => splitCents(100, -2)).toThrow('Member count must be a positive integer')
    expect(() => splitCents(100, 2.5)).toThrow('Member count must be a positive integer')
  })

  it('throws an error for negative or non-integer total cents', () => {
    expect(() => splitCents(-100, 3)).toThrow('Total cents must be a non-negative integer')
    expect(() => splitCents(10.5, 3)).toThrow('Total cents must be a non-negative integer')
  })
})
