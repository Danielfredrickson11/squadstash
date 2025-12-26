import { Link, router } from "expo-router";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import React, { useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, HelperText, Text, TextInput } from "react-native-paper";
import { auth, db } from "../../firebase";

function isValidEmail(email: string) {
  const e = email.trim().toLowerCase();
  return e.includes("@") && e.includes(".") && e.length >= 6;
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanEmail = useMemo(() => email.trim().toLowerCase(), [email]);

  const canSubmit = useMemo(() => {
    return !submitting && isValidEmail(cleanEmail) && password.length >= 1;
  }, [submitting, cleanEmail, password]);

  const onLogin = async () => {
    if (!canSubmit) return;

    setError(null);
    setSubmitting(true);

    try {
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);

      // ✅ self-heal: ensure both profile docs exist
      const u = cred.user;
      const displayName =
        (u.displayName && u.displayName.trim()) ||
        (u.email ? u.email.split("@")[0] : "User");

      await setDoc(
        doc(db, "users", u.uid),
        {
          uid: u.uid,
          displayName,
          email: (u.email ?? cleanEmail).toLowerCase(),
          photoURL: u.photoURL ?? null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await setDoc(
        doc(db, "publicUsers", u.uid),
        {
          uid: u.uid,
          displayName,
          photoURL: u.photoURL ?? "",
          emailLower: (u.email ?? cleanEmail).toLowerCase(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      router.replace("/(tabs)/home");
    } catch (e: any) {
      const msg = String(e?.message ?? "Login failed");
      if (msg.includes("auth/invalid-credential")) setError("Invalid email or password.");
      else if (msg.includes("auth/user-not-found")) setError("No account found for that email.");
      else setError(msg);
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
            style={{ marginBottom: 8 }}
          />
          <HelperText type="error" visible={email.length > 0 && !isValidEmail(cleanEmail)}>
            Enter a valid email address.
          </HelperText>

          <TextInput
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={{ marginBottom: 8 }}
          />

          <HelperText type="error" visible={!!error}>
            {error ?? ""}
          </HelperText>

          <Button mode="contained" onPress={onLogin} loading={submitting} disabled={!canSubmit}>
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
