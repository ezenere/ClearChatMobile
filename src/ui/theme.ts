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
  success: '#4ade80',
  warning: '#f5b544',
  danger: '#f87171'
} as const

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const

export const radius = { sm: 6, md: 10, lg: 14 } as const

export const font = {
  mono: 'monospace'
} as const
