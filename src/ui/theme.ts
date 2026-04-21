// src/ui/theme.ts
//
// Minimal palette for a Claude-Code-style inline UI.
// The BNA yellow (#FAD40B) is the one accent; everything else is neutral.

export const theme = {
  accent: '#FAD40B', // BNA brand yellow
  user: '#93c5fd', // soft blue for user prompt marker
  assistant: '#e5e7eb', // near-white for assistant text
  mute: '#6b7280', // dim grey for metadata/timestamps
  ok: '#22c55e', // green check
  warn: '#f59e0b', // amber warn
  err: '#ef4444', // red cross
  dim: '#9ca3af', // slightly lighter than mute for progress lines
} as const;

// Cycle of verbs the thinking spinner rotates through.
// Kept short and playful — matches your brand voice.
export const verbs = [
  'Thinking',
  'Cooking',
  'Wiring',
  'Plotting',
  'Polishing',
];
