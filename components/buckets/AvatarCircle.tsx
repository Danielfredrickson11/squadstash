// Small presentational avatar bits shared between the Bucket card's
// avatar stack (components/buckets/BucketCard.tsx) and the Members
// dialog's member list (app/(tabs)/buckets.tsx) - extracted here rather
// than duplicated in both places. Pure presentation only: no Firebase
// reads/writes, no navigation.
import React from "react";
import { Image, Text as RNText, View } from "react-native";
import { useTheme } from "react-native-paper";

export function initialsFromName(name?: string) {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => (p?.[0] ?? "").toUpperCase()).join("");
}

export function shortUid(uid: string) {
  return `${uid.slice(0, 6)}…${uid.slice(-4)}`;
}

export function AvatarCircle(props: {
  index: number;
  label: string;
  photoURL?: string;
  size?: number;
}) {
  const { index, label, photoURL, size = 26 } = props;
  const theme = useTheme();

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        marginLeft: index === 0 ? 0 : -10,
        borderWidth: 2,
        borderColor: theme.colors.surface,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surfaceVariant,
        overflow: "hidden",
      }}
    >
      {photoURL ? (
        <Image
          source={{ uri: photoURL }}
          style={{ width: size - 2, height: size - 2, borderRadius: 999 }}
        />
      ) : (
        <RNText
          style={{ fontSize: 11, fontWeight: "800", color: theme.colors.onSurfaceVariant }}
        >
          {label}
        </RNText>
      )}
    </View>
  );
}
