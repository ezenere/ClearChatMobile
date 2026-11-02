// Ligações React da voz: estado da chamada e do ditado (useSyncExternalStore sobre os controllers).
import { useSyncExternalStore } from 'react'
import { voice } from './native'
import type { CallView } from './call'
import type { DictationView } from './dictation'

export function useCallView(): CallView {
  return useSyncExternalStore(voice.call.subscribe, voice.call.getView)
}

export function useDictationView(): DictationView {
  return useSyncExternalStore(voice.dictation.subscribe, voice.dictation.getView)
}

export { voice }
