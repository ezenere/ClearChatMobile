// Metro: config padrão do Expo + redirecionamentos da camada de plataforma (scripts/platformAliases.cjs).
const { getDefaultConfig } = require('expo/metro-config')
const { redirect } = require('./scripts/platformAliases.cjs')

const config = getDefaultConfig(__dirname)

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = redirect(moduleName, context.originModulePath)
  if (target) return { type: 'sourceFile', filePath: target }
  return upstream
    ? upstream(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}

module.exports = config
