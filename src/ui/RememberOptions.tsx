// "Lembrar neste dispositivo" (DEK no Keystore/Keychain) + "Exigir biometria" (só se o aparelho tiver
// biometria cadastrada) — §3.13.
import { Card, ToggleRow } from './Card'

export function RememberOptions({
  remember,
  setRemember,
  biometric,
  setBiometric,
  canUseBiometrics,
  disabled
}: {
  remember: boolean
  setRemember: (v: boolean) => void
  biometric: boolean
  setBiometric: (v: boolean) => void
  canUseBiometrics: boolean
  disabled?: boolean
}) {
  return (
    <Card>
      <ToggleRow
        testID="remember-toggle"
        title="Lembrar neste dispositivo"
        subtitle={
          remember
            ? 'A chave fica no armazenamento seguro do aparelho: abre direto na próxima vez.'
            : 'Pede a senha toda vez que o app abrir.'
        }
        value={remember}
        onChange={setRemember}
        disabled={disabled}
      />
      {remember && canUseBiometrics ? (
        <ToggleRow
          testID="biometric-toggle"
          title="Exigir biometria para abrir"
          subtitle="Digital ou rosto antes de abrir seus dados."
          value={biometric}
          onChange={setBiometric}
          disabled={disabled}
        />
      ) : null}
    </Card>
  )
}
