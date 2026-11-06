// Localização no aparelho (expo-location): permissão só "durante o uso" (nunca segundo plano),
// aproximada = só ACCESS_COARSE_LOCATION no Android / precisão reduzida aceita no iOS; exata =
// ACCESS_FINE_LOCATION / precisão total (no iOS 14+ com "Localização Precisa" desligada, o pedido
// mostra o aviso de precisão total temporária com a finalidade `ExpoLocationFullAccuracy` do
// app.json — recusado, o serviço cai para a aproximada e avisa). Geocodificador do sistema pelo
// `reverseGeocodeAsync` (Android Geocoder / Apple CLGeocoder). Nunca loga coordenadas.
import Constants from 'expo-constants'
import * as Legacy from 'expo-location'
import {
  Location,
  LocationAccuracy,
  LocationProfile,
  RequestPermissionsAccuracyOption,
  type LocationPermissionResponse
} from 'expo-location/next'
import { Linking, Platform } from 'react-native'
import { kv } from '@/account/native'
import { withSystemDialog } from '@/platform/systemDialog'
import type { LatLon, Precision } from './geo'
import { OsmGeocoder, type PlaceName } from './nominatim'
import { OverpassClient } from './overpass'
import { LocationService, type DevicePermission, type LocationDevice } from './service'
import { LocationPrefs } from './settings'

export const USER_AGENT = `ClearChat/${Constants.expoConfig?.version ?? '0.0.0'} (+https://clear.ezenere.com)`

function toPermission(r: LocationPermissionResponse): DevicePermission {
  const status = r.granted ? 'granted' : r.status === 'denied' ? 'denied' : 'undetermined'
  const accuracy =
    r.accuracy === LocationAccuracy.FULL
      ? 'full'
      : r.accuracy === LocationAccuracy.REDUCED
        ? 'reduced'
        : 'none'
  return { status, accuracy: status === 'granted' ? accuracy : 'none', canAskAgain: r.canAskAgain }
}

const s = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null)

export const device: LocationDevice = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  geocoderName: Platform.OS === 'ios' ? 'geocodificador da Apple' : 'geocodificador do Android',
  permission: async () => toPermission(await Location.getForegroundPermissions()),
  request: (precision: Precision) =>
    withSystemDialog(async () =>
      toPermission(
        await Location.requestForegroundPermissions({
          accuracy:
            precision === 'exact'
              ? RequestPermissionsAccuracyOption.FULL
              : RequestPermissionsAccuracyOption.REDUCED
        })
      )
    ),
  servicesEnabled: async () => {
    try {
      return Location.hasLocationServicesEnabled()
    } catch {
      return true
    }
  },
  position: async (precision: Precision) => {
    const p = await Location.getPosition({
      maxCachedAge: 60,
      timeout: 20,
      profile: precision === 'exact' ? LocationProfile.DEFAULT : LocationProfile.LOW_POWER
    })
    if (!p) return null
    return {
      lat: p.coordinates.latitude,
      lon: p.coordinates.longitude,
      accuracyM: p.horizontalAccuracy,
      timestamp: p.timestamp,
      mocked: p.mocked
    }
  },
  reverseGeocode: async (p: LatLon): Promise<PlaceName | null> => {
    const list = await Legacy.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lon })
    const a = list[0]
    if (!a) return null
    return {
      neighbourhood: s(a.district),
      city: s(a.city) ?? s(a.subregion),
      state: s(a.region),
      country: s(a.country),
      street: s(a.street)
    }
  }
}

export const locationPrefs = new LocationPrefs(kv)

export const location = new LocationService({
  device,
  settings: locationPrefs.get,
  overpass: new OverpassClient({ fetch: (u, i) => fetch(u, i), userAgent: USER_AGENT }),
  geocoder: new OsmGeocoder({ fetch: (u, i) => fetch(u, i), userAgent: USER_AGENT })
})

/** Estado para Configurações → Localização. */
export type PermissionView =
  | { kind: 'granted'; accuracy: 'full' | 'reduced' }
  | { kind: 'undetermined' }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'services-off'; accuracy: 'full' | 'reduced' }

export async function permissionView(): Promise<PermissionView> {
  const p = await device.permission()
  if (p.status === 'granted') {
    const accuracy = p.accuracy === 'full' ? 'full' : 'reduced'
    if (!(await device.servicesEnabled())) return { kind: 'services-off', accuracy }
    return { kind: 'granted', accuracy }
  }
  if (p.status === 'denied') return { kind: 'denied', canAskAgain: p.canAskAgain }
  return { kind: 'undetermined' }
}

export const requestPermission = (precision: Precision): Promise<DevicePermission> =>
  device.request(precision)

export function openSystemSettings(): void {
  void Linking.openSettings().catch(() => undefined)
}
