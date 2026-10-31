// Nome do aparelho mostrado na lista de dispositivos da conta (§5.4: `name`, editável).
/** Nome padrão: o nome do aparelho (Configurações) ou o modelo; emulador ganha um nome legível. */
export function defaultDeviceName(
  deviceName: string | null | undefined,
  model: string | null | undefined,
  platform: 'android' | 'ios'
): string {
  const raw = (deviceName?.trim() || model?.trim() || '').slice(0, 64)
  if (!raw) return platform === 'ios' ? 'iPhone' : 'Celular Android'
  if (/^sdk_|gphone|emulator|^generic/i.test(raw))
    return platform === 'ios' ? 'Simulador iOS' : 'Emulador Android'
  return raw
}
