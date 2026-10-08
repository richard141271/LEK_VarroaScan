// Supabase Edge Function: varroa-export-training
// Exports an admin-corrected annotated image from varroa_annotation_export_queue to
// the Roboflow Core Dataset API for model retraining.
//
// Supabase Function Secrets (set via CLI: `supabase secrets set ROBOFLOW_...=...`):
//   ROBOFLOW_DATASET_API_KEY - Core API key (write permissions to dataset)
//   ROBOFLOW_PROJECT_ID      - Project slug, e.g. "varroa-detection-sqgvi"
//   ROBOFLOW_WORKSPACE       - Workspace slug, default: "lek-vision-lab"
//
// Admin-only. Authenticated via JWT.
// Body (JSON): { queue_id: uuid } or { submission_id: uuid, image_index: int }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type BB = {
  id?: string;
  class_name?: string;
  class?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
};

type Note = {
  image_index: number;
  url?: string | null;
  note?: string | null;
  annotations?: BB[];
  ai_annotations_pending?: BB[];
};

const DEFAULT_WORKSPACE = "lek-vision-lab";

function isTruthyRole(r: unknown): boolean {
  return r === "SUPERADMIN" || r === "FAGANSVARLIG";
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight OPTIONS so cross-origin panels (admin preview on
  // different origin / localhost / mobile wrapper) work.
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
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  const jsonResp = (body: unknown, status = 200, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, apikey, X-Client-Info, X-Supabase-Traceparent",
        ...(extra ?? {}),
      },
    });
  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const sbServiceRole =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
  const roboDatasetKey = Deno.env.get("ROBOFLOW_DATASET_API_KEY") ?? "";
  const projectId = Deno.env.get("ROBOFLOW_PROJECT_ID") ?? "";
  const workspace = Deno.env.get("ROBOFLOW_WORKSPACE") ?? DEFAULT_WORKSPACE;

  if (!sbUrl || !sbServiceRole) {
    return jsonResp({ error: "Missing Supabase env in function." }, 500);
  }
  if (!roboDatasetKey || !projectId) {
    return jsonResp(
      {
        error:
          "Missing ROBOFLOW_DATASET_API_KEY and/or ROBOFLOW_PROJECT_ID secrets. Set via `supabase secrets set`.",
      },
      500,
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  const sbPrivileged = createClient(sbUrl, sbServiceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Authorization: allow service_role tokens, or users with SUPERADMIN/FAGANSVARLIG role.
  let adminUserId: string | null = null;
  if (jwt) {
    if (jwt === sbServiceRole || jwt === (Deno.env.get("SUPABASE_SERVICE_KEY") ?? "")) {
      adminUserId = "service-role";
    } else {
      const sbAnon = createClient(sbUrl, jwt, {
        auth: { persistSession: false, autoRefreshToken: false, global: { headers: { Authorization: `Bearer ${jwt}` } } },
      });
      const { data: userRes } = await sbAnon.auth.getUser(jwt);
      const uid = userRes?.user?.id ?? null;
      if (uid) {
        const { data: roles, error: roleErr } = await sbPrivileged
          .from("varroa_user_roles")
          .select("role")
          .eq("user_id", uid)
          .is("deleted_at", null)
          .maybeSingle();
        if (roleErr) console.warn("role lookup err", roleErr);
        const role = (roles as { role: string } | null)?.role ?? null;
        if (isTruthyRole(role)) adminUserId = uid;
      }
    }
  }
  if (!adminUserId) {
    return jsonResp(
      { error: "Unauthorized. Admin role (SUPERADMIN/FAGANSVARLIG) required." },
      401,
    );
  }

  let body: { queue_id?: string; submission_id?: string; image_index?: number } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  // ...(rest of function handled below, concatenated from original after the write)
  if (!body.queue_id && !(body.submission_id && typeof body.image_index === "number")) {
    return jsonResp(
      { error: "Provide either queue_id OR (submission_id AND image_index)." },
      400,
    );
  }

  // Locate/create a queue row
  let queueId: string | null = body.queue_id ?? null;
  if (!queueId) {
    const { data, error } = await sbPrivileged
      .from("varroa_annotation_export_queue")
      .select("id")
      .eq("submission_id", body.submission_id)
      .eq("image_index", body.image_index)
      .maybeSingle();
    if (error) return jsonResp({ error: error.message }, 500);
    if (data) {
      queueId = (data as { id: string }).id;
    } else {
      const { data: ins, error: insErr } = await sbPrivileged
        .from("varroa_annotation_export_queue")
        .insert({
          submission_id: body.submission_id,
          image_index: body.image_index,
          status: "PENDING",
          approved_by_admin_id: adminUserId === "service-role" ? null : adminUserId,
        } as never)
        .select("id")
        .maybeSingle();
      if (insErr) return jsonResp({ error: insErr.message }, 500);
      queueId = ins ? (ins as { id: string }).id : null;
    }
  }
  if (!queueId) {
    return jsonResp({ error: "No queue id available." }, 400);
  }

  // Mark RUNNING (with retry_count increment if we can read it)
  {
    const { data: cur } = await sbPrivileged
      .from("varroa_annotation_export_queue")
      .select("retry_count")
      .eq("id", queueId)
      .maybeSingle();
    const rc = cur && typeof (cur as { retry_count?: unknown }).retry_count === "number"
      ? (cur as { retry_count: number }).retry_count + 1
      : 1;
    const { error } = await sbPrivileged
      .from("varroa_annotation_export_queue")
      .update({ status: "RUNNING", retry_count: rc, error_msg: null } as never)
      .eq("id", queueId);
    if (error) return jsonResp({ error: error.message }, 500);
  }

  const markFailed = async (msg: string) => {
    await sbPrivileged
      .from("varroa_annotation_export_queue")
      .update({ status: "FAILED", error_msg: msg } as never)
      .eq("id", queueId!);
  };

  try {
    const { data: qRow, error: qErr } = await sbPrivileged
      .from("varroa_annotation_export_queue")
      .select("id, submission_id, image_index")
      .eq("id", queueId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!qRow) throw new Error("Queue row missing");
    const submissionId = (qRow as { submission_id: string }).submission_id;
    const imageIndex = (qRow as { image_index: number }).image_index;

    const { data: sub, error: subErr } = await sbPrivileged
      .from("varroa_submissions")
      .select("id, images, image_notes")
      .eq("id", submissionId)
      .maybeSingle();
    if (subErr) throw new Error(subErr.message);
    if (!sub) throw new Error("Submission missing");
    const images = Array.isArray((sub as { images?: unknown }).images)
      ? ((sub as { images: unknown[] }).images.filter((p) => typeof p === "string") as string[])
      : [];
    const imagePath = images[imageIndex];
    if (!imagePath) throw new Error("Missing image at index " + imageIndex);
    const notesIn = Array.isArray((sub as { image_notes?: unknown }).image_notes)
      ? ((sub as { image_notes: unknown[] }).image_notes as Note[])
      : [];
    const noteObj = notesIn.find((n) => n && n.image_index === imageIndex) ??
      notesIn[imageIndex] ??
      ({ image_index: imageIndex, url: imagePath, annotations: [] } as Note);
    const adminAnnotations = Array.isArray(noteObj.annotations) ? noteObj.annotations : [];
    if (adminAnnotations.length === 0) {
      throw new Error(
        "Ingen admin-godkjente annotasjoner. Du må rette/opprette bokser i admin-review først (kun annotasjoner du har bekreftet sendes til trening, ikke rå AI-forslag).",
      );
    }

    // Sign URL for upload to Roboflow (HTTPS required)
    let signedUrl = "";
    const signRes = await sbPrivileged.storage
      .from("varroa-submissions")
      .createSignedUrl(imagePath, 60 * 60);
    if (signRes.error || !signRes.data?.signedUrl) {
      throw new Error("Failed to sign storage URL: " + (signRes.error?.message ?? "unknown"));
    }
    signedUrl = signRes.data.signedUrl;

    // Core Roboflow Dataset API
    const uploadUrl =
      `https://api.roboflow.com/${encodeURIComponent(workspace)}/${encodeURIComponent(projectId)}/upload?api_key=${encodeURIComponent(roboDatasetKey)}`;
    const annotateUrl =
      `https://api.roboflow.com/${encodeURIComponent(workspace)}/${encodeURIComponent(projectId)}/annotate?api_key=${encodeURIComponent(roboDatasetKey)}`;
    const split = "train";

    // Roboflow upload (name + split + image URL as hosted)
    const uploadBody: Record<string, unknown> = {
      name: `sub_${submissionId}_${imageIndex}`,
      split,
      image: signedUrl,
    };
    const upResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uploadBody),
    });
    const upText = await upResp.text();
    let upJson: unknown = null;
    try { upJson = upText ? JSON.parse(upText) : null; } catch { /* ignore */ }
    if (!upResp.ok) {
      throw new Error(
        `Roboflow upload failed (HTTP ${upResp.status}): ${JSON.stringify(upJson ?? upText.slice(0, 500))}`,
      );
    }
    const roboflowImageId: string =
      (upJson && typeof upJson === "object" && typeof (upJson as Record<string, unknown>).id === "string"
        ? (upJson as Record<string, string>).id
        : (upJson && typeof upJson === "object" && typeof (upJson as Record<string, unknown>).imageId === "string"
          ? (upJson as Record<string, string>).imageId
          : ""));
    if (!roboflowImageId) {
      throw new Error("Roboflow upload returned no image id");
    }

    // Annotations in multiple formats for robustness
    const annotations: unknown[] = adminAnnotations.map((b) => {
      const cx = Math.max(0, Math.min(1, b.x + b.w / 2));
      const cy = Math.max(0, Math.min(1, b.y + b.h / 2));
      const w = Math.max(0.0005, Math.min(1, b.w));
      const h = Math.max(0.0005, Math.min(1, b.h));
      const x = Math.max(0, Math.min(1 - w, b.x));
      const y = Math.max(0, Math.min(1 - h, b.y));
      return {
        x, y, width: w, height: h,
        x_min: x, y_min: y, x_max: Math.min(1, x + w), y_max: Math.min(1, y + h),
        cx, cy,
        class: "varroa",
        class_name: "varroa",
        label: "varroa",
      };
    });
    const annotateBody = {
      id: roboflowImageId,
      annotations,
    };
    const anResp = await fetch(annotateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(annotateBody),
    });
    const anText = await anResp.text();
    let anJson: unknown = null;
    try { anJson = anText ? JSON.parse(anText) : null; } catch { /* ignore */ }
    if (!anResp.ok) {
      throw new Error(
        `Roboflow annotate failed (HTTP ${anResp.status}): ${JSON.stringify(anJson ?? anText.slice(0, 500))}`,
      );
    }

    const now = new Date().toISOString();
    const payload = {
      roboflow_image_id: roboflowImageId,
      image_path: imagePath,
      annotation_count: annotations.length,
      upload_response: upJson ?? null,
      annotate_response: anJson ?? null,
    };
    const { error: updateErr } = await sbPrivileged
      .from("varroa_annotation_export_queue")
      .update({
        status: "SENT",
        roboflow_image_id: roboflowImageId,
        payload: payload as never,
        sent_at: now,
        error_msg: null,
      } as never)
      .eq("id", queueId!);
    if (updateErr) throw new Error(updateErr.message);

    return jsonResp({ ok: true, queue_id: queueId, roboflow_image_id: roboflowImageId, annotations_sent: annotations.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { await markFailed(msg); } catch { /* swallow */ }
    return jsonResp({ error: msg }, 500);
  }
});
