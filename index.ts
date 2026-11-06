// Entrada do app: a camada de plataforma (polyfills do Hermes) carrega antes do expo-router.
import './src/platform/install'
import './src/platform/devLogs'
// notificações push: a tarefa precisa existir no escopo do módulo (roda também com o app fechado)
import './src/push/task'
import 'expo-router/entry'
