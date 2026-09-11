// Client-side call for archiving a Material Entry Camera Upload photo to
// Dropbox — see services/apiHandlers.ts's handleArchivePhoto for the
// actual upload (server-side only; needs DROPBOX_APP_KEY/APP_SECRET/
// REFRESH_TOKEN, never exposed to the browser).
//
// Deliberately swallows every error: this is an audit-trail nice-to-have,
// never allowed to block or even visibly interrupt a real Material Entry
// save over a Dropbox hiccup (expired token, network blip, quota). Errors
// still go to the console so a genuinely broken setup is diagnosable.
export const archivePhotoToDropbox = async (imageBase64: string, mimeType: string, fileName: string): Promise<void> => {
  try {
    const response = await fetch('/api/dropbox/archivePhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType, fileName }),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }
  } catch (error) {
    console.error('Dropbox photo archive failed (non-fatal — Material Entry save is unaffected):', error);
  }
};

// Builds a stable, sortable, filesystem-safe filename for an archived
// Material Entry photo: <supplier>_<invoiceNo>_<timestamp> — Dropbox's own
// `autorename: true` (see handleArchivePhoto) covers the rare collision.
export const buildArchiveFileName = (supplierName: string, invoiceNo: string): string => {
  const clean = (s: string) => (s || 'unknown').trim().replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `${clean(supplierName)}_${clean(invoiceNo)}_${ts}`;
};
