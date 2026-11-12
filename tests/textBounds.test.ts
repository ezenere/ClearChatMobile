// Texto cortado no Android 15+ (bolha do usuário em itálico começando com "/"): o RN mede pelo
// avanço dos glifos e o TextView (targetSdk ≥ 35) pelos limites — o plugin
// `plugins/withTextBoundsForWidth.js` põe o estilo padrão dos TextView do app com
// `android:useBoundsForWidth=false` (a mesma regra da medição do RN).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const plugin = require('../plugins/withTextBoundsForWidth.js') as {
  applyTextBoundsForWidth: (xml: unknown) => unknown
  TEXT_VIEW_STYLE: string
}
const { AndroidConfig, XML } = require('expo/config-plugins') as {
  AndroidConfig: {
    Styles: {
      getStylesGroupAsObject: (
        xml: unknown,
        group: { name: string }
      ) => Record<string, string> | null
    }
  }
  XML: { format: (xml: unknown) => string }
}

/** O `styles.xml` que o prebuild gera para o app (AppTheme AppCompat). */
const prebuildStyles = () => ({
  resources: {
    $: { 'xmlns:tools': 'http://schemas.android.com/tools' },
    style: [
      {
        $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
        item: [
          { $: { name: 'colorPrimary' }, _: '@color/colorPrimary' },
          { $: { name: 'android:windowBackground' }, _: '@color/activityBackground' }
        ]
      }
    ]
  }
})

describe('texto cortado no Android 15+ (useBoundsForWidth × medição do RN)', () => {
  it('o tema do app usa um TextView padrão com useBoundsForWidth=false (só API 35+), sem mexer no resto', () => {
    const xml = plugin.applyTextBoundsForWidth(prebuildStyles())
    const theme = AndroidConfig.Styles.getStylesGroupAsObject(xml, { name: 'AppTheme' })
    expect(theme).toEqual({
      colorPrimary: '@color/colorPrimary',
      'android:windowBackground': '@color/activityBackground',
      'android:textViewStyle': `@style/${plugin.TEXT_VIEW_STYLE}`
    })
    const out = XML.format(xml)
    expect(out).toContain(
      `<style name="${plugin.TEXT_VIEW_STYLE}" parent="Widget.AppCompat.TextView">`
    )
    expect(out).toContain(
      '<item name="android:useBoundsForWidth" tools:targetApi="35">false</item>'
    )
    // idempotente (o prebuild roda de novo sobre o android/ existente)
    expect(XML.format(plugin.applyTextBoundsForWidth(xml))).toBe(out)
  })

  it('o plugin está no app.json', () => {
    const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
      expo: { plugins: unknown[] }
    }
    expect(app.expo.plugins).toContain('./plugins/withTextBoundsForWidth')
  })
})
