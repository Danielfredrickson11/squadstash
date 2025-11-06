import { router } from "expo-router";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import React, { useState } from "react";
import { View } from "react-native";
import { Button, Card, Text, TextInput } from "react-native-paper";
import { auth } from "../../firebase";

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRegister = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name.trim()) {
        await updateProfile(cred.user, { displayName: name.trim() });
      }
      router.replace("/(tabs)/home"); // <-- navigate immediately
    } catch (e: any) {
      setError(e.message ?? "Registration failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 16, justifyContent: "center" }}>
      <Card>
        <Card.Title title="Create your SquadStash account" />
        <Card.Content>
          <TextInput
            label="Name"
            value={name}
            onChangeText={setName}
            style={{ marginBottom: 12 }}
          />
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
          <Button mode="contained" onPress={onRegister} loading={submitting}>
            Sign Up
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}
