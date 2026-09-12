// "TOTAL STASHED" hero card (Milestone 3 Checkpoint 3F.2; made a fixed
// dark-navy premium card regardless of the active app theme in Checkpoint
// 3F.3A - the approved Light Mode mockup calls for a dark navy hero here
// specifically, matching item 1 of the approved palette ("Deep Navy ...
// Total Stashed hero"), so this card intentionally does NOT switch to a
// white surface in Light Mode). Shows the real sum of the user's
// Personal Savings bucket balances - the same `totalSaved` value Home
// already computed pre-3F.2, passed in as a prop.
//
// The real "vs. last month" balance-change metric on the right side is
// computed entirely in src/domain/monthlyStashChange.ts from real ledger
// data (Checkpoint 3F.3A.2) - this component only renders whatever
// `monthlyChange` it is given and NEVER fabricates a number:
// `status !== "available"` (still loading, no history yet, or a
// genuinely non-meaningful 0/0 case) renders nothing on the right at
// all, and `status === "new"` renders the truthful "New this month" pill
// instead of a percentage a brand-new bucket can't mathematically have.
//
// Checkpoint 3F.3A.3: matched to the final approved visual reference -
// a more compact card, the monthly-change block repositioned to align
// with the amount (not the small label) roughly mid-card, and the
// previous CSS-triangle "mountain" decor replaced with smooth Bezier SVG
// contours (react-native-svg, added this checkpoint - see the report for
// why/compatibility).
import React from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import Svg, { Path } from "react-native-svg";

import type { MonthlyStashChange } from "../../src/domain/monthlyStashChange";
import { navyHeroShadow, radii, spacing, typography } from "../../src/theme/tokens";
import { useSemanticColors } from "../../src/theme/useSemanticColors";
import { formatCurrency } from "../../utils/format";

// This card is always dark-navy regardless of app theme (see the module
// comment above), so its accent colors are fixed literals rather than
// theme-switched semantic tokens - the same reasoning already applied to
// the photo-composited hero cards (ActiveStashHero/EmptyAdventureHero).
const PILL_MINT_BG = "rgba(69,240,174,0.16)";
const PILL_MINT_TEXT = "#45F0AE";
const PILL_NEGATIVE_BG = "rgba(255,107,104,0.14)";
const PILL_NEGATIVE_TEXT = "#FF9B98";
const PILL_NEUTRAL_BG = "rgba(255,255,255,0.10)";
const PILL_NEUTRAL_TEXT = "rgba(247,249,252,0.85)";
const CAPTION_COLOR = "rgba(247,249,252,0.6)";

// Decorative mountain-contour fills - blue/teal tones only, never the
// signature bright mint (that stays reserved for the real up/positive
// pill so it isn't diluted by decoration). Checkpoint 3F.3A.4 retuned
// these to the approved reference's values - clearly visible contours
// that are still faded, not competing with the amount or the pill.
const MOUNTAIN_BACK = "rgba(65,145,190,0.10)";
const MOUNTAIN_MID = "rgba(75,160,200,0.12)";
const MOUNTAIN_FRONT = "rgba(85,175,205,0.14)";
// Checkpoint 3F.3A.4: an extremely subtle stroke on the back layer only,
// for the faint smooth contour-line feeling visible in the approved
// reference - not applied to the mid/front layers, which stay fill-only.
const MOUNTAIN_BACK_STROKE = "rgba(90,190,215,0.14)";

function formatPercent(percentChange: number): string {
  const rounded = Math.abs(percentChange).toFixed(1);
  const sign = percentChange > 0 ? "+" : percentChange < 0 ? "-" : "";
  return `${sign}${rounded}%`;
}

function MonthlyChangePill({ monthlyChange }: { monthlyChange: MonthlyStashChange | null }) {
  if (!monthlyChange) return null;

  if (monthlyChange.status === "new") {
    return (
      <View style={[styles.pill, { backgroundColor: PILL_MINT_BG }]}>
        <Text style={[styles.pillText, { color: PILL_MINT_TEXT }]}>New this month</Text>
      </View>
    );
  }

  if (monthlyChange.status !== "available" || monthlyChange.percentChange === null) {
    // "unavailable" - genuinely nothing truthful to show (history
    // couldn't be fetched, or both months are $0) - omit rather than
    // invent, per the monthly-change checkpoint's explicit requirement.
    return null;
  }

  const { direction, percentChange } = monthlyChange;
  const pillStyle =
    direction === "up"
      ? { backgroundColor: PILL_MINT_BG }
      : direction === "down"
        ? { backgroundColor: PILL_NEGATIVE_BG }
        : { backgroundColor: PILL_NEUTRAL_BG };
  const textColor =
    direction === "up" ? PILL_MINT_TEXT : direction === "down" ? PILL_NEGATIVE_TEXT : PILL_NEUTRAL_TEXT;
  const arrow = direction === "up" ? "↑ " : direction === "down" ? "↓ " : "";

  return (
    <>
      <View style={[styles.pill, pillStyle]}>
        <Text style={[styles.pillText, { color: textColor }]}>
          {arrow}
          {formatPercent(percentChange)}
        </Text>
      </View>
      <Text style={styles.caption}>vs. last month</Text>
    </>
  );
}

// Smooth, layered Bezier mountain/wave contours - purely decorative
// landscape motif (SquadStash's travel/adventure identity), deliberately
// NOT shaped like a line/stock-performance chart (these are filled
// silhouettes rising from the card's bottom edge, not a stroked line
// with data-point vertices). Three overlapping layers, back-to-front,
// each a closed Path (curves across, then straight down/across to close
// against the card's bottom-right corner) so every layer reads as solid
// ground, not a graph line.
//
// Checkpoint 3F.3A.4: reshaped from the previous pass, whose peaks
// stayed compressed near the card's floor (reading as stacked waves) -
// each layer now uses one long gradual rise, a broad rounded peak, a
// smooth descent, and a second, taller rounded peak toward the right
// before tapering to the edge - broader/more natural slopes, not
// repeated small humps. Approximate peak heights (viewBox y, smaller =
// higher): back ~18-35, middle ~42-47, front ~60-61, matching the
// approved reference's "mountains rise into the card" proportions.
function MountainContours() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 320 100" preserveAspectRatio="xMaxYMax slice">
      <Path
        d="M0,92 C35,88 55,67 82,53 C108,40 128,51 150,58 C175,66 195,53 220,35 C244,18 263,20 281,34 C294,43 306,48 320,46 L320,100 L0,100 Z"
        fill={MOUNTAIN_BACK}
        stroke={MOUNTAIN_BACK_STROKE}
        strokeWidth={0.9}
      />
      <Path
        d="M20,96 C55,90 78,72 105,64 C130,57 150,70 176,72 C205,74 226,53 250,47 C272,42 293,56 320,61 L320,100 L20,100 Z"
        fill={MOUNTAIN_MID}
      />
      <Path
        d="M55,100 C85,92 108,78 134,73 C158,69 179,82 204,80 C228,78 250,63 272,61 C293,60 307,68 320,72 L320,100 L55,100 Z"
        fill={MOUNTAIN_FRONT}
      />
    </Svg>
  );
}

export function TotalStashedCard({
  totalSaved,
  monthlyChange = null,
}: {
  totalSaved: number;
  monthlyChange?: MonthlyStashChange | null;
}) {
  const colors = useSemanticColors();
  const showMonthlyChange =
    monthlyChange != null &&
    (monthlyChange.status === "new" ||
      (monthlyChange.status === "available" && monthlyChange.percentChange !== null));

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.navy, borderColor: colors.navyStrong },
        // Checkpoint 3F.3A.1: the generic dark-card shadow (opacity 0.28,
        // tuned for a dark card on a dark background) read as a heavy
        // gray halo on the light page - navyHeroShadow() is a dedicated,
        // much lighter preset for this always-navy card.
        navyHeroShadow(),
      ]}
    >
      {/* Decorative only: non-interactive, sits behind all text (z-order
          1 = card background, 2 = this, 3 = content below), anchored
          bottom-right and capped with maxWidth/maxHeight so it stays a
          bounded corner accent rather than stretching across a wide
          desktop card. */}
      <View pointerEvents="none" style={styles.mountainWrap}>
        <MountainContours />
      </View>

      <View style={styles.row}>
        <View style={styles.leftCol}>
          <Text style={[styles.label, { color: "rgba(247,249,252,0.72)" }]}>
            TOTAL STASHED
          </Text>
          <Text style={[styles.value, { color: "#FFFFFF" }]}>
            {formatCurrency(totalSaved)}
          </Text>
        </View>

        {showMonthlyChange ? (
          <View style={styles.rightCol}>
            <MonthlyChangePill monthlyChange={monthlyChange} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    // Checkpoint 3F.3A.3: more compact - target ~90-105px tall at mobile
    // width rather than a screen-dependent height. minHeight (not a
    // fixed height) keeps layout stable while still letting content size
    // naturally if text scaling makes it taller.
    minHeight: 96,
    justifyContent: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    overflow: "hidden",
    position: "relative",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    // Center-aligning the two columns (rather than flex-start) is what
    // pulls the right block down off the very top of the card and keeps
    // it responsive to content height changes (e.g. the single-line "New
    // this month" pill vs. the two-line percent+caption block) without
    // any fragile absolute-position math.
    alignItems: "center",
    gap: spacing.sm,
  },
  leftCol: { flexShrink: 1 },
  // Checkpoint 3F.3A.3: pushed down further than the previous pass so
  // the block's vertical center lands closer to the AMOUNT's own center
  // than to the small TOTAL STASHED label above it, matching the
  // approved reference ("align with the amount rather than the label").
  rightCol: { alignItems: "flex-end", marginTop: spacing.md + 2 },

  label: { ...typography.meta, textTransform: "uppercase", letterSpacing: 0.8 },
  value: { ...typography.majorValue, fontSize: 28, marginTop: 2 },

  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  pillText: { fontSize: 12, fontWeight: "700" },
  caption: { ...typography.meta, fontSize: 11, color: CAPTION_COLOR, marginTop: spacing.xs },

  // Checkpoint 3F.3A.4: enlarged from 62%/78% so the landscape occupies
  // more of the card's lower-right half (beginning roughly around the
  // card's horizontal middle) rather than hugging only the bottom-right
  // corner - still capped so it can't stretch oddly on a wide desktop
  // card, and still comfortably clear of the left-side amount.
  mountainWrap: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: "75%",
    height: "96%",
    maxWidth: 320,
    maxHeight: 110,
  },
});
