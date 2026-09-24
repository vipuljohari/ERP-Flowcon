// Client-side call for archiving a Material Entry Camera Upload photo to
// Dropbox — see services/apiHandlers.ts's handleArchivePhoto for the
// actual upload (server-side only; needs DROPBOX_APP_KEY/APP_SECRET/
// REFRESH_TOKEN, never exposed to the browser).
//
// Deliberately swallows every error: this is an audit-trail nice-to-have,
// never allowed to block or even visibly interrupt a real Material Entry
// save over a Dropbox hiccup (expired token, network blip, quota). Errors
// still go to the console so a genuinely broken setup is diagnosable.
//
// Returns the Dropbox path the photo was actually saved to (so a caller can
// link it to the record it belongs to, e.g. PendingRMEntry.photoDropboxPath
// in the RM Approval Queue), or null if the archive failed — never throws.
// `folder` (optional) is a month-bucket subfolder, e.g. "Sep 26" — see
// buildArchiveMonthFolder below. Omitted/blank keeps photos in the flat
// "Unit 2/Inwards" root (back-compat with any older caller).
// `archiveRoot` (optional, added 24-Sep-26) picks the top-level Dropbox
// folder: omitted/'inward' is the normal "Unit 2/Inwards" archive;
// 'rejected' is the sibling "Unit 2/Rejected" folder App.tsx's
// handleRejectGateDocument uses so a rejected entry's photo never looks
// like a genuine posted one.
export const archivePhotoToDropbox = async (imageBase64: string, mimeType: string, fileName: string, folder?: string, archiveRoot?: 'inward' | 'rejected'): Promise<string | null> => {
  try {
    const response = await fetch('/api/dropbox/archivePhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType, fileName, folder, archiveRoot }),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }
    const result = await response.json().catch(() => ({} as any));
    return result?.path || null;
  } catch (error) {
    console.error('Dropbox photo archive failed (non-fatal — Material Entry save is unaffected):', error);
    return null;
  }
};

// Keeps letters, digits, spaces, dots and hyphens (readable, matches how
// Vipul writes supplier names/invoice numbers by hand — e.g. "A.S.T Pipe
// Limited", "AST-D-26-27-2514") and only strips characters Dropbox/Windows
// actually can't store in a filename, instead of collapsing everything
// non-alphanumeric to underscores. Trims a trailing dot/space (Windows
// forbids both at the end of a filename).
const cleanForFileName = (s: string, fallback: string): string => {
  const trimmed = (s || '').trim();
  if (!trimmed) return fallback;
  return trimmed
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 60) || fallback;
};

// "YYYY-MM-DD" -> "10.09.26" (DD.MM.YY, matching how Vipul writes dates).
// Falls back to today when the date is missing/unparseable — parsed from
// the string's own components (not `new Date(dateStr)`) so this can't shift
// a day due to local timezone conversion.
const formatDateForFileName = (dateStr?: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (m) return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getFullYear()).slice(2)}`;
};

// "YYYY-MM-DD" -> "Sep 26" (MMM YY) — the month-bucket subfolder name under
// "Unit 2/Inwards". Same manual parsing as formatDateForFileName, for the
// same timezone-safety reason.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const buildArchiveMonthFolder = (dateStr?: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (m) return `${MONTH_NAMES[parseInt(m[2], 10) - 1]} ${m[1].slice(2)}`;
  const now = new Date();
  return `${MONTH_NAMES[now.getMonth()]} ${String(now.getFullYear()).slice(2)}`;
};

// Builds a stable, sortable filename for an archived inward invoice photo:
// <Supplier Name>_<Invoice No>_<DD.MM.YY> — e.g.
// "A.S.T Pipe Limited_AST-D-26-27-2514_10.09.26". Dropbox's own
// `autorename: true` (see handleArchivePhoto) covers the rare collision
// (e.g. two photos of the same invoice re-uploaded).
export const buildArchiveFileName = (supplierName: string, invoiceNo: string, dateStr?: string): string => {
  return `${cleanForFileName(supplierName, 'Unknown Supplier')}_${cleanForFileName(invoiceNo, 'Pending')}_${formatDateForFileName(dateStr)}`;
};
