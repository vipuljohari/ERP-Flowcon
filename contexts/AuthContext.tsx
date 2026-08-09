import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../services/firebase';
import { AppUser } from '../types';

interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  appUser: AppUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        try {
          // The user's role/profile lives in Firestore, keyed by their Auth UID.
          // This document is created by an Admin via User Master (see UserMaster.tsx).
          const snap = await getDoc(doc(db, 'users', fbUser.uid));
          if (snap.exists()) {
            const data = snap.data() as Omit<AppUser, 'uid'>;
            if (data.active === false) {
              setError('This account has been deactivated. Contact your Admin.');
              await firebaseSignOut(auth);
              setAppUser(null);
            } else {
              setAppUser({ uid: fbUser.uid, ...data });
            }
          } else {
            // Auth account exists but no role profile — treat as not provisioned yet.
            setError('No role assigned to this account yet. Contact your Admin.');
            await firebaseSignOut(auth);
            setAppUser(null);
          }
        } catch (e: any) {
          setError(e.message || 'Failed to load user profile.');
        }
      } else {
        setAppUser(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const login = async (email: string, password: string) => {
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e: any) {
      const msg = e.code === 'auth/invalid-credential'
        ? 'Incorrect email or password.'
        : (e.message || 'Login failed.');
      setError(msg);
      throw e;
    }
  };

  const logout = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ firebaseUser, appUser, loading, error, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
