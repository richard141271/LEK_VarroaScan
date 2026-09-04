"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  getRoleLabel,
  getStatusUi,
  getSubmissionSelect,
  getTypeLabel,
  getWorkflowMigrationMessage,
  isAvailableControlSubmission,
  isMissingWorkflowSchemaError,
  type VarroaSubmissionRecord,
} from "@/lib/varroaWorkflow";

function normalizeInternalRedirectPath(value: string | null) {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/api/")) return null;
  return value;
}

export default function AdminInboxPage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
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
  const requestedNextPath = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return normalizeInternalRedirectPath(params.get("next"));
  }, []);

  const supabase = useMemo(() => getSupabaseClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isAuthed, setIsAuthed] = useState(false);
  const [access, setAccess] = useState<VarroaAccess | null>(null);
  const [items, setItems] = useState<VarroaSubmissionRecord[]>([]);
  const [availableNewCount, setAvailableNewCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const reload = useCallback(async () => {
    setAuthError(null);
    setLoadError(null);

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
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
        return;
      }

      const nextAccess = await getVarroaAccess(supabase, session);
      setAccess(nextAccess);
      if (!nextAccess.role) {
        setItems([]);
        setAvailableNewCount(0);
        return;
      }

      const [submissionsRes, availableRes] = await Promise.all([
        supabase
          .from("varroa_submissions")
          .select(getSubmissionSelect())
          .order("updated_at", { ascending: false })
          .limit(300),
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
          setLoadError(getWorkflowMigrationMessage());
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
    } finally {
      setIsLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  useEffect(() => {
    if (!isAuthed || !access?.role || !requestedNextPath) return;
    if (requestedNextPath === "/admin/" || requestedNextPath === "/admin") return;
    window.location.replace(`${basePath}${requestedNextPath}`);
  }, [access?.role, basePath, isAuthed, requestedNextPath]);

  const signInWithPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Innlogging krever nett.");
      return;
    }

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setAuthError("Skriv inn e-post.");
      return;
    }

    if (!password) {
      setAuthError("Skriv inn passord.");
      return;
    }

    setIsLoading(true);
    const res = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });
    setIsLoading(false);

    if (res.error) {
      setAuthError(res.error.message);
      return;
    }

    await reload();
  };

  const sendLoginLink = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Innlogging krever nett.");
      return;
    }

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    const trimmed = email.trim();
    if (!trimmed) {
      setAuthError("Skriv inn e-post.");
      return;
    }

    const authRedirect = new URL(`${window.location.origin}${basePath}/`);
    authRedirect.searchParams.set("authRedirect", requestedNextPath ?? "/admin/");

    const res = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: authRedirect.toString(),
      },
    });

    if (res.error) {
      setAuthError(res.error.message);
      return;
    }

    setAuthInfo("Sjekk e-posten din for en innloggingslenke.");
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    await reload();
  };

  const openNextSubmission = async () => {
    if (!supabase) return;
    setAuthInfo(null);
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
        setAuthInfo("Ingen flere ledige saker akkurat nå.");
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

  const counts = useMemo(() => {
    const summary = {
      NY: 0,
      UNDER_ARBEID: 0,
      KLAR_FOR_KONTROLL: 0,
      GODKJENT: 0,
      KLAR_FOR_TRENING: 0,
      ARKIVERT: 0,
    };
    for (const item of items) {
      if (item.status in summary) {
        summary[item.status as keyof typeof summary] += 1;
      }
    }
    return summary;
  }, [items]);

  const myItems = useMemo(() => {
    const userId = access?.userId;
    if (!userId) return [];
    return items.filter(
      (item) => item.assigned_to === userId || item.processed_by === userId,
    );
  }, [access?.userId, items]);

  const reviewItems = useMemo(
    () =>
      items
        .filter((item) => isAvailableControlSubmission(item, access?.userId))
        .slice(0, 8),
    [access?.userId, items],
  );

  const trainingItems = useMemo(
    () =>
      items
        .filter((item) => item.status === "GODKJENT" || item.status === "KLAR_FOR_TRENING")
        .slice(0, 8),
    [items],
  );

  const statusCards = [
    { key: "NY", label: "Nye saker", value: counts.NY, fallback: availableNewCount },
    { key: "UNDER_ARBEID", label: "Under arbeid", value: counts.UNDER_ARBEID, fallback: 0 },
    {
      key: "KLAR_FOR_KONTROLL",
      label: "Venter pa kontroll",
      value: counts.KLAR_FOR_KONTROLL,
      fallback: 0,
    },
    { key: "GODKJENT", label: "Godkjente", value: counts.GODKJENT, fallback: 0 },
    {
      key: "KLAR_FOR_TRENING",
      label: "Klar for trening",
      value: counts.KLAR_FOR_TRENING,
      fallback: 0,
    },
    { key: "ARKIVERT", label: "Arkiverte", value: counts.ARKIVERT, fallback: 0 },
  ] as const;

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">LEK-VarroaScan</div>
            <div className="text-xs text-zinc-400">Produksjonsverktøy</div>
          </div>
          <div className="flex items-center gap-3">
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
              href={`${basePath}/admin/innsendinger/?view=mine`}
              className="text-sm font-semibold text-zinc-300 hover:text-zinc-50"
            >
              Arbeidskø
            </a>
          </div>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Produksjonsflyten krever nett.
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-6xl space-y-4">
        {!isAuthed ? (
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="text-2xl font-semibold text-zinc-50">
              Logg inn
            </div>
            <div className="mt-2 text-sm text-zinc-400">
              Logg inn for å åpne kø, arbeidsflate og kontrollflyt.
            </div>

            <div className="mt-5 rounded-2xl border border-indigo-900/60 bg-indigo-950/30 px-4 py-4 text-sm text-indigo-200">
              <div className="font-semibold text-base">
                🎓 HIØ-student / fagansvarlig?
              </div>
              <div className="mt-2 text-indigo-100">
                Skriv inn din <b>skole-e-post</b> nedenfor og trykk{" "}
                <b>📧 Send e-postlenke</b>. Du får en sikker
                innloggingslenke på e-post — ingen passord trengs.
                Tilgangen gjelder automatisk til{" "}
                <b>31. desember 2026</b>.
              </div>
              <div className="mt-2 text-xs text-indigo-300">
                Gyldige skole-e-poster: <code className="rounded bg-indigo-900/50 px-1.5 py-0.5">@hiof.no</code>,{" "}
                <code className="rounded bg-indigo-900/50 px-1.5 py-0.5">@stud.hiof.no</code>,{" "}
                <code className="rounded bg-indigo-900/50 px-1.5 py-0.5">@hit.no</code>,{" "}
                <code className="rounded bg-indigo-900/50 px-1.5 py-0.5">@stud.hit.no</code>.
                Bruker du annen e-post? Kontakt fagansvarlig, så legger vi deg til manuelt.
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4">
              <div>
                <label className="text-xs font-semibold text-zinc-300">
                  E-post
                </label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  placeholder="fornavn.etternavn@stud.hiof.no"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (password) void signInWithPassword();
                      else void sendLoginLink();
                    }
                  }}
                  className="mt-1 h-14 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-base text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-zinc-300">
                  Passord (kun for fagansvarlige / superadmin)
                </label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="••••••••"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void signInWithPassword();
                  }}
                  className="mt-1 h-14 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-base text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                />
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3">
              <button
                type="button"
                onClick={sendLoginLink}
                className="h-14 rounded-2xl bg-amber-400 text-base font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-amber-300"
                disabled={!isOnline || isLoading}
              >
                📧 Send e-postlenke (anbefalt for studenter)
              </button>
              <button
                type="button"
                onClick={signInWithPassword}
                className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60 hover:bg-zinc-900"
                disabled={!isOnline || isLoading}
              >
                Logg inn med passord (kun admin/fagansvarlig)
              </button>
            </div>

            {authInfo ? (
              <div className="mt-5 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                ✅ {authInfo}
              </div>
            ) : null}
            {authError ? (
              <div className="mt-5 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {authError}
              </div>
            ) : null}
          </div>
        ) : null}

        {isAuthed && access?.role == null ? (
          <div className="rounded-3xl border border-amber-900/60 bg-amber-950/30 p-6">
            <div className="text-2xl font-semibold text-amber-100">
              🔐 Logget inn, men mangler tilgang
            </div>
            <div className="mt-2 text-sm text-amber-200">
              Din bruker finnes, men er ikke tildelt noen rolle i
              VarroaScan. Vanligvis årsaker:
            </div>
            <ul className="mt-4 space-y-2 pl-5 text-sm text-amber-100 list-disc">
              <li>
                Du logget inn med <b>feil e-post</b> (ikke skole-eposten din
                som{" "}
                <code className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-50">@hiof.no</code> /{" "}
                <code className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-50">@stud.hiof.no</code>).
                Logg ut under og prøv igjen med riktig e-post.
              </li>
              <li>
                Hvis du bruker riktig skole-epost og fortsatt ikke får
                tilgang: kontakt fagansvarlig / prosjektleder, så legger
                de deg til manuelt.
              </li>
              <li>
                Hvis du tidligere hadde tilgang kan den ha utløpt
                (studenttilgader går vanligvis ut 31.12.2026 eller ved
                semester-slutt).
              </li>
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={signOut}
                className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 px-5 text-sm font-semibold text-zinc-50 active:opacity-90 hover:bg-zinc-900"
              >
                Logg ut og bytt bruker
              </button>
              <a
                href={`${basePath}/`}
                className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-950 px-5 text-sm font-semibold text-zinc-50 active:opacity-90 hover:bg-zinc-900"
              >
                ← Til forsiden
              </a>
            </div>
          </div>
        ) : null}

        {access?.role ? (
          <>
            <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="text-xl font-semibold text-zinc-50">
                    Samlebånd for merking og kvalitetssikring
                  </div>
                  <div className="mt-1 text-sm text-zinc-400">
                    Rolle: {getRoleLabel(access.role)}. Optimalisert for neste sak, store
                    bilder og færrest mulig klikk.
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={openNextSubmission}
                    disabled={!access.canUseQueue || isLoading}
                    className="h-12 rounded-2xl bg-amber-400 px-5 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60"
                  >
                    Start arbeid
                  </button>
                  <a
                    href={appendAdminContext(
                      `${basePath}/admin/innsendinger/?view=mine`,
                      adminContextSearch,
                    )}
                    className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-950 px-5 text-sm font-semibold text-zinc-50 active:opacity-90"
                  >
                    Mine saker
                  </a>
                  <a
                    href={appendAdminContext(
                      `${basePath}/admin/innsendinger/?view=all`,
                      adminContextSearch,
                    )}
                    className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-950 px-5 text-sm font-semibold text-zinc-50 active:opacity-90"
                  >
                    Arbeidskø
                  </a>
                  <button
                    type="button"
                    onClick={signOut}
                    className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 px-5 text-sm font-semibold text-zinc-50 active:opacity-90"
                  >
                    Logg ut
                  </button>
                </div>
              </div>

              {authInfo ? (
                <div className="mt-4 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                  {authInfo}
                </div>
              ) : null}
              {loadError ? (
                <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                  {loadError}
                </div>
              ) : null}
            </section>

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {statusCards.map((card) => {
                const ui = getStatusUi(card.key);
                const value =
                  card.key === "NY" && !access.canSeeAll
                    ? Math.max(card.value, card.fallback)
                    : card.value;
                return (
                  <div
                    key={card.key}
                    className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-zinc-200">{card.label}</div>
                      <div className={`h-2.5 w-2.5 rounded-full ${ui.accentClass}`} />
                    </div>
                    <div className="mt-3 text-4xl font-semibold text-zinc-50">{value}</div>
                    <div className="mt-1 text-xs text-zinc-500">{ui.label}</div>
                  </div>
                );
              })}
            </section>

            <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr]">
              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-zinc-50">Mine saker</div>
                    <div className="text-sm text-zinc-400">
                      Sakene du har i arbeid akkurat nå.
                    </div>
                  </div>
                  <a
                    href={appendAdminContext(
                      `${basePath}/admin/innsendinger/?view=mine`,
                      adminContextSearch,
                    )}
                    className="text-sm font-semibold text-amber-300 hover:text-amber-200"
                  >
                    Åpne kø →
                  </a>
                </div>
                <div className="mt-4 space-y-3">
                  {myItems.length === 0 ? (
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-400">
                      Ingen aktive saker ennå.
                    </div>
                  ) : null}
                  {myItems.slice(0, 6).map((item) => {
                    const ui = getStatusUi(item.status);
                    return (
                      <a
                        key={item.id}
                        href={appendAdminContext(
                          `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(item.id)}`,
                          adminContextSearch,
                        )}
                        className="block rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 hover:bg-zinc-950/70"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-zinc-50">
                              {getTypeLabel(item.type)}
                            </div>
                            <div className="mt-1 text-xs text-zinc-500">
                              Opprettet {formatDateTime(item.created_at)}
                            </div>
                          </div>
                          <div
                            className={[
                              "rounded-full border px-3 py-1 text-[11px] font-semibold",
                              ui.chipClass,
                            ].join(" ")}
                          >
                            {ui.label}
                          </div>
                        </div>
                        <div className="mt-2 line-clamp-2 text-sm text-zinc-300">
                          {item.note || "Ingen kommentar fra innsendingen."}
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-zinc-50">
                        Venter pa kontroll
                      </div>
                      <div className="text-sm text-zinc-400">
                        Saker som venter pa andresjekk fra en annen bruker.
                      </div>
                    </div>
                    <a
                      href={appendAdminContext(
                        `${basePath}/admin/innsendinger/?view=kontroll`,
                        adminContextSearch,
                      )}
                      className="text-sm font-semibold text-amber-300 hover:text-amber-200"
                    >
                      Se alle →
                    </a>
                  </div>
                  <div className="mt-4 space-y-3">
                    {reviewItems.length === 0 ? (
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-400">
                        Ingen saker venter pa kontroll fra andre akkurat na.
                      </div>
                    ) : null}
                    {reviewItems.map((item) => (
                      <a
                        key={item.id}
                        href={appendAdminContext(
                          `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(item.id)}`,
                          adminContextSearch,
                        )}
                        className="block rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 hover:bg-zinc-950/70"
                      >
                        <div className="text-sm font-semibold text-zinc-50">
                          {getTypeLabel(item.type)}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {formatDateTime(item.updated_at ?? item.created_at)}
                        </div>
                        <div className="mt-2 text-xs text-zinc-400">
                          Forste sjekk: {formatWorkerLabel(access?.userId, item.processed_by)}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>

                <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-zinc-50">
                        Godkjent / trening
                      </div>
                      <div className="text-sm text-zinc-400">
                        Sporbare saker som nærmer seg treningsdatasett.
                      </div>
                    </div>
                    <a
                      href={appendAdminContext(`${basePath}/admin/archive/`, adminContextSearch)}
                      className="text-sm font-semibold text-amber-300 hover:text-amber-200"
                    >
                      Arkiv →
                    </a>
                  </div>
                  <div className="mt-4 space-y-3">
                    {trainingItems.length === 0 ? (
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-400">
                        Ingen saker er godkjent ennå.
                      </div>
                    ) : null}
                    {trainingItems.map((item) => {
                      const ui = getStatusUi(item.status);
                      return (
                        <a
                          key={item.id}
                          href={appendAdminContext(
                            `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(item.id)}`,
                            adminContextSearch,
                          )}
                          className="block rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 hover:bg-zinc-950/70"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-semibold text-zinc-50">
                              {getTypeLabel(item.type)}
                            </div>
                            <div
                              className={[
                                "rounded-full border px-3 py-1 text-[11px] font-semibold",
                                ui.chipClass,
                              ].join(" ")}
                            >
                              {ui.label}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {item.training_ready ? "Treningsklar" : "Ikke treningsklar"}{" "}
                            {item.manual_mite_count != null
                              ? `• ${item.manual_mite_count} midd`
                              : ""}
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
