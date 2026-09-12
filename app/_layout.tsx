import { useColorScheme } from "@/components/useColorScheme";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavLightTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo } from "react";
import { Provider as PaperProvider } from "react-native-paper";
import "react-native-reanimated";

import { AuthProvider } from "../src/contexts/AuthContext";
import { paperThemes } from "../src/theme/appTheme";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  // Checkpoint 3F.3A: the approved Light Mode is now the flagship active
  // visual mode for review, pinned here regardless of system preference
  // until the System/Light/Dark settings workflow (explicitly out of
  // scope here) is built. Dark Mode (Checkpoint 3F.2) remains fully
  // intact in paperThemes.dark - flipping this one flag back to `true`
  // (or to `colorScheme === "dark"` for a real System option) is the
  // entire switch-over, no per-screen changes required. useColorScheme()
  // is kept imported/called so that future switcher doesn't have to
  // re-wire theme selection from scratch.
  const colorScheme = useColorScheme();
  void colorScheme;
  const isDark = false;

  const paperTheme = isDark ? paperThemes.dark : paperThemes.light;

  // ✅ Make React Navigation match Paper colors
  const navTheme = useMemo(() => {
    const base = isDark ? NavDarkTheme : NavLightTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: paperTheme.colors.primary,
        background: paperTheme.colors.background,
        card: paperTheme.colors.surface,
        text: paperTheme.colors.onBackground,
        border: paperTheme.colors.outline,
      },
    };
  }, [isDark, paperTheme.colors]);

  return (
    <PaperProvider theme={paperTheme}>
      <AuthProvider>
        <ThemeProvider value={navTheme}>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="modal" options={{ presentation: "modal" }} />
          </Stack>
        </ThemeProvider>
      </AuthProvider>
    </PaperProvider>
  );
}
