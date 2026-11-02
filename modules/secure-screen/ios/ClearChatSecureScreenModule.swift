// Equivalente iOS do FLAG_SECURE (o iOS não deixa um app BLOQUEAR screenshots): enquanto houver
// tela sensível aberta (contagem no JS — `holdSecureScreen`), uma capa opaca cobre a janela
// (1) quando o app sai do primeiro plano — a prévia no seletor de apps não mostra a senha/chave —
// e (2) enquanto a tela está sendo gravada/espelhada (`UIScreen.isCaptured`). Screenshot comum
// continua possível (limitação do sistema; documentado no README).
import ExpoModulesCore
import UIKit

public class ClearChatSecureScreenModule: Module {
  private var secure = false
  private var cover: UIView?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("ClearChatSecureScreen")

    Function("setSecure") { (on: Bool) -> Bool in
      DispatchQueue.main.async { self.apply(on) }
      return true
    }

    OnDestroy {
      DispatchQueue.main.async { self.apply(false) }
    }
  }

  private func apply(_ on: Bool) {
    if on == secure { return }
    secure = on
    let nc = NotificationCenter.default
    if on {
      observers = [
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
          self?.showCover()
        },
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
          self?.updateForCapture()
        },
        nc.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
          self?.updateForCapture()
        }
      ]
      updateForCapture()
    } else {
      observers.forEach { nc.removeObserver($0) }
      observers = []
      hideCover()
    }
  }

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  private func updateForCapture() {
    let captured = keyWindow()?.windowScene?.screen.isCaptured ?? false
    if secure && captured { showCover() } else { hideCover() }
  }

  private func showCover() {
    guard secure, cover == nil, let window = keyWindow() else { return }
    let v = UIView(frame: window.bounds)
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // fundo do tema escuro do app (#0b0b0f)
    v.backgroundColor = UIColor(red: 11 / 255, green: 11 / 255, blue: 15 / 255, alpha: 1)
    window.addSubview(v)
    cover = v
  }

  private func hideCover() {
    cover?.removeFromSuperview()
    cover = nil
  }
}
