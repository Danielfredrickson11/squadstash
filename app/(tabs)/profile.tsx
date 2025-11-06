import React from "react";
import { View } from "react-native";
import { Card, Text, Button, Avatar } from "react-native-paper";
import { useAuth } from "../contexts/AuthContext";

export default function Profile() {
  const { user, logout } = useAuth();

  const initials = (user?.displayName ?? user?.email ?? "?")
    .split(/[ .@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase())
    .join("") || "?";

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Card>
        <Card.Title
          title="Profile"
          left={() => <Avatar.Text size={40} label={initials} />}
        />
        <Card.Content>
          <Text style={{ marginBottom: 6 }}>
            <Text style={{ fontWeight: "600" }}>Name: </Text>
            {user?.displayName ?? "—"}
          </Text>
          <Text style={{ marginBottom: 16 }}>
            <Text style={{ fontWeight: "600" }}>Email: </Text>
            {user?.email ?? "—"}
          </Text>
          <Button mode="outlined" onPress={logout}>
            Log Out
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}
