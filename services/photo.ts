// Shared photo capture/compression helper for every "Camera Upload" flow in
// this app. Mirrors components/RMCrossBillCheck.tsx's own
// readAndCompressInvoicePhoto exactly (same max dimension/quality) — kept
// as a separate copy there rather than switched over to this one, so that
// already-working screen's behavior can't be disturbed by a change made
// here for Material Entry. New Camera Upload flows (Material Entry, and
// any future one) should use this shared version instead of writing a
// third copy.
//
// Re-encodes to a capped-dimension JPEG before it ever reaches the vision
// model / server: a full-resolution phone photo can be 5-10MB, well past
// what's sensible for a serverless function body and this deployment's own
// 10mb JSON body limit (see server.ts). Also sidesteps HEIC (iPhone
// photos) not being accepted by the vision model directly — if the browser
// itself can't decode the source file, this rejects with a clear error
// asking for a JPG/PNG instead of failing silently.
const MAX_PHOTO_DIMENSION = 1600;

export const readAndCompressPhoto = (file: File): Promise<{ base64: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error("This browser can't process images — try a different device.")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Could not process this photo.')); return; }
        resolve({ base64, mimeType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Could not open this photo — try a JPG or PNG.'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.readAsDataURL(file);
  });
};
