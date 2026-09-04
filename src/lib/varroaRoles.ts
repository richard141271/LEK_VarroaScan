import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { VarroaRole } from "@/lib/varroaWorkflow";

const SUPER_ADMIN_EMAILS = new Set(["richard141271@gmail.com"]);

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isMissingRoleTableError(value: unknown) {
  if (!value || typeof value !== "object") return false;
  if (!("message" in value)) return false;
  const message = String((value as { message?: unknown }).message ?? "");
  return message.includes("varroa_user_roles");
}

export type VarroaAccess = {
  userId: string | null;
  email: string | null;
  role: VarroaRole | null;
  canManageSystem: boolean;
  canSeeAll: boolean;
  canControl: boolean;
  canWork: boolean;
  canUseQueue: boolean;
  canDeleteAnything: boolean;
};

export function buildRoleAccess(
  userId: string | null,
  email: string | null,
  role: VarroaRole | null,
): VarroaAccess {
  const privileged = role === "SUPERADMIN" || role === "FAGANSVARLIG";
  return {
    userId,
    email,
    role,
    canManageSystem: privileged,
    canSeeAll: privileged,
    canControl: privileged,
    canWork: role != null,
    canUseQueue: role != null,
    canDeleteAnything: privileged,
  };
}

export async function getVarroaAccess(
  supabase: SupabaseClient,
  session: Session | null | undefined,
) {
  const user = session?.user;
  if (!user) {
    return buildRoleAccess(null, null, null);
  }

  const email = normalizeEmail(user.email);
  if (SUPER_ADMIN_EMAILS.has(email)) {
    return buildRoleAccess(user.id, user.email ?? null, "SUPERADMIN");
  }

  const roleRes = await supabase
    .from("varroa_user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRes.error && !isMissingRoleTableError(roleRes.error)) {
    throw roleRes.error;
  }

  const role =
    typeof roleRes.data?.role === "string"
      ? (roleRes.data.role as VarroaRole)
      : null;

  if (role) {
    return buildRoleAccess(user.id, user.email ?? null, role);
  }

  const adminRes = await supabase
    .from("varroa_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminRes.error) {
    throw adminRes.error;
  }

  if (adminRes.data?.user_id) {
    return buildRoleAccess(user.id, user.email ?? null, "SUPERADMIN");
  }

  return buildRoleAccess(user.id, user.email ?? null, null);
}
