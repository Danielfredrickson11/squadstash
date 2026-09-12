// Premium empty-state hero for "no real trips yet" (Milestone 3
// Checkpoint 3F.2A), shared by Home and Trips so both surfaces present
// the same rich, on-brand empty state instead of a plain icon-and-text
// card. Uses the same tasteful generic/fallback travel image the rest of
// the app already relies on for a missing/failed trip.imageUrl (see
// ActiveStashHero/OtherTripCard's own FALLBACK_IMAGE) - not a new image
// source. Never fabricates a title, location, saved amount, member
// count, or progress: this is decorative empty-state presentation only,
// with real copy and a real navigation target (existing Trip creation),
// not a fake trip.
import React from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { radii, spacing, typography } from "../../src/theme/tokens";

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=60";

// Checkpoint 3F.3A: see the identical note in
// components/home/ActiveStashHero.tsx - this icon bubble sits on top of
// a fixed dark photo scrim in both themes, so it keeps the same bright
// mint-on-dark-tint treatment regardless of Light/Dark Mode.
const PHOTO_MINT = "#45F0AE";
const PHOTO_MINT_SURFACE = "rgba(69,240,174,0.12)";
// Deep navy for the CTA pill's text/icon - the pill itself is always a
// solid white/light control regardless of app theme (Checkpoint
// 3F.3A.1), so its text stays this fixed navy rather than switching with
// Light/Dark Mode, matching the approved mockup's "white pill, deep navy
// text" CTA treatment.
const PHOTO_NAVY = "#0B1F33";

export function EmptyAdventureHero({
  onPress,
  height = 200,
}: {
  onPress: () => void;
  height?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Plan your first adventure"
      style={({ pressed }) => [styles.card, { height }, pressed && { opacity: 0.96 }]}
    >
      <Image source={{ uri: FALLBACK_IMAGE }} style={styles.image} resizeMode="cover" />
      {/* Checkpoint 3F.3A.1: substantially lighter than the original
          0.68-opacity full-card scrim - the approved Light Mode mockup
          wants the photo itself bright/inviting, with just enough tint
          for the centered white title/subtitle to stay legible. */}
      <View pointerEvents="none" style={styles.overlay} />

      <View style={styles.content}>
        <View style={[styles.iconBubble, { backgroundColor: PHOTO_MINT_SURFACE }]}>
          <MaterialCommunityIcons name="compass-outline" size={22} color={PHOTO_MINT} />
        </View>
        <Text style={styles.title}>Plan your first adventure</Text>
        <Text style={styles.subtitle}>Create a trip and start stashing together.</Text>

        {/* Checkpoint 3F.3A.1: the approved mockup's visible "Create a
            Trip >" CTA, restored. This is a plain View, not a nested
            Pressable - the whole card above is already one Pressable
            wired to the same real Trip-creation route, and nesting a
            second Pressable inside it risks a double-fire on React
            Native Web (whose Pressable uses ordinary DOM event bubbling,
            unlike native's exclusive responder system). Tapping the
            pill's exact pixels still calls the real onPress, since it's
            inside the single outer Pressable's hit area - no dead
            button. */}
        <View style={styles.ctaPill}>
          <Text style={styles.ctaText}>Create a Trip</Text>
          <MaterialCommunityIcons name="chevron-right" size={16} color={PHOTO_NAVY} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    overflow: "hidden",
    position: "relative",
  },
  image: { width: "100%", height: "100%", position: "absolute" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(9,14,26,0.4)",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  iconBubble: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: { ...typography.sectionTitle, color: "#FFFFFF" },
  subtitle: {
    ...typography.body,
    color: "rgba(255,255,255,0.8)",
    marginTop: spacing.xs,
    textAlign: "center",
  },
  ctaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    marginTop: spacing.md,
  },
  ctaText: { fontSize: 13, fontWeight: "700", color: PHOTO_NAVY },
});
