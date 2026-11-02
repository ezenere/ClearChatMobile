package expo.modules.clearchatsecurescreen

import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// FLAG_SECURE na janela da Activity: o sistema não deixa tirar screenshot/gravar a tela e a
// prévia na tela de recentes fica em branco. Liga/desliga a pedido do JS (contagem de telas no JS).
class ClearChatSecureScreenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ClearChatSecureScreen")

    Function("setSecure") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      true
    }
  }
}
