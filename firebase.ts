// firebase.ts
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyCP9h5yk-4HYBfQJJ4aOlxfO_Xb-xTraaw",
  authDomain: "squadstash-6d0f1.firebaseapp.com",
  projectId: "squadstash-6d0f1",
  storageBucket: "squadstash-6d0f1.firebasestorage.app",
  messagingSenderId: "1048007868667",
  appId: "1:1048007868667:web:a63772f6322465302c305e",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// ✅ Cloud Functions (invite-by-email)
export const functions = getFunctions(app);
