import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { auth, db } from "../../firebase";

type AuthContextType = {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}

async function upsertPublicUser(u: User) {
  const ref = doc(db, "publicUsers", u.uid);

  const displayName =
    (u.displayName && u.displayName.trim()) ||
    (u.email ? u.email.split("@")[0] : "User");

  const payload = {
    uid: u.uid,
    displayName,
    photoURL: u.photoURL ?? "",
    emailLower: (u.email ?? "").toLowerCase(),
    updatedAt: serverTimestamp(),
  };

  // merge keeps any future fields you add
  await setDoc(ref, payload, { merge: true });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);

      // Create/update public profile doc for avatar + member display names
      if (u) {
        try {
          await upsertPublicUser(u);
        } catch (e) {
          console.warn("Failed to upsert public user profile:", e);
        }
      }
    });

    return unsub;
  }, []);

  const logout = async () => {
    await signOut(auth);
  };

  const value = useMemo(() => ({ user, loading, logout }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
