// Escolha com herança (persona/chat) sem opção duplicada — a regra pura do `InheritChoice` (=
// `components/ui/InheritChoice.tsx` do desktop): só as opções REAIS, com ★ na igual ao valor herdado
// (da persona ou do padrão global); sem override (`value` null) a opção ★ aparece selecionada;
// escolher a ★ remove o override (null = segue herdando, muda junto se o herdado mudar); escolher
// outra fixa o valor neste nível. Sem React Native (testável no Node).

/** Valor mostrado como selecionado: o override, ou o herdado (★). */
export function inheritShown<T>(value: T | null | undefined, inherited: T): T {
  return value ?? inherited
}

/** O que gravar ao tocar numa opção: a ★ (igual ao herdado) volta a herdar (null). */
export function inheritPick<T>(picked: T, inherited: T): T | null {
  return picked === inherited ? null : picked
}

/** `testID`/estado estável de uma opção (booleanos → on/off, como nos testes de UI do desktop). */
export function inheritValueKey(v: unknown): string {
  return v === true ? 'on' : v === false ? 'off' : String(v)
}
