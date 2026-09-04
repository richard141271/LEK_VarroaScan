"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  appendAdminContext,
  getAdminContextSearch,
  getAdminReturnInfo,
} from "@/lib/adminNavigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getVarroaAccess, type VarroaAccess } from "@/lib/varroaRoles";
import {
  formatWorkerLabel,
  formatDateTime,
  getStatusUi,
  getSubmissionSelect,
  getTypeLabel,
  getWorkflowMigrationMessage,
  isAvailableControlSubmission,
  isMissingWorkflowSchemaError,
  type VarroaSubmissionRecord,
} from "@/lib/varroaWorkflow";

type QueueView = "all" | "mine" | "kontroll" | "training" | "archive";

export function AdminQueueClient() {
  const isOnline = useOnlineStatus();
  const searchParams = useSearchParams();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);
  const adminContextSearch = useMemo(() => {
    if (typeof window === "undefined") return "";
    return getAdminContextSearch(window.location.search);
  }, []);
  const returnInfo = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: null as string | null, label: null as string | null };
    }
    const raw = getAdminReturnInfo(window.location.search);
    if (raw.href) return raw;
    return { href: null as string | null, label: null as string | null };
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
  const [availableNewCount, setAvailableNewCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const canDeleteSubmissions = Boolean(
    access?.role === "SUPERADMIN" || access?.role === "FAGANSVARLIG",
  );

  const handleDelete = useCallback(async (id: string, title: string) => {
    const typeOk = confirm(
      `Er du HELT sikker på at du vil slette denne saken?\n\n${title}\n\nSletting er permanent. Alle revurderinger, bilder, notater og historikk blir slettet fra databasen. Bilder i Storage må slettes manuelt om nødvendig.\n\nSkriv inn nøyaktig ordet Slett for å fortsette:`,
    );
    if (!typeOk) return;

    const promptAns = (
      window.prompt(
        'For å bekrefte, skriv nøyaktig ordet "Slett" (stor S):',
        "",
      ) ?? ""
    ).trim();
    if (promptAns !== "Slett") {
      alert("Sletting avbrutt – du skrev ikke riktig ord.");
      return;
    }

    if (!supabase) return;
    setDeletingId(id);
    try {
      const res = await supabase.rpc("varroa_delete_submission_as_admin", {
        p_submission_id: id,
      });
      if (res.error) throw res.error;
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e: unknown) {
      let msg = "Ukjent feil";
      if (typeof e === "object" && e) {
        const err = e as { message?: unknown; code?: unknown; details?: unknown };
        if (typeof err.message === "string") msg = err.message;
        else if (typeof err.code === "string") msg = `Feilkode ${err.code}`;
        else msg = String(e);
      } else if (typeof e === "string") {
        msg = e;
      }
      alert("Kunne ikke slette saken:\n\n" + msg);
    } finally {
      setDeletingId(null);
    }
  }, [supabase]);

  const view = (searchParams.get("view") as QueueView | null) ?? "all";

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
        setAvailableNewCount(0);
        window.location.replace(adminLoginHref);
        return;
      }

      const nextAccess = await getVarroaAccess(supabase, session);
      setAccess(nextAccess);
      if (!nextAccess.role) {
        setItems([]);
        setAvailableNewCount(0);
        setLoadError("Du mangler rolle i VarroaScan-produksjonen.");
        return;
      }

      const [submissionsRes, availableRes] = await Promise.all([
        supabase
          .from("varroa_submissions")
          .select(getSubmissionSelect())
          .order("updated_at", { ascending: false })
          .limit(500),
        supabase.rpc("varroa_available_new_count"),
      ]);

      if (submissionsRes.error) {
        if (isMissingWorkflowSchemaError(submissionsRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          setItems([]);
        } else {
          throw submissionsRes.error;
        }
      } else {
        setItems((submissionsRes.data ?? []) as unknown as VarroaSubmissionRecord[]);
      }

      if (availableRes.error) {
        if (isMissingWorkflowSchemaError(availableRes.error)) {
          setAvailableNewCount(0);
        } else {
          throw availableRes.error;
        }
      } else {
        setAvailableNewCount(Number(availableRes.data ?? 0));
      }
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
      setItems([]);
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

  const openNextSubmission = async () => {
    if (!supabase) return;
    setLoadError(null);
    setIsLoading(true);
    try {
      const userId = access?.userId;
      if (userId) {
        const underWorkRes = await supabase
          .from("varroa_submissions")
          .select("id")
          .eq("status", "UNDER_ARBEID")
          .or(`assigned_to.eq.${userId},processed_by.eq.${userId}`)
          .order("updated_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (underWorkRes.error) throw underWorkRes.error;
        const resumeId = String(underWorkRes.data?.id ?? "");
        if (resumeId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(resumeId)}`,
              adminContextSearch,
            ),
          );
          return;
        }
      }

      if (access?.canControl) {
        const reviewRes = await supabase
          .from("varroa_submissions")
          .select("id")
          .eq("status", "KLAR_FOR_KONTROLL")
          .neq("processed_by", userId ?? "")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (reviewRes.error) throw reviewRes.error;
        const reviewId = String(reviewRes.data?.id ?? "");
        if (reviewId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(reviewId)}`,
              adminContextSearch,
            ),
          );
          return;
        }
      }

      const res = await supabase.rpc("varroa_claim_next_submission");
      if (res.error) {
        if (isMissingWorkflowSchemaError(res.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw res.error;
      }
      const nextId = String(res.data ?? "");
      if (!nextId) {
        setLoadError("Ingen ledige nye saker akkurat nå.");
        await reload();
        return;
      }
      window.location.assign(
        appendAdminContext(
          `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(nextId)}`,
          adminContextSearch,
        ),
      );
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredItems = useMemo(() => {
    const userId = access?.userId;
    if (!access?.role) return [];

    if (view === "mine") {
      return items.filter(
        (item) => item.assigned_to === userId || item.processed_by === userId,
      );
    }
    if (view === "kontroll") {
      return items.filter((item) => isAvailableControlSubmission(item, userId));
    }
    if (view === "training") {
      return items.filter(
        (item) => item.status === "GODKJENT" || item.status === "KLAR_FOR_TRENING",
      );
    }
    if (view === "archive") {
      return items.filter((item) => item.status === "ARKIVERT");
    }
    if (!access.canSeeAll) {
      return items.filter(
        (item) => item.assigned_to === userId || item.processed_by === userId,
      );
    }
    return items;
  }, [access, items, view]);

  const queueTitle = useMemo(() => {
    switch (view) {
      case "mine":
        return "Mine saker";
      case "kontroll":
        return "Venter på kontroll";
      case "training":
        return "Godkjent / trening";
      case "archive":
        return "Arkiv";
      default:
        return access?.canSeeAll ? "Arbeidskø" : "Min arbeidskø";
    }
  }, [access?.canSeeAll, view]);

  const queueHelp =
    view === "kontroll"
      ? "Viser saker som venter pa andresjekk. Egen forstesjekk skjules her."
      : access?.canSeeAll
        ? "Full ko med filtrering for produksjonsflyten."
        : "Viser dine tildelte saker. Bruk Start arbeid for neste ledige sak.";

  const filterLinks: Array<{ view: QueueView; label: string }> = [
    { view: "all", label: access?.canSeeAll ? "Alle" : "Min kø" },
    { view: "mine", label: "Mine" },
    { view: "kontroll", label: "Venter pa kontroll" },
    { view: "training", label: "Trening" },
    { view: "archive", label: "Arkiv" },
  ];
  const ownerColumnLabel = view === "kontroll" ? "Forste sjekk" : "Tildelt";

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{queueTitle}</div>
            <div className="text-xs text-zinc-400">{queueHelp}</div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {returnInfo.href ? (
              <a
                href={returnInfo.href}
                className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
              >
                {returnInfo.label}
              </a>
            ) : (
              <a
                href={`${basePath}/`}
                className="text-sm font-semibold text-zinc-300 hover:text-zinc-50"
              >
                ← Til forsiden
              </a>
            )}
            <a
              href={appendAdminContext(`${basePath}/admin/`, adminContextSearch)}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Dashboard
            </a>
            <button
              type="button"
              onClick={reload}
              disabled={isLoading || !isOnline}
              className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
            >
              Oppdater
            </button>
          </div>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Arbeidskøen krever nett.
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-7xl space-y-4">
        {!isAuthed ? (
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-300">
            Logg inn via `Admin` for å åpne arbeidskøen.
          </div>
        ) : null}

        {loadError ? (
          <div className="rounded-3xl border border-red-900/60 bg-red-950/40 px-5 py-4 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}

        {access?.role ? (
          <>
            <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2">
                  {filterLinks.map((link) => {
                    const active = link.view === view;
                    return (
                      <a
                        key={link.view}
                        href={appendAdminContext(
                          `${basePath}/admin/innsendinger/?view=${link.view}`,
                          adminContextSearch,
                        )}
                        className={[
                          "inline-flex h-10 items-center justify-center rounded-2xl px-4 text-sm font-semibold transition",
                          active
                            ? "bg-amber-400 text-zinc-950"
                            : "border border-zinc-700 bg-zinc-950 text-zinc-100",
                        ].join(" ")}
                      >
                        {link.label}
                      </a>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm text-zinc-300">
                    Ledige nye saker:{" "}
                    <span className="font-semibold text-zinc-50">{availableNewCount}</span>
                  </div>
                  <button
                    type="button"
                    onClick={openNextSubmission}
                    disabled={isLoading}
                    className="h-11 rounded-2xl bg-amber-400 px-5 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60"
                  >
                    Neste sak
                  </button>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
                <div className="hidden grid-cols-[1.1fr_1fr_0.8fr_0.9fr_1.1fr_110px_minmax(0,1fr)] gap-3 border-b border-zinc-800 px-5 py-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 lg:grid">
                <div>Sak</div>
                <div>Status</div>
                  <div>{ownerColumnLabel}</div>
                <div>Midd</div>
                <div>Sist oppdatert</div>
                <div>Åpne</div>
                {canDeleteSubmissions ? <div className="text-right">Slett</div> : null}
              </div>

              {filteredItems.length === 0 ? (
                <div className="px-5 py-8 text-sm text-zinc-400">
                  Ingen saker i denne visningen ennå.
                </div>
              ) : null}

              <div className="divide-y divide-zinc-800">
                {filteredItems.map((item) => {
                  const ui = getStatusUi(item.status);
                  const assignedLabel =
                    view === "kontroll"
                      ? formatWorkerLabel(access.userId, item.processed_by)
                      : formatWorkerLabel(access.userId, item.assigned_to);
                  const rowCols = canDeleteSubmissions
                    ? "grid-cols-1 gap-3 lg:grid-cols-[1.1fr_1fr_0.8fr_0.9fr_1.1fr_110px_minmax(0,1fr)] lg:items-center"
                    : "grid-cols-1 gap-3 lg:grid-cols-[1.1fr_1fr_0.8fr_0.9fr_1.1fr_110px] lg:items-center";
                  const isDeleting = deletingId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="px-5 py-4 hover:bg-zinc-950/60"
                    >
                      <div className={`grid ${rowCols}`}>
                        <a
                          href={appendAdminContext(
                            `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(item.id)}`,
                            adminContextSearch,
                          )}
                          className="contents"
                        >
                          <div>
                            <div className="text-sm font-semibold text-zinc-50">
                              {getTypeLabel(item.type)}
                            </div>
                            <div className="mt-1 text-xs text-zinc-500">
                              Opprettet {formatDateTime(item.created_at)}
                            </div>
                            <div className="mt-2 line-clamp-2 text-sm text-zinc-300">
                              {item.note || "Ingen kommentar fra innsendingen."}
                            </div>
                          </div>

                          <div className="lg:justify-self-start">
                            <div
                              className={[
                                "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold",
                                ui.chipClass,
                              ].join(" ")}
                            >
                              {ui.label}
                            </div>
                          </div>

                          <div className="text-sm text-zinc-300">{assignedLabel}</div>
                          <div className="text-sm text-zinc-300">
                            {item.manual_mite_count != null ? item.manual_mite_count : "—"}
                          </div>
                          <div className="text-sm text-zinc-300">
                            {formatDateTime(item.updated_at ?? item.created_at)}
                          </div>
                          <div className="text-sm font-semibold text-amber-300">Åpne →</div>
                        </a>
                        {canDeleteSubmissions ? (
                          <div className="mt-3 flex justify-end sm:mt-0">
                            <button
                              type="button"
                              onClick={() => void handleDelete(item.id, getTypeLabel(item.type))}
                              disabled={isDeleting || deletingId !== null}
                              className={[
                                "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition",
                                isDeleting
                                  ? "border-red-900/70 bg-red-950/60 text-red-100"
                                  : "border-red-900/40 bg-red-950/20 text-red-200 hover:bg-red-950/40 disabled:opacity-60",
                              ].join(" ")}
                            >
                              {isDeleting ? "Sletter…" : "🗑️ Slett sak"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
