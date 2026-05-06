export type ThemeMode = 'light' | 'dark' | 'system'
export type DensityMode = 'comfortable' | 'compact'

export type AppearanceSettings = {
  theme: ThemeMode
  accent: string
  translucentSidebar: boolean
  density: DensityMode
  contrast: number
}

const STORAGE_KEY = 'openclaw_appearance'

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  accent: '#0891b2',
  translucentSidebar: true,
  density: 'comfortable',
  contrast: 52,
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isDensityMode(value: unknown): value is DensityMode {
  return value === 'comfortable' || value === 'compact'
}

function clampContrast(value: unknown): number {
  const next = typeof value === 'number' ? value : DEFAULT_APPEARANCE.contrast
  return Math.max(35, Math.min(75, Math.round(next)))
}

export function readAppearanceSettings(): AppearanceSettings {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>
    return {
      theme: isThemeMode(parsed.theme) ? parsed.theme : DEFAULT_APPEARANCE.theme,
      accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULT_APPEARANCE.accent,
      translucentSidebar:
        typeof parsed.translucentSidebar === 'boolean'
          ? parsed.translucentSidebar
          : DEFAULT_APPEARANCE.translucentSidebar,
      density: isDensityMode(parsed.density) ? parsed.density : DEFAULT_APPEARANCE.density,
      contrast: clampContrast(parsed.contrast),
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function resolveThemeMode(theme: ThemeMode): 'light' | 'dark' {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  root.dataset.theme = resolveThemeMode(settings.theme)
  root.dataset.themePreference = settings.theme
  root.dataset.sidebar = settings.translucentSidebar ? 'translucent' : 'solid'
  root.dataset.density = settings.density
  root.dataset.contrast = settings.contrast >= 60 ? 'high' : 'normal'
  root.style.setProperty('--color-accent-blue', settings.accent)
  root.style.setProperty('--appearance-contrast', String(settings.contrast))
}

export function saveAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }
  applyAppearanceSettings(settings)
}

export function applyStoredAppearance(): void {
  applyAppearanceSettings(readAppearanceSettings())
}
