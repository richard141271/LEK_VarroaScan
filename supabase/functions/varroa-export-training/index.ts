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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const sbServiceRole =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
  const roboDatasetKey = Deno.env.get("ROBOFLOW_DATASET_API_KEY") ?? "";
  const projectId = Deno.env.get("ROBOFLOW_PROJECT_ID") ?? "";
  const workspace = Deno.env.get("ROBOFLOW_WORKSPACE") ?? DEFAULT_WORKSPACE;

  if (!sbUrl || !sbServiceRole) {
    return new Response(JSON.stringify({ error: "Missing Supabase env in function." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!roboDatasetKey || !projectId) {
    return new Response(
      JSON.stringify({
        error:
          "Missing ROBOFLOW_DATASET_API_KEY and/or ROBOFLOW_PROJECT_ID secrets. Set via `supabase secrets set`.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
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
    return new Response(
      JSON.stringify({ error: "Unauthorized. Admin role (SUPERADMIN/FAGANSVARLIG) required." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: { queue_id?: string; submission_id?: string; image_index?: number } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve queue row
  let queueWhere: Record<string, unknown> = {};
  if (body.queue_id) queueWhere = { id: body.queue_id };
  else if (body.submission_id && typeof body.image_index === "number") {
    queueWhere = { submission_id: body.submission_id, image_index: body.image_index };
  } else {
    return new Response(
      JSON.stringify({
        error: "Body must contain either { queue_id } or { submission_id, image_index }",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let row: Record<string, unknown> | null = null;
  {
    const qb = sbPrivileged.from("varroa_annotation_export_queue").select("*");
    for (const [k, v] of Object.entries(queueWhere)) (qb as unknown as { eq: (k: string, v: unknown) => typeof qb }).eq(k, v);
    const { data, error } = await qb.maybeSingle();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    row = data as Record<string, unknown> | null;
  }
  if (!row) {
    return new Response(JSON.stringify({ error: "Queue row not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const qid = String(row.id);
  const sid = String(row.submission_id);
  const imageIndex = Number(row.image_index);

  // Mark RUNNING, increment retry count
  await sbPrivileged
    .from("varroa_annotation_export_queue")
    .update({
      status: "RUNNING",
      retry_count: Number(row.retry_count ?? 0) + 1,
      approved_by_admin_id:
        adminUserId === "service-role"
          ? (row.approved_by_admin_id ?? null)
          : adminUserId,
      error_msg: null,
    })
    .eq("id", qid);

  try {
    // Fetch submission
    const { data: sub, error: subErr } = await sbPrivileged
      .from("varroa_submissions")
      .select("id, images, image_notes")
      .eq("id", sid)
      .maybeSingle();
    if (subErr) throw new Error(`Fetch submission: ${subErr.message}`);
    if (!sub) throw new Error("Submission missing for queue row.");
    const s = sub as Record<string, unknown>;
    const images: string[] = Array.isArray(s.images) ? (s.images as string[]) : [];
    const path = images[imageIndex];
    if (!path) throw new Error(`Missing image path at index ${imageIndex}`);

    // Final annotations = image_notes[image_index].annotations (admin-corrected).
    let notes: Note[] = [];
    try {
      const raw = s.image_notes;
      if (Array.isArray(raw)) notes = raw as Note[];
    } catch {
      notes = [];
    }
    const found = notes.find(
      (n) => n && n.image_index === imageIndex,
    ) ?? notes[imageIndex] ?? null;
    const finalAnnotations: BB[] =
      found && Array.isArray(found.annotations) ? (found.annotations as BB[]).filter(Boolean) : [];

    // Sign the image URL (HTTPS required by Roboflow)
    const signRes = await sbPrivileged.storage
      .from("varroa-submissions")
      .createSignedUrl(path, 60 * 30);
    if (signRes.error || !signRes.data?.signedUrl) {
      throw new Error(
        `Could not create signed URL: ${signRes.error?.message ?? "Unknown signing error"}`,
      );
    }
    const signedUrl = signRes.data.signedUrl;

    // --- 1) Upload image to Roboflow dataset ---
    const uploadUrl =
      `https://api.roboflow.com/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(projectId)}/upload?api_key=${encodeURIComponent(roboDatasetKey)}`;
    const name = `${sid.slice(0, 8)}_img${imageIndex}.jpg`;
    const uploadBody = JSON.stringify({
      image: signedUrl,
      name,
      split: "train",
    });
    let uploadJson: Record<string, unknown> = {};
    {
      const r = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: uploadBody,
      });
      const text = await r.text();
      try {
        uploadJson = text ? JSON.parse(text) : {};
      } catch {
        uploadJson = { raw_text: text };
      }
      if (!r.ok) {
        throw new Error(
          `Roboflow upload failed HTTP ${r.status} ${r.statusText}: ${text.slice(0, 800)}`,
        );
      }
    }

    const roboflowImageId: string | null =
      (typeof uploadJson.id === "string" && uploadJson.id)
        ? uploadJson.id
        : (uploadJson as Record<string, unknown>).image &&
            typeof (uploadJson as Record<string, unknown>).image === "object" &&
            typeof ((uploadJson as Record<string, unknown>).image as Record<string, unknown>).id === "string"
          ? ((uploadJson as Record<string, unknown>).image as Record<string, unknown>).id as string
          : null;
    if (!roboflowImageId) {
      throw new Error(
        `Roboflow upload response missing id. Full response: ${JSON.stringify(uploadJson).slice(0, 1000)}`,
      );
    }

    // --- 2) Annotate image in Roboflow ---
    // Send both normalized and absolute-ish coordinates to be tolerant to Roboflow format
    // preferences. x/y here are left/top w/h normalized 0..1. Roboflow accepts:
    //   - center normalized:  { label, x, y, width, height } where x/y = center, normalized 0..1
    //   - corners pixel:      { label, x_min, y_min, x_max, y_max } in absolute pixels
    // Without image dimensions we can't produce true pixels. We send the normalized form with
    // the common center-bbox convention, as well as all variant keys for maximum compatibility.
    const roboflowAnnotations: Record<string, unknown>[] = [];
    for (const b of finalAnnotations) {
      const x = Number(b.x);
      const y = Number(b.y);
      const w = Number(b.w);
      const h = Number(b.h);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const cls = (b.class_name || b.class || "varroa").toString().toLowerCase().includes("varroa") ? "varroa" : (b.class_name || b.class || "varroa").toString();
      const cx = Math.max(0, Math.min(1, x + w / 2));
      const cy = Math.max(0, Math.min(1, y + h / 2));
      const nw = Math.max(0.0001, Math.min(1, w));
      const nh = Math.max(0.0001, Math.min(1, h));
      const nx = Math.max(0, Math.min(1, x));
      const ny = Math.max(0, Math.min(1, y));
      roboflowAnnotations.push({
        label: cls,
        class: cls,
        class_name: cls,
        // Normalized center + size (most common for Roboflow upload endpoint)
        x: cx,
        y: cy,
        cx,
        cy,
        center_x: cx,
        center_y: cy,
        width: nw,
        height: nh,
        w: nw,
        h: nh,
        // Normalized corners (Pascal VOC style but normalized)
        x_min: nx,
        xmin: nx,
        left: nx,
        y_min: ny,
        ymin: ny,
        top: ny,
        x_max: Math.min(1, nx + nw),
        xmax: Math.min(1, nx + nw),
        right: Math.min(1, nx + nw),
        y_max: Math.min(1, ny + nh),
        ymax: Math.min(1, ny + nh),
        bottom: Math.min(1, ny + nh),
      });
    }

    const annotateUrl =
      `https://api.roboflow.com/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(projectId)}/annotate?api_key=${encodeURIComponent(roboDatasetKey)}`;
    const annotateBody = JSON.stringify({
      id: roboflowImageId,
      image_id: roboflowImageId,
      annotations: roboflowAnnotations,
      boxes: roboflowAnnotations,
    });
    let annotateJson: unknown = {};
    {
      const r = await fetch(annotateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: annotateBody,
      });
      const text = await r.text();
      try {
        annotateJson = text ? JSON.parse(text) : {};
      } catch {
        annotateJson = { raw_text: text };
      }
      if (!r.ok) {
        throw new Error(
          `Roboflow annotate failed HTTP ${r.status} ${r.statusText}: ${text.slice(0, 800)}`,
        );
      }
    }

    // All good — mark SENT
    await sbPrivileged
      .from("varroa_annotation_export_queue")
      .update({
        status: "SENT",
        sent_at: new Date().toISOString(),
        roboflow_image_id: roboflowImageId,
        payload: {
          uploaded_at: new Date().toISOString(),
          roboflow_upload: uploadJson,
          roboflow_annotate: annotateJson as Record<string, unknown>,
          annotations_count: finalAnnotations.length,
          image_path: path,
        },
        error_msg: null,
      })
      .eq("id", qid);

    return new Response(
      JSON.stringify({
        ok: true,
        queue_id: qid,
        submission_id: sid,
        image_index: imageIndex,
        roboflow_image_id: roboflowImageId,
        annotations_count: finalAnnotations.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await sbPrivileged
        .from("varroa_annotation_export_queue")
        .update({ status: "FAILED", error_msg: msg })
        .eq("id", qid);
    } catch {
      // swallow rollback error
    }
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
