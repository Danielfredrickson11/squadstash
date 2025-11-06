import { Link, router } from "expo-router";
import { signInWithEmailAndPassword } from "firebase/auth";
import React, { useState } from "react";
import { View } from "react-native";
import { Button, Card, Text, TextInput } from "react-native-paper";
import { auth } from "../../firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      router.replace("/(tabs)/home"); // <-- navigate immediately
    } catch (e: any) {
      setError(e.message ?? "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 16, justifyContent: "center" }}>
      <Card>
        <Card.Title title="Welcome to SquadStash" />
        <Card.Content>
          <TextInput
            label="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            style={{ marginBottom: 12 }}
          />
        <TextInput
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={{ marginBottom: 12 }}
          />
          {error ? <Text style={{ color: "red", marginBottom: 8 }}>{error}</Text> : null}
          <Button mode="contained" onPress={onLogin} loading={submitting}>
            Log In
          </Button>
          <View style={{ height: 12 }} />
          <Link href="/(auth)/register">
            <Text>New here? Create an account</Text>
          </Link>
        </Card.Content>
      </Card>
    </View>
  );
}
