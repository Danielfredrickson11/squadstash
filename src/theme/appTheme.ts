// src/theme/appTheme.ts
import { MD3DarkTheme, MD3LightTheme } from "react-native-paper";

import { darkColors, lightColors } from "./tokens";

export const paperThemes = {
  // Checkpoint 3F.3A approved Light Mode - light, premium, clean fintech
  // + travel. Built from lightColors (src/theme/tokens.ts) the same way
  // the dark theme below is built from darkColors, so both themes share
  // one semantic source of truth rather than duplicating color literals.
  // primary is the restrained mint/teal accent (CTAs, active nav,
  // success); secondary is the single approved soft-blue accent - no
  // purple/orange/coral used as decorative brand color.
  light: {
    ...MD3LightTheme,
    roundness: 18,
    colors: {
      ...MD3LightTheme.colors,

      primary: lightColors.mint,
      onPrimary: lightColors.onMint,
      secondary: lightColors.blue,

      background: lightColors.background,
      surface: lightColors.surface,
      surfaceVariant: lightColors.surfaceTertiary,
      outline: lightColors.border,
      outlineVariant: lightColors.border,

      onBackground: lightColors.textPrimary,
      onSurface: lightColors.textPrimary,
      onSurfaceVariant: lightColors.textSecondary,

      error: lightColors.coral,
    },
  },
  // Checkpoint 3F.2 dark signature UI - preserved unchanged as the future
  // Dark Mode option. Built from src/theme/tokens.ts's darkColors so the
  // palette lives in one place rather than being hardcoded per screen.
  // primary is the signature mint accent (not the old brand blue) -
  // onPrimary is a near-black for legible text/icons on a bright mint
  // background.
  dark: {
    ...MD3DarkTheme,
    roundness: 18,
    colors: {
      ...MD3DarkTheme.colors,

      primary: darkColors.mint,
      onPrimary: darkColors.onMint,
      secondary: darkColors.violet,

      background: darkColors.background,
      surface: darkColors.surface,
      surfaceVariant: darkColors.surfaceElevated,
      outline: darkColors.border,
      outlineVariant: darkColors.border,

      onBackground: darkColors.textPrimary,
      onSurface: darkColors.textPrimary,
      onSurfaceVariant: darkColors.textSecondary,

      error: darkColors.coral,
    },
  },
};

export type AppPaperTheme = typeof paperThemes.light;
