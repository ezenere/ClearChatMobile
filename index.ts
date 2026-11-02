// Entrada do app: a camada de plataforma (polyfills do Hermes) carrega antes do expo-router.
import './src/platform/install'
import './src/platform/devLogs'
import 'expo-router/entry'
