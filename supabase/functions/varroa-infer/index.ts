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
  // Browsers send OPTIONS (CORS preflight) before POST. We must answer OK with permissive
  // CORS headers or the browser will abort with "Failed to fetch" / TypeError network error.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, apikey, X-Client-Info, X-Supabase-Traceparent",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed", method: req.method }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Base CORS headers we always attach to responses so cross-origin browser calls succeed.
  const baseCors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, X-Client-Info, X-Supabase-Traceparent",
  };
  const jsonResp = (body: unknown, status = 200, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...baseCors,
        ...(extra ?? {}),
      },
    });

  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const sbAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const sbServiceRole =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
  const roboKey = Deno.env.get("ROBOFLOW_INFERENCE_KEY") ?? "";
  const roboUrl = Deno.env.get("ROBOFLOW_WORKFLOW_URL") ?? DEFAULT_WORKFLOW_URL;

  if (!sbUrl || !sbServiceRole) {
    return jsonResp({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in function env." }, 500);
  }
  if (!roboKey) {
    // Fail FAST if Roboflow key is missing; don't even mark RUNNING so caller sees error immediately.
    return jsonResp(
      { error: "Missing ROBOFLOW_INFERENCE_KEY in Supabase Function Secrets. Run: supabase secrets set ROBOFLOW_INFERENCE_KEY=..." },
      500,
    );
  }

  let payload: { submission_id?: string; signed_images?: SignedImage[] } = {};
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }

  const submissionId = payload.submission_id;
  if (!submissionId || typeof submissionId !== "string") {
    return jsonResp({ error: "Missing submission_id" }, 400);
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
    return jsonResp(
      { error: "Failed fetching submission", details: String(fetchErr.message ?? fetchErr) },
      500,
    );
  }
  if (!row) {
    return jsonResp({ error: "Submission not found" }, 404);
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
    return jsonResp({ error: "Submission has no images" }, 400);
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
        // Timeout each Roboflow call at 90s; iPhone 15 Pro Max 48MP pictures can be 50MB; need time for Roboflow to download from signed URL
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort("Roboflow call timed out after 90s"), 90000);
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
      let imageWidth: number | null = null;
      let imageHeight: number | null = null;
      if (roboResp && typeof roboResp === "object") {
        const rObj = roboResp as Record<string, unknown>;
        if (Array.isArray(rObj.predictions)) predArrays.push(rObj.predictions);
        if (
          rObj.predictions &&
          typeof rObj.predictions === "object" &&
          Array.isArray((rObj.predictions as Record<string, unknown>).predictions)
        ) {
          predArrays.push((rObj.predictions as Record<string, unknown>).predictions);
          const im = (rObj.predictions as Record<string, unknown>).image;
          if (im && typeof im === "object") {
            const w = (im as Record<string, unknown>).width;
            const h = (im as Record<string, unknown>).height;
            if (typeof w === "number") imageWidth = w;
            if (typeof h === "number") imageHeight = h;
          }
        }
        if (Array.isArray(rObj.data?.predictions)) predArrays.push((rObj.data as Record<string, unknown>).predictions);
        if (
          rObj.data &&
          typeof rObj.data === "object" &&
          (rObj.data as Record<string, unknown>).predictions &&
          typeof (rObj.data as Record<string, unknown>).predictions === "object" &&
          Array.isArray(((rObj.data as Record<string, unknown>).predictions as Record<string, unknown>).predictions)
        ) {
          predArrays.push((((rObj.data as Record<string, unknown>).predictions as Record<string, unknown>).predictions));
        }
        const outputs = rObj.outputs;
        const pushOutput = (v: unknown) => {
          if (v && typeof v === "object") {
            const vo = v as Record<string, unknown>;
            if (Array.isArray(vo.predictions)) predArrays.push(vo.predictions);
            if (Array.isArray(vo.detections)) predArrays.push(vo.detections);
            // Nested: vo.predictions = { image: {width,height}, predictions: [...] }
            if (vo.predictions && typeof vo.predictions === "object") {
              const vp = vo.predictions as Record<string, unknown>;
              if (Array.isArray(vp.predictions)) predArrays.push(vp.predictions);
              const im = vp.image;
              if (im && typeof im === "object" && imageWidth == null && imageHeight == null) {
                const w = (im as Record<string, unknown>).width;
                const h = (im as Record<string, unknown>).height;
                if (typeof w === "number") imageWidth = w;
                if (typeof h === "number") imageHeight = h;
              }
            }
          }
          if (Array.isArray(v)) predArrays.push(v);
        };
        if (Array.isArray(outputs)) {
          for (const v of outputs) pushOutput(v);
        } else if (outputs && typeof outputs === "object") {
          const o = outputs as Record<string, unknown>;
          for (const k of Object.keys(o)) pushOutput((o as Record<string, unknown>)[k]);
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

        // If we know the original image dimensions from Roboflow output, use them to normalize
        // pixel coordinates (x,y,w,h) → [0,1] exactly.
        const hasKnownDims = typeof imageWidth === "number" && typeof imageHeight === "number" &&
          imageWidth > 10 && imageHeight > 10;

        // Determine if current coords are in pixels (value > ~2 typically signals pixels since 1.0 = full width)
        const coordsLookLikePixels = finalW > 1.01 || finalH > 1.01 || finalX > 1.01 || finalY > 1.01;

        if (hasKnownDims && coordsLookLikePixels) {
          finalX = finalX / (imageWidth as number);
          finalY = finalY / (imageHeight as number);
          finalW = finalW / (imageWidth as number);
          finalH = finalH / (imageHeight as number);
        } else {
          // Fallback: if any coordinate clearly exceeds 1 (pixels) but dims unknown, clamp into [0,1].
          const maxExtent = Math.max(finalX + finalW, finalY + finalH, finalX, finalY, finalW, finalH);
          if (maxExtent > 1.1) {
            const den = Math.max(2, maxExtent);
            finalX = finalX / den;
            finalY = finalY / den;
            finalW = finalW / den;
            finalH = finalH / den;
          }
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
    return jsonResp(
      { error: `Inference failed: ${msg}`, details: roboResponses },
      500,
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

  return jsonResp(
    {
      ok: true,
      submission_id: submissionId,
      ai_count: totalCount,
      ai_confidence: avgConf,
      per_image_count: perImageCount,
    },
    200,
  );
});
