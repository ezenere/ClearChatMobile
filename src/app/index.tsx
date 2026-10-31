// "/" decide a tela pela fase da conta. Também é para onde o Stack raiz volta quando uma fase
// fecha o grupo atual (ex.: desbloqueou → (auth) fica inacessível → aqui → /home).
import { Redirect } from 'expo-router'
import { useSession } from '@/account/react'

export default function Index() {
  const { phase } = useSession()
  if (phase === 'unlocked') return <Redirect href="/home" />
  if (phase === 'locked') return <Redirect href="/unlock" />
  if (phase === 'needs-setup') return <Redirect href="/setup" />
  return <Redirect href="/login" />
}
