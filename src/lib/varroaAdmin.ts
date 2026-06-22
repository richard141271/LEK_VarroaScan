import type { Session, SupabaseClient } from "@supabase/supabase-js";

const SUPER_ADMIN_EMAILS = new Set(["richard141271@gmail.com"]);

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export async function isVarroaAdmin(
  supabase: SupabaseClient,
  session: Session | null | undefined,
) {
  const user = session?.user;
  if (!user) return false;

  if (SUPER_ADMIN_EMAILS.has(normalizeEmail(user.email))) {
    return true;
  }

  const adminRes = await supabase
    .from("varroa_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminRes.error) {
    throw adminRes.error;
  }

  return Boolean(adminRes.data?.user_id);
}
