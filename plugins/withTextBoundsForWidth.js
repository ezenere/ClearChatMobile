// Texto cortado no Android 15+ (targetSdk ≥ 35): o TextView passou a medir a largura pelos LIMITES
// dos glifos (`useBoundsForWidth`, padrão ligado para quem mira a API 35+), enquanto o React Native
// (TextLayoutManager) mede pelo AVANÇO dos glifos (BoringLayout/StaticLayout sem bounds). Quando um
// glifo passa da caixa — o "/" em itálico no começo da linha desce à esquerda da origem —, o texto
// que o RN mediu para caber numa linha não cabe no TextView: ele quebra no último ponto possível e a
// 2ª linha some (a altura é a de uma). Ex.: a fala "/chats" de uma chamada (bolha em itálico) virava
// "/"; "/sleep 16000 resposta demorada" virava "/sleep 16000 resposta". Vale para qualquer <Text>
// encolhido ao conteúdo (bolha do usuário, chips) — o de largura cheia sobra espaço e não quebra.
// Correção na raiz: o estilo padrão dos TextView do app desliga `useBoundsForWidth`, e a medição do
// RN e o desenho voltam a usar a mesma regra (a do Android ≤ 14). Ver tests/textBounds.test.ts.
const { AndroidConfig, withAndroidStyles } = require('expo/config-plugins')

const STYLE = 'ClearChatTextView'
/** Pai = o `android:textViewStyle` do tema AppCompat (o resto do estilo continua igual). */
const STYLE_PARENT = 'Widget.AppCompat.TextView'

/** Aplica no XML de `res/values/styles.xml` (idempotente). */
function applyTextBoundsForWidth(xml) {
  const { Styles } = AndroidConfig
  xml = Styles.assignStylesValue(xml, {
    add: true,
    name: 'android:useBoundsForWidth',
    value: 'false',
    targetApi: '35',
    parent: { name: STYLE, parent: STYLE_PARENT }
  })
  xml = Styles.assignStylesValue(xml, {
    add: true,
    name: 'android:textViewStyle',
    value: `@style/${STYLE}`,
    parent: Styles.getAppThemeGroup()
  })
  return xml
}

module.exports = function withTextBoundsForWidth(config) {
  return withAndroidStyles(config, (cfg) => {
    cfg.modResults = applyTextBoundsForWidth(cfg.modResults)
    return cfg
  })
}
module.exports.applyTextBoundsForWidth = applyTextBoundsForWidth
module.exports.TEXT_VIEW_STYLE = STYLE
