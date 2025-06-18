const lightColors = {
  // Base colors
  background: '#ffffff',
  foreground: '#0a0a0a',

  // Card colors
  card: '#F8F9FA',
  cardForeground: '#0a0a0a',

  // Popover colors
  popover: '#F8F9FA',
  popoverForeground: '#0a0a0a',

  // Primary colors
  primary: '#18181b',
  primaryForeground: '#fafafa',

  // Secondary colors
  secondary: '#EBECED',
  secondaryForeground: '#18181b',

  // Muted colors
  muted: '#EBECED',
  mutedForeground: '#71717a',

  // Accent colors
  accent: '#EBECED',
  accentForeground: '#18181b',

  // Destructive colors
  destructive: '#ef4444',
  destructiveForeground: '#fafafa',

  // Border and input
  border: '#e4e4e7',
  input: '#e4e4e7',
  ring: '#a1a1aa',

  // Text colors
  text: '#0a0a0a',
  textMuted: '#71717a',

  // Legacy support for existing components
  tint: '#18181b',
  icon: '#71717a',
  tabIconDefault: '#71717a',
  tabIconSelected: '#18181b',

  // Chart colors for data visualization
  chart1: '#f97316',
  chart2: '#06b6d4',
  chart3: '#8b5cf6',
  chart4: '#84cc16',
  chart5: '#f59e0b',

  // Sidebar colors
  sidebar: '#fafafa',
  sidebarForeground: '#0a0a0a',
  sidebarPrimary: '#18181b',
  sidebarPrimaryForeground: '#fafafa',
  sidebarAccent: '#EBECED',
  sidebarAccentForeground: '#18181b',
  sidebarBorder: '#e4e4e7',
  sidebarRing: '#a1a1aa',
};

const darkColors = {
  // Base colors
  background: '#0a0a0a',
  foreground: '#fafafa',

  // Card colors
  card: '#18181b',
  cardForeground: '#fafafa',

  // Popover colors
  popover: '#18181b',
  popoverForeground: '#fafafa',

  // Primary colors
  primary: '#e4e4e7',
  primaryForeground: '#18181b',

  // Secondary colors
  secondary: '#27272a',
  secondaryForeground: '#fafafa',

  // Muted colors
  muted: '#27272a',
  mutedForeground: '#a1a1aa',

  // Accent colors
  accent: '#27272a',
  accentForeground: '#fafafa',

  // Destructive colors
  destructive: '#dc2626',
  destructiveForeground: '#fafafa',

  // Border and input - using alpha values for better blending
  border: 'rgba(255, 255, 255, 0.1)',
  input: 'rgba(255, 255, 255, 0.15)',
  ring: '#71717a',

  // Text colors
  text: '#fafafa',
  textMuted: '#a1a1aa',

  // Legacy support for existing components
  tint: '#fafafa',
  icon: '#a1a1aa',
  tabIconDefault: '#a1a1aa',
  tabIconSelected: '#fafafa',

  // Chart colors for data visualization (adjusted for dark mode)
  chart1: '#8b5cf6',
  chart2: '#10b981',
  chart3: '#f59e0b',
  chart4: '#ef4444',
  chart5: '#06b6d4',

  // Sidebar colors
  sidebar: '#18181b',
  sidebarForeground: '#fafafa',
  sidebarPrimary: '#8b5cf6',
  sidebarPrimaryForeground: '#fafafa',
  sidebarAccent: '#27272a',
  sidebarAccentForeground: '#fafafa',
  sidebarBorder: 'rgba(255, 255, 255, 0.1)',
  sidebarRing: '#71717a',
};

export const Colors = {
  light: lightColors,
  dark: darkColors,
};

// Export individual color schemes for easier access
export { darkColors, lightColors };

// Utility type for color keys
export type ColorKeys = keyof typeof lightColors;

// Semantic color mappings for common UI patterns
export const semanticColors = {
  light: {
    success: '#22c55e',
    successForeground: '#ffffff',
    warning: '#f59e0b',
    warningForeground: '#ffffff',
    info: '#3b82f6',
    infoForeground: '#ffffff',
    error: '#ef4444',
    errorForeground: '#ffffff',
  },
  dark: {
    success: '#16a34a',
    successForeground: '#ffffff',
    warning: '#d97706',
    warningForeground: '#ffffff',
    info: '#2563eb',
    infoForeground: '#ffffff',
    error: '#dc2626',
    errorForeground: '#ffffff',
  },
};
