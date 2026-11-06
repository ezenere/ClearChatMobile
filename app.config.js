// Config dinâmica: estende o app.json (fonte única do resto — versionCode, plugins…) só com o
// google-services.json do Firebase (notificações push, SYNC_PROTOCOL.md §22).
//   - EAS (nuvem): variável de ambiente do tipo arquivo GOOGLE_SERVICES_JSON (o EAS põe o caminho
//     do arquivo nela);
//   - build local: secrets/google-services.json, se existir (fora do git);
//   - sem nenhum dos dois: o app compila e roda com o push desligado (sem token do FCM).
const fs = require('node:fs')
const path = require('node:path')

const LOCAL = './secrets/google-services.json'

function googleServicesFile() {
  const env = process.env.GOOGLE_SERVICES_JSON
  if (env) return env
  return fs.existsSync(path.join(__dirname, LOCAL)) ? LOCAL : undefined
}

module.exports = ({ config }) => {
  const file = googleServicesFile()
  if (!file) return config
  return { ...config, android: { ...config.android, googleServicesFile: file } }
}
