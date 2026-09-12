// Checkpoint 3F.3A: picks the active semantic color object (`darkColors`
// or `lightColors` from ./tokens) based on the currently active Paper
// theme's own `dark` flag - the same flag react-native-paper's
// MD3DarkTheme/MD3LightTheme already carry, and that
// src/theme/appTheme.ts's paperThemes.dark/light spread unmodified. This
// is the single place components ask "which palette is active right
// now?" instead of importing `darkColors` directly, so every screen
// automatically follows whichever theme app/_layout.tsx selects (today:
// pinned to Light; previously: pinned to Dark) without per-component
// changes.
import { useTheme } from "react-native-paper";

import { darkColors, lightColors, type SemanticColors } from "./tokens";

export function useSemanticColors(): SemanticColors {
  const theme = useTheme();
  return theme.dark ? darkColors : lightColors;
}
