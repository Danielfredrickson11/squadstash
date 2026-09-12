// Compact "Other Stashes" row card for the Trips screen (Milestone 3
// Checkpoint 3F.2; Light Mode-matched in Checkpoint 3F.3B) - every real
// trip after the first/most relevant one shown by ActiveStashHero.
// Thumbnail, title, location, saved amount, progress, percentage,
// chevron. Tapping opens the existing Trip Detail route; no new query or
// Trips backend behavior.
//
// Checkpoint 3F.2A containment fix: the outer row is a plain View, not a
// Pressable wrapping every child - only title/location/amountRow are
// inside the tappable Pressable, and the progress bar is a sibling View
// after it closes. Same root cause/fix as
// components/buckets/BucketGridCard.tsx: a Pressable wrapping several
// stacked rows didn't reliably contain all of its children's natural
// height on React Native Web (the Checkpoint 3D intrinsic-layout bug
// class) - this file hadn't yet shown the symptom (no real trips existed
// to render it against), so this is a proactive application of the same
// proven fix rather than a reported regression here.
import React, { useState } from "react";
import { Image, Platform, Pressable, StyleSheet, View } from "react-native";
import { ProgressBar, Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { formatTripDates } from "../../src/domain/tripDates";
import { cardShadowFor, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import type { Trip } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=60";

// Checkpoint 3F.2C.2's permanent fix, applied here for the first time
// (Checkpoint 3F.3B): numberOfLines={1} on web triggers React Native
// Web's single-line-truncation CSS path, which a controlled runtime test
// proved can clip a Text to zero visible width when its Pressable
// ancestor has no definite width - exactly this card's previous
// structure (`pressable` had no explicit width). Fixed the same
// two-part way as BucketGridCard/BucketPreviewCard: numberOfLines is
// platform-aware (web wraps naturally instead), and `pressable` now has
// width:"100%" for a definite ancestor width regardless.
const NAME_NUMBER_OF_LINES = Platform.OS === "web" ? undefined : 1;

export function OtherTripCard({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const theme = useTheme();
  const colors = useSemanticColors();
  const [imgFailed, setImgFailed] = useState(false);

  const title = trip.title?.trim() || "Untitled trip";
  const location = trip.location?.trim();
  const dateText = formatTripDates(trip.tripStartDate, trip.tripEndDate);
  const saved = Number(trip.saved ?? 0);
  const target = Number(trip.target ?? 0);
  const pct = target > 0 ? Math.min(Math.max(saved / target, 0), 1) : 0;

  const uri = !imgFailed && trip.imageUrl ? trip.imageUrl : FALLBACK_IMAGE;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: colors.border },
        theme.dark ? null : cardShadowFor(false),
      ]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open ${title} details`}
        style={({ pressed }) => [styles.pressable, pressed && { opacity: 0.96 }]}
      >
        <Image
          source={{ uri }}
          style={styles.thumb}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />

        <View style={styles.body}>
          <Text
            style={[styles.title, { color: theme.colors.onSurface }]}
            numberOfLines={NAME_NUMBER_OF_LINES}
          >
            {title}
          </Text>
          {location ? (
            <Text
              style={[styles.location, { color: theme.colors.onSurfaceVariant }]}
              numberOfLines={NAME_NUMBER_OF_LINES}
            >
              {location}
            </Text>
          ) : null}

          {dateText ? (
            <Text
              style={[styles.dateText, { color: theme.colors.onSurfaceVariant }]}
              numberOfLines={1}
            >
              {dateText}
            </Text>
          ) : null}

          <View style={styles.amountRow}>
            <Text style={[styles.savedAmount, { color: theme.colors.onSurface }]}>
              {formatCurrency(saved)}
            </Text>
            <Text style={[styles.pctText, { color: theme.colors.onSurfaceVariant }]}>
              {Math.round(pct * 100)}%
            </Text>
          </View>
        </View>

        <MaterialCommunityIcons
          name="chevron-right"
          size={20}
          color={theme.colors.onSurfaceVariant}
        />
      </Pressable>

      <ProgressBar
        progress={pct}
        style={[styles.progress, { backgroundColor: colors.surfaceTertiary }]}
        color={theme.colors.primary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.sm,
  },
  pressable: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    // Checkpoint 3F.3B root cause fix - see the platform-aware
    // numberOfLines note above. width:'100%' gives this Pressable a
    // definite ancestor width for numberOfLines' web CSS path to resolve
    // against on native, and is harmless/inert on web now that
    // numberOfLines is omitted there.
    width: "100%",
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
  },
  body: { flex: 1 },
  title: { ...typography.cardTitle },
  location: { ...typography.meta, marginTop: 1 },
  // Checkpoint 3F.3B.2: compact, real trip-start date line - fontSize 10
  // (smaller than location's meta size) keeps this card from growing
  // materially taller when a date is present.
  dateText: { fontSize: 10, fontWeight: "600", marginTop: 1 },
  amountRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 2,
  },
  savedAmount: { fontSize: 14, fontWeight: "700" },
  pctText: { ...typography.meta, fontSize: 11 },
  progress: { height: 5, borderRadius: radii.pill, marginTop: spacing.sm },
});
