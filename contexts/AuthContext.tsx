import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { auth, db } from '../services/firebase';
import { AppUser } from '../types';

// A stable, random identifier for this browser — not tied to real hardware
// (the browser deliberately blocks reading MAC addresses / hardware IDs),
// but persistent enough to recognize "this same browser logging in again"
// versus "a login attempt from somewhere new."
const DEVICE_TOKEN_KEY = 'flowcon_device_token';
const getDeviceToken = (): string => {
  let token = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  }
  return token;
};

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
            } else if (data.role !== 'admin' && !(data.authorizedDevices || []).includes(getDeviceToken())) {
              // Unrecognized device for a non-admin role — block the login
              // and file a request for an Admin to approve in User Master.
              const token = getDeviceToken();
              const alreadyPending = (data.pendingDevices || []).some((d) => d.token === token);
              if (!alreadyPending) {
                await updateDoc(doc(db, 'users', fbUser.uid), {
                  pendingDevices: arrayUnion({
                    token,
                    requestedAt: new Date().toISOString(),
                    userAgent: navigator.userAgent,
                  }),
                }).catch(() => {}); // best-effort; rules allow self-write of this field only
              }
              setError(
                alreadyPending
                  ? 'This device is still waiting for Admin approval.'
                  : "This device isn't authorized yet. An Admin needs to approve it in User Master, then try logging in again."
              );
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
