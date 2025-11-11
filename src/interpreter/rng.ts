/**
 * Seeded pseudo-random number generator using xorshift32 algorithm.
 * Provides deterministic random sequences for testing.
 */
export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    // Ensure seed is a non-zero 32-bit integer
    this.state = seed === 0 ? 1 : seed >>> 0;
  }

  /**
   * Generate next random number in [0, 1) range
   */
  next(): number {
    // xorshift32 algorithm
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0; // Keep as unsigned 32-bit int
    // Convert to [0, 1) range
    return this.state / 0x100000000;
  }
}
