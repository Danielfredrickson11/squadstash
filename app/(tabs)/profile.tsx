import { useRouter } from "expo-router";
import React, { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Text } from "react-native-paper";
import { useAuth } from "../../src/contexts/AuthContext";

export default function Profile() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const initials =
    (user?.displayName ?? user?.email ?? "?")
      .split(/[ .@_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "?";

  const onLogout = async () => {
    setSubmitting(true);
    try {
      await logout();
      // Optional, but makes it feel immediate:
      router.replace("/(auth)/login");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Card>
        <Card.Title title="Profile" left={() => <Avatar.Text size={40} label={initials} />} />
        <Card.Content>
          <Text style={{ marginBottom: 6 }}>
            <Text style={{ fontWeight: "600" }}>Name: </Text>
            {user?.displayName ?? "—"}
          </Text>
          <Text style={{ marginBottom: 16 }}>
            <Text style={{ fontWeight: "600" }}>Email: </Text>
            {user?.email ?? "—"}
          </Text>

          <Button mode="outlined" onPress={onLogout} loading={submitting} disabled={submitting}>
            Log Out
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}
