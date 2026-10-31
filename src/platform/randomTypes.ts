export interface RandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
  randomUUID(): string
}
