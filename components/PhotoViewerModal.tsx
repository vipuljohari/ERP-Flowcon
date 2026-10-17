import React, { useState, useRef, useEffect } from 'react';

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
//
// 17-Oct-26, Vipul's ask — click-and-drag panning once zoomed in, matching
// WhatsApp Web's own image viewer. Left-click-drag pans (only meaningful
// once zoom > 1); the existing middle-click reset/close shortcut below is
// untouched and lives on a different mouse button entirely, so there's no
// conflict between the two. The one subtlety: a plain left-click on the
// backdrop still has to close the viewer (existing behaviour) — so a
// mousedown->mousemove->mouseup is only treated as a pan once the cursor
// has actually moved past a small threshold; a click with no real
// movement still closes, same as a real click would in WhatsApp's own
// viewer. Panning is clamped loosely (not pixel-perfect to the image's
// true edges) — Vipul confirmed "loosely" is fine, the point is just to
// stop the image from being dragged completely off-screen with no way
// back short of the existing middle-click reset.
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

// Pan tuning — 17-Oct-26. PAN_BOUND_BASE scales with zoom so the loose
// clamp allows more travel the further in you've zoomed, without pinning
// it exactly to the rendered image's true edges (not worth the extra
// measurement code for a "loose" clamp). DRAG_THRESHOLD is how far the
// mouse must move, in px, before a mousedown is treated as a drag/pan
// rather than a plain click (which should still close the viewer).
const PAN_BOUND_BASE = 160;
const DRAG_THRESHOLD = 4;

const PhotoViewerModal: React.FC<PhotoViewerModalProps> = ({ base64, mimeType, label, onClose }) => {
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const imgWrapRef = useRef<HTMLDivElement>(null);

  // Drag bookkeeping lives in refs (not state) so the window-level
  // mousemove/mouseup listeners below always see the latest values
  // without needing to be re-attached on every mouse move.
  const panningRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const didDragRef = useRef(false);

  const clampPan = (x: number, y: number, z: number) => {
    const bound = PAN_BOUND_BASE * z;
    return { x: Math.max(-bound, Math.min(bound, x)), y: Math.max(-bound, Math.min(bound, y)) };
  };

  // Rotating re-orients the image, so any existing pan offset would be
  // pointing in the wrong direction afterwards — reset it, same as the
  // existing middle-click reset already does.
  const rotate = () => { setRotation(r => (r + 90) % 360); setPan({ x: 0, y: 0 }); };
  const zoomIn = () => setZoom(z => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));

  // There's nothing to pan at 100% zoom, so once zoom drops back to 1
  // (zoom-out button, wheel, or the middle-click reset) snap pan back to
  // centre too — otherwise zooming back in later would resume off-centre.
  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  // 12-Oct-26, Vipul's ask — mouse-wheel zoom as a faster alternative to
  // the +/- buttons. This needs a real (non-React-synthetic) listener:
  // React delegates 'wheel' as a passive listener by default (matching
  // browsers' own scroll-perf guidance), and a passive listener is not
  // allowed to call preventDefault() — without going native here, the
  // browser would ALSO scroll this backdrop every time Vipul spun the
  // wheel to zoom, instead of just zooming in place.
  useEffect(() => {
    const el = imgWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => {
        const next = e.deltaY < 0 ? z + ZOOM_STEP : z - ZOOM_STEP;
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 17-Oct-26, Vipul's ask — click-and-drag panning, WhatsApp-Web-style.
  // Listens on `window` (not just this component's own elements) so the
  // drag keeps tracking even if the cursor briefly leaves the backdrop
  // mid-drag (fast mouse movement, multi-monitor setups, etc.) and so it
  // reliably sees the mouseup wherever it happens.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panningRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (!didDragRef.current && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        didDragRef.current = true;
      }
      if (didDragRef.current) {
        setPan(clampPan(panStartRef.current.x + dx, panStartRef.current.y + dy, zoom));
      }
    };
    const onUp = () => {
      panningRef.current = false;
      setIsDragging(false);
      // Clear didDragRef a tick later rather than immediately: the browser
      // fires a `click` event right after this `mouseup`, and that click
      // may land on the image wrapper (which calls stopPropagation and
      // never reaches handleBackdropClick on the backdrop below) rather
      // than the backdrop itself. Clearing on a timeout, instead of only
      // inside handleBackdropClick, means a drag that started/ended over
      // the image still gets its flag reset — so a later genuine click
      // on the backdrop isn't mistakenly swallowed as a leftover drag.
      setTimeout(() => { didDragRef.current = false; }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [zoom]);

  // 12-Oct-26, Vipul's ask — the mouse wheel's middle-click as a two-stage
  // shortcut: from any zoomed/rotated state, the first middle-click resets
  // back to the default view (100% zoom, no rotation) instead of making
  // Vipul find both the zoom-out and rotate buttons separately; a second
  // middle-click while ALREADY at that default view closes the viewer
  // entirely, the same way a middle-click closes a browser tab.
  // preventDefault stops the browser's own middle-click autoscroll cursor
  // from kicking in. Attached on the outer backdrop (not just the image)
  // so it works wherever inside the viewer Vipul clicks — same reach as
  // the existing click-anywhere-on-backdrop-to-close behavior below.
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      if (zoom === 1 && rotation === 0) {
        onClose();
      } else {
        setZoom(1);
        setRotation(0);
        setPan({ x: 0, y: 0 });
      }
      return;
    }
    // Left-click-drag-to-pan — only meaningful once zoomed in; at 100% a
    // plain left-click should keep doing exactly what it already does
    // (close the viewer via the backdrop's onClick, below).
    if (e.button === 0 && zoom > 1) {
      e.preventDefault(); // stop the browser's own native image-drag ghost
      panningRef.current = true;
      didDragRef.current = false;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      panStartRef.current = pan;
      setIsDragging(true);
    }
  };

  // A plain click (mousedown+mouseup with no real movement) should still
  // close the viewer, same as before panning existed. Only a click that
  // the drag effect above flagged as an actual pan (didDragRef) should be
  // swallowed here instead of closing.
  const handleBackdropClick = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/95 backdrop-blur-md z-[110] overflow-y-auto" onClick={handleBackdropClick} onMouseDown={handleMouseDown}>
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

      <div ref={imgWrapRef} className="min-h-full w-full flex items-center justify-center p-4 pt-20 pb-6" onClick={(e) => e.stopPropagation()}>
        <img
          src={`data:${mimeType};base64,${base64}`}
          alt={label || 'Photo'}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className={`max-w-full max-h-[70vh] object-contain rounded-2xl shadow-2xl ${isDragging ? '' : 'transition-transform duration-200'}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${zoom})`,
            cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : undefined,
          }}
        />
      </div>
    </div>
  );
};

export default PhotoViewerModal;
