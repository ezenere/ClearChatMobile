import Constants from 'expo-constants'
import { Link } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing } from '@/ui/theme'

export default function Home() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>ClearChat</Text>
      <Text style={styles.subtitle}>
        Mobile {Constants.expoConfig?.version ?? ''} — fase 0 (fundação)
      </Text>
      {__DEV__ && (
        <Link href="/dev/selftest" style={styles.link}>
          Abrir o self-test da cripto
        </Link>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
    padding: spacing.xl
  },
  title: { color: colors.fg, fontSize: 28, fontWeight: '600' },
  subtitle: { color: colors.muted, fontSize: 14 },
  link: {
    marginTop: spacing.lg,
    color: colors.accentStrong,
    fontSize: 15,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden'
  }
})
