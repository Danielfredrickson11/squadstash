// Custom dark floating bottom navigation (Milestone 3 Checkpoint 3F.2),
// passed as the `tabBar` prop to expo-router's <Tabs> in
// app/(tabs)/_layout.tsx. Renders Home / Buckets / [center create] /
// Trips / Profile - the hidden `transactions` route (href: null, see
// app/(tabs)/_layout.tsx) is deliberately never rendered here.
//
// Tab press handling follows React Navigation's own documented custom-
// tab-bar pattern exactly (emit a `tabPress` event, only navigate if not
// already focused and the event wasn't prevented) specifically so the
// existing Buckets-tab `tabPress` listener (Checkpoint 3C navigation
// review fix - returns to the Bucket list when already on a Bucket
// Detail screen) keeps firing correctly through this custom bar, not
// just the default one it replaces.
import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, useTheme } from "react-native-paper";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useRouter } from "expo-router";

import { cardShadowFor, mintGlowFor, radii, spacing } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { CreateActionSheet } from "./CreateActionSheet";

const VISIBLE_TABS: {
  name: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
}[] = [
  { name: "home", label: "Home", icon: "home-variant-outline" },
  { name: "buckets", label: "Buckets", icon: "chart-donut" },
  { name: "trips", label: "Trips", icon: "airplane" },
  { name: "profile", label: "Profile", icon: "account-circle-outline" },
];

export function BottomNav({ state, navigation }: BottomTabBarProps) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const focusedRouteName = state.routes[state.index]?.name;

  const leftTabs = VISIBLE_TABS.slice(0, 2);
  const rightTabs = VISIBLE_TABS.slice(2);

  const renderTab = (tab: (typeof VISIBLE_TABS)[number]) => {
    const route = state.routes.find((r) => r.name === tab.name);
    const isFocused = focusedRouteName === tab.name;
    const color = isFocused ? colors.mintText : colors.textMuted;

    const onPress = () => {
      if (!route) return;
      const event = navigation.emit({
        type: "tabPress",
        target: route.key,
        canPreventDefault: true,
      });
      if (!isFocused && !event.defaultPrevented) {
        navigation.navigate(route.name);
      }
    };

    return (
      <Pressable
        key={tab.name}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={tab.label}
        accessibilityState={{ selected: isFocused }}
        style={styles.tabButton}
      >
        <View
          style={[
            styles.tabIconWrap,
            isFocused && { backgroundColor: colors.mintSurface },
          ]}
        >
          <MaterialCommunityIcons name={tab.icon} size={22} color={color} />
        </View>
        <Text style={[styles.tabLabel, { color }]}>{tab.label}</Text>
      </Pressable>
    );
  };

  return (
    <View
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
      pointerEvents="box-none"
    >
      <View
        style={[
          styles.bar,
          { backgroundColor: theme.colors.surface, borderColor: colors.border },
          // Checkpoint 3F.3A.1: an extremely subtle shadow in Light Mode
          // only, for a touch of separation from the page behind it.
          // Dark Mode is unchanged - it never had a bar shadow.
          theme.dark ? null : cardShadowFor(false),
        ]}
      >
        {leftTabs.map(renderTab)}
        {/* Reserves space for the floating center button below. */}
        <View style={styles.centerSpacer} />
        {rightTabs.map(renderTab)}
      </View>

      <Pressable
        onPress={() => setCreateOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Create"
        style={({ pressed }) => [
          styles.centerButton,
          { backgroundColor: colors.mint },
          // Checkpoint 3F.3A.1: Dark Mode keeps its original full-
          // intensity glow; Light Mode uses a visibly softer one - the
          // dark-tuned glow read as neon against the light page.
          theme.dark ? mintGlowFor(colors.mint) : mintGlowFor(colors.mint, { opacity: 0.22, radius: 8, elevation: 3 }),
          pressed && { opacity: 0.9 },
        ]}
      >
        <MaterialCommunityIcons name="plus" size={28} color={colors.onMint} />
      </Pressable>

      <CreateActionSheet
        visible={createOpen}
        onDismiss={() => setCreateOpen(false)}
        onNewBucket={() => {
          setCreateOpen(false);
          router.push({ pathname: "/(tabs)/buckets", params: { openCreate: "1" } });
        }}
        onNewTrip={() => {
          setCreateOpen(false);
          router.push("/(tabs)/trips/create");
        }}
      />
    </View>
  );
}

// Checkpoint 3F.2A polish: tighter bar/button sizing, closer to the
// approved reference's proportions.
//
// Checkpoint 3F.3B.4B: exported (appearance/values unchanged) so a
// screen with content that must scroll clear of this floating nav can
// compute a real bottom clearance from these actual dimensions instead
// of guessing an unrelated magic number - see
// app/(tabs)/trips/[tripId].tsx for the first consumer.
export const BAR_HEIGHT = 56;
export const CENTER_BUTTON_SIZE = 52;

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    height: BAR_HEIGHT,
    borderRadius: radii.xl,
    borderWidth: 1,
    paddingHorizontal: spacing.xs,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    minHeight: 44,
  },
  tabIconWrap: {
    width: 34,
    height: 26,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: { fontSize: 10, fontWeight: "600" },
  centerSpacer: { width: CENTER_BUTTON_SIZE - 10 },
  centerButton: {
    position: "absolute",
    alignSelf: "center",
    bottom: BAR_HEIGHT - CENTER_BUTTON_SIZE / 2 + 4,
    width: CENTER_BUTTON_SIZE,
    height: CENTER_BUTTON_SIZE,
    borderRadius: CENTER_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
