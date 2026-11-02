// Avisos de desenvolvimento conhecidos e inofensivos (antes de qualquer módulo do app carregar):
// tts.ts ↔ elevenlabs.ts (vendorados do desktop) se importam em ciclo — só funções, sem estado no
// carregamento. Sem isto o LogBox cobre o composer no build de desenvolvimento.
import { LogBox } from 'react-native'

LogBox.ignoreLogs(['Require cycle: src/vendor/desktop/voice/'])
