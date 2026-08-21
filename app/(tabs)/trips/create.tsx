import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, Text, TextInput } from "react-native-paper";

import { useAuth } from "../../../src/contexts/AuthContext";
import { createTrip } from "../../../src/services/firebase/trips";

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

  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [target, setTarget] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSave = useMemo(() => {
    if (loading || !user) return false;
    if (!title.trim()) return false;
    const t = parseMoneyInput(target);
    if (!Number.isFinite(t) || t <= 0) return false;
    return !submitting;
  }, [loading, user, title, target, submitting]);

  const onSave = async () => {
    if (loading || !user) return;

    const cleanTitle = title.trim();
    const cleanLocation = location.trim();
    const t = parseMoneyInput(target);

    if (!cleanTitle) {
      setErr("Please enter a trip name.");
      return;
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
    <View style={styles.page}>
      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <Text variant="headlineSmall" style={styles.title}>
            Create Trip
          </Text>
          <Text style={styles.subtitle}>
            Add a destination and target—then invite friends later.
          </Text>

          <View style={{ height: 14 }} />

          <TextInput
            label="Trip name"
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              if (err) setErr(null);
            }}
            style={{ marginBottom: 12 }}
          />

          <TextInput
            label="Location (ex: Scottsdale, Arizona, US)"
            value={location}
            onChangeText={(v) => {
              setLocation(v);
              if (err) setErr(null);
            }}
            style={{ marginBottom: 12 }}
          />

          <TextInput
            label="Target amount"
            value={target}
            onChangeText={(v) => {
              setTarget(v);
              if (err) setErr(null);
            }}
            keyboardType="numeric"
            style={{ marginBottom: 8 }}
          />

          {err ? <Text style={styles.errorText}>{err}</Text> : null}

          <View style={{ height: 12 }} />

          <Button
            mode="contained"
            onPress={onSave}
            loading={submitting}
            disabled={!canSave}
          >
            Save Trip
          </Button>

          <View style={{ height: 10 }} />

          <Button mode="text" onPress={() => router.back()} disabled={submitting}>
            Cancel
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, backgroundColor: "#F6F7FB" },
  card: { borderRadius: 18, backgroundColor: "white" },
  title: { fontWeight: "900" },
  subtitle: { opacity: 0.7, marginTop: 4 },
  errorText: { marginTop: 6, color: "#B91C1C", fontWeight: "700" },
});
