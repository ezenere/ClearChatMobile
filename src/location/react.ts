// Ligações React das preferências de localização deste aparelho.
import { useSyncExternalStore } from 'react'
import { locationPrefs } from './native'
import type { LocationSettings } from './settings'

export function useLocationPrefs(): LocationSettings {
  return useSyncExternalStore(locationPrefs.subscribe, locationPrefs.get)
}
