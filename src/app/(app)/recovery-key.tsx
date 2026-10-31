// Nova chave de recuperação (§5.5): gerada no aparelho, mostrada uma vez e só enviada
// (PUT /keys/recovery com key_proof) depois da confirmação — até lá a antiga continua valendo.
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { account } from '@/account/native'
import { useAction, useSession } from '@/account/react'
import type { PendingRecoveryKey } from '@/account/service'
import { Banner, Spinner } from '@/ui/Card'
import { RecoveryKeyPanel } from '@/ui/RecoveryKeyPanel'
import { Hero, Screen, ScreenHeader } from '@/ui/Screen'
import { useToast } from '@/ui/Toast'

export default function NewRecoveryKey() {
  const s = useSession()
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState<PendingRecoveryKey | null>(null)
  const gen = useAction()
  const save = useAction()

  useEffect(() => {
    void gen.run(async () => setPending(await account.newRecoveryKey()))
    // gera uma vez ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Screen
      testID="screen-recovery-key"
      header={<ScreenHeader title="Chave de recuperação" onBack={() => router.back()} />}
    >
      <Hero
        title="Nova chave de recuperação"
        subtitle="Guarde a chave abaixo. Ao concluir, a chave anterior deixa de funcionar."
      />
      {gen.error ? <Banner tone="danger">{gen.error}</Banner> : null}
      {save.error ? <Banner tone="danger">{save.error}</Banner> : null}
      {pending ? (
        <RecoveryKeyPanel
          recoveryKey={pending.recoveryKey}
          email={s.account?.email ?? ''}
          instanceName={s.server.name ?? 'ClearChat'}
          serverUrl={s.server.url}
          confirmLabel="Guardei — trocar a chave"
          busy={save.busy}
          onConfirmed={() =>
            void save.run(async () => {
              await pending.commit()
              if (s.notice?.action === 'new-recovery-key') account.dismissNotice()
              toast('Nova chave de recuperação salva')
              router.back()
            })
          }
        />
      ) : gen.busy ? (
        <Spinner label="Gerando…" />
      ) : null}
    </Screen>
  )
}
