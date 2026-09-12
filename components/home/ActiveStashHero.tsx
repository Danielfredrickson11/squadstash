// Shared visual centerpiece for the user's first/most relevant real Trip
// - used by both Home and the Trips tab (Milestone 3 Checkpoint 3F.2;
// substantially brightened in Checkpoint 3F.3A.1 - the approved Light
// Mode mockup treats travel photography as the strongest color moment,
// and the original scrim covered nearly the whole photo). Reuses the
// exact same fallback-image strategy app/(tabs)/trips/index.tsx already
// uses (imageUrl, or the same FALLBACK_IMAGE constant on load failure) -
// no new image fetching added. Approximates a bottom-weighted dark
// gradient with two stacked translucent Views (no new gradient
// dependency) rather than a flat single-opacity overlay, and only covers
// the lower portion of the image - the top ~55% is left fully bright,
// with the top badges carrying their own opaque-enough pill backgrounds
// instead of relying on a full-width top scrim.
//
// Never fabricates funding dates, "on track" status, or scheduled-
// contribution copy - only real trip.title/location/memberIds/saved/
// target are rendered. Member count comes straight off the already-
// fetched Trip document.
//
// Checkpoint 3F.3B.1: 3F.3B bumped the height (200 -> 240px) and added a
// visual-only "View Trip >" CTA pill, but that was intended for the
// Trips tab only - Home was explicitly frozen that checkpoint, and this
// component is shared. `variant` ("home" | "trips", default "home")
// isolates the two presentations without duplicating the component:
// Home gets back its pre-3F.3B 200px height and no CTA; Trips explicitly
// passes variant="trips" (a plain View, not a nested Pressable, matching
// EmptyAdventureHero's identical pattern - the whole card is already one
// Pressable, and nesting a second on React Native Web risks a
// double-fire). Real data, real single-Pressable navigation, the
// bright-image/scrim treatment, and the platform-aware numberOfLines fix
// are unchanged and shared by both.
//
// Checkpoint 3F.3B.2: the Trips variant's height was found too visually
// dominant at 240px and is reduced back to ~200px (density pass only -
// Home's own 200px was and remains independently controlled). Also adds
// a compact real-date line (via src/domain/tripDates.ts's
// formatTripDates) between location and the financial card, when
// trip.tripStartDate exists - omitted entirely for a legacy trip with no
// stored date, never a fabricated one.
import React, { useState } from "react";
import { Image, Platform, Pressable, StyleSheet, View } from "react-native";
import { ProgressBar, Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { formatTripDates } from "../../src/domain/tripDates";
import { radii, spacing, typography } from "../../src/theme/tokens";
import type { Trip } from "../../src/types/domain";
import { formatCurrency } from "../../utils/format";

// Checkpoint 3F.3A: this hero always composites over a real trip photo
// with a localized dark scrim (see the overlay styles below) for
// legibility, independent of whether the app theme is Light or Dark -
// so its badge/progress accent stays the same bright mint-on-dark-tint
// treatment in both themes, rather than switching to Light Mode's
// deeper `mintText`/opaque `mintSurface` (which are tuned for pale
// surfaces, not a dark photo scrim).
const PHOTO_MINT = "#45F0AE";
const PHOTO_NAVY = "#0B1F33";

// Checkpoint 3F.2C.2/3F.3B: numberOfLines={1} on web triggers React
// Native Web's single-line-truncation CSS path, which a controlled
// runtime test (Checkpoint 3F.2C.1, applied to BucketGridCard/
// BucketPreviewCard) proved can clip text to zero visible width when its
// ancestor's width is indeterminate. This hero's title/location sit
// inside `bottomContent`, whose left+right (not width) absolute
// positioning already gives it a definite width, so the bug's precise
// trigger condition isn't present here the way it was for those cards -
// but per the Trips checkpoint's explicit caution against unconditional
// numberOfLines={1} on web, this uses the same proven platform-aware
// pattern anyway rather than relying on that structural difference.
const NAME_NUMBER_OF_LINES = Platform.OS === "web" ? undefined : 1;

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=60";

export function ActiveStashHero({
  trip,
  onPress,
  variant = "home",
}: {
  trip: Trip;
  onPress: () => void;
  // Checkpoint 3F.3B.1: "home" restores the pre-3F.3B presentation
  // (default, so Home's existing call site needs no change); "trips" is
  // the taller Checkpoint 3F.3B treatment with the CTA pill. See the
  // module comment above.
  variant?: "home" | "trips";
}) {
  const [imgFailed, setImgFailed] = useState(false);

  const title = trip.title?.trim() || "Untitled trip";
  const location = trip.location?.trim();
  const dateText = formatTripDates(trip.tripStartDate, trip.tripEndDate);
  const saved = Number(trip.saved ?? 0);
  const target = Number(trip.target ?? 0);
  const pct = target > 0 ? Math.min(Math.max(saved / target, 0), 1) : 0;
  const memberCount = trip.memberIds?.length ?? 0;

  const uri = !imgFailed && trip.imageUrl ? trip.imageUrl : FALLBACK_IMAGE;

  const heroHeight = variant === "trips" ? TRIPS_HERO_HEIGHT : HOME_HERO_HEIGHT;
  const showCta = variant === "trips";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title} details`}
      style={({ pressed }) => [styles.card, { height: heroHeight }, pressed && { opacity: 0.97 }]}
    >
      <Image
        source={{ uri }}
        style={styles.image}
        resizeMode="cover"
        onError={() => setImgFailed(true)}
      />

      <View
        pointerEvents="none"
        style={[styles.overlayBottomWide, { height: heroHeight * 0.55 }]}
      />
      <View
        pointerEvents="none"
        style={[styles.overlayBottomStrong, { height: heroHeight * 0.3 }]}
      />

      <View style={styles.topRow}>
        <View style={[styles.badge, styles.mintBadge]}>
          <Text style={[styles.badgeText, { color: PHOTO_MINT }]}>ACTIVE STASH</Text>
        </View>
        {memberCount > 0 ? (
          <View style={[styles.badge, styles.memberBadge]}>
            <MaterialCommunityIcons name="account-multiple" size={12} color="#FFFFFF" />
            <Text style={styles.memberBadgeText}>{memberCount}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.bottomContent}>
        <Text style={styles.title} numberOfLines={NAME_NUMBER_OF_LINES}>
          {title}
        </Text>
        {location ? (
          <Text style={styles.location} numberOfLines={NAME_NUMBER_OF_LINES}>
            {location}
          </Text>
        ) : null}

        {dateText ? (
          <View style={styles.dateRow}>
            <MaterialCommunityIcons
              name="calendar-blank-outline"
              size={11}
              color="rgba(255,255,255,0.75)"
            />
            <Text style={styles.dateText} numberOfLines={1}>
              {dateText}
            </Text>
          </View>
        ) : null}

        <View style={[styles.financialCard, { backgroundColor: "rgba(20,27,45,0.82)" }]}>
          <View style={styles.amountRow}>
            <Text style={styles.savedAmount}>{formatCurrency(saved)}</Text>
            <Text style={styles.targetAmount}> / {formatCurrency(target)}</Text>
          </View>
          <ProgressBar
            progress={pct}
            style={[styles.progress, { backgroundColor: "rgba(255,255,255,0.14)" }]}
            color={PHOTO_MINT}
          />
          <View style={styles.bottomRow}>
            <Text style={styles.pctText}>{Math.round(pct * 100)}% funded</Text>
            {/* Checkpoint 3F.3B.1: Trips-only CTA - a plain View, not a
                nested Pressable (see the module comment above); the
                whole card is already tappable and routes to the same
                real Trip Detail. Home (variant="home", the default)
                never renders this, restoring its pre-3F.3B presentation. */}
            {showCta ? (
              <View style={styles.ctaPill}>
                <Text style={styles.ctaText}>View Trip</Text>
                <MaterialCommunityIcons name="chevron-right" size={14} color={PHOTO_NAVY} />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// Checkpoint 3F.3B.1/3F.3B.2: per-variant heights - the height (and the
// two scrim bands, which scale off it) are applied inline per render
// based on `variant` rather than baked into StyleSheet.create, since the
// two presentations now differ. HOME_HERO_HEIGHT is the original
// pre-3F.3B value, restored exactly and independently controlled.
// TRIPS_HERO_HEIGHT was 240 in 3F.3B but found too visually dominant in
// review - reduced to 200 (3F.3B.2's approved ~195-205px density pass).
const HOME_HERO_HEIGHT = 200;
const TRIPS_HERO_HEIGHT = 200;

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    overflow: "hidden",
    position: "relative",
  },
  image: { width: "100%", height: "100%", position: "absolute" },
  // Checkpoint 3F.3A.1: a two-band graduated scrim confined to the lower
  // portion of the photo only (the top ~55% is left untouched/bright) -
  // much lighter than the previous single overlayTop+overlayBottom pair,
  // which darkened nearly the entire image. Heights are applied inline
  // (see the component above) since they scale with the per-variant
  // hero height.
  overlayBottomWide: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(9,14,26,0.2)",
  },
  overlayBottomStrong: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(9,14,26,0.42)",
  },

  topRow: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  badgeText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  // Own opaque-enough dark pill (rather than relying on a full-width top
  // scrim, now removed) so the ACTIVE STASH label stays legible however
  // bright the photo behind it is.
  mintBadge: { backgroundColor: "rgba(9,14,26,0.55)" },
  memberBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  memberBadgeText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },

  bottomContent: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
  },
  title: { ...typography.headline, fontSize: 22, color: "#FFFFFF" },
  location: { ...typography.body, color: "rgba(255,255,255,0.78)", marginTop: 2 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  dateText: { fontSize: 11, fontWeight: "600", color: "rgba(255,255,255,0.75)" },

  // Checkpoint 3F.3B.2: tightened padding/marginTop (was spacing.md/
  // spacing.sm) as part of the shorter 200px Trips hero density pass -
  // still comfortable, not "tiny" text, just less surrounding air.
  financialCard: {
    borderRadius: radii.md,
    padding: spacing.sm,
    marginTop: spacing.xs,
  },
  amountRow: { flexDirection: "row", alignItems: "baseline", marginBottom: spacing.xs },
  savedAmount: { fontSize: 20, fontWeight: "800", color: "#FFFFFF" },
  targetAmount: { fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.7)" },
  progress: { height: 6, borderRadius: radii.pill },
  pctText: { ...typography.meta, color: "rgba(255,255,255,0.78)" },

  bottomRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  ctaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  ctaText: { fontSize: 11, fontWeight: "700", color: PHOTO_NAVY },
});
