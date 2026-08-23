import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, updateDoc, arrayUnion, arrayRemove, deleteField } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from '../contexts/AuthContext';
import { AppUser, UserRole, PendingDevice } from '../types';

const ROLES: UserRole[] = ['admin', 'store', 'accounts', 'ppc'];

const UserMaster: React.FC = () => {
  const { firebaseUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', displayName: '', role: 'store' as UserRole });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), (snap) => {
      setUsers(snap.docs.map((d) => ({ uid: d.id, ...d.data() } as AppUser)));
    });
    return () => unsub();
  }, []);

  const callAdminApi = async (path: string, body: any) => {
    const token = await firebaseUser?.getIdToken();
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await callAdminApi('/api/admin/createUser', form);
      setMessage({ type: 'success', text: `User ${form.email} created.` });
      setForm({ email: '', password: '', displayName: '', role: 'store' });
      setShowForm(false);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: AppUser) => {
    setBusy(true);
    try {
      await callAdminApi('/api/admin/updateUser', { uid: u.uid, active: !u.active });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u: AppUser, role: UserRole) => {
    setBusy(true);
    try {
      await callAdminApi('/api/admin/updateUser', { uid: u.uid, role });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  // Device approval — Admin already has full write access to `users` per
  // Firestore rules, so this goes straight to Firestore, no API route needed.
  const approveDevice = async (u: AppUser, device: PendingDevice) => {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', u.uid), {
        pendingDevices: arrayRemove(device),
        authorizedDevices: arrayUnion(device.token),
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const rejectDevice = async (u: AppUser, device: PendingDevice) => {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', u.uid), { pendingDevices: arrayRemove(device) });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (u: AppUser, token: string) => {
    if (!confirm('Revoke this device? That device will need Admin approval again to log back in.')) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', u.uid), { authorizedDevices: arrayRemove(token) });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  // Single-active-session lock (Store/Accounts/PPC only) — releases the
  // seat that's currently "owning" this user's login so they can sign in
  // on a new device right away. Needed when the previous device wasn't
  // logged out cleanly (closed laptop, crashed browser) and is still
  // holding the lock.
  const releaseSession = async (u: AppUser) => {
    if (!confirm(`Release ${u.displayName}'s active session?\n\nThey'll be able to log in on a different PC immediately. Their old device isn't force-logged-out by this — it'll keep working until someone closes it out or logs out there — but it won't be able to log back in elsewhere until this is done.`)) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', u.uid), {
        activeDeviceToken: deleteField(),
        activeSessionAt: deleteField(),
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const totalPending = users.reduce((sum, u) => sum + (u.pendingDevices?.length || 0), 0);

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-black text-slate-900">User Master</h2>
          <p className="text-xs text-slate-500 font-medium">Create logins and assign roles for Store, Accounts, PPC, and Admin.</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold"
        >
          {showForm ? 'Cancel' : '+ New User'}
        </button>
      </div>

      {message && (
        <div className={`mb-4 px-4 py-2 rounded-xl text-sm font-semibold ${message.type === 'error' ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
          {message.text}
        </div>
      )}

      {totalPending > 0 && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-amber-50 text-amber-700 text-sm font-bold">
          {totalPending} device{totalPending > 1 ? 's are' : ' is'} waiting for approval below.
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-slate-50 rounded-2xl p-6 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Email" type="email" value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            <input required placeholder="Temporary password" type="text" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            <input required placeholder="Display name" type="text" value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              className="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button disabled={busy} type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold disabled:opacity-50">
            {busy ? 'Creating…' : 'Create User'}
          </button>
        </form>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <React.Fragment key={u.uid}>
              <tr className="border-t border-slate-50">
                <td className="px-4 py-3 font-semibold">{u.displayName}</td>
                <td className="px-4 py-3 text-slate-500">{u.email}</td>
                <td className="px-4 py-3">
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value as UserRole)}
                    className="border border-slate-200 rounded-lg px-2 py-1 text-xs">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${u.active ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                    {u.active ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => toggleActive(u)} className="text-xs font-bold text-indigo-600">
                    {u.active ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
              {u.role !== 'admin' && ((u.pendingDevices?.length || 0) > 0 || (u.authorizedDevices?.length || 0) > 0 || u.activeDeviceToken) && (
                <tr className="bg-slate-50/50">
                  <td colSpan={5} className="px-4 py-3">
                    {u.activeDeviceToken && (
                      <div className="flex items-center justify-between text-xs bg-indigo-50 rounded-lg px-3 py-2 mb-1">
                        <div className="text-indigo-700">
                          <span className="font-bold">🔒 Session locked to device {u.activeDeviceToken.slice(0, 8)}…</span>
                          {u.activeSessionAt && <span className="text-indigo-500 block">since {new Date(u.activeSessionAt).toLocaleString()} — logging in elsewhere is blocked until this is released or they log out</span>}
                        </div>
                        <button onClick={() => releaseSession(u)} className="font-bold text-rose-600 shrink-0 ml-4">Release Session</button>
                      </div>
                    )}
                    {(u.pendingDevices || []).map((d) => (
                      <div key={d.token} className="flex items-center justify-between text-xs bg-amber-50 rounded-lg px-3 py-2 mb-1">
                        <div className="text-amber-700">
                          <span className="font-bold">Pending device</span> — requested {new Date(d.requestedAt).toLocaleString()}
                          <span className="text-amber-500 block truncate max-w-md">{d.userAgent}</span>
                        </div>
                        <div className="flex gap-3 shrink-0 ml-4">
                          <button onClick={() => approveDevice(u, d)} className="font-bold text-emerald-600">Approve</button>
                          <button onClick={() => rejectDevice(u, d)} className="font-bold text-rose-600">Reject</button>
                        </div>
                      </div>
                    ))}
                    {(u.authorizedDevices || []).map((token) => (
                      <div key={token} className="flex items-center justify-between text-xs bg-emerald-50 rounded-lg px-3 py-2 mb-1">
                        <span className="text-emerald-700 font-bold">Authorized device — {token.slice(0, 8)}…</span>
                        <button onClick={() => revokeDevice(u, token)} className="font-bold text-rose-600 shrink-0 ml-4">Revoke</button>
                      </div>
                    ))}
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default UserMaster;
