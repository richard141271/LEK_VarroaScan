"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { useSearchParams } from "next/navigation";
import {
  appendAdminContext,
  getAdminContextSearch,
  getAdminReturnInfo,
} from "@/lib/adminNavigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getVarroaAccess, type VarroaAccess } from "@/lib/varroaRoles";
import {
  createSignedImages,
  formatWorkerLabel,
  formatDateTime,
  getDisplayNameFromEmail,
  getHistoryActionLabel,
  getQualityOptions,
  getRoleLabel,
  getStatusUi,
  getSubmissionSelect,
  getTypeLabel,
  getWorkflowMigrationMessage,
  isAvailableControlSubmission,
  isMissingWorkflowSchemaError,
  type SignedImage,
  type VarroaSubmissionHistory,
  type VarroaSubmissionImageReview,
  type VarroaSubmissionRecord,
  type VarroaSubmissionReview,
} from "@/lib/varroaWorkflow";

type SaveAction =
  | "SAVE_DRAFT"
  | "READY_FOR_REVIEW"
  | "SAVE_AND_NEXT"
  | "APPROVED"
  | "APPROVED_FOR_TRAINING"
  | "RETURNED"
  | "ARCHIVED";

function getActionButtonLabel(action: SaveAction) {
  switch (action) {
    case "SAVE_DRAFT":
      return "Lagre kladd";
    case "READY_FOR_REVIEW":
      return "Klar for kontroll";
    case "SAVE_AND_NEXT":
      return "Lagre og neste";
    case "APPROVED":
      return "Godkjenn";
    case "APPROVED_FOR_TRAINING":
      return "Godkjenn + trening";
    case "RETURNED":
      return "Send tilbake";
    case "ARCHIVED":
      return "Arkiver";
  }
}

/**
 * Bounding box for a detected varroa mite.
 * Coordinates are NORMALIZED to the source image (0..1 range), so the dataset
 * is independent of image resolution and ready for Roboflow / YOLO export.
 *
 *  x = left edge   (0 = leftmost pixel in source image, 1 = rightmost)
 *  y = top edge    (0 = top,            1 = bottom)
 *  w = width of the box, expressed as fraction of source image width
 *  h = height of the box, expressed as fraction of source image height
 *
 * Roboflow Pascal VOC / YOLO conversion is straightforward from this shape.
 */
export type VarroaBoundingBox = {
  id: string;
  class_name: "varroa_mite";
  x: number; // 0..1, left
  y: number; // 0..1, top
  w: number; // 0..1, width
  h: number; // 0..1, height
};

type ImageReviewDraft = {
  id?: string;
  imageIndex: number;
  miteCountInput: string;
  imageQuality: string;
  comment: string;
  trainingReady: boolean;
  approved: boolean;
  /**
   * Per-image Roboflow-ready varroa annotations.
   * When boxes are drawn: miteCountInput is kept in sync = boxes.length automatically.
   */
  annotations: VarroaBoundingBox[];
};

function createEmptyImageDraft(imageIndex: number): ImageReviewDraft {
  return {
    imageIndex,
    miteCountInput: "",
    imageQuality: "",
    comment: "",
    trainingReady: false,
    approved: false,
    annotations: [],
  };
}

/**
 * Load annotations from legacy `image_notes` JSON if available.
 * The review payload stores per-image entries with an `annotations` key.
 */
function extractAnnotationsFromImageNotes(
  imageNotes: unknown,
  imageIndex: number,
): VarroaBoundingBox[] {
  if (!imageNotes || typeof imageNotes !== "object") return [];
  if (!Array.isArray(imageNotes)) return [];
  const entry = (imageNotes as unknown[]).find(
    (e) =>
      !!e &&
      typeof e === "object" &&
      "image_index" in (e as Record<string, unknown>) &&
      (e as { image_index: number }).image_index === imageIndex,
  );
  if (!entry || typeof entry !== "object") return [];
  const rec = entry as Record<string, unknown>;
  const raw = rec.annotations;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const obj = b as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : cryptoRandomId();
      const cn = typeof obj.class_name === "string" ? obj.class_name : "varroa_mite";
      const x = typeof obj.x === "number" ? obj.x : NaN;
      const y = typeof obj.y === "number" ? obj.y : NaN;
      const w = typeof obj.w === "number" ? obj.w : NaN;
      const h = typeof obj.h === "number" ? obj.h : NaN;
      if (![x, y, w, h].every(Number.isFinite)) return null;
      if (w <= 0 || h <= 0) return null;
      return {
        id,
        class_name: cn === "varroa_mite" ? cn : "varroa_mite",
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        w: Math.max(0.0005, Math.min(1, w)),
        h: Math.max(0.0005, Math.min(1, h)),
      } satisfies VarroaBoundingBox;
    })
    .filter((b): b is VarroaBoundingBox => !!b);
}

function cryptoRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftFromImageReview(
  review: VarroaSubmissionImageReview,
  imageNotes: unknown,
): ImageReviewDraft {
  const annotations = extractAnnotationsFromImageNotes(imageNotes, review.image_index);
  const explicitMiteCount = review.mite_count != null ? String(review.mite_count) : "";
  // If annotations exist (new flow) → use their count as authoritative count.
  // Otherwise: fall back to whatever explicit count was stored in the row.
  const miteCountInput =
    annotations.length > 0 ? String(annotations.length) : explicitMiteCount;
  return {
    id: review.id,
    imageIndex: review.image_index,
    miteCountInput,
    imageQuality: review.image_quality ?? "",
    comment: review.comment ?? "",
    trainingReady: Boolean(review.training_ready),
    approved: Boolean(review.approved),
    annotations,
  };
}

/**
 * Zoomable / pannable / annotatable image view with Roboflow-ready varroa bboxes.
 *
 * Interactions:
 *  - Default mode = MARK midd (click + drag on image creates a numbered bbox).
 *  - PAN mode: drag to pan, scroll/double-click/pinch to zoom.
 *  - Any mode: hold SHIFT + drag → force pan (useful while MARK mode to scroll around).
 *  - Two fingers (touch): pinch-zoom + pan (never draws a bbox).
 *  - Numbers on bboxes = counting order. Antall midd auto = boxes.length.
 *  - X on each bbox deletes it. "Angre siste" and "Slett alle" available.
 *
 * Coordinates: bboxes are normalized 0..1 to source image, ready for Roboflow later.
 */
function ZoomableAnnotatedImage({
  src,
  alt,
  boxes,
  onBoxesChange,
  disabled,
}: {
  src: string;
  alt: string;
  boxes: VarroaBoundingBox[];
  onBoxesChange: (next: VarroaBoundingBox[]) => void;
  disabled?: boolean;
}) {
  const MIN_SCALE = 1;
  const MAX_SCALE = 10;
  const DEFAULT_CLICK_BOX_SIZE = 0.010;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const cachedSizeRef = useRef<{ w: number; h: number } | null>(null);
  const visitedGenRef = useRef<{
    array: Int32Array;
    gen: number;
    w: number;
    h: number;
  } | null>(null);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [mode, setMode] = useState<"MARK" | "PAN">("MARK");
  const [drawing, setDrawing] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);

  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  useEffect(() => {
    viewRef.current = { scale, tx, ty };
  }, [scale, tx, ty]);

  // Reset when switching images
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setDrawing(null);
    imageDataRef.current = null;
    cachedSizeRef.current = null;
    visitedGenRef.current = null;
  }, [src]);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchState = useRef<{
    startDist: number;
    startScale: number;
    startMidX: number;
    startMidY: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    moved: boolean;
  } | null>(null);
  const drawKeysPressed = useRef({ shift: false });
  const clickCandidate = useRef<
    | { type: "box"; id: string; t: number; x: number; y: number; moved: boolean }
    | { type: "draw"; t: number; x: number; y: number; moved: boolean }
    | null
  >(null);
  const [hoveredBoxId, setHoveredBoxId] = useState<string | null>(null);

  // Track SHIFT held on window for "force pan during MARK mode".
  useEffect(() => {
    const syncShiftFromEvent = (e: { shiftKey?: boolean; getModifierState?: (k: string) => boolean }) => {
      const fromEvent =
        typeof e.shiftKey === "boolean"
          ? e.shiftKey
          : typeof e.getModifierState === "function"
            ? e.getModifierState("Shift")
            : null;
      if (typeof fromEvent === "boolean") {
        drawKeysPressed.current.shift = fromEvent;
      }
    };

    const cancelAllInteraction = () => {
      dragState.current = null;
      pinchState.current = null;
      clickCandidate.current = null;
      pointers.current.clear();
      setDrawing(null);
    };

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      syncShiftFromEvent(e);
    };
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      const wasShift = drawKeysPressed.current.shift;
      syncShiftFromEvent(e);
      if (
        wasShift &&
        !drawKeysPressed.current.shift &&
        mode === "MARK" &&
        dragState.current != null &&
        !disabled
      ) {
        cancelAllInteraction();
      }
    };
    const onBlur = () => {
      drawKeysPressed.current.shift = false;
    };
    const onFocus = () => {
      drawKeysPressed.current.shift = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur, true);
    window.addEventListener("focus", onFocus, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur, true);
      window.removeEventListener("focus", onFocus, true);
    };
  }, [mode, disabled]);

  const getImageDisplayRect = () => {
    const img = imgRef.current;
    const box = containerRef.current;
    if (!img || !box) return null;
    const cRect = box.getBoundingClientRect();
    const iWidth = img.clientWidth;
    const iHeight = img.clientHeight;
    const left = (cRect.width - iWidth) / 2;
    const top = (cRect.height - iHeight) / 2;
    return {
      containerClientLeft: cRect.left,
      containerClientTop: cRect.top,
      containerWidth: cRect.width,
      containerHeight: cRect.height,
      imgLeft: left,
      imgTop: top,
      imgWidth: iWidth,
      imgHeight: iHeight,
    };
  };

  const handleImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (iw <= 0 || ih <= 0) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = iw;
      canvas.height = ih;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, iw, ih);
      try {
        const data = ctx.getImageData(0, 0, iw, ih);
        imageDataRef.current = data;
        cachedSizeRef.current = { w: iw, h: ih };
      } catch {
        imageDataRef.current = null;
        cachedSizeRef.current = null;
      }
    } catch {
      // Ignore tainted canvas / CORS etc – fall back to default size boxes
    }
  };

  const detectMiteBBox = (
    normX: number,
    normY: number,
  ): { x: number; y: number; w: number; h: number } | null => {
    const id = imageDataRef.current;
    const sz = cachedSizeRef.current;
    if (!id || !sz) return null;
    const iw = sz.w;
    const ih = sz.h;
    const data = id.data;
    const LUM_THRESHOLD = 160;
    const isDark = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= iw || py >= ih) return false;
      const off = (py * iw + px) * 4;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum < LUM_THRESHOLD;
    };

    let cx = Math.round(normX * iw);
    let cy = Math.round(normY * ih);
    cx = Math.max(2, Math.min(iw - 3, cx));
    cy = Math.max(2, Math.min(ih - 3, cy));

    const MAX_REGION = Math.max(2500, Math.round((iw * ih) / 400));

    if (!isDark(cx, cy)) {
      return null;
    }

    let v = visitedGenRef.current;
    if (!v || v.w !== iw || v.h !== ih) {
      v = { w: iw, h: ih, array: new Int32Array(iw * ih), gen: 0 };
      visitedGenRef.current = v;
    }
    v.gen = (v.gen + 1) | 0;
    const gen = v.gen;
    const visited = v.array;

    const stack: number[] = [];
    const idx0 = cy * iw + cx;
    stack.push(idx0);
    visited[idx0] = gen;

    let x1 = cx;
    let y1 = cy;
    let x2 = cx;
    let y2 = cy;
    let count = 0;

    while (stack.length > 0 && count < MAX_REGION) {
      const idx = stack.pop()!;
      const px = idx % iw;
      const py = (idx - px) / iw;
      if (px < x1) x1 = px;
      if (py < y1) y1 = py;
      if (px > x2) x2 = px;
      if (py > y2) y2 = py;
      count++;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= iw || ny >= ih) continue;
          const nIdx = ny * iw + nx;
          if (visited[nIdx] === gen) continue;
          visited[nIdx] = gen;
          if (isDark(nx, ny)) {
            stack.push(nIdx);
          }
        }
      }
    }

    let wPx = x2 - x1 + 1;
    let hPx = y2 - y1 + 1;

    const MIN_BOX_PX = 6;
    if (wPx < MIN_BOX_PX || hPx < MIN_BOX_PX) {
      return null;
    }

    const mW = Math.max(3, Math.round(wPx * 0.35));
    const mH = Math.max(3, Math.round(hPx * 0.35));
    x1 = Math.max(0, x1 - mW);
    y1 = Math.max(0, y1 - mH);
    x2 = Math.min(iw - 1, x2 + mW);
    y2 = Math.min(ih - 1, y2 + mH);
    wPx = x2 - x1 + 1;
    hPx = y2 - y1 + 1;

    return {
      x: x1 / iw,
      y: y1 / ih,
      w: wPx / iw,
      h: hPx / ih,
    };
  };

  const clientToNormalized = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const r = getImageDisplayRect();
    const v = viewRef.current;
    if (!r) return null;
    const localX = clientX - r.containerClientLeft;
    const localY = clientY - r.containerClientTop;
    const cx = r.containerWidth / 2;
    const cy = r.containerHeight / 2;
    const untransformedX = (localX - cx - v.tx) / Math.max(0.001, v.scale) + cx;
    const untransformedY = (localY - cy - v.ty) / Math.max(0.001, v.scale) + cy;
    const imgRelX = untransformedX - r.imgLeft;
    const imgRelY = untransformedY - r.imgTop;
    if (imgRelX < 0 || imgRelY < 0 || imgRelX > r.imgWidth || imgRelY > r.imgHeight) {
      return null;
    }
    return {
      x: imgRelX / Math.max(1, r.imgWidth),
      y: imgRelY / Math.max(1, r.imgHeight),
    };
  };

  const boxHitTest = (clientX: number, clientY: number): { hit: boolean; id: string | null } => {
    const norm = clientToNormalized(clientX, clientY);
    if (!norm) return { hit: false, id: null };
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const b = boxes[i];
      if (norm.x >= b.x && norm.x <= b.x + b.w && norm.y >= b.y && norm.y <= b.y + b.h) {
        return { hit: true, id: b.id };
      }
    }
    return { hit: false, id: null };
  };

  const clampTxTy = (
    nextScale: number,
    nextTx: number,
    nextTy: number,
  ): [number, number] => {
    const img = imgRef.current;
    const box = containerRef.current;
    if (!img || !box || nextScale <= 1) return [0, 0];
    const rect = box.getBoundingClientRect();
    const imgW = img.clientWidth || rect.width;
    const imgH = img.clientHeight || rect.height;
    const maxTx = Math.max(0, (imgW * nextScale - rect.width) / 2);
    const maxTy = Math.max(0, (imgH * nextScale - rect.height) / 2);
    return [
      Math.max(-maxTx, Math.min(maxTx, nextTx)),
      Math.max(-maxTy, Math.min(maxTy, nextTy)),
    ];
  };

  const applyZoomAt = (
    clientX: number,
    clientY: number,
    newScale: number,
  ) => {
    const box = containerRef.current;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    if (!box) {
      setScale(nextScale);
      const [txN, tyN] = clampTxTy(nextScale, 0, 0);
      setTx(txN);
      setTy(tyN);
      viewRef.current = { scale: nextScale, tx: txN, ty: tyN };
      return;
    }
    const rect = box.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    const cur = viewRef.current;
    const k = nextScale / Math.max(0.0001, cur.scale);
    const nextTxRaw = px - (px - cur.tx) * k;
    const nextTyRaw = py - (py - cur.ty) * k;
    const [txN, tyN] = clampTxTy(nextScale, nextTxRaw, nextTyRaw);
    viewRef.current = { scale: nextScale, tx: txN, ty: tyN };
    setScale(nextScale);
    setTx(txN);
    setTy(tyN);
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (viewRef.current.scale === 1 && e.deltaY > 0) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyZoomAt(e.clientX, e.clientY, viewRef.current.scale * factor);
  };

  const startPanFromPointer = (clientX: number, clientY: number) => {
    const cur = viewRef.current;
    dragState.current = {
      startX: clientX,
      startY: clientY,
      startTx: cur.tx,
      startTy: cur.ty,
      moved: false,
    };
  };

  const movePan = (clientX: number, clientY: number) => {
    const st = dragState.current;
    if (!st) return;
    const cur = viewRef.current;
    const dx = clientX - st.startX;
    const dy = clientY - st.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) st.moved = true;
    if (cur.scale <= 1) return;
    const [txN, tyN] = clampTxTy(cur.scale, st.startTx + dx, st.startTy + dy);
    viewRef.current = { ...cur, tx: txN, ty: tyN };
    setTx(txN);
    setTy(tyN);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (typeof e.shiftKey === "boolean") {
      drawKeysPressed.current.shift = e.shiftKey;
    }
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const arr = Array.from(pointers.current.values());
      const [p1, p2] = arr;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const cur = viewRef.current;
      pinchState.current = {
        startDist: dist,
        startScale: cur.scale,
        startMidX: midX,
        startMidY: midY,
        startTx: cur.tx,
        startTy: cur.ty,
      };
      dragState.current = null;
      clickCandidate.current = null;
      setDrawing(null);
      return;
    }

    if (pointers.current.size !== 1) return;

    const shiftHeld =
      drawKeysPressed.current.shift ||
      (typeof e.shiftKey === "boolean" ? e.shiftKey : false);
    const wantPan = mode === "PAN" || shiftHeld || disabled;

    if (wantPan) {
      startPanFromPointer(e.clientX, e.clientY);
      pinchState.current = null;
      clickCandidate.current = null;
      setDrawing(null);
      return;
    }

    const norm = clientToNormalized(e.clientX, e.clientY);
    if (!norm) {
      startPanFromPointer(e.clientX, e.clientY);
      clickCandidate.current = null;
      setDrawing(null);
      return;
    }

    const hit = boxHitTest(e.clientX, e.clientY);
    if (hit.hit && hit.id) {
      clickCandidate.current = {
        type: "box",
        id: hit.id,
        t: performance.now(),
        x: e.clientX,
        y: e.clientY,
        moved: false,
      };
      dragState.current = null;
      pinchState.current = null;
      setDrawing(null);
      return;
    }

    clickCandidate.current = {
      type: "draw",
      t: performance.now(),
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    dragState.current = null;
    pinchState.current = null;
    setDrawing({
      startX: norm.x,
      startY: norm.y,
      endX: norm.x,
      endY: norm.y,
    });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    if (typeof e.shiftKey === "boolean") {
      drawKeysPressed.current.shift = e.shiftKey;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinchState.current && pointers.current.size === 2) {
      const arr = Array.from(pointers.current.values());
      const [p1, p2] = arr;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const ps = pinchState.current;
      const k = dist / Math.max(0.0001, ps.startDist);
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, ps.startScale * k));

      const box = containerRef.current?.getBoundingClientRect();
      if (box) {
        const cx = ps.startMidX - box.left - box.width / 2;
        const cy = ps.startMidY - box.top - box.height / 2;
        const kRatio = nextScale / Math.max(0.0001, ps.startScale);
        const nTx = cx - (cx - ps.startTx) * kRatio + (midX - ps.startMidX);
        const nTy = cy - (cy - ps.startTy) * kRatio + (midY - ps.startMidY);
        const [txN, tyN] = clampTxTy(nextScale, nTx, nTy);
        viewRef.current = { scale: nextScale, tx: txN, ty: tyN };
        setScale(nextScale);
        setTx(txN);
        setTy(tyN);
      } else {
        viewRef.current.scale = nextScale;
        setScale(nextScale);
      }
      if (clickCandidate.current) clickCandidate.current.moved = true;
      return;
    }

    if (clickCandidate.current && !clickCandidate.current.moved) {
      const dx = e.clientX - clickCandidate.current.x;
      const dy = e.clientY - clickCandidate.current.y;
      if (Math.hypot(dx, dy) > 4) {
        clickCandidate.current.moved = true;
        if (clickCandidate.current.type === "box") {
          startPanFromPointer(e.clientX, e.clientY);
        }
      }
    }

    if (drawing && pointers.current.size === 1 && pinchState.current == null) {
      const n = clientToNormalized(e.clientX, e.clientY);
      if (n) {
        setDrawing({
          startX: drawing.startX,
          startY: drawing.startY,
          endX: Math.max(0, Math.min(1, n.x)),
          endY: Math.max(0, Math.min(1, n.y)),
        });
      }
      return;
    }

    if (pointers.current.size === 1 && dragState.current && pinchState.current == null) {
      movePan(e.clientX, e.clientY);
    }
  };

  const finalizePointerEnd = (
    e: PointerEvent<HTMLDivElement>,
    commitDraw: boolean,
  ) => {
    const target = e.currentTarget;
    try { target.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.current.delete(e.pointerId);

    if (pointers.current.size < 2) pinchState.current = null;

    if (commitDraw && clickCandidate.current && !clickCandidate.current.moved) {
      const cand = clickCandidate.current;
      clickCandidate.current = null;
      if (cand.type === "box") {
        onBoxesChange(boxes.filter((b) => b.id !== cand.id));
        setDrawing(null);
        dragState.current = null;
        return;
      }
      if (cand.type === "draw") {
        setDrawing(null);
        const norm = clientToNormalized(cand.x, cand.y);
        if (norm) {
          let rect: { x: number; y: number; w: number; h: number } | null = null;
          const detected = detectMiteBBox(norm.x, norm.y);
          if (detected) {
            rect = detected;
          } else {
            const iw = Math.max(1, imgRef.current?.naturalWidth ?? 1);
            const ih = Math.max(1, imgRef.current?.naturalHeight ?? 1);
            const aspect = iw / Math.max(1, ih);
            const wNorm = DEFAULT_CLICK_BOX_SIZE;
            const hNorm = wNorm * Math.max(0.0001, aspect);
            const hx = wNorm / 2;
            const hy = hNorm / 2;
            const cx = Math.max(hx, Math.min(1 - hx, norm.x));
            const cy = Math.max(hy, Math.min(1 - hy, norm.y));
            rect = { x: cx - hx, y: cy - hy, w: wNorm, h: hNorm };
          }
          if (rect && rect.w > 0.0001 && rect.h > 0.0001) {
            const rx1 = Math.max(0, rect.x);
            const ry1 = Math.max(0, rect.y);
            const rx2 = Math.min(1, rect.x + rect.w);
            const ry2 = Math.min(1, rect.y + rect.h);
            const w = rx2 - rx1;
            const h = ry2 - ry1;
            if (w > 0.0001 && h > 0.0001) {
              const id = cryptoRandomId();
              const next: VarroaBoundingBox = {
                id,
                class_name: "varroa_mite",
                x: rx1,
                y: ry1,
                w,
                h,
              };
              onBoxesChange([...boxes, next]);
            }
          }
        }
        dragState.current = null;
        return;
      }
    }
    clickCandidate.current = null;

    if (commitDraw && drawing && pointers.current.size === 0) {
      const b = drawing;
      setDrawing(null);
      const x = Math.min(b.startX, b.endX);
      const y = Math.min(b.startY, b.endY);
      const w = Math.max(b.endX, b.startX) - x;
      const h = Math.max(b.endY, b.startY) - y;
      if (w > 0.001 && h > 0.001) {
        const id = cryptoRandomId();
        const next: VarroaBoundingBox = {
          id,
          class_name: "varroa_mite",
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y)),
          w: Math.max(0.0005, Math.min(1, w)),
          h: Math.max(0.0005, Math.min(1, h)),
        };
        onBoxesChange([...boxes, next]);
      }
      dragState.current = null;
      return;
    }

    if (!commitDraw) {
      setDrawing(null);
    }

    if (pointers.current.size === 0) dragState.current = null;
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    finalizePointerEnd(e, true);
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    finalizePointerEnd(e, false);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drawing) return;
    if (viewRef.current.scale > 1.05) {
      setScale(1);
      setTx(0);
      setTy(0);
      viewRef.current = { scale: 1, tx: 0, ty: 0 };
    } else {
      applyZoomAt(e.clientX, e.clientY, 3);
    }
  };

  const zoomBy = (factor: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    const cx = box ? box.left + box.width / 2 : 0;
    const cy = box ? box.top + box.height / 2 : 0;
    applyZoomAt(cx, cy, viewRef.current.scale * factor);
  };

  const deleteBox = (id: string) => {
    onBoxesChange(boxes.filter((b) => b.id !== id));
  };

  const undoLast = () => {
    onBoxesChange(boxes.slice(0, -1));
  };

  const clearAll = () => {
    onBoxesChange([]);
  };

  const normalizedToCssPx = (b: VarroaBoundingBox) => {
    const r = getImageDisplayRect();
    if (!r) return null;
    const left = r.imgLeft + b.x * r.imgWidth;
    const top = r.imgTop + b.y * r.imgHeight;
    const width = b.w * r.imgWidth;
    const height = b.h * r.imgHeight;
    return { left, top, width, height };
  };

  const normalizedRectToCssPx = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => {
    const r = getImageDisplayRect();
    if (!r) return null;
    const left = r.imgLeft + Math.min(x1, x2) * r.imgWidth;
    const top = r.imgTop + Math.min(y1, y2) * r.imgHeight;
    const width = Math.max(Math.abs(x2 - x1) * r.imgWidth, 1);
    const height = Math.max(Math.abs(y2 - y1) * r.imgHeight, 1);
    return { left, top, width, height };
  };

  return (
    <div className="relative select-none">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold",
              boxes.length === 0
                ? "border border-zinc-700 bg-zinc-950 text-zinc-300"
                : "border border-amber-400/40 bg-amber-500/10 text-amber-300",
            ].join(" ")}
          >
            🐝 Antall midd markert: <span className="font-bold text-amber-200">{boxes.length}</span>
          </span>
          <div className="inline-flex overflow-hidden rounded-xl border border-zinc-700 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setMode("MARK")}
              disabled={disabled}
              className={[
                "h-9 px-3 transition",
                mode === "MARK"
                  ? "bg-amber-400 text-zinc-950 hover:bg-amber-300"
                  : "bg-zinc-950 text-zinc-300 hover:bg-zinc-900",
                disabled ? "opacity-60" : "",
              ].join(" ")}
            >
              ✏️ Markér midd
            </button>
            <button
              type="button"
              onClick={() => setMode("PAN")}
              className={[
                "h-9 px-3 transition",
                mode === "PAN"
                  ? "bg-amber-400 text-zinc-950 hover:bg-amber-300"
                  : "bg-zinc-950 text-zinc-300 hover:bg-zinc-900",
              ].join(" ")}
            >
              ✋ Pan/zoom
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={undoLast}
            disabled={disabled || boxes.length === 0}
            className="h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-xs font-semibold text-zinc-300 hover:bg-zinc-900 active:opacity-90 disabled:opacity-50"
          >
            ↶ Angre siste
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={disabled || boxes.length === 0}
            className="h-9 rounded-xl border border-red-900/50 bg-red-950/30 px-3 text-xs font-semibold text-red-300 hover:bg-red-950/50 active:opacity-90 disabled:opacity-50"
          >
            🗑️ Slett alle
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        className={[
          "relative overflow-hidden rounded-3xl bg-zinc-950",
          mode === "MARK" && !disabled ? "cursor-crosshair" : "",
          mode === "PAN" ? "cursor-grab active:cursor-grabbing" : "",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        <div
          className="relative flex h-[55vh] w-full items-center justify-center xl:h-[70vh]"
          style={{
            transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
            transformOrigin: "center center",
            transition: "transform 80ms ease-out",
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={handleImageLoad}
            className="h-auto max-h-full w-auto max-w-full object-contain select-none"
          />

          {boxes.map((b) => {
            const px = normalizedToCssPx(b);
            if (!px) return null;
            const hovered = hoveredBoxId === b.id;
            return (
              <div
                key={b.id}
                className="pointer-events-auto absolute"
                style={{
                  left: px.left,
                  top: px.top,
                  width: px.width,
                  height: px.height,
                }}
                onPointerEnter={() => setHoveredBoxId(b.id)}
                onPointerLeave={() =>
                  setHoveredBoxId((prev) => (prev === b.id ? null : prev))
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!disabled) onBoxesChange(boxes.filter((x) => x.id !== b.id));
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
              >
                <div
                  className={[
                    "absolute inset-0 bg-transparent transition",
                    hovered && !disabled ? "border-[1.5px] border-red-500" : "border border-amber-400",
                  ].join(" ")}
                  style={{
                    cursor: disabled ? "default" : "pointer",
                    ...(hovered && !disabled
                      ? { boxShadow: "0 0 0 1px rgba(250,204,21,0.25) inset, 0 0 14px 1px rgba(239,68,68,0.5)" }
                      : {}),
                  }}
                />
              </div>
            );
          })}

          {drawing ? (() => {
            const px = normalizedRectToCssPx(
              drawing.startX,
              drawing.startY,
              drawing.endX,
              drawing.endY,
            );
            if (!px) return null;
            return (
              <div
                className="pointer-events-none absolute"
                style={{
                  left: px.left,
                  top: px.top,
                  width: px.width,
                  height: px.height,
                }}
              >
                <div className="absolute inset-0 border border-dashed border-amber-400 bg-transparent" />
              </div>
            );
          })() : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs font-semibold text-zinc-300">
        <span className="mr-2 rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1.5">
          Zoom: {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(2 / 1.5)}
          className="h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 hover:bg-zinc-900 active:opacity-90"
        >
          ➕ Zoom inn
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.5 / 2)}
          className="h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 hover:bg-zinc-900 active:opacity-90"
        >
          ➖ Zoom ut
        </button>
        <button
          type="button"
          onClick={() => zoomBy(3 / Math.max(0.001, scale))}
          className="h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 hover:bg-zinc-900 active:opacity-90"
        >
          🔍 300%
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setTx(0);
            setTy(0);
            viewRef.current = { scale: 1, tx: 0, ty: 0 };
          }}
          className="h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 hover:bg-zinc-900 active:opacity-90"
        >
          ↺ Tilpass
        </button>
      </div>

      <div className="mt-2 text-center text-[11px] text-zinc-500">
        ✏️ Markér-modus: hurtigklikk på en midd → lager en firkant automatisk. Trenger du
        større boks: hold inne og dra. Klikk på en eksisterende firkant for å fjerne den. Hold
        SHIFT for å panorere mens du merker. Mobil: knip to fingre for å zoome, tap for å merke,
        dra for å tegne større.
      </div>
    </div>
  );
}

export function ProductionSubmissionClient() {
  const isOnline = useOnlineStatus();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);
  const adminContextSearch = useMemo(() => {
    if (typeof window === "undefined") return "";
    return getAdminContextSearch(window.location.search);
  }, []);
  const returnInfo = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: null as string | null, label: null as string | null };
    }
    const raw = getAdminReturnInfo(window.location.search);
    if (raw.href) return raw;
    return { href: null as string | null, label: null as string | null };
  }, []);
  const adminLoginHref = useMemo(() => {
    if (typeof window === "undefined") return `${basePath}/admin/`;
    const params = new URLSearchParams(window.location.search);
    const currentPath = window.location.pathname.startsWith(basePath)
      ? window.location.pathname.slice(basePath.length) || "/"
      : window.location.pathname;
    params.set("next", `${currentPath}${window.location.search}`);
    return `${basePath}/admin/?${params.toString()}`;
  }, [basePath]);

  const [isAuthed, setIsAuthed] = useState(false);
  const [access, setAccess] = useState<VarroaAccess | null>(null);
  const [item, setItem] = useState<VarroaSubmissionRecord | null>(null);
  const [images, setImages] = useState<SignedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [reviews, setReviews] = useState<VarroaSubmissionReview[]>([]);
  const [imageDrafts, setImageDrafts] = useState<Record<number, ImageReviewDraft>>({});
  const [history, setHistory] = useState<VarroaSubmissionHistory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const totalImages = images.length;
  const isLastImage = totalImages === 0 || selectedImage >= totalImages - 1;
  const currentDraft = imageDrafts[selectedImage] ?? createEmptyImageDraft(selectedImage);

  const reload = useCallback(async () => {
    setLoadError(null);
    setSaveError(null);
    setSaveOk(null);

    if (!id) {
      setLoadError("Mangler id i URL. Bruk ?id=<uuid>.");
      return;
    }
    if (!supabase) {
      setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    setIsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      setIsAuthed(Boolean(session));
      if (!session) {
        setAccess(null);
        setItem(null);
        setImages([]);
        window.location.replace(adminLoginHref);
        return;
      }

      const nextAccess = await getVarroaAccess(supabase, session);
      setAccess(nextAccess);
      if (!nextAccess.role) {
        setItem(null);
        setImages([]);
        setLoadError("Du mangler rolle i VarroaScan-produksjonen.");
        return;
      }

      const [submissionRes, reviewsRes, historyRes, imageReviewsRes] = await Promise.all([
        supabase
          .from("varroa_submissions")
          .select(getSubmissionSelect())
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("varroa_submission_reviews")
          .select(
            "id,submission_id,created_at,updated_at,created_by,mite_count,image_quality,comment,training_ready,approved,current_image_index,image_notes",
          )
          .eq("submission_id", id)
          .order("updated_at", { ascending: false })
          .limit(20),
        supabase
          .from("varroa_submission_history")
          .select("id,submission_id,created_at,user_id,action,from_status,to_status,comment,payload")
          .eq("submission_id", id)
          .order("created_at", { ascending: false })
          .limit(40),
        supabase
          .from("varroa_submission_review_images")
          .select(
            "id,submission_id,review_id,created_at,updated_at,created_by,image_index,mite_count,image_quality,comment,training_ready,approved",
          )
          .eq("submission_id", id)
          .eq("created_by", nextAccess.userId)
          .order("image_index", { ascending: true }),
      ]);

      if (submissionRes.error) {
        if (isMissingWorkflowSchemaError(submissionRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw submissionRes.error;
      }
      if (!submissionRes.data) {
        setLoadError("Fant ikke saken.");
        setItem(null);
        setImages([]);
        return;
      }
      if (reviewsRes.error) {
        if (isMissingWorkflowSchemaError(reviewsRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw reviewsRes.error;
      }
      if (historyRes.error) {
        if (isMissingWorkflowSchemaError(historyRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw historyRes.error;
      }
      if (imageReviewsRes.error) {
        if (isMissingWorkflowSchemaError(imageReviewsRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw imageReviewsRes.error;
      }

      const loaded = submissionRes.data as unknown as VarroaSubmissionRecord;
      const loadedReviews =
        (reviewsRes.data ?? []) as unknown as VarroaSubmissionReview[];
      const loadedImageReviews =
        (imageReviewsRes.data ?? []) as unknown as VarroaSubmissionImageReview[];
      const loadedHistory =
        (historyRes.data ?? []) as unknown as VarroaSubmissionHistory[];
      const signedImages = await createSignedImages(
        supabase,
        Array.isArray(loaded.images) ? loaded.images : [],
      );

      setItem(loaded);
      setReviews(loadedReviews);
      setHistory(loadedHistory);
      setImages(signedImages);

      const ownReview = loadedReviews.find((review) => review.created_by === nextAccess.userId);
      const latestReview = ownReview ?? loadedReviews[0] ?? null;
      const sharedImageNotes = latestReview?.image_notes;
      const nextImageIndex =
        typeof latestReview?.current_image_index === "number"
          ? latestReview.current_image_index
          : 0;
      setSelectedImage(
        signedImages.length === 0 ? 0 : Math.min(Math.max(nextImageIndex, 0), signedImages.length - 1),
      );
      const nextDrafts: Record<number, ImageReviewDraft> = {};
      for (let index = 0; index < signedImages.length; index += 1) {
        nextDrafts[index] = createEmptyImageDraft(index);
      }
      for (const imageReview of loadedImageReviews) {
        nextDrafts[imageReview.image_index] = createDraftFromImageReview(
          imageReview,
          sharedImageNotes,
        );
      }
      if (loadedImageReviews.length === 0 && latestReview) {
        const fallbackIndex = Math.min(Math.max(nextImageIndex, 0), Math.max(signedImages.length - 1, 0));
        const annotations = extractAnnotationsFromImageNotes(sharedImageNotes, fallbackIndex);
        nextDrafts[fallbackIndex] = {
          imageIndex: fallbackIndex,
          miteCountInput:
            annotations.length > 0
              ? String(annotations.length)
              : latestReview.mite_count != null
                ? String(latestReview.mite_count)
                : loaded.manual_mite_count != null
                  ? String(loaded.manual_mite_count)
                  : "",
          imageQuality: latestReview.image_quality ?? loaded.quality_rating ?? "",
          comment: latestReview.comment ?? loaded.review_comment ?? "",
          trainingReady: Boolean(latestReview.training_ready ?? loaded.training_ready),
          approved: Boolean(latestReview.approved),
          annotations,
        };
      }
      setImageDrafts(nextDrafts);
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
      setItem(null);
      setImages([]);
      setReviews([]);
      setImageDrafts({});
      setHistory([]);
    } finally {
      setIsLoading(false);
    }
  }, [adminLoginHref, id, supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  const isControlStage = Boolean(
    item &&
      access?.canControl &&
      isAvailableControlSubmission(item, access.userId) &&
      item.processed_by,
  );
  const isFinalized = item?.status === "GODKJENT" || item?.status === "KLAR_FOR_TRENING";
  const canDoWork = Boolean(item && access?.role && !isControlStage && item.status !== "ARKIVERT" && !isFinalized);
  const totalDraftMites = Object.values(imageDrafts).reduce((sum, draft) => {
    if (draft.miteCountInput.trim() === "") return sum;
    const value = Number.parseInt(draft.miteCountInput.trim(), 10);
    return Number.isNaN(value) ? sum : sum + value;
  }, 0);
  const allImagesTrainingReady =
    totalImages > 0 &&
    Array.from({ length: totalImages }, (_, index) => imageDrafts[index] ?? createEmptyImageDraft(index)).every(
      (draft) => draft.trainingReady,
    );

  const updateCurrentDraft = (patch: Partial<ImageReviewDraft>) => {
    setImageDrafts((prev) => {
      const existing = prev[selectedImage] ?? createEmptyImageDraft(selectedImage);
      const next = { ...existing, ...patch };
      // Auto-sync: when annotations array is present, set miteCountInput = boxes.length.
      if (
        "annotations" in patch &&
        Array.isArray(patch.annotations) &&
        patch.annotations.length >= 0
      ) {
        next.miteCountInput = patch.annotations.length === 0 ? "" : String(patch.annotations.length);
      }
      return { ...prev, [selectedImage]: next };
    });
  };

  const handleAnnotationsChange = (next: VarroaBoundingBox[]) => {
    updateCurrentDraft({ annotations: next });
  };

  const persist = async (action: SaveAction) => {
    setSaveError(null);
    setSaveOk(null);

    if (!supabase) {
      setSaveError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }
    if (!isOnline) {
      setSaveError("Du er offline. Kan ikke lagre.");
      return;
    }
    if (!item || !access?.userId || !access.role) {
      setSaveError("Mangler tilgang eller sak.");
      return;
    }

    const draftEntries = Array.from({ length: totalImages }, (_, index) => imageDrafts[index] ?? createEmptyImageDraft(index));
    const invalidDraft = draftEntries.find((draft) => {
      if (draft.miteCountInput.trim() === "") return false;
      return Number.isNaN(Number.parseInt(draft.miteCountInput.trim(), 10));
    });
    if (invalidDraft) {
      setSaveError(`Antall midd ma vare et helt tall pa bilde ${invalidDraft.imageIndex + 1}.`);
      return;
    }

    const currentMiteCount =
      currentDraft.miteCountInput.trim() === ""
        ? null
        : Number.parseInt(currentDraft.miteCountInput.trim(), 10);

    const nowIso = new Date().toISOString();
    let nextStatus = item.status;
    let nextTrainingReady = allImagesTrainingReady;
    let approved = false;
    const historyComment = currentDraft.comment.trim() || null;
    const stayOnCurrentSubmission =
      action === "SAVE_AND_NEXT" && selectedImage < Math.max(images.length - 1, 0);
    const nextImageIndex = stayOnCurrentSubmission
      ? Math.min(selectedImage + 1, Math.max(images.length - 1, 0))
      : selectedImage;

    switch (action) {
      case "SAVE_DRAFT":
        nextStatus =
          isControlStage
            ? item.status
            : item.status === "NY" || item.status === "KLAR_FOR_KONTROLL"
              ? "UNDER_ARBEID"
              : item.status;
        break;
      case "READY_FOR_REVIEW":
        nextStatus = "KLAR_FOR_KONTROLL";
        break;
      case "SAVE_AND_NEXT":
        nextStatus = isControlStage
          ? item.status
          : stayOnCurrentSubmission
            ? item.status === "KLAR_FOR_KONTROLL"
              ? "KLAR_FOR_KONTROLL"
              : "UNDER_ARBEID"
            : "KLAR_FOR_KONTROLL";
        break;
      case "APPROVED":
        nextStatus = "GODKJENT";
        approved = true;
        break;
      case "APPROVED_FOR_TRAINING":
        nextStatus = "KLAR_FOR_TRENING";
        nextTrainingReady = true;
        approved = true;
        break;
      case "RETURNED":
        nextStatus = "UNDER_ARBEID";
        break;
      case "ARCHIVED":
        nextStatus = "ARKIVERT";
        approved = item.status === "GODKJENT" || item.status === "KLAR_FOR_TRENING";
        break;
    }

    const isImageStep = action === "SAVE_AND_NEXT" && stayOnCurrentSubmission;
    const historyAction = isImageStep
      ? isControlStage
        ? "CONTROL_NEXT_IMAGE"
        : "WORK_NEXT_IMAGE"
      : action;
    const historyFromStatus = isImageStep ? null : item.status;
    const historyToStatus = isImageStep ? null : nextStatus;

    const updatePatch: Record<string, unknown> = {
      status: nextStatus,
      manual_mite_count: totalDraftMites,
      quality_rating: currentDraft.imageQuality || null,
      review_comment: historyComment,
      training_ready: nextTrainingReady,
      current_role_owner:
        action === "RETURNED" ? "ARBEID" : action === "READY_FOR_REVIEW" ? "KONTROLL" : access.role,
    };

    if (action === "SAVE_DRAFT" || action === "READY_FOR_REVIEW" || action === "SAVE_AND_NEXT") {
      updatePatch.assigned_to = item.assigned_to ?? access.userId;
      updatePatch.assigned_at = item.assigned_at ?? nowIso;
      updatePatch.processed_by = access.userId;
      updatePatch.processed_at = item.processed_at ?? nowIso;
    }

    if (action === "APPROVED" || action === "APPROVED_FOR_TRAINING") {
      updatePatch.approved_by = access.userId;
      updatePatch.approved_at = nowIso;
      updatePatch.returned_by = null;
      updatePatch.returned_at = null;
    }

    if (action === "RETURNED") {
      updatePatch.returned_by = access.userId;
      updatePatch.returned_at = nowIso;
      updatePatch.approved_by = null;
      updatePatch.approved_at = null;
      updatePatch.assigned_to = item.processed_by ?? item.assigned_to;
    }

    if (action === "ARCHIVED") {
      updatePatch.approved_by = item.approved_by ?? access.userId;
      updatePatch.approved_at = item.approved_at ?? nowIso;
    }

    setIsSaving(true);
    try {
      const reviewPayload = {
        submission_id: item.id,
        created_by: access.userId,
        mite_count: currentMiteCount,
        image_quality: currentDraft.imageQuality || null,
        comment: historyComment,
        training_ready: nextTrainingReady,
        approved,
        current_image_index: nextImageIndex,
        image_notes: draftEntries.map((draft) => {
          // Annotations (Roboflow-ready bboxes) are stored per-image in image_notes.
          // Later: these can be exported as YOLO/COCO/Roboflow JSON.
          const validAnnotations = (draft.annotations ?? []).filter(
            (b) =>
              Number.isFinite(b.x) &&
              Number.isFinite(b.y) &&
              Number.isFinite(b.w) &&
              Number.isFinite(b.h) &&
              b.w > 0 &&
              b.h > 0,
          );
          const countFromBoxes = validAnnotations.length;
          const explicitCount =
            draft.miteCountInput.trim() === ""
              ? null
              : Number.parseInt(draft.miteCountInput.trim(), 10);
          // Prefer explicit count if it differs (rare, user typed manually after drawing).
          // Otherwise: derived count = number of boxes.
          const finalMiteCount =
            explicitCount != null && !Number.isNaN(explicitCount)
              ? countFromBoxes > 0
                ? countFromBoxes
                : explicitCount
              : countFromBoxes > 0
                ? countFromBoxes
                : null;
          return {
            image_index: draft.imageIndex,
            mite_count: finalMiteCount,
            image_quality: draft.imageQuality || null,
            comment: draft.comment.trim() || null,
            training_ready: draft.trainingReady,
            approved: approved || draft.approved,
            annotations: validAnnotations,
          };
        }),
      };
      const reviewRes = await supabase
        .from("varroa_submission_reviews")
        .upsert(reviewPayload, {
          onConflict: "submission_id,created_by",
        })
        .select("id")
        .single();

      if (reviewRes.error) throw reviewRes.error;
      const reviewId = String(reviewRes.data.id);

      const imageReviewRows = draftEntries.map((draft) => ({
        id: draft.id,
        submission_id: item.id,
        review_id: reviewId,
        created_by: access.userId,
        image_index: draft.imageIndex,
        mite_count:
          draft.miteCountInput.trim() === ""
            ? null
            : Number.parseInt(draft.miteCountInput.trim(), 10),
        image_quality: draft.imageQuality || null,
        comment: draft.comment.trim() || null,
        training_ready: draft.trainingReady,
        approved: approved || draft.approved,
      }));
      const imageReviewRes = await supabase
        .from("varroa_submission_review_images")
        .upsert(imageReviewRows, {
          onConflict: "review_id,image_index",
          defaultToNull: false,
        });

      if (imageReviewRes.error) throw imageReviewRes.error;

      const updateRes = await supabase
        .from("varroa_submissions")
        .update(updatePatch)
        .eq("id", item.id);
      if (updateRes.error) throw updateRes.error;

      const historyRes = await supabase.from("varroa_submission_history").insert({
        submission_id: item.id,
        user_id: access.userId,
        action: historyAction,
        from_status: historyFromStatus,
        to_status: historyToStatus,
        comment: historyComment,
        payload: {
          role: access.role,
          mite_count: currentMiteCount,
          image_quality: currentDraft.imageQuality || null,
          training_ready: nextTrainingReady,
          approved,
          current_image_index: nextImageIndex,
          total_images: images.length,
        },
      });
      if (historyRes.error) throw historyRes.error;

      setSaveOk(`${getActionButtonLabel(action)} lagret.`);

      if (
        access.canControl &&
        (action === "APPROVED" ||
          action === "APPROVED_FOR_TRAINING" ||
          action === "RETURNED" ||
          action === "ARCHIVED")
      ) {
        const nextControlRes = await supabase
          .from("varroa_submissions")
          .select("id")
          .eq("status", "KLAR_FOR_KONTROLL")
          .neq("processed_by", access.userId)
          .neq("id", item.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (nextControlRes.error) throw nextControlRes.error;
        const nextId = String(nextControlRes.data?.id ?? "");
        if (nextId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(nextId)}`,
              adminContextSearch,
            ),
          );
          return;
        }

        const underWorkRes = await supabase
          .from("varroa_submissions")
          .select("id")
          .eq("status", "UNDER_ARBEID")
          .or(`assigned_to.eq.${access.userId},processed_by.eq.${access.userId}`)
          .neq("id", item.id)
          .order("updated_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (underWorkRes.error) throw underWorkRes.error;
        const resumeId = String(underWorkRes.data?.id ?? "");
        if (resumeId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(resumeId)}`,
              adminContextSearch,
            ),
          );
          return;
        }

        window.location.assign(
          appendAdminContext(`${basePath}/admin/innsendinger/?view=mine`, adminContextSearch),
        );
        return;
      }

      if (action === "SAVE_AND_NEXT") {
        if (stayOnCurrentSubmission) {
          await reload();
          return;
        }
        if (isControlStage) {
          setSaveOk("Alle bilder er kontrollert. Du kan nå godkjenne saken.");
          await reload();
          return;
        }
        const nextRes = await supabase.rpc("varroa_claim_next_submission");
        if (nextRes.error) throw nextRes.error;
        const nextId = String(nextRes.data ?? "");
        if (nextId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(nextId)}`,
              adminContextSearch,
            ),
          );
          return;
        }
        const underWorkRes = await supabase
          .from("varroa_submissions")
          .select("id")
          .eq("status", "UNDER_ARBEID")
          .or(`assigned_to.eq.${access.userId},processed_by.eq.${access.userId}`)
          .neq("id", item.id)
          .order("updated_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (underWorkRes.error) throw underWorkRes.error;
        const resumeId = String(underWorkRes.data?.id ?? "");
        if (resumeId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(resumeId)}`,
              adminContextSearch,
            ),
          );
          return;
        }

        window.location.assign(
          appendAdminContext(`${basePath}/admin/innsendinger/?view=mine`, adminContextSearch),
        );
        return;
      }

      await reload();
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const currentImage = images[selectedImage] ?? null;
  const currentStatusUi = getStatusUi(item?.status ?? "NY");
  const qualityOptions = getQualityOptions();
  const latestReview = reviews[0] ?? null;
  const isArchived = item?.status === "ARKIVERT";
  const isApproved = item?.status === "GODKJENT" || item?.status === "KLAR_FOR_TRENING";
  const canBrowseImages = images.length > 1 && !isArchived;
  const saveAndNextLabel = isControlStage
    ? isLastImage
      ? "Kontroll fullført"
      : "Neste kontrollbilde"
    : isLastImage
      ? "Lagre og neste sak"
      : "Lagre og neste bilde";

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-[1500px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex-shrink-0">
            <div className="text-lg font-semibold">Arbeidsflate</div>
            <div className="text-xs text-zinc-400">
              Stor bildeflate, rask lagring og sporbar historikk.
            </div>
          </div>
          <div className="hidden flex-1 text-center md:block">
            {access?.role && access.email ? (
              <div className="text-sm font-medium text-amber-200/90">
                👋 Velkommen {getDisplayNameFromEmail(access.email)} ({getRoleLabel(access.role)}), ha
                en fin dag!
              </div>
            ) : null}
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
            {returnInfo.href ? (
              <a
                href={returnInfo.href}
                className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
              >
                {returnInfo.label}
              </a>
            ) : (
              <a
                href={`${basePath}/`}
                className="text-sm font-semibold text-zinc-300 hover:text-zinc-50"
              >
                ← Til forsiden
              </a>
            )}
            <a
              href={appendAdminContext(`${basePath}/admin/innsendinger/?view=mine`, adminContextSearch)}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Arbeidskø
            </a>
            <button
              type="button"
              onClick={reload}
              disabled={isLoading}
              className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
            >
              Oppdater
            </button>
          </div>
        </div>
        {access?.role && access.email ? (
          <div className="mt-2 text-center md:hidden">
            <div className="text-xs font-medium text-amber-200/90">
              👋 Velkommen {getDisplayNameFromEmail(access.email)} ({getRoleLabel(access.role)})
            </div>
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-[1500px] space-y-4">
        {!isAuthed ? (
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-300">
            Logg inn via `Admin` for å åpne arbeidsflaten.
          </div>
        ) : null}

        {loadError ? (
          <div className="rounded-3xl border border-red-900/60 bg-red-950/40 px-5 py-4 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}

        {item && access?.role ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_420px]">
            <section className="space-y-4">
              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xl font-semibold text-zinc-50">
                      {getTypeLabel(item.type)}
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">
                      Innsendt {formatDateTime(item.created_at)} • ID {item.id}
                    </div>
                  </div>
                  <div
                    className={[
                      "rounded-full border px-4 py-1.5 text-[11px] font-semibold",
                      currentStatusUi.chipClass,
                    ].join(" ")}
                  >
                    {currentStatusUi.label}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-zinc-300 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-zinc-500">Tildelt</div>
                    <div className="mt-1">{formatWorkerLabel(access.userId, item.assigned_to)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Forste sjekk</div>
                    <div className="mt-1">{formatWorkerLabel(access.userId, item.processed_by)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Godkjent av</div>
                    <div className="mt-1">{formatWorkerLabel(access.userId, item.approved_by)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Oppdatert</div>
                    <div className="mt-1">{formatDateTime(item.updated_at ?? item.created_at)}</div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-200">
                  {item.note || "Ingen kommentar fra innsendingen."}
                </div>
              </div>

              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Bilde</div>
                <div className="mt-2 text-sm text-zinc-400">
                  Bilde {Math.min(selectedImage + 1, Math.max(totalImages, 1))} av {Math.max(totalImages, 1)}
                </div>
                {canBrowseImages ? (
                  <div className="mt-2 text-xs text-zinc-500">
                    Klikk miniatyrene for å bytte mellom bilder og rette vurderingen før saken er
                    ferdigstilt.
                  </div>
                ) : null}
                <div className="mt-4 rounded-3xl border border-zinc-800 bg-zinc-950 p-2">
                  {currentImage ? (
                    <ZoomableAnnotatedImage
                      src={currentImage.url}
                      alt="Varroa-bilde"
                      boxes={currentDraft.annotations ?? []}
                      onBoxesChange={handleAnnotationsChange}
                      disabled={isArchived || isFinalized || isSaving || isLoading}
                    />
                  ) : (
                    <div className="flex h-[55vh] items-center justify-center text-sm text-zinc-500 xl:h-[70vh]">
                      Ingen bilder tilgjengelig.
                    </div>
                  )}
                </div>

                {images.length > 1 ? (
                  <div className="mt-4 grid grid-cols-4 gap-3 xl:grid-cols-6">
                    {images.map((image, index) => (
                      <button
                        type="button"
                        key={image.path}
                        onClick={() => setSelectedImage(index)}
                        disabled={isSaving || isArchived}
                        className={[
                          "overflow-hidden rounded-2xl border bg-zinc-950 text-left transition active:opacity-90 disabled:cursor-default disabled:opacity-80",
                          index === selectedImage
                            ? "border-amber-300 ring-2 ring-amber-300/40"
                            : index < selectedImage
                              ? "border-emerald-700"
                              : "border-zinc-800",
                        ].join(" ")}
                      >
                        <img
                          src={image.url}
                          alt={`Miniatyr ${index + 1}`}
                          className="h-24 w-24 object-cover"
                        />
                        <div className="border-t border-zinc-800 px-2 py-1 text-center text-[10px] font-semibold text-zinc-400">
                          {index === selectedImage
                            ? "Nå"
                            : isApproved
                              ? "Vis"
                              : index < selectedImage
                                ? "Åpne igjen"
                                : "Åpne"}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
              <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Arbeidsfelt</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {isControlStage
                    ? "Denne saken venter pa kontroll av en annen bruker. Du kan ga gjennom alle bildene og godkjenne eller sende tilbake."
                    : "Du kan gå fritt mellom bildene, rette vurderingen og sende saken til kontroll når du er klar."}
                </div>
                {item.status === "KLAR_FOR_KONTROLL" && item.processed_by === access.userId ? (
                  <div className="mt-3 rounded-2xl border border-sky-900/50 bg-sky-950/30 px-4 py-3 text-xs text-sky-100">
                    Saken venter pa kontroll fra en annen bruker. Du kan fortsatt rette bildene og
                    sende den til kontroll pa nytt, men du kan ikke godkjenne din egen forstesjekk.
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-1 gap-4">
                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Antall midd</div>
                    <input
                      value={currentDraft.miteCountInput}
                      onChange={(e) => updateCurrentDraft({ miteCountInput: e.target.value })}
                      inputMode="numeric"
                      placeholder="F.eks. 14"
                      className="mt-2 h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    />
                  </label>

                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Bildekvalitet</div>
                    <select
                      value={currentDraft.imageQuality}
                      onChange={(e) => updateCurrentDraft({ imageQuality: e.target.value })}
                      className="mt-2 h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    >
                      {qualityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Kommentar for dette bildet</div>
                    <textarea
                      value={currentDraft.comment}
                      onChange={(e) => updateCurrentDraft({ comment: e.target.value })}
                      rows={5}
                      className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                      placeholder="Observasjoner, usikkerhet, kvalitet eller vurdering."
                    />
                  </label>

                  <label className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={currentDraft.trainingReady}
                      onChange={(e) => updateCurrentDraft({ trainingReady: e.target.checked })}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-amber-400 focus:ring-amber-300"
                    />
                    <span className="text-sm font-medium text-zinc-200">Dette bildet er klart for trening</span>
                  </label>
                </div>

                {latestReview ? (
                  <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                    Siste review oppdatert {formatDateTime(latestReview.updated_at)} av{" "}
                    {latestReview.created_by}
                  </div>
                ) : null}

                {saveOk ? (
                  <div className="mt-4 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                    {saveOk}
                  </div>
                ) : null}
                {saveError ? (
                  <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                    {saveError}
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => void persist("SAVE_DRAFT")}
                    disabled={isSaving}
                    className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
                  >
                    {isSaving ? "Lagrer…" : getActionButtonLabel("SAVE_DRAFT")}
                  </button>

                  {canDoWork ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void persist("READY_FOR_REVIEW")}
                        disabled={isSaving || !isLastImage}
                        className="h-12 rounded-2xl border border-sky-700 bg-sky-950/40 text-sm font-semibold text-sky-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("READY_FOR_REVIEW")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("SAVE_AND_NEXT")}
                        disabled={isSaving}
                        className="h-12 rounded-2xl bg-amber-400 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60"
                      >
                        {saveAndNextLabel}
                      </button>
                      {!isLastImage ? (
                        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                          Jobb deg gjennom bildene og send saken til kontroll nar du er klar. Pa
                          siste bilde kan du enten sende til kontroll eller ga videre til neste sak.
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {isControlStage ? (
                    <>
                      {!isLastImage ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void persist("SAVE_AND_NEXT")}
                            disabled={isSaving}
                            className="h-12 rounded-2xl bg-amber-400 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60"
                          >
                            {saveAndNextLabel}
                          </button>
                          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                            Gå gjennom alle bildene i saken. Godkjenning låses opp når du er på
                            siste bilde.
                          </div>
                        </>
                      ) : (
                        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                          Kontroll fullført. Velg Godkjenn, Godkjenn + trening, Send tilbake eller
                          Arkiver. Neste sak åpnes automatisk.
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => void persist("APPROVED")}
                        disabled={isSaving || !isLastImage || isApproved || isArchived}
                        className="h-12 rounded-2xl border border-emerald-700 bg-emerald-950/40 text-sm font-semibold text-emerald-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("APPROVED")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("APPROVED_FOR_TRAINING")}
                        disabled={
                          isSaving ||
                          !isLastImage ||
                          item.status === "KLAR_FOR_TRENING" ||
                          isArchived
                        }
                        className="h-12 rounded-2xl border border-fuchsia-700 bg-fuchsia-950/40 text-sm font-semibold text-fuchsia-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("APPROVED_FOR_TRAINING")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("RETURNED")}
                        disabled={isSaving || isArchived}
                        className="h-12 rounded-2xl border border-amber-700 bg-amber-950/40 text-sm font-semibold text-amber-100 active:opacity-90 disabled:opacity-60"
                      >
                        {getActionButtonLabel("RETURNED")}
                      </button>
                      {item.status === "GODKJENT" || item.status === "KLAR_FOR_TRENING" ? (
                        <button
                          type="button"
                          onClick={() => void persist("ARCHIVED")}
                          disabled={isSaving || !isLastImage}
                          className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-40"
                        >
                          {getActionButtonLabel("ARCHIVED")}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>

              <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Historikk</div>
                <div className="mt-4 space-y-3">
                  {history.length === 0 ? (
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-400">
                      Ingen historikk ennå.
                    </div>
                  ) : null}
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-zinc-100">
                          {getHistoryActionLabel(entry.action)}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {formatDateTime(entry.created_at)}
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">
                        {entry.from_status ? `${entry.from_status} → ` : ""}
                        {entry.to_status ?? "—"}
                        {entry.user_id ? ` • ${entry.user_id}` : ""}
                      </div>
                      {entry.comment ? (
                        <div className="mt-2 text-sm text-zinc-300">{entry.comment}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        ) : null}
      </main>
    </div>
  );
}
