import React, { createContext, useContext, useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, limit } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Company } from '../types';

interface CompanyContextValue {
  activeCompany: Company | null;
  loading: boolean;
}

const CompanyContext = createContext<CompanyContextValue>({ activeCompany: null, loading: true });

const FALLBACK: Company = {
  id: 'fallback',
  name: 'Flowcon Auto',
  address: 'IMT Faridabad • Plot 835',
};

export const CompanyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeCompany, setActiveCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'companies'), where('isActive', '==', true), limit(1));
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (!snap.empty) {
          const d = snap.docs[0];
          setActiveCompany({ id: d.id, ...d.data() } as Company);
        } else {
          setActiveCompany(null); // no company marked active yet — caller falls back
        }
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  return (
    <CompanyContext.Provider value={{ activeCompany, loading }}>
      {children}
    </CompanyContext.Provider>
  );
};

// Always returns something renderable — falls back to the original hardcoded
// branding until an Admin marks a company as active in Company Master.
export const useActiveCompany = (): Company => {
  const { activeCompany } = useContext(CompanyContext);
  return activeCompany || FALLBACK;
};

// The name to show across app UI (header, tab title, login, AI assistant).
// Uses the dedicated branding name if set, otherwise falls back to the
// company's legal name.
export const useBrandName = (): string => {
  const company = useActiveCompany();
  return company.brandingName?.trim() || company.name;
};
