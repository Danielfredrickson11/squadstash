// Pure, client-side category icon selection for a Personal Savings
// Bucket (Milestone 3 Checkpoint 3F.2). The Bucket domain type has no
// category/type field (see src/types/domain/bucket.ts) - this is a
// deterministic keyword match against the bucket's own real name, never
// fabricated data, shared by BucketCard and Bucket Detail so both
// surfaces pick the same icon for the same bucket instead of duplicating
// the mapping. Falls back to a generic goal icon for anything
// unrecognized.
import type { MaterialCommunityIcons } from "@expo/vector-icons";
import type { ComponentProps } from "react";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const KEYWORD_ICONS: { keywords: string[]; icon: IconName }[] = [
  { keywords: ["rent", "mortgage", "apartment", "lease", "utilit"], icon: "home-city-outline" },
  { keywords: ["vacation", "trip", "travel", "holiday"], icon: "palm-tree" },
  { keywords: ["emergency"], icon: "shield-check-outline" },
  { keywords: ["car", "auto", "vehicle"], icon: "car-outline" },
  { keywords: ["home", "house"], icon: "home-outline" },
  { keywords: ["health", "medical", "dental"], icon: "heart-pulse" },
  { keywords: ["food", "grocery", "groceries", "dining"], icon: "silverware-fork-knife" },
  { keywords: ["school", "education", "tuition", "college"], icon: "school-outline" },
  { keywords: ["gift", "present"], icon: "gift-outline" },
  { keywords: ["wedding"], icon: "ring" },
  { keywords: ["pet", "dog", "cat"], icon: "paw-outline" },
  { keywords: ["baby", "nursery"], icon: "baby-face-outline" },
];

const DEFAULT_ICON: IconName = "bullseye-arrow";

export function bucketIconForName(name: string | undefined): IconName {
  const normalized = (name ?? "").trim().toLowerCase();
  if (!normalized) return DEFAULT_ICON;

  for (const entry of KEYWORD_ICONS) {
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) {
      return entry.icon;
    }
  }

  return DEFAULT_ICON;
}

// Checkpoint 3F.3A/3F.3A.1: the approved Light Mode palette is
// intentionally restrained (mint / blue / slate only - no per-bucket
// rainbow accents), and the approved mockup shows controlled VARIATION
// across cards (card 1 mint, card 2 blue, card 3 slate, repeating) rather
// than every card collapsing to the same accent. The 8-swatch
// AccentColorPicker and each bucket's stored `color` field are
// UNCHANGED - a user can still pick any of those 8 colors, and the exact
// value is still what's saved to Firestore; this function only decides
// which of the three restrained accents a given card POSITION should be
// DISPLAYED with in Light Mode, so existing bucket data never needs to
// be mutated for presentation. Dark Mode is untouched and keeps showing
// each bucket's real stored color exactly as Checkpoint 3F.2 always has
// (an earlier 3F.3A attempt mapped the restrained accent from the
// stored color's hue instead of position - that produced the reported
// "everything looks slate" bug whenever several real buckets happened to
// share a color that hashed to the slate bucket; position-based rotation
// can't collapse like that).
const RESTRAINED_ACCENT_SEQUENCE: readonly ("mint" | "blue" | "slate")[] = [
  "mint",
  "blue",
  "slate",
];

export type BucketAccentPresentation = {
  // Strong accent - icon color and progress-bar fill color.
  icon: string;
  // Pale tint - icon-bubble background.
  pale: string;
};

export function bucketAccentPresentation(
  index: number,
  storedColor: string | null | undefined,
  isDark: boolean,
  colors: {
    mint: string;
    mintText: string;
    mintSurface: string;
    blue: string;
    bluePale: string;
    textSecondary: string;
    slatePale: string;
  }
): BucketAccentPresentation {
  if (isDark) {
    // Dark Mode (Checkpoint 3F.2) is preserved exactly - real stored
    // bucket colors, no restrained-palette mapping/rotation.
    const raw = storedColor ?? colors.blue;
    return { icon: raw, pale: `${raw}22` };
  }

  const category = RESTRAINED_ACCENT_SEQUENCE[((index % 3) + 3) % 3];
  switch (category) {
    case "mint":
      return { icon: colors.mintText, pale: colors.mintSurface };
    case "blue":
      return { icon: colors.blue, pale: colors.bluePale };
    case "slate":
    default:
      return { icon: colors.textSecondary, pale: colors.slatePale };
  }
}
