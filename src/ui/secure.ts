// Tela sensível (senha, chave de recuperação, chaves de API): FLAG_SECURE enquanto ela estiver em
// foco — sem screenshot, gravação de tela nem prévia nos recentes (modules/secure-screen).
import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { holdSecureScreen } from '../../modules/secure-screen'

export function useSecureScreen(): void {
  useFocusEffect(useCallback(() => holdSecureScreen(), []))
}
