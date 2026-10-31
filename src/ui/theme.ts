// Tokens do tema escuro — os mesmos do app desktop (ClearChatDesktop/src/renderer/src/styles.css).
export const colors = {
  bg: '#0b0b0f',
  surface: '#101015',
  elevated: '#17171e',
  hover: '#1c1c24',
  active: '#23232c',
  border: '#24242c',
  borderStrong: '#33333d',
  fg: '#e6e6ea',
  muted: '#a1a1aa',
  subtle: '#6e6e78',
  faint: '#4a4a53',
  accent: '#8b5cf6',
  accentStrong: '#a78bfa',
  accentSoft: 'rgba(139, 92, 246, 0.14)',
  accentBorder: 'rgba(139, 92, 246, 0.38)',
  onAccent: '#ffffff',
  success: '#4ade80',
  successSoft: 'rgba(74, 222, 128, 0.12)',
  warning: '#f5b544',
  warningSoft: 'rgba(245, 181, 68, 0.12)',
  danger: '#f87171',
  dangerSoft: 'rgba(248, 113, 113, 0.12)',
  info: '#7dd3fc',
  infoSoft: 'rgba(125, 211, 252, 0.10)',
  /** Markdown: fundo dos blocos de código e cor do código inline (desktop: .md). */
  codeBg: '#0d0d12',
  codeInline: '#e9d5ff',
  strong: '#f4f4f6'
} as const

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

export const radius = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const

export const font = {
  mono: 'monospace'
} as const

/** Escala tipográfica. */
export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  caption: { fontSize: 12.5, lineHeight: 17 }
} as const

export type Tone = 'info' | 'success' | 'warning' | 'danger'

export const toneColors: Record<Tone, { fg: string; bg: string; border: string }> = {
  info: { fg: colors.info, bg: colors.infoSoft, border: 'rgba(125, 211, 252, 0.28)' },
  success: { fg: colors.success, bg: colors.successSoft, border: 'rgba(74, 222, 128, 0.3)' },
  warning: { fg: colors.warning, bg: colors.warningSoft, border: 'rgba(245, 181, 68, 0.32)' },
  danger: { fg: colors.danger, bg: colors.dangerSoft, border: 'rgba(248, 113, 113, 0.32)' }
}
