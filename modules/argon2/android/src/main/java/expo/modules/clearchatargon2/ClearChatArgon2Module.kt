package expo.modules.clearchatargon2

import android.util.Base64
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import com.lambdapioneer.argon2kt.Argon2Version
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Argon2id v1.3 sobre o argon2kt (referência em C). Entrada/saída em base64url sem padding.
class ClearChatArgon2Module : Module() {
  private val argon2 by lazy { Argon2Kt() }

  override fun definition() = ModuleDefinition {
    Name("ClearChatArgon2")

    AsyncFunction("argon2id") Coroutine { passwordB64u: String, saltB64u: String, iterations: Int,
      memoryKiB: Int, parallelism: Int, hashLength: Int ->
      withContext(Dispatchers.Default) {
        val password = decode(passwordB64u)
        val salt = decode(saltB64u)
        try {
          val result = argon2.hash(
            Argon2Mode.ARGON2_ID,
            password,
            salt,
            iterations,
            memoryKiB,
            parallelism,
            hashLength,
            Argon2Version.V13
          )
          val raw = result.rawHashAsByteArray()
          try {
            Base64.encodeToString(raw, FLAGS)
          } finally {
            raw.fill(0)
            result.rawHash.let { buf -> if (!buf.isReadOnly) for (i in 0 until buf.capacity()) buf.put(i, 0) }
          }
        } catch (e: Throwable) {
          throw Argon2Exception(e.message ?: e.javaClass.simpleName)
        } finally {
          password.fill(0)
        }
      }
    }
  }

  private fun decode(s: String): ByteArray = Base64.decode(s, FLAGS)

  private class Argon2Exception(message: String) : CodedException("ERR_ARGON2", "Argon2id falhou: $message", null)

  companion object {
    private const val FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
  }
}
