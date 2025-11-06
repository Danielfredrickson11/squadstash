import React from "react";
import { View, StyleSheet } from "react-native";
import { Card, Text, Button } from "react-native-paper";
import { useAuth } from "../contexts/AuthContext";

export default function HomeScreen() {
  const { user } = useAuth();

  const displayName =
    user?.displayName ||
    (user?.email ? user.email.split("@")[0] : "Guest");

  return (
    <View style={styles.container}>
      <Card style={styles.card}>
        <Card.Title title={`Welcome, ${displayName}!`} />
        <Card.Content>
          <Text style={styles.text}>
            This is your SquadStash home dashboard. From here you’ll be able to:
          </Text>
          <Text style={styles.list}>• Create or join group trips</Text>
          <Text style={styles.list}>• Track personal savings buckets</Text>
          <Text style={styles.list}>• Manage shared expenses</Text>
          <Text style={styles.list}>• View your transactions</Text>
        </Card.Content>
        <Card.Actions>
          <Button
            mode="contained"
            onPress={() => console.log("Navigate to Trips")}
          >
            Get Started
          </Button>
        </Card.Actions>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
    backgroundColor: "#f8f9fa",
  },
  card: {
    borderRadius: 12,
    elevation: 3,
    backgroundColor: "#fff",
  },
  text: {
    fontSize: 16,
    marginBottom: 10,
  },
  list: {
    fontSize: 15,
    marginBottom: 6,
    marginLeft: 10,
  },
});
