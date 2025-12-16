import { collection, DocumentData, onSnapshot, orderBy, query } from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, ProgressBar, Text } from "react-native-paper";
import { db } from "../../firebase";
import { formatCurrency } from "../../utils/format";
import { useAuth } from "../contexts/AuthContext";

type MiniBucket = { name: string; balance: number; target: number };

export default function HomeScreen() {
  const { user } = useAuth();
  const displayName = user?.displayName || (user?.email ? user.email.split("@")[0] : "Guest");

  const [totalSaved, setTotalSaved] = useState(0);
  const [topBuckets, setTopBuckets] = useState<MiniBucket[]>([]);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "buckets"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const list: MiniBucket[] = [];
      let total = 0;
      snap.forEach((doc) => {
        const d = doc.data() as DocumentData;
        const bal = Number(d.balance) || 0;
        const tgt = Number(d.target) || 0;
        total += bal;
        list.push({ name: d.name, balance: bal, target: tgt });
      });
      setTotalSaved(total);
      setTopBuckets(list.slice(0, 3));
    });
    return () => unsub();
  }, [user]);

  return (
    <View style={styles.container}>
      <Card style={styles.card}>
        <Card.Title title={`Welcome, ${displayName}!`} />
        <Card.Content>
          <Text style={styles.text}>Total Saved</Text>
          <Text variant="headlineMedium" style={{ marginBottom: 12 }}>
            {formatCurrency(totalSaved)}
          </Text>

          <Text style={[styles.text, { marginTop: 8, marginBottom: 6 }]}>Top Buckets</Text>
          {topBuckets.length === 0 ? (
            <Text style={{ opacity: 0.7 }}>No buckets yet. Create one to get started.</Text>
          ) : (
            topBuckets.map((b, i) => {
              const pct = b.target > 0 ? Math.min(b.balance / b.target, 1) : 0;
              return (
                <View key={`${b.name}-${i}`} style={{ marginBottom: 10 }}>
                  <Text>
                    {b.name}: {formatCurrency(b.balance)} / {formatCurrency(b.target)}
                  </Text>
                  <ProgressBar progress={pct} style={{ height: 8, borderRadius: 6 }} />
                </View>
              );
            })
          )}
        </Card.Content>
        <Card.Actions>
          <Button mode="contained" onPress={() => console.log("Navigate to Buckets")}>
            Add Bucket
          </Button>
          <Button onPress={() => console.log("Navigate to Trips")}>Create Trip</Button>
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
  card: { borderRadius: 12, elevation: 3, backgroundColor: "#fff" },
  text: { fontSize: 16 },
});
