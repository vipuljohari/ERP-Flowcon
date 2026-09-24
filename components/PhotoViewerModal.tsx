import React, { useState } from 'react';

// ============================================================
// Shared full-screen photo viewer — 24-Sep-26.
// ============================================================
// Was previously duplicated inline in both GateDocumentsQueue.tsx and
// RMApprovalQueue.tsx as a fixed-height flex-centered overlay with the
// "Close" button placed AFTER the image in normal document flow. That
// broke for any photo taller than the viewport (a very common case here —
// gate photos are often shot sideways, like Vipul's Tube Investments
// example) or heavily zoomed: the button was pushed below the visible
// area with no way to scroll down to it, so there was no way to close the
// viewer at all except reloading the page.
//
// Fixed here by pinning the toolbar (Close/Rotate/Zoom) to the viewport
// with `fixed` positioning, independent of the image's own size, plus
// making the backdrop itself scrollable (`overflow-y-auto`) as a second
// line of defense for anything still taller than the screen. Rotate and
// zoom were Vipul's explicit ask alongside the Close fix, since a sideways
// gate photo is common and hard to read without them.
// ============================================================

interface PhotoViewerModalProps {
  base64: string;
  mimeType: string;
  label?: string;
  onClose: () => void;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

const PhotoViewerModal: React.FC<PhotoViewerModalProps> = ({ base64, mimeType, label, onClose }) => {
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270
  const [zoom, setZoom] = useState(1);

  const rotate = () => setRotation(r => (r + 90) % 360);
  const zoomIn = () => setZoom(z => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));

  return (
    <div className="fixed inset-0 bg-slate-900/95 backdrop-blur-md z-[110] overflow-y-auto" onClick={onClose}>
      {/* Pinned toolbar — stays on screen regardless of image size, zoom,
          rotation, or scroll position. This is the fix: Close is always
          reachable. */}
      <div
        className="fixed top-0 left-0 right-0 z-[111] flex items-center justify-between gap-2 px-3 py-3 bg-gradient-to-b from-slate-900/90 to-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-white text-[11px] font-black uppercase tracking-widest truncate pr-2">{label}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out"
            className="w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 text-white rounded-lg text-lg font-black leading-none">
            −
          </button>
          <span className="text-white text-[10px] font-bold w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in"
            className="w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 text-white rounded-lg text-lg font-black leading-none">
            +
          </button>
          <button onClick={rotate} title="Rotate 90°"
            className="w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-lg text-base leading-none">
            ⟳
          </button>
          <button onClick={onClose} title="Close"
            className="w-9 h-9 flex items-center justify-center bg-white/15 hover:bg-rose-500 text-white rounded-lg text-lg font-black leading-none">
            ✕
          </button>
        </div>
      </div>

      <div className="min-h-full w-full flex items-center justify-center p-4 pt-20 pb-6" onClick={(e) => e.stopPropagation()}>
        <img
          src={`data:${mimeType};base64,${base64}`}
          alt={label || 'Photo'}
          className="max-w-full max-h-[70vh] object-contain rounded-2xl shadow-2xl transition-transform duration-200"
          style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }}
        />
      </div>
    </div>
  );
};

export default PhotoViewerModal;
