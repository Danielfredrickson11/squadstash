import React from "react";
import { View, StyleSheet } from "react-native";
import { Card, Text, Button } from "react-native-paper";

export default function TripsScreen() {
  return (
    <View style={styles.container}>
      <Card style={styles.card}>
        <Card.Title title="Trips" />
        <Card.Content>
          <Text style={styles.text}>
            This section will allow groups to plan and save for trips together.
          </Text>
          <Text style={styles.text}>
            Each trip will have shared goals, expense tracking, and an easy way
            to split costs.
          </Text>
        </Card.Content>
        <Card.Actions>
          <Button mode="contained" onPress={() => console.log("Create Trip")}>
            Create Trip
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
