// Assinatura do APK/AAB release (CNG: android/ é regenerado, então isto entra pelo prebuild).
// Lê um .properties FORA do repositório (padrão ~/.android/clearchat-release.properties, ou o caminho
// em CLEARCHAT_SIGNING_PROPS) com storeFile, storePassword, keyAlias e keyPassword — criado por
// scripts/build-apk.sh. Sem o arquivo, o release sai sem assinatura (o script recusa antes disso);
// o build debug não muda.
const { withAppBuildGradle } = require('expo/config-plugins')

const MARK = '// clearchat:release-signing'

const SIGNING = `
        release { ${MARK}
            def propsPath = System.getenv('CLEARCHAT_SIGNING_PROPS') ?: "\${System.getProperty('user.home')}/.android/clearchat-release.properties"
            def propsFile = new File(propsPath)
            if (propsFile.exists()) {
                def p = new Properties()
                propsFile.withInputStream { p.load(it) }
                storeFile new File(p.getProperty('storeFile'))
                storePassword p.getProperty('storePassword')
                keyAlias p.getProperty('keyAlias')
                keyPassword p.getProperty('keyPassword')
            }
        }`

function apply(src) {
  if (src.includes(MARK)) return src
  const debugBlock = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/
  if (!debugBlock.test(src))
    throw new Error('withReleaseSigning: signingConfigs.debug não encontrado')
  let out = src.replace(debugBlock, `$1${SIGNING}`)
  const releaseUsesDebug =
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/
  if (!releaseUsesDebug.test(out))
    throw new Error('withReleaseSigning: buildTypes.release não encontrado')
  out = out.replace(releaseUsesDebug, '$1signingConfig signingConfigs.release')
  return out
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = apply(cfg.modResults.contents)
    return cfg
  })
}
module.exports.apply = apply
