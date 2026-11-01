// Caminhos no formato do HOST (a aba Arquivos navega com o caminho absoluto que o host devolve).

/** Separador do host a partir de um caminho absoluto dele (Windows usa `\`). */
export const hostSep = (dir: string): string =>
  dir.includes('\\') && !dir.includes('/') ? '\\' : '/'

export const joinHost = (dir: string, name: string): string => {
  const sep = hostSep(dir)
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}
