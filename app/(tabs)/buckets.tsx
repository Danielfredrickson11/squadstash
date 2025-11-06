import React from "react";
import { View, StyleSheet } from "react-native";
import { Card, Text, Button } from "react-native-paper";

export default function BucketsScreen() {
  return (
    <View style={styles.container}>
      <Card style={styles.card}>
        <Card.Title title="Buckets" />
        <Card.Content>
          <Text style={styles.text}>
            This is where you'll manage your personal savings buckets.
          </Text>
          <Text style={styles.text}>
            You’ll be able to create new goals like Rent, Food, or Vacation —
            and track your progress toward each one.
          </Text>
        </Card.Content>
        <Card.Actions>
          <Button mode="contained" onPress={() => console.log("Add Bucket")}>
            Add Bucket
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
  },
  text: {
    fontSize: 16,
    marginBottom: 10,
  },
});
