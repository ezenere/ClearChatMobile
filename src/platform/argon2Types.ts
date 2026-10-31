/** Argon2id v1.3 (0x13) bruto: bytes da senha e do salt → `hashLength` bytes. */
export interface Argon2Params {
  password: Uint8Array
  salt: Uint8Array
  iterations: number
  /** KiB */
  memorySize: number
  parallelism: number
  hashLength: number
}
export type Argon2Backend = (p: Argon2Params) => Promise<Uint8Array>
