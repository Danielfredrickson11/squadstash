import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, HelperText, TextInput } from "react-native-paper";
import { signUp, updateAuthProfile } from "../../src/services/firebase/auth";
import { upsertPublicProfile, upsertUserProfile } from "../../src/services/firebase/users";

function isValidEmail(email: string) {
  const e = email.trim().toLowerCase();
  return e.includes("@") && e.includes(".") && e.length >= 6;
}

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const displayName = useMemo(() => name.trim(), [name]);

  const canSubmit = useMemo(() => {
    return (
      !submitting &&
      displayName.length >= 1 &&
      isValidEmail(cleanEmail) &&
      password.length >= 6
    );
  }, [submitting, displayName, cleanEmail, password]);

  const onRegister = async () => {
    if (!canSubmit) return;

    setError(null);
    setSubmitting(true);

    try {
      const cred = await signUp(cleanEmail, password);

      // Set Firebase Auth display name
      await updateAuthProfile(cred.user, { displayName });

      // ✅ Private profile doc (safe place for email, later settings, etc.)
      await upsertUserProfile({
        uid: cred.user.uid,
        displayName,
        email: cleanEmail,
        photoURL: cred.user.photoURL ?? null,
        includeCreatedAt: true,
      });

      // ✅ Public profile doc (readable by other bucket members)
      // Account creation time lives on the private `users` doc above -
      // publicUsers never stores createdAt, so this write is compatible
      // regardless of whether AuthContext's upsert already created the
      // document first (see firestore.rules publicUsers create allowlist).
      await upsertPublicProfile({
        uid: cred.user.uid,
        displayName,
        photoURL: cred.user.photoURL ?? "",
      });

      router.replace("/(tabs)/home");
    } catch (e: any) {
      const msg = String(e?.message ?? "Registration failed");
      if (msg.includes("email-already-in-use")) setError("That email is already in use.");
      else if (msg.includes("weak-password")) setError("Password should be at least 6 characters.");
      else if (msg.includes("invalid-email")) setError("Please enter a valid email address.");
      else setError(msg);
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
            style={{ marginBottom: 8 }}
          />
          <HelperText type="info" visible={displayName.length > 0 && displayName.length < 1}>
            Please enter your name.
          </HelperText>

          <TextInput
            label="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            style={{ marginBottom: 8 }}
          />
          <HelperText type="error" visible={email.length > 0 && !isValidEmail(cleanEmail)}>
            Enter a valid email (example: name@email.com)
          </HelperText>

          <TextInput
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={{ marginBottom: 8 }}
          />
          <HelperText type="error" visible={password.length > 0 && password.length < 6}>
            Password must be at least 6 characters.
          </HelperText>

          <HelperText type="error" visible={!!error}>
            {error ?? ""}
          </HelperText>

          <Button mode="contained" onPress={onRegister} loading={submitting} disabled={!canSubmit}>
            Sign Up
          </Button>
        </Card.Content>
      </Card>
    </View>
  );
}
