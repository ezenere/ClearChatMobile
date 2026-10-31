// Substitui `./primitives` para os módulos de src/vendor/site/crypto (redirecionado pelo resolver do
// Metro e do Vitest — scripts/platformAliases.cjs). Reexporta as primitivas vendoradas (WebCrypto,
// atendido pelo shim de subtle.ts) e troca só deflateRaw/inflateRaw, que no site usam
// CompressionStream + Blob.stream() — inexistentes no Hermes — por fflate.
/* eslint-disable import/export -- de propósito: as exportações locais abaixo sombreiam as do `export *` (regra do ES) */
import * as vendored from '@vendor/site/crypto/primitives'
import { MAX_INFLATED_BYTES } from '@vendor/site/crypto/constants'
import type { Bytes } from '@vendor/site/crypto/encoding'
import { deflateRawSync, inflateRawSync } from './deflate'

export * from '@vendor/site/crypto/primitives'

/** DEFLATE cru (RFC 1951). */
export const deflateRaw: typeof vendored.deflateRaw = async (data) => deflateRawSync(data) as Bytes

export const inflateRaw: typeof vendored.inflateRaw = async (data, cap = MAX_INFLATED_BYTES) =>
  inflateRawSync(data, cap) as Bytes

/** Marca usada pelos testes/self-test para confirmar que o redirecionamento está ativo. */
export const PLATFORM_PRIMITIVES = true
