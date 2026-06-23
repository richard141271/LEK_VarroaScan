import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getVarroaAccess } from "@/lib/varroaRoles";

export async function isVarroaAdmin(
  supabase: SupabaseClient,
  session: Session | null | undefined,
) {
  const access = await getVarroaAccess(supabase, session);
  return Boolean(access.role);
}
