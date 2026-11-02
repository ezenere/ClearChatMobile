// Argon2id v1.3 no iOS (SYNC_PROTOCOL.md §3.4) sobre a implementação de referência em C
// (phc-winner-argon2, vendorada em vendor/). Mesmo contrato do módulo Android: entrada/saída em
// base64url sem padding, cálculo fora da thread do JS (AsyncFunction roda na fila do módulo).
// A saída é byte a byte a dos vetores (docs/test-vectors/kdf.json) — conferida pelo self-test
// (clearchat://dev/selftest) e, no Linux, compilando os mesmos .c contra os vetores.
import ExpoModulesCore
import Foundation

public class ClearChatArgon2Module: Module {
  public func definition() -> ModuleDefinition {
    Name("ClearChatArgon2")

    AsyncFunction("argon2id") {
      (passwordB64u: String, saltB64u: String, iterations: Int, memoryKiB: Int, parallelism: Int,
       hashLength: Int) throws -> String in
      guard var password = Self.decode(passwordB64u), let salt = Self.decode(saltB64u) else {
        throw Argon2Exception("entrada inválida (base64url)")
      }
      guard iterations > 0, memoryKiB > 0, parallelism > 0, hashLength > 0, hashLength <= 1024 else {
        throw Argon2Exception("parâmetros inválidos")
      }
      var out = [UInt8](repeating: 0, count: hashLength)
      defer {
        // a senha e o hash não ficam na memória além do necessário
        for i in password.indices { password[i] = 0 }
        for i in out.indices { out[i] = 0 }
      }
      let rc: Int32 = password.withUnsafeBytes { pwd in
        salt.withUnsafeBytes { s in
          out.withUnsafeMutableBytes { o in
            argon2id_hash_raw(
              UInt32(iterations), UInt32(memoryKiB), UInt32(parallelism),
              pwd.baseAddress, pwd.count,
              s.baseAddress, s.count,
              o.baseAddress, o.count)
          }
        }
      }
      if rc != 0 /* ARGON2_OK */ {
        let msg = String(cString: argon2_error_message(rc))
        throw Argon2Exception(msg)
      }
      return Self.encode(out)
    }
  }

  private static func decode(_ s: String) -> [UInt8]? {
    var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b.count % 4 != 0 { b += "=" }
    guard let d = Data(base64Encoded: b) else { return nil }
    return [UInt8](d)
  }

  private static func encode(_ bytes: [UInt8]) -> String {
    Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

internal final class Argon2Exception: GenericException<String> {
  override var code: String { "ERR_ARGON2" }
  override var reason: String { "Argon2id falhou: \(param)" }
}
