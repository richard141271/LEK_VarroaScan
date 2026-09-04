import type { SupabaseClient } from "@supabase/supabase-js";

export const VARROA_STATUSES = [
  "NY",
  "UNDER_ARBEID",
  "KLAR_FOR_KONTROLL",
  "GODKJENT",
  "KLAR_FOR_TRENING",
  "ARKIVERT",
] as const;

export type VarroaSubmissionStatus = (typeof VARROA_STATUSES)[number];
export type VarroaRole = "SUPERADMIN" | "FAGANSVARLIG" | "STUDENT";

export type VarroaSubmissionRecord = {
  id: string;
  created_at: string;
  updated_at: string | null;
  user_id: string | null;
  user_name: string | null;
  type: string;
  note: string | null;
  images: string[];
  source: string | null;
  app_version: string | null;
  route: string | null;
  status: VarroaSubmissionStatus | string;
  assigned_to: string | null;
  assigned_at: string | null;
  processed_by: string | null;
  processed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  returned_by: string | null;
  returned_at: string | null;
  quality_rating: string | null;
  training_ready: boolean;
  manual_mite_count: number | null;
  review_comment: string | null;
  current_role_owner: string | null;
};

export type VarroaSubmissionReview = {
  id: string;
  submission_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  mite_count: number | null;
  image_quality: string | null;
  comment: string | null;
  training_ready: boolean;
  approved: boolean;
  current_image_index: number;
  image_notes: unknown;
};

export type VarroaSubmissionImageReview = {
  id: string;
  submission_id: string;
  review_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  image_index: number;
  mite_count: number | null;
  image_quality: string | null;
  comment: string | null;
  training_ready: boolean;
  approved: boolean;
};

export type VarroaSubmissionHistory = {
  id: string;
  submission_id: string;
  created_at: string;
  user_id: string | null;
  action: string;
  from_status: VarroaSubmissionStatus | null;
  to_status: VarroaSubmissionStatus | null;
  comment: string | null;
  payload: Record<string, unknown> | null;
};

export type SignedImage = {
  path: string;
  url: string;
};

export function formatDateTime(value: string | null | undefined) {
  const raw = String(value ?? "");
  if (!raw) return "—";
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleString("no-NO");
}

export function formatShortDate(value: string | null | undefined) {
  const raw = String(value ?? "");
  if (!raw) return "—";
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString("no-NO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function getStatusUi(status: string) {
  switch (status) {
    case "NY":
      return {
        label: "Ny",
        chipClass: "border-zinc-700 bg-zinc-800 text-zinc-100",
        accentClass: "bg-zinc-500",
      };
    case "UNDER_ARBEID":
      return {
        label: "Under arbeid",
        chipClass: "border-amber-300 bg-amber-400 text-zinc-950",
        accentClass: "bg-amber-400",
      };
    case "KLAR_FOR_KONTROLL":
      return {
        label: "Venter pa kontroll",
        chipClass: "border-sky-300 bg-sky-400 text-zinc-950",
        accentClass: "bg-sky-400",
      };
    case "GODKJENT":
      return {
        label: "Godkjent",
        chipClass: "border-emerald-300 bg-emerald-400 text-zinc-950",
        accentClass: "bg-emerald-400",
      };
    case "KLAR_FOR_TRENING":
      return {
        label: "Klar for trening",
        chipClass: "border-fuchsia-300 bg-fuchsia-400 text-zinc-950",
        accentClass: "bg-fuchsia-400",
      };
    case "ARKIVERT":
      return {
        label: "Arkivert",
        chipClass: "border-zinc-700 bg-zinc-950 text-zinc-200",
        accentClass: "bg-zinc-700",
      };
    default:
      return {
        label: status || "Ukjent",
        chipClass: "border-zinc-700 bg-zinc-900 text-zinc-100",
        accentClass: "bg-zinc-500",
      };
  }
}

export function getRoleLabel(role: VarroaRole | null) {
  switch (role) {
    case "SUPERADMIN":
      return "Superadmin";
    case "FAGANSVARLIG":
      return "Fagansvarlig";
    case "STUDENT":
      return "Student";
    default:
      return "Ukjent";
  }
}

export function getDisplayNameFromEmail(email: string | null | undefined): string {
  if (!email) return "Gjest";
  const local = String(email).split("@")[0] ?? "";
  if (!local) return email;
  const cleaned = local
    .replace(/[0-9._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) return local;
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ")
    .trim();
}

export function getTypeLabel(type: string | null | undefined) {
  if (type === "BUNNBRETT_FOTO") return "Bunnbrett foto";
  if (type === "KONTROLLFOTO") return "Kontrollfoto";
  return String(type ?? "Ukjent");
}

export function getQualityOptions() {
  return [
    { value: "", label: "Ikke vurdert" },
    { value: "LAV", label: "Lav" },
    { value: "MIDDELS", label: "Middels" },
    { value: "HØY", label: "Høy" },
  ];
}

export function getHistoryActionLabel(action: string) {
  switch (action) {
    case "CLAIMED_NEXT":
      return "Neste sak hentet";
    case "CONTROL_NEXT_IMAGE":
      return "Neste kontrollbilde";
    case "WORK_NEXT_IMAGE":
      return "Neste bilde";
    case "SAVE_DRAFT":
      return "Lagring";
    case "READY_FOR_REVIEW":
      return "Sendt til kontroll";
    case "SAVE_AND_NEXT":
      return "Lagre og neste";
    case "APPROVED":
      return "Godkjent";
    case "APPROVED_FOR_TRAINING":
      return "Klar for trening";
    case "RETURNED":
      return "Sendt tilbake";
    case "ARCHIVED":
      return "Arkivert";
    default:
      return action;
  }
}

export function isMissingWorkflowSchemaError(value: unknown) {
  if (!value || typeof value !== "object") return false;
  if (!("message" in value)) return false;
  const message = String((value as { message?: unknown }).message ?? "");
  return (
    message.includes("varroa_user_roles") ||
    message.includes("varroa_submission_history") ||
    message.includes("varroa_submission_reviews") ||
    message.includes("varroa_submission_review_images") ||
    message.includes("assigned_to") ||
    message.includes("updated_at") ||
    message.includes("current_image_index") ||
    message.includes("image_notes") ||
    message.includes("varroa_claim_next_submission") ||
    message.includes("varroa_available_new_count")
  );
}

export function getWorkflowMigrationMessage() {
  return "Produksjonsflyten krever ny DB-migrasjon. Kjor siste workflow-migrasjoner i Supabase forst.";
}

export function isAvailableControlSubmission(
  item: Pick<VarroaSubmissionRecord, "status" | "processed_by">,
  userId: string | null | undefined,
) {
  if (item.status !== "KLAR_FOR_KONTROLL") return false;
  if (!userId) return true;
  return item.processed_by !== userId;
}

export function formatWorkerLabel(
  userId: string | null | undefined,
  workerId: string | null | undefined,
) {
  if (!workerId) return "Ingen";
  if (userId && workerId === userId) return "Meg";
  return `${workerId.slice(0, 8)}...`;
}

export async function createSignedImages(
  supabase: SupabaseClient,
  imagePaths: string[],
) {
  if (imagePaths.length === 0) return [] as SignedImage[];

  const signedRes = await supabase.storage
    .from("varroa-submissions")
    .createSignedUrls(imagePaths, 60 * 30);

  if (signedRes.error) throw signedRes.error;

  return (signedRes.data ?? []).flatMap((item) => {
    if (!item) return [];
    if (typeof item.path !== "string") return [];
    if (typeof item.signedUrl !== "string") return [];
    return [{ path: item.path, url: item.signedUrl }];
  });
}

export function getSubmissionSelect() {
  return [
    "id",
    "created_at",
    "updated_at",
    "user_id",
    "user_name",
    "type",
    "note",
    "images",
    "source",
    "app_version",
    "route",
    "status",
    "assigned_to",
    "assigned_at",
    "processed_by",
    "processed_at",
    "approved_by",
    "approved_at",
    "returned_by",
    "returned_at",
    "quality_rating",
    "training_ready",
    "manual_mite_count",
    "review_comment",
    "current_role_owner",
  ].join(",");
}
