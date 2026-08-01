// src/theme/appTheme.ts
import { MD3DarkTheme, MD3LightTheme } from "react-native-paper";

const brand = {
  primary: "#2B66FF",
  secondary: "#5C47B8",
};

export const paperThemes = {
  light: {
    ...MD3LightTheme,
    roundness: 14,
    colors: {
      ...MD3LightTheme.colors,

      primary: brand.primary,
      secondary: brand.secondary,

      background: "#F6F7FB",
      surface: "#FFFFFF",
      surfaceVariant: "#F1F5F9",
      outline: "#E2E8F0",

      onBackground: "#0F172A",
      onSurface: "#0F172A",
      onSurfaceVariant: "#64748B",
    },
  },
  dark: {
    ...MD3DarkTheme,
    roundness: 14,
    colors: {
      ...MD3DarkTheme.colors,

      primary: brand.primary,
      secondary: brand.secondary,

      background: "#0B0F1A",
      surface: "#0F1526",
      surfaceVariant: "#11182A",
      outline: "#182240",

      onBackground: "#FFFFFF",
      onSurface: "#FFFFFF",
      onSurfaceVariant: "#A9B0C3",
    },
  },
};

export type AppPaperTheme = typeof paperThemes.light;
