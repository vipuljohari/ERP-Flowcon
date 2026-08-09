import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Safe to expose publicly — access control comes from Firestore Security Rules,
// not from hiding this config. See firestore.rules in the project root.
const firebaseConfig = {
  apiKey: "AIzaSyANT0Eq-0iCgAfnVc50eLSPitOSqR1ZBbA",
  authDomain: "erp-8fd61.firebaseapp.com",
  projectId: "erp-8fd61",
  storageBucket: "erp-8fd61.firebasestorage.app",
  messagingSenderId: "274197859452",
  appId: "1:274197859452:web:e30ae01969f4f047ad4df9",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
