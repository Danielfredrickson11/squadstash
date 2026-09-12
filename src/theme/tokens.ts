// Shared visual tokens for SquadStash (Milestone 3). Kept as plain
// exported constants - not baked directly into every component - so the
// same set of screens can render either semantic palette. Most Paper-
// driven components (Card, Button, ProgressBar, Dialog, Snackbar,
// TextInput) get their colors from react-native-paper's theme
// (src/theme/appTheme.ts, itself built from `darkColors`/`lightColors`
// below) via useTheme() - these tokens exist for the values Paper's MD3
// color roles don't cover (extra surface tiers, the signature mint
// accent, secondary accents) and for spacing/radii/typography
// consistency across the app's restyled screens.
//
// Checkpoint 3F.3A: `darkColors` and `lightColors` share an identical key
// shape (`SemanticColors`) on purpose - every component that previously
// imported `darkColors` directly now reads the ACTIVE palette through
// `useSemanticColors()` (src/theme/useSemanticColors.ts), which picks
// between these two objects based on the current Paper theme's `dark`
// flag. Dark is fully preserved, unchanged in value - Light is the new
// approved "light, premium, clean fintech + travel" direction, active by
// default for this checkpoint's visual review.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radii = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  pill: 999,
};

export type SemanticColors = {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceTertiary: string;
  border: string;
  borderStrong: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  mint: string;
  onMint: string;
  mintSurface: string;
  mintDark: string;
  // The mint shade to use for TEXT/ICONS drawn directly on a light/pale
  // surface (badges, active-nav icon+label, small accent bubbles) - kept
  // distinct from `mint` (the solid-fill accent) because the bright
  // signature mint reads fine on Dark Mode's near-black surfaces but
  // fails contrast on Light Mode's pale/white ones. Dark keeps this
  // identical to `mint` (no visual change); Light uses the deeper
  // `mintDark` shade instead.
  mintText: string;
  lime: string;

  violet: string;
  orange: string;
  coral: string;
  blue: string;
  bluePale: string;
  // Pale neutral blue-gray for the "slate" leg of the restrained 3-accent
  // rotation (Checkpoint 3F.3A.1) - the icon-bubble background paired
  // with `textSecondary` as its "strong" icon/progress color.
  slatePale: string;

  // Deep navy - a fixed brand accent (Checkpoint 3F.3A) for elements the
  // approved design calls out as navy regardless of overall theme (the
  // Total Stashed hero card, selected filter pills). Same values in both
  // palettes on purpose.
  navy: string;
  navyStrong: string;
  navySoft: string;
};

// The dark palette - the original Milestone 3 Checkpoint 3F.2 flagship
// signature UI. Values are unchanged by the 3F.3A light-mode work.
export const darkColors: SemanticColors = {
  background: "#0B1020",
  surface: "#141B2D",
  surfaceElevated: "#1A2235",
  surfaceTertiary: "#20283A",
  border: "rgba(255,255,255,0.09)",
  borderStrong: "rgba(255,255,255,0.14)",

  textPrimary: "#F7F9FC",
  textSecondary: "#98A2B8",
  textMuted: "#6F7A90",

  // Signature accent - used intentionally (active nav state, primary
  // CTAs, progress, success), never as a whole-card background.
  mint: "#45F0AE",
  onMint: "#04140D",
  mintSurface: "rgba(69,240,174,0.12)",
  mintDark: "#2FBD84",
  mintText: "#45F0AE",
  lime: "#8CF45A",

  // Secondary accents - selectively used (category icons, one accent
  // per element), never turning every card a different bright color.
  violet: "#8A6BF6",
  orange: "#F3A15E",
  coral: "#FF6B68",
  blue: "#55B7F3",
  bluePale: "rgba(85,183,243,0.14)",
  slatePale: "rgba(255,255,255,0.06)",

  navy: "#0B1F33",
  navyStrong: "#071828",
  navySoft: "#17344D",
};

// Checkpoint 3F.3A approved LIGHT MODE palette: light, premium, clean
// fintech + travel. Intentionally limited - deep navy for primary text/
// premium surfaces, restrained mint/teal for actions and success, a
// single soft blue as the only secondary accent, slate for neutral/
// metadata/inactive treatments, and an off-white background. No orange/
// purple/coral used decoratively - `coral` here is reserved for real
// destructive/error states only (Delete button, form error text), never
// a bucket accent choice.
export const lightColors: SemanticColors = {
  // Checkpoint 3F.3A.1: nudged from #F6F9FC - the original read slightly
  // too cool/gray in side-by-side visual review against the approved
  // mockup. Still an off-white, just a touch brighter/cleaner.
  background: "#F8FAFD",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfaceTertiary: "#E5EBF2",
  border: "#E1E8F0",
  borderStrong: "#C9D6E4",

  textPrimary: "#0B1F33",
  textSecondary: "#55708D",
  textMuted: "#8A9AAF",

  mint: "#19C89A",
  onMint: "#04140D",
  mintSurface: "#DDF8EF",
  mintDark: "#0E9877",
  // Deeper than `mint` for legible text/icons directly on `mintSurface`
  // or the off-white background - `mint` itself is too close in
  // lightness to both to pass contrast for small text/icons.
  mintText: "#0E9877",
  lime: "#8CF45A",

  violet: "#8A6BF6",
  orange: "#F3A15E",
  // Accessible semantic danger color for real destructive/error states
  // only (Delete confirm button, form validation errors) - never used
  // decoratively in the approved Light Mode palette.
  coral: "#DC2626",
  blue: "#2F7ED8",
  bluePale: "#E6F1FC",
  slatePale: "#E5EBF2",

  navy: "#0B1F33",
  navyStrong: "#071828",
  navySoft: "#17344D",
};

// Very subtle elevation. Dark keeps its original deeper shadow; light
// uses a much softer, lower-opacity version so white cards on an
// off-white background read as gently lifted, not heavy/skeuomorphic.
export function cardShadowFor(isDark: boolean) {
  return isDark
    ? {
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.28,
        shadowRadius: 16,
        elevation: 6,
      }
    : {
        shadowColor: "#0B1F33",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06,
        shadowRadius: 12,
        elevation: 2,
      };
}

// Backward-compatible default (dark) shadow constant - most call sites
// now use `cardShadowFor(isDark)` via useSemanticColors(), but this is
// kept for any remaining plain-constant usage.
export const cardShadow = cardShadowFor(true);

// Checkpoint 3F.3A.1: a dedicated, lighter shadow for the always-navy
// Total Stashed hero (see components/home/TotalStashedCard.tsx). The
// generic dark `cardShadowFor(true)` preset (opacity 0.28) was tuned for
// a dark card sitting on a dark background - reused unconditionally for
// a navy card sitting on a LIGHT page, it read as a heavy gray halo
// instead of the approved mockup's subtle premium depth.
export function navyHeroShadow() {
  return {
    shadowColor: "#04101E",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 4,
  };
}

// `strength` lets call sites dial down the signature mint glow for
// contexts where the full-intensity dark-theme glow (opacity 0.45) would
// read as neon rather than premium - e.g. the Light Mode center-create
// button (Checkpoint 3F.3A.1).
export function mintGlowFor(
  mint: string,
  strength: { opacity?: number; radius?: number; elevation?: number } = {}
) {
  return {
    shadowColor: mint,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: strength.opacity ?? 0.45,
    shadowRadius: strength.radius ?? 14,
    elevation: strength.elevation ?? 8,
  };
}

export const mintGlow = mintGlowFor(darkColors.mint);

// Checkpoint 3F.2 typography direction: large headline 700-800, major
// financial values 800, section headings 700, card titles 600-700,
// metadata 400-500 - not everything bold.
export const typography = {
  headline: { fontSize: 26, fontWeight: "800" as const, lineHeight: 32 },
  pageTitle: { fontSize: 24, fontWeight: "800" as const },
  majorValue: { fontSize: 32, fontWeight: "800" as const },
  sectionTitle: { fontSize: 15, fontWeight: "700" as const },
  cardTitle: { fontSize: 15, fontWeight: "600" as const },
  body: { fontSize: 14, fontWeight: "500" as const },
  meta: { fontSize: 12, fontWeight: "500" as const },
};
