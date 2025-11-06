import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// 🔥 Replace with your actual config from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyCP9h5yk-4HYBfQJJ4aOlxfO_Xb-xTraaw",
  authDomain: "squadstash-6d0f1.firebaseapp.com",
  projectId: "squadstash-6d0f1",
  storageBucket: "squadstash-6d0f1.firebasestorage.app",
  messagingSenderId: "1048007868667",
  appId: "1:1048007868667:web:a63772f6322465302c305e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export commonly used services
export const auth = getAuth(app);
export const db = getFirestore(app);
