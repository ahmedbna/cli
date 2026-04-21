// Color palette tuned for both dark and light terminals.
// Accent is the BNA yellow (#FAD40B) from the existing logger.
export const theme = {
  accent: '#FAD40B',
  accentDim: '#b89a00',
  ok: '#22c55e',
  warn: '#f59e0b',
  err: '#ef4444',
  info: '#a5b4fc',
  userFg: '#93c5fd',
  assistFg: '#fde68a',
  mute: '#6b7280',
  border: '#3f3f46',
  borderHot: '#FAD40B',
  toolBg: '#1f2937',
} as const;

export const verbs = [
  'Marinating',
  'Cooking',
  'Plotting',
  'Wiring',
  'Polishing',
];
