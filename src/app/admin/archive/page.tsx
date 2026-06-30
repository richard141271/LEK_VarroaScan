"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendAdminContext,
  getAdminReturnInfo,
} from "@/lib/adminNavigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getVarroaAccess, type VarroaAccess } from "@/lib/varroaRoles";
import {
  formatDateTime,
  getStatusUi,
  getSubmissionSelect,
  getTypeLabel,
  getWorkflowMigrationMessage,
  isMissingWorkflowSchemaError,
  type VarroaSubmissionRecord,
} from "@/lib/varroaWorkflow";

export default function AdminArchivePage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);
  const adminContextSearch = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.search;
  }, []);
  const returnInfo = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: null as string | null, label: "← Tilbake" };
    }
    return getAdminReturnInfo(window.location.search);
  }, []);
  const adminLoginHref = useMemo(() => {
    if (typeof window === "undefined") return `${basePath}/admin/`;
    const params = new URLSearchParams(window.location.search);
    const currentPath = window.location.pathname.startsWith(basePath)
      ? window.location.pathname.slice(basePath.length) || "/"
      : window.location.pathname;
    params.set("next", `${currentPath}${window.location.search}`);
    return `${basePath}/admin/?${params.toString()}`;
  }, [basePath]);

  const [isAuthed, setIsAuthed] = useState(false);
  const [access, setAccess] = useState<VarroaAccess | null>(null);
  const [items, setItems] = useState<VarroaSubmissionRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoadError(null);
    if (!supabase) {
      setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }
    setIsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      setIsAuthed(Boolean(session));
      if (!session) {
        setAccess(null);
        setItems([]);
        window.location.replace(adminLoginHref);
        return;
      }

      const nextAccess = await getVarroaAccess(supabase, session);
      setAccess(nextAccess);
      if (!nextAccess.role || !nextAccess.canControl) {
        setItems([]);
        setLoadError("Kun fagansvarlig eller superadmin kan se arkivet.");
        return;
      }

      const res = await supabase
        .from("varroa_submissions")
        .select(getSubmissionSelect())
        .in("status", ["GODKJENT", "KLAR_FOR_TRENING", "ARKIVERT"])
        .order("updated_at", { ascending: false })
        .limit(300);

      if (res.error) {
        if (isMissingWorkflowSchemaError(res.error)) {
          setLoadError(getWorkflowMigrationMessage());
          setItems([]);
        } else {
          throw res.error;
        }
        return;
      }

      setItems((res.data ?? []) as unknown as VarroaSubmissionRecord[]);
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, [adminLoginHref, supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Admin</div>
            <div className="text-xs text-zinc-400">Arkiv</div>
          </div>
          <div className="flex items-center gap-4">
            {returnInfo.href ? (
              <a
                href={returnInfo.href}
                className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
              >
                {returnInfo.label}
              </a>
            ) : null}
            <a
              href={appendAdminContext(`${basePath}/admin/innsendinger/`, adminContextSearch)}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Innsendinger
            </a>
          </div>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Admin krever nett.
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-3xl space-y-4">
        {!isAuthed && loadError === "Logg inn for å se arkivet." ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Innlogging kreves</div>
            <div className="mt-1 text-sm text-zinc-400">
              Logg inn via admin for å åpne arkivet.
            </div>
            <a
              href={`${basePath}/admin/`}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-2xl bg-amber-400 px-4 font-semibold text-zinc-950 active:opacity-90"
            >
              Gå til admin
            </a>
          </div>
        ) : null}

        {isAuthed &&
        !access?.canControl &&
        loadError === "Kun fagansvarlig eller superadmin kan se arkivet." ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Ingen tilgang</div>
            <div className="mt-1 text-sm text-zinc-400">
              Arkivet er kun for kontroll og treningsklar klargjøring.
            </div>
          </div>
        ) : null}

        {access?.canControl ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold">Godkjent / arkiv</div>
                <div className="text-sm text-zinc-400">
                  Saker som er godkjent, klare for trening eller arkivert.
                </div>
              </div>
              <button
                type="button"
                onClick={reload}
                className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
                disabled={isLoading}
              >
                Oppdater
              </button>
            </div>

            {loadError ? (
              <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {loadError}
              </div>
            ) : null}

            <div className="mt-4 divide-y divide-zinc-800">
              {items.length === 0 ? (
                <div className="py-6 text-sm text-zinc-400">
                  Ingen innsendelser i arkivet.
                </div>
              ) : null}

              {items.map((s) => (
                <a
                  key={s.id}
                  href={appendAdminContext(
                    `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(s.id)}`,
                    adminContextSearch,
                  )}
                  className="block py-4 hover:bg-zinc-950/60 rounded-2xl px-3 -mx-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-100 truncate">
                        {getTypeLabel(s.type)}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {formatDateTime(s.updated_at ?? s.created_at)}
                        {s.user_name ? ` • ${s.user_name}` : ""}
                        {s.images?.length ? ` • ${s.images.length} bilder` : ""}
                        {s.status ? ` • ${s.status}` : ""}
                        {s.training_ready ? " • Treningsklar" : ""}
                        {typeof s.manual_mite_count === "number"
                          ? ` • ${s.manual_mite_count} midd`
                          : ""}
                      </div>
                      {s.note ? (
                        <div className="mt-2 text-sm text-zinc-300">
                          {s.note}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div
                        className={[
                          "rounded-full border px-3 py-1 text-[11px] font-semibold",
                          getStatusUi(s.status).chipClass,
                        ].join(" ")}
                      >
                        {getStatusUi(s.status).label}
                      </div>
                      <div className="text-sm font-semibold text-zinc-200">
                        Åpne →
                      </div>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
