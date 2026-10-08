// Supabase Edge Function: varroa-infer
// Proxy for Roboflow "Varroa Detection v2 Logic" workflow inference.
// Reads AI predictions, updates varroa_submissions.ai_* columns and image_notes[].ai_annotations_pending.
//
// Requires Supabase Function Secrets (via CLI: `supabase secrets set ROBOFLOW_INFERENCE_KEY=...`):
//   ROBOFLOW_INFERENCE_KEY  - Bearer token for Roboflow workflow inference endpoint
//   ROBOFLOW_WORKFLOW_URL   - (optional) full workflow URL, defaults to the known slug
//
// Default Roboflow Workflow:
//   workspace slug:  lek-vision-lab
//   workflow slug:   varroa-detection-v2-logic
//   inference URL:   POST https://serverless.roboflow.com/lek-vision-lab/workflows/varroa-detection-v2-logic
//   input key:       "image"  (HTTPS URL or base64)
//   auth:            Authorization: Bearer ${ROBOFLOW_INFERENCE_KEY}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type BB = {
  id: string;
  class_name: "varroa_mite";
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
};

type ImageNoteIn = {
  image_index: number;
  url?: string | null;
  note?: string | null;
  annotations?: BB[];
  ai_annotations_pending?: BB[];
  quality?: unknown | null;
};

type SignedImage = { path: string; url: string };

const DEFAULT_WORKFLOW_URL =
  "https://serverless.roboflow.com/lek-vision-lab/workflows/varroa-detection-v2-logic";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed", method: req.method }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const sbAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const sbServiceRole =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
  const roboKey = Deno.env.get("ROBOFLOW_INFERENCE_KEY") ?? "";
  const roboUrl = Deno.env.get("ROBOFLOW_WORKFLOW_URL") ?? DEFAULT_WORKFLOW_URL;

  if (!sbUrl || !sbServiceRole) {
    return new Response(
      JSON.stringify({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in function env." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!roboKey) {
    // Fail FAST if Roboflow key is missing; don't even mark RUNNING so caller sees error immediately.
    return new Response(
      JSON.stringify({ error: "Missing ROBOFLOW_INFERENCE_KEY in Supabase Function Secrets. Run: supabase secrets set ROBOFLOW_INFERENCE_KEY=..." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let payload: { submission_id?: string; signed_images?: SignedImage[] } = {};
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const submissionId = payload.submission_id;
  if (!submissionId || typeof submissionId !== "string") {
    return new Response(JSON.stringify({ error: "Missing submission_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signedIn: Map<string, string> = new Map();
  for (const s of payload.signed_images ?? []) {
    if (s && typeof s.path === "string" && typeof s.url === "string") {
      signedIn.set(s.path, s.url);
    }
  }

  const supabase = createClient(sbUrl, sbServiceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: row, error: fetchErr } = await supabase
    .from("varroa_submissions")
    .select("id, images, image_notes, ai_status, ai_count, ai_confidence, ai_result")
    .eq("id", submissionId)
    .maybeSingle();

  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: "Failed fetching submission", details: String(fetchErr.message ?? fetchErr) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!row) {
    return new Response(JSON.stringify({ error: "Submission not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const r = row as {
    id: string;
    images?: string[] | null;
    image_notes?: unknown;
    ai_status?: string | null;
  };
  const imagePaths: string[] = Array.isArray(r.images) ? (r.images as string[]).filter((p) => typeof p === "string") : [];
  if (imagePaths.length === 0) {
    await supabase
      .from("varroa_submissions")
      .update({ ai_status: "FAILED", ai_error: "No images on submission" })
      .eq("id", submissionId);
    return new Response(JSON.stringify({ error: "Submission has no images" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Mark RUNNING
  await supabase
    .from("varroa_submissions")
    .update({ ai_status: "RUNNING", ai_started_at: new Date().toISOString() })
    .eq("id", submissionId);

  // Ensure signed URLs for every image (reuse caller-supplied if present and HTTPS)
  const finalSigned: SignedImage[] = [];
  const missing: string[] = [];
  for (const p of imagePaths) {
    const fromCaller = signedIn.get(p);
    if (fromCaller && /^https:\/\//i.test(fromCaller)) finalSigned.push({ path: p, url: fromCaller });
    else missing.push(p);
  }
  if (missing.length > 0) {
    const signRes = await supabase.storage
      .from("varroa-submissions")
      .createSignedUrls(missing, 60 * 30);
    if (!signRes.error && signRes.data) {
      for (const it of signRes.data as { path: string; signedUrl: string }[]) {
        if (it && it.path && it.signedUrl) finalSigned.push({ path: it.path, url: it.signedUrl });
      }
    }
  }

  // Parse / coerce image_notes
  const notesIn: ImageNoteIn[] = Array.isArray(r.image_notes) ? (r.image_notes as ImageNoteIn[]) : [];
  const coerced: ImageNoteIn[] = imagePaths.map((p, idx) => {
    const found = notesIn.find((n) => n && n.image_index === idx);
    if (found) return found;
    // Also try index match in case they are ordered without image_index field
    const byPos = notesIn[idx];
    if (byPos && typeof byPos === "object") {
      return { image_index: idx, ...byPos };
    }
    return {
      image_index: idx,
      url: p,
      note: null,
      annotations: [],
      ai_annotations_pending: [],
      quality: null,
    };
  });

  // If caller sent string[] (old format), convert to our structure without losing notes
  for (let i = 0; i < coerced.length; i++) {
    if (notesIn[i] != null && typeof notesIn[i] === "string") {
      coerced[i] = {
        image_index: i,
        url: imagePaths[i] ?? null,
        note: notesIn[i] as unknown as string,
        annotations: coerced[i]?.annotations ?? [],
        ai_annotations_pending: coerced[i]?.ai_annotations_pending ?? [],
        quality: null,
      };
    }
  }

  let totalCount = 0;
  let totalConf = 0;
  let totalConfCount = 0;
  const roboResponses: Record<string, unknown> = {};
  const perImageCount: Record<number, number> = {};

  try {
    for (let idx = 0; idx < imagePaths.length; idx++) {
      const path = imagePaths[idx]!;
      const signedEntry = finalSigned.find((s) => s.path === path);
      const signedUrl = signedEntry?.url;
      if (!signedUrl) {
        // Can't infer without URL; skip but don't fail entire job
        perImageCount[idx] = 0;
        continue;
      }

      let roboResp: unknown = null;
      let predictions: BB[] = [];
      try {
        if (!roboKey) {
          throw new Error("ROBOFLOW_INFERENCE_KEY is not set in Supabase Function Secrets.");
        }
        // Timeout each Roboflow call at 30s to avoid hanging edge functions (Roboflow usually answers in ~3s)
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort("Roboflow call timed out after 30s"), 30000);
        let resp: Response;
        try {
        resp = await fetch(roboUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${roboKey}`,
            },
            body: JSON.stringify({
              inputs: {
                image: signedUrl,
              },
            }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
        const text = await resp.text();
        try {
          roboResp = text ? JSON.parse(text) : {};
        } catch {
          roboResp = { raw_text: text };
        }
        if (!resp.ok) {
          console.warn("roboflow non-2xx", resp.status, resp.statusText, text.slice(0, 500));
          roboResponses[`${idx}`] = { status: resp.status, statusText: resp.statusText, body: roboResp };
          perImageCount[idx] = 0;
          continue;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("roboflow fetch failed for image", idx, msg);
        roboResponses[`${idx}`] = { error: msg };
        perImageCount[idx] = 0;
        continue;
      }

      // Defensive prediction extraction: try multiple known Roboflow output shapes
      const predArrays: unknown[] = [];
      if (roboResp && typeof roboResp === "object") {
        const rObj = roboResp as Record<string, unknown>;
        if (Array.isArray(rObj.predictions)) predArrays.push(rObj.predictions);
        if (Array.isArray(rObj.data?.predictions)) predArrays.push((rObj.data as Record<string, unknown>).predictions);
        const outputs = rObj.outputs;
        if (outputs && typeof outputs === "object") {
          const o = outputs as Record<string, unknown>;
          for (const k of Object.keys(o)) {
            const v = (o as Record<string, unknown>)[k];
            if (v && typeof v === "object") {
              const vo = v as Record<string, unknown>;
              if (Array.isArray(vo.predictions)) predArrays.push(vo.predictions);
              if (Array.isArray(vo.detections)) predArrays.push(vo.detections);
            }
            if (Array.isArray(v)) predArrays.push(v);
          }
        }
        if (Array.isArray(rObj.detections)) predArrays.push(rObj.detections);
      }
      const flat: unknown[] = predArrays.flat();

      for (const p of flat) {
        if (!p || typeof p !== "object") continue;
        const po = p as Record<string, unknown>;
        // Extract confidence
        let conf: number | undefined;
        if (typeof po.confidence === "number") conf = po.confidence;
        else if (typeof po.conf === "number") conf = po.conf;
        if (conf != null) {
          if (conf > 1.5) conf = conf / 100; // convert 85% → 0.85 if passed as percentage
          conf = Math.max(0, Math.min(1, conf));
        }
        // Extract geometry. Roboflow may use (x=center, y=center, width, height) in px
        // OR may use (x=left, y=top, w, h) in normalized format depending on workflow config.
        // We read many candidate keys.
        const numOr = (k: string[], fallback: number): number => {
          for (const key of k) {
            const v = (po as Record<string, unknown>)[key];
            if (typeof v === "number" && Number.isFinite(v)) return v;
          }
          return fallback;
        };
        const xCenter = numOr(["x", "center_x", "cx"], NaN);
        const yCenter = numOr(["y", "center_y", "cy"], NaN);
        const left = numOr(["left", "x_min", "xmin", "x1"], NaN);
        const top = numOr(["top", "y_min", "ymin", "y1"], NaN);
        const right = numOr(["right", "x_max", "xmax", "x2"], NaN);
        const bottom = numOr(["bottom", "y_max", "ymax", "y2"], NaN);
        const width = numOr(["width", "w"], NaN);
        const height = numOr(["height", "h"], NaN);

        let finalX = NaN;
        let finalY = NaN;
        let finalW = NaN;
        let finalH = NaN;

        // Case 1: x_min / x_max / y_min / y_max
        if ([left, top, right, bottom].every(Number.isFinite)) {
          finalX = left;
          finalY = top;
          finalW = Math.max(0.0001, right - left);
          finalH = Math.max(0.0001, bottom - top);
        }
        // Case 2: center_x, center_y, width, height (Roboflow default for detection outputs)
        else if ([xCenter, yCenter, width, height].every(Number.isFinite)) {
          finalW = Math.max(0.0001, width);
          finalH = Math.max(0.0001, height);
          // Assume left = center - width/2 UNLESS we see evidence values are already left/top
          // (We can't know for sure without image dimensions; if values are clearly pixels we
          //  normalize later. Admin will correct if the mapping assumption is wrong in staging.)
          finalX = xCenter - finalW / 2;
          finalY = yCenter - finalH / 2;
        }
        // Case 3: left + width + top + height
        else if ([left, top, width, height].every(Number.isFinite)) {
          finalX = left;
          finalY = top;
          finalW = Math.max(0.0001, width);
          finalH = Math.max(0.0001, height);
        }

        if (![finalX, finalY, finalW, finalH].every(Number.isFinite)) continue;
        if (finalW <= 0 || finalH <= 0) continue;

        // If any coordinate clearly exceeds 1 (pixels), we can't reliably normalize here
        // because we don't know the image dimensions. Clamp into [0,1] range as a best-effort.
        const maxExtent = Math.max(finalX + finalW, finalY + finalH, finalX, finalY, finalW, finalH);
        if (maxExtent > 1.1) {
          // Looks like pixels. Best effort: if width/height are within [0,1] then only x/y were
          // in pixels. We don't have the dims, so divide each by maxExtent*1.1 to bring into 0..1.
          // This will be wrong but admin can fix. Better than boxes that are 1000x outside canvas.
          const den = Math.max(2, maxExtent);
          finalX = finalX / den;
          finalY = finalY / den;
          finalW = finalW / den;
          finalH = finalH / den;
        }
        finalX = Math.max(0, Math.min(1, finalX));
        finalY = Math.max(0, Math.min(1, finalY));
        finalW = Math.max(0.0005, Math.min(1, finalW));
        finalH = Math.max(0.0005, Math.min(1, finalH));
        if (finalX + finalW > 1) finalW = 1 - finalX;
        if (finalY + finalH > 1) finalH = 1 - finalY;

        const id =
          typeof po.id === "string" && po.id
            ? po.id
            : `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const box: BB = {
          id,
          class_name: "varroa_mite",
          x: finalX,
          y: finalY,
          w: finalW,
          h: finalH,
        };
        if (conf != null) box.confidence = conf;
        predictions.push(box);

        totalCount += 1;
        if (conf != null) {
          totalConf += conf;
          totalConfCount += 1;
        }
      }

      roboResponses[`${idx}`] = roboResp;
      perImageCount[idx] = predictions.length;

      // Update this image's ai_annotations_pending
      if (coerced[idx]) {
        coerced[idx]!.ai_annotations_pending = predictions;
        if (!coerced[idx]!.url) coerced[idx]!.url = path;
        if (!coerced[idx]!.annotations) coerced[idx]!.annotations = [];
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("varroa_submissions")
      .update({ ai_status: "FAILED", ai_error: msg, ai_result: roboResponses })
      .eq("id", submissionId);
    return new Response(
      JSON.stringify({ error: `Inference failed: ${msg}`, details: roboResponses }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const avgConf = totalConfCount > 0 ? totalConf / totalConfCount : null;
  await supabase.from("varroa_submissions").update({
    ai_status: "DONE",
    ai_finished_at: new Date().toISOString(),
    ai_count: totalCount,
    ai_confidence: avgConf,
    ai_result: roboResponses,
    ai_error: null,
    image_notes: coerced,
  }).eq("id", submissionId);

  return new Response(
    JSON.stringify({
      ok: true,
      submission_id: submissionId,
      ai_count: totalCount,
      ai_confidence: avgConf,
      per_image_count: perImageCount,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
