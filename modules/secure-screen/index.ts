// FLAG_SECURE nas telas sensíveis (senha, desbloqueio, chave de recuperação, chaves de API): sem
// screenshot, sem gravação de tela e sem prévia na tela de recentes. Contagem de telas abertas: o
// flag só sai quando a última tela sensível fecha. Sem o módulo nativo (iOS ainda, testes) não faz
// nada — no iOS a proteção equivalente fica para a fase 6.
import { requireOptionalNativeModule } from 'expo'

interface NativeSecureScreen {
  setSecure(on: boolean): boolean
}

let native: NativeSecureScreen | null | undefined
const load = (): NativeSecureScreen | null =>
  native === undefined
    ? (native = requireOptionalNativeModule<NativeSecureScreen>('ClearChatSecureScreen'))
    : native

let count = 0

/** Liga a proteção enquanto a tela estiver aberta; devolve a função que a solta. */
export function holdSecureScreen(): () => void {
  count++
  if (count === 1) load()?.setSecure(true)
  let released = false
  return () => {
    if (released) return
    released = true
    count = Math.max(0, count - 1)
    if (count === 0) load()?.setSecure(false)
  }
}
