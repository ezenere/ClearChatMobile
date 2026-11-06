// Localização só "durante o uso" (tools get_location/nearby_places): o expo-location declara no
// manifesto dele dois serviços em primeiro plano do tipo `location` (tarefas e sessão em segundo
// plano), que o app nunca usa. Este plugin os remove do manifesto final (`tools:node="remove"`);
// as permissões de segundo plano ficam bloqueadas por `android.blockedPermissions` no app.json.
const { withAndroidManifest } = require('expo/config-plugins')

const SERVICES = [
  'expo.modules.location.services.LocationTaskService',
  'expo.modules.location.next.locationForegroundService.LocationForegroundService'
]

module.exports = function withForegroundOnlyLocation(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest
    manifest.$ = { ...manifest.$, 'xmlns:tools': 'http://schemas.android.com/tools' }
    const app = manifest.application?.[0]
    if (!app) throw new Error('withForegroundOnlyLocation: <application> não encontrado')
    const list = (app.service ??= [])
    for (const name of SERVICES) {
      if (list.some((s) => s.$?.['android:name'] === name)) continue
      list.push({ $: { 'android:name': name, 'tools:node': 'remove' } })
    }
    return cfg
  })
}
