import React from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, Text } from "react-native-paper";

export default function TransactionsScreen() {
  return (
    <View style={styles.container}>
      <Card style={styles.card}>
        <Card.Title title="Transactions" />
        <Card.Content>
          <Text style={styles.text}>
            This tab will display all of your personal and group transactions.
          </Text>
          <Text style={styles.text}>
            Soon, you'll be able to view, edit, and categorize your spending.
          </Text>
        </Card.Content>
        <Card.Actions>
          <Button mode="contained" onPress={() => console.log("Add Transaction")}>
            Add Transaction
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
