# Argon2id nativo no iOS: a implementação de REFERÊNCIA (phc-winner-argon2, tag 20190702, CC0 /
# Apache-2.0 — a mesma que o argon2kt do Android embala) compilada junto do módulo Swift.
# Só a versão portável (ref.c, sem SSE): mesma saída em arm64 e no simulador.
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ClearChatArgon2'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = { :type => 'CC0-1.0 OR Apache-2.0 (argon2); privado (módulo)' }
  s.author         = 'ClearChat'
  s.homepage       = 'https://clear.ezenere.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = [
    '*.swift',
    'vendor/phc-winner-argon2/include/argon2.h',
    'vendor/phc-winner-argon2/src/argon2.c',
    'vendor/phc-winner-argon2/src/core.{c,h}',
    'vendor/phc-winner-argon2/src/encoding.{c,h}',
    'vendor/phc-winner-argon2/src/ref.c',
    'vendor/phc-winner-argon2/src/thread.{c,h}',
    'vendor/phc-winner-argon2/src/blake2/*.{c,h}'
  ]
  # só o argon2.h é público: o Swift do módulo o enxerga pelo module map gerado (DEFINES_MODULE)
  s.public_header_files = 'vendor/phc-winner-argon2/include/argon2.h'
  s.private_header_files = 'vendor/phc-winner-argon2/src/**/*.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/vendor/phc-winner-argon2/include" "${PODS_TARGET_SRCROOT}/vendor/phc-winner-argon2/src"',
    # sem pthreads: as lanes rodam em sequência (mesma saída; o protocolo usa p = 1)
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) ARGON2_NO_THREADS=1'
  }
end
