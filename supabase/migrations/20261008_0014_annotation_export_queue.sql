-- Migration: varroa_annotation_export_queue table
-- Queue of admin-corrected annotations waiting to be exported to Roboflow dataset for model retraining.
-- Admin (FAGANSVARLIG/SUPERADMIN) inserts rows when they click "Send to Roboflow training".
-- Edge function varroa-export-training processes rows by sending image + annotations to Core API.

CREATE TABLE IF NOT EXISTS public.varroa_annotation_export_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.varroa_submissions(id) ON DELETE CASCADE,
  image_index integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'::text
    CHECK (status IN ('PENDING','RUNNING','SENT','FAILED','RETRY','CANCELLED')),
  payload jsonb,
  roboflow_image_id text,
  error_msg text,
  approved_by_admin_id uuid,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  retry_count integer NOT NULL DEFAULT 0,
  UNIQUE (submission_id, image_index)
);

ALTER TABLE public.varroa_annotation_export_queue ENABLE ROW LEVEL SECURITY;

-- Only admins can read queue rows.
DROP POLICY IF EXISTS "varroa_export_queue_admin_select" ON public.varroa_annotation_export_queue;
CREATE POLICY "varroa_export_queue_admin_select"
  ON public.varroa_annotation_export_queue
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.varroa_user_roles r
      WHERE r.user_id = auth.uid()
        AND r.role IN ('SUPERADMIN'::text, 'FAGANSVARLIG'::text)
        AND r.deleted_at IS NULL
    )
  );

-- Only admins can insert new rows (to approve for export).
DROP POLICY IF EXISTS "varroa_export_queue_admin_insert" ON public.varroa_annotation_export_queue;
CREATE POLICY "varroa_export_queue_admin_insert"
  ON public.varroa_annotation_export_queue
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.varroa_user_roles r
      WHERE r.user_id = auth.uid()
        AND r.role IN ('SUPERADMIN'::text, 'FAGANSVARLIG'::text)
        AND r.deleted_at IS NULL
    )
    AND (approved_by_admin_id = auth.uid())
  );

-- Only admins can update (e.g. retry, cancel).
DROP POLICY IF EXISTS "varroa_export_queue_admin_update" ON public.varroa_annotation_export_queue;
CREATE POLICY "varroa_export_queue_admin_update"
  ON public.varroa_annotation_export_queue
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.varroa_user_roles r
      WHERE r.user_id = auth.uid()
        AND r.role IN ('SUPERADMIN'::text, 'FAGANSVARLIG'::text)
        AND r.deleted_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.varroa_user_roles r
      WHERE r.user_id = auth.uid()
        AND r.role IN ('SUPERADMIN'::text, 'FAGANSVARLIG'::text)
        AND r.deleted_at IS NULL
    )
  );

-- Grant base privileges to authenticated (RLS policies above will restrict them).
GRANT SELECT, INSERT, UPDATE ON TABLE public.varroa_annotation_export_queue TO authenticated;
GRANT ALL ON TABLE public.varroa_annotation_export_queue TO service_role;
