import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, View } from "react-native";
import { Button, Text, TextInput, useTheme } from "react-native-paper";

import { useAuth } from "../../../src/contexts/AuthContext";
import { createTrip } from "../../../src/services/firebase/trips";
import { isValidCanonicalDate, todayCanonicalDate } from "../../../src/domain/tripDates";
import { radii, spacing, typography } from "../../../src/theme/tokens";
import { useSemanticColors } from "../../../src/theme/useSemanticColors";

/** Turn "Scottsdale, Arizona, US" -> "scottsdale,arizona" (good for fallback tags) */
function normalizeLocation(location?: string | null) {
  const raw = (location ?? "").trim();
  if (!raw) return "travel";
  return raw
    .split(",")
    .slice(0, 2)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

/** Stable-ish fallback image (no key). `lock` helps keep it consistent for the same seed. */
function buildFallbackTripImageUrl(seed: string, location?: string | null, title?: string) {
  const loc = normalizeLocation(location);
  const t = (title ?? "").trim().toLowerCase();
  const tags = encodeURIComponent(`${loc},${t},travel`);

  // lock must be a number; derive one from seed
  const lock = Math.abs(seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0));
  return `https://loremflickr.com/1200/700/${tags}?lock=${lock}`;
}

/**
 * Try to fetch a relevant image for a place using Wikipedia (no API key).
 * Works on web because we use origin=*; works on native because CORS isn’t enforced the same way.
 */
async function tryGetWikipediaImage(queryText: string): Promise<string | null> {
  const q = queryText.trim();
  if (!q) return null;

  try {
    // 1) Search Wikipedia for the best matching page title
    const searchUrl =
      `https://en.wikipedia.org/w/api.php` +
      `?action=query&list=search&srlimit=1&format=json&origin=*` +
      `&srsearch=${encodeURIComponent(q)}`;

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;

    const searchJson = await searchRes.json();
    const first = searchJson?.query?.search?.[0];
    const title: string | undefined = first?.title;
    if (!title) return null;

    // 2) Pull the page summary which often includes a thumbnail/original image
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) return null;

    const summaryJson = await summaryRes.json();

    const img =
      summaryJson?.originalimage?.source ||
      summaryJson?.thumbnail?.source ||
      null;

    // Make sure it’s a usable http(s) URL
    if (typeof img === "string" && img.startsWith("http")) return img;

    return null;
  } catch (e) {
    console.log("Wikipedia image lookup failed:", e);
    return null;
  }
}

/** Parse target input safely (lets users type $3,000 etc.) */
function parseMoneyInput(input: string) {
  const cleaned = input.replace(/[^0-9.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

export default function CreateTripScreen() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const theme = useTheme();
  const colors = useSemanticColors();

  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  // Checkpoint 3F.3B.2: canonical "YYYY-MM-DD" calendar-date-only
  // strings, entered as plain text (no date-picker dependency was
  // already installed, and this checkpoint explicitly asks not to add a
  // large one just for styling - see the checkpoint report). tripStarts
  // is required for every trip created from this checkpoint forward;
  // tripEnds stays optional.
  const [tripStarts, setTripStarts] = useState("");
  const [tripEnds, setTripEnds] = useState("");
  const [target, setTarget] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const todayPlaceholder = todayCanonicalDate();

  const canSave = useMemo(() => {
    if (loading || !user) return false;
    if (!title.trim()) return false;
    if (!isValidCanonicalDate(tripStarts.trim())) return false;
    const t = parseMoneyInput(target);
    if (!Number.isFinite(t) || t <= 0) return false;
    return !submitting;
  }, [loading, user, title, tripStarts, target, submitting]);

  const onSave = async () => {
    if (loading || !user) return;

    const cleanTitle = title.trim();
    const cleanLocation = location.trim();
    const cleanStart = tripStarts.trim();
    const cleanEnd = tripEnds.trim();
    const t = parseMoneyInput(target);

    if (!cleanTitle) {
      setErr("Please enter a trip name.");
      return;
    }
    if (!isValidCanonicalDate(cleanStart)) {
      setErr("Enter a valid trip start date (YYYY-MM-DD).");
      return;
    }
    if (cleanStart < todayCanonicalDate()) {
      setErr("Trip start date cannot be before today.");
      return;
    }
    if (cleanEnd) {
      if (!isValidCanonicalDate(cleanEnd)) {
        setErr("Enter a valid trip end date (YYYY-MM-DD), or leave it blank.");
        return;
      }
      if (cleanEnd < cleanStart) {
        setErr("Trip end date cannot be before the start date.");
        return;
      }
    }
    if (!Number.isFinite(t) || t <= 0) {
      setErr("Target must be a number greater than 0.");
      return;
    }

    setSubmitting(true);
    setErr(null);

    try {
      // Seed for stable fallback image
      const seed = `${user.uid}-${cleanTitle}-${cleanLocation || "travel"}`;

      // ✅ Try location-matching Wikipedia image first; fallback to loremflickr
      const wikiQuery = cleanLocation || cleanTitle;
      const wikiImage = await tryGetWikipediaImage(wikiQuery);
      const imageUrl = wikiImage ?? buildFallbackTripImageUrl(seed, cleanLocation || null, cleanTitle);

      const tripId = await createTrip({
        title: cleanTitle,
        location: cleanLocation ? cleanLocation : null,
        target: t,
        imageUrl,
        ownerId: user.uid,
        tripStartDate: cleanStart,
        tripEndDate: cleanEnd ? cleanEnd : null,
      });

      router.replace(`/(tabs)/trips/${tripId}`);
    } catch (e) {
      console.error("Failed to create trip:", e);
      setErr("Failed to create trip (permissions or network).");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.contentWrap}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.title, { color: theme.colors.onSurface }]}>Create Trip</Text>
            <Text style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              Add a destination and target — then invite friends later.
            </Text>

            <View style={{ height: spacing.md }} />

            <TextInput
              mode="outlined"
              dense
              label="Trip name"
              value={title}
              onChangeText={(v) => {
                setTitle(v);
                if (err) setErr(null);
              }}
              style={styles.field}
            />

            <TextInput
              mode="outlined"
              dense
              label="Location (ex: Scottsdale, Arizona, US)"
              value={location}
              onChangeText={(v) => {
                setLocation(v);
                if (err) setErr(null);
              }}
              style={styles.field}
            />

            <TextInput
              mode="outlined"
              dense
              label="Trip starts (YYYY-MM-DD)"
              placeholder={todayPlaceholder}
              value={tripStarts}
              onChangeText={(v) => {
                setTripStarts(v);
                if (err) setErr(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.field}
            />

            <TextInput
              mode="outlined"
              dense
              label="Trip ends (optional, YYYY-MM-DD)"
              value={tripEnds}
              onChangeText={(v) => {
                setTripEnds(v);
                if (err) setErr(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.field}
            />

            <TextInput
              mode="outlined"
              dense
              label="Target amount"
              value={target}
              onChangeText={(v) => {
                setTarget(v);
                if (err) setErr(null);
              }}
              keyboardType="numeric"
              style={styles.field}
            />

            {err ? (
              <Text style={[styles.errorText, { color: colors.coral }]}>{err}</Text>
            ) : null}

            <View style={{ height: spacing.sm }} />

            <Button
              mode="contained"
              buttonColor={theme.colors.primary}
              textColor={theme.colors.onPrimary}
              onPress={onSave}
              loading={submitting}
              disabled={!canSave}
            >
              Save Trip
            </Button>

            <View style={{ height: spacing.sm }} />

            <Button
              mode="text"
              textColor={theme.colors.onSurfaceVariant}
              onPress={() => router.back()}
              disabled={submitting}
            >
              Cancel
            </Button>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const MAX_CONTENT_WIDTH = 560;

const styles = StyleSheet.create({
  safe: { flex: 1 },
  page: { padding: spacing.lg, alignItems: "center" },
  contentWrap: { width: "100%", maxWidth: MAX_CONTENT_WIDTH },
  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.lg,
  },
  title: { ...typography.sectionTitle, fontSize: 18 },
  subtitle: { ...typography.body, marginTop: spacing.xs },
  field: { marginBottom: spacing.sm },
  errorText: { marginTop: 6, fontWeight: "700", fontSize: 13 },
});
