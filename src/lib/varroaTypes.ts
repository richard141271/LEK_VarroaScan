import type { ImageQualityMetrics } from "./imageQuality";

export type VarroaBoundingBox = {
  id: string;
  class_name: "varroa_mite";
  x: number; // 0..1, left edge normalized
  y: number; // 0..1, top edge normalized
  w: number; // 0..1, width normalized
  h: number; // 0..1, height normalized
  confidence?: number; // 0..1, only for AI-generated boxes. Undefined = manual.
};

export type ImageNote = {
  image_index: number;
  url?: string | null; // Storage bucket path (object path), same as varroa_submissions.images[] entry
  note?: string | null;
  annotations: VarroaBoundingBox[]; // Final admin-approved annotations
  ai_annotations_pending: VarroaBoundingBox[]; // AI-suggested boxes, shown to beekeeper; merged into annotations first time admin opens
  quality?: ImageQualityMetrics | null; // Pre-upload quality check results for audit
};

export function coerceImageNotes(raw: unknown): ImageNote[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map((entry, idx): ImageNote => {
    if (!entry) {
      return {
        image_index: idx,
        url: null,
        note: null,
        annotations: [],
        ai_annotations_pending: [],
        quality: null,
      };
    }
    if (typeof entry === "string") {
      return {
        image_index: idx,
        url: null,
        note: entry,
        annotations: [],
        ai_annotations_pending: [],
        quality: null,
      };
    }
    if (typeof entry !== "object") {
      return {
        image_index: idx,
        url: null,
        note: null,
        annotations: [],
        ai_annotations_pending: [],
        quality: null,
      };
    }
    const rec = entry as Record<string, unknown>;
    const imageIndex =
      typeof rec.image_index === "number"
        ? rec.image_index
        : idx;
    const url = typeof rec.url === "string" ? rec.url : null;
    const note =
      typeof rec.note === "string"
        ? rec.note
        : typeof rec === "object" && rec && "image_note" in rec
          ? String((rec as { image_note?: unknown }).image_note ?? "") || null
          : null;

    const annotations = coerceBoundingBoxArray(rec.annotations);
    const aiPending = coerceBoundingBoxArray(rec.ai_annotations_pending);
    const quality =
      rec.quality && typeof rec.quality === "object"
        ? (rec.quality as ImageQualityMetrics)
        : null;

    return {
      image_index: imageIndex,
      url,
      note,
      annotations,
      ai_annotations_pending: aiPending,
      quality,
    };
  });
}

function coerceBoundingBoxArray(raw: unknown): VarroaBoundingBox[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: VarroaBoundingBox[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const obj = b as Record<string, unknown>;
    const id =
      typeof obj.id === "string"
        ? obj.id
        : `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const class_name =
      typeof obj.class_name === "string" && obj.class_name === "varroa_mite"
        ? "varroa_mite"
        : ("varroa_mite" as const);
    const x = typeof obj.x === "number" ? obj.x : NaN;
    const y = typeof obj.y === "number" ? obj.y : NaN;
    const w = typeof obj.w === "number" ? obj.w : NaN;
    const h = typeof obj.h === "number" ? obj.h : NaN;
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (w <= 0 || h <= 0) continue;
    const box: VarroaBoundingBox = {
      id,
      class_name,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.max(0.0005, Math.min(1, w)),
      h: Math.max(0.0005, Math.min(1, h)),
    };
    if (typeof obj.confidence === "number") {
      box.confidence = Math.max(0, Math.min(1, obj.confidence));
    }
    out.push(box);
  }
  return out;
}

export function getConfidenceLevel(confidence: number | undefined): "high" | "medium" | "low" {
  if (confidence == null || !Number.isFinite(confidence)) return "low";
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

export function getMiteCountCategory(count: number): {
  level: "low" | "medium" | "high";
  label: string;
  chipClass: string;
  message: string;
} {
  if (count <= 3) {
    return {
      level: "low",
      label: "Lavt antall",
      chipClass: "border-emerald-300 bg-emerald-500 text-white",
      message:
        "Lavt antall midd. Send inn flere bilder for å øke treffsikkerheten — en birøkter vil gjennomgå bildene for å forbedre modellen over tid.",
    };
  }
  if (count <= 19) {
    return {
      level: "medium",
      label: "Middels antall",
      chipClass: "border-amber-300 bg-amber-400 text-zinc-950",
      message:
        "Middels antall – observer neste uke og send flere bilder. For å forbedre modellen kan du sende flere, slik at vi kan lære av dem.",
    };
  }
  return {
    level: "high",
    label: "Behandling anbefales",
    chipClass: "border-red-400 bg-red-500 text-white",
    message:
      "Behandling anbefales! Dette er en AI-forutsigelse, ikke et medisinsk råd. Send gjerne flere bilder for å øke treffsikkerheten.",
  };
}
