/**
 * QueryLoad design tokens — the binding "dark editorial" specification.
 *
 * Source of truth: Master Decision Log D75–D80 and Build Prompt Section D.
 * The owner's approved screenshot is the visual contract. These tokens are
 * consumed by the renderer (emitted as CSS custom properties) AND by the
 * composer-layout regression test, so a design drift fails a test rather than
 * slipping through review.
 *
 * This file is pure data — no imports, no logic — so it is safe in every
 * runtime.
 */

/** Palette — D77. The accent is reserved; see {@link ACCENT_ALLOWED_USES}. */
export const COLORS = {
  /** Near-black canvas — D75 (#0F0F0E family). */
  canvas: '#0F0F0E',
  /** Hairline dividers — D75. */
  divider: '#262624',
  /** Composer / input surface — D77. */
  inputSurface: '#161615',
  /** Composer / input border — D77. */
  inputBorder: '#2A2A28',

  /** Primary text (wordmark, titles) — D77. */
  textPrimary: '#EDE8DC',
  /** User queries — D77 (bright cream). */
  textUserQuery: '#E8E4DA',
  /** Answer / body text — D77 (warm gray). */
  textBody: '#A8A49B',
  /** Icons & placeholders — D77 (muted). */
  textMuted: '#6E6A63',
  /** Section labels — D77 (faint). */
  textLabel: '#56534D',

  /**
   * The single red-coral accent — D77. RESERVED. It may appear ONLY in the
   * uses enumerated by {@link ACCENT_ALLOWED_USES}; nothing else may use it.
   */
  accent: '#E5484D',
} as const;

export type ColorToken = keyof typeof COLORS;

/**
 * The exhaustive, enforceable list of where the coral accent may be used
 * (D77 / D78). Referenced by design-audit tooling and code review.
 */
export const ACCENT_ALLOWED_USES = [
  'reference-entries',
  'processing-indicator',
  'live-network-state',
] as const;

/** Typography — D76 / Section D. Fonts are BUNDLED; never network-loaded. */
export const TYPOGRAPHY = {
  /** Serif: wordmark, matter/chat titles, and ALL AI answer text. */
  serifStack: "'Source Serif 4', 'Lora', Georgia, 'Times New Roman', serif",
  /** Sans: UI chrome. */
  sansStack: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
  /** Minimum line-height for AI answer text — D76 (>= 1.7). */
  answerLineHeight: 1.7,
  /** Uppercase letter-spaced section labels (TODAY, USER INTENT, ...) — D76. */
  labelSizePx: 11,
  labelLetterSpacingEm: 0.14,
} as const;

/**
 * Layout — D78 / D79. The composer constraint is the load-bearing rule the
 * owner flagged: the input MUST live in the center column's grid track and
 * share its max-width, never spanning under the References rail.
 */
export const LAYOUT = {
  /** Center content column max-width, px — D79 (560–640). */
  centerColumnMaxWidthPx: 640,
  centerColumnMinWidthPx: 560,
  /** Left sidebar fixed width. */
  sidebarWidthPx: 232,
  /** Right References rail fixed width. */
  referencesRailWidthPx: 232,
  /** Gutter between regions. */
  regionGapPx: 24,
} as const;

/**
 * Named CSS custom-property keys, generated from {@link COLORS}. Keeping the
 * mapping here means the renderer and any tooling agree on variable names.
 */
export function cssVarName(token: ColorToken): string {
  return `--ql-color-${token.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

/** Build the `:root` custom-property block for the palette. */
export function paletteCssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of Object.keys(COLORS) as ColorToken[]) {
    vars[cssVarName(token)] = COLORS[token];
  }
  return vars;
}
