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
  const preservedContextForLogin = useMemo(() => {
    if (typeof window === "undefined") return "";
    const parts = new URLSearchParams();
    if (adminContextSearch) {
      for (const [k, v] of new URLSearchParams(
        adminContextSearch.replace(/^\?/, ""),
      ).entries()) {
        parts.set(k, v);
      }
    }
    if (requestedNextPath) {
      parts.set("next", requestedNextPath);
    }
    const s = parts.toString();
    return s ? `?${s}` : "";
  }, [adminContextSearch, requestedNextPath]);

  const goAfterLogin = useCallback(() => {
    const parts = new URLSearchParams(preservedContextForLogin.replace(/^\?/, ""));
    const ctx = new URLSearchParams();
    for (const [k, v] of parts.entries()) {
      if (k === "next") continue;
      ctx.set(k, v);
    }
    const ctxString = ctx.toString();
    const nextRaw = parts.get("next");
    const next = normalizeInternalRedirectPath(nextRaw);
    const base = `${window.location.origin}${basePath}/admin/${
      ctxString ? `?${ctxString}` : ""
    }`;
    if (next && next !== "/admin" && next !== "/admin/") {
      const joiner = next.includes("?") ? "&" : "?";
      const withCtx = ctxString ? `${next}${joiner}${ctxString}` : next;
      window.location.replace(`${window.location.origin}${basePath}${withCtx}`);
      return;
    }
    window.location.replace(base);
  }, [basePath, preservedContextForLogin]);

  const supabase = useMemo(() => getSupabaseClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState<
    | "login"
    | "register"
    | "forgot"
    | "recovery"
  >(() => {
    if (typeof window === "undefined") return "login";
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return "login";
    const params = new URLSearchParams(hash);
    return params.get("type") === "recovery" ? "recovery" : "login";
  });
  const [authInfo, setAuthInfo] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    return params.get("type") === "recovery"
      ? "Du kom fra en lenke for å tilbakestille passord. Skriv inn et nytt passord under, så lagrer vi det."
      : null;
  });
  const [authError, setAuthError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isAuthed, setIsAuthed] = useState(false);
  const [access, setAccess] = useState<VarroaAccess | null>(null);
  const [items, setItems] = useState<VarroaSubmissionRecord[]>([]);
  const [availableNewCount, setAvailableNewCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  type VarroaUserRecord = {
    user_id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    role: string | null;
    role_created_at: string | null;
    expires_at: string | null;
    banned_at: string | null;
  };
  const [users, setUsers] = useState<VarroaUserRecord[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    if (!supabase || !access?.canManageSystem) return;
    setUsersError(null);
    setUsersLoading(true);
    try {
      const res = await supabase.rpc("varroa_list_users");
      if (res.error) throw res.error;
      setUsers((res.data ?? []) as unknown as VarroaUserRecord[]);
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setUsersError(msg);
    } finally {
      setUsersLoading(false);
    }
  }, [access?.canManageSystem, supabase]);

  const isFromBiensVokterAdmin = useMemo(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    const src = (params.get("source") ?? "").toLowerCase();
    return src.includes("biens") || src.includes("bien") || params.has("returnTo");
  }, []);

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
      if (nextAccess.canManageSystem) void loadUsers();
      else setUsers([]);
      if (!nextAccess.role) {
        setItems([]);
        setAvailableNewCount(0);
        return;
      }

      if (requestedNextPath) {
        // Allerede logget inn, og kom hit via en side som ba om login.
        // Gå rett tilbake dit – ikke vis dashboardet i det hele tatt.
        void goAfterLogin();
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
  }, [goAfterLogin, loadUsers, requestedNextPath, supabase]);

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
      if (res.error.message?.toLowerCase()?.includes("invalid") || res.error.message?.toLowerCase()?.includes("password")) {
        setAuthError(`${res.error.message} — hvis du ikke har bruker enda, bytt til "Registrer deg" øverst.`);
      } else {
        setAuthError(res.error.message);
      }
      return;
    }

    void goAfterLogin();
  };

  const registerWithPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Registrering krever nett.");
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

    if (!password || password.length < 6) {
      setAuthError("Passordet må være minst 6 tegn.");
      return;
    }

    if (password !== confirmPassword) {
      setAuthError("Passordene er ikke like i de to feltene.");
      return;
    }

    setIsLoading(true);
    const res = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${basePath}/admin/`,
        data: {},
      },
    });
    setIsLoading(false);

    if (res.error) {
      const msg = res.error.message ?? "";
      if (msg.toLowerCase().includes("already registered") || msg.toLowerCase().includes("email")) {
        setAuthError(`${msg} — prøv i stedet "Logg inn" øverst, eller "Glemt passord?".`);
      } else if (msg.toLowerCase().includes("email rate")) {
        setAuthError("E-postrate-begrensning: vent noen minutter og prøv igjen, eller logg inn med eksisterende passord.");
      } else {
        setAuthError(msg);
      }
      return;
    }

    const newSession = res.data.session;
    if (newSession) {
      setAuthInfo("Velkommen! Bruker er opprettet og du er logget inn. Laster arbeidsflaten…");
      setTimeout(() => void goAfterLogin(), 200);
      return;
    }

    setAuthInfo("Bruker opprettet! Sjekk e-posten din for en bekreftelseslenke (hvis aktivert), så logg inn.");
  };

  const resetPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Tilbakestilling krever nett.");
      return;
    }

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig.");
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setAuthError("Skriv inn e-posten din.");
      return;
    }

    setIsLoading(true);
    const redirectTo = new URL(`${window.location.origin}${basePath}/`);
    redirectTo.searchParams.set("authRedirect", requestedNextPath ?? "/admin/");

    const res = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
      redirectTo: redirectTo.toString(),
    });
    setIsLoading(false);

    if (res.error) {
      if (res.error.message.toLowerCase().includes("rate limit")) {
        setAuthError("E-postrate-begrensning. Vent noen minutter, eller bruk magic link knappen under.");
      } else {
        setAuthError(res.error.message);
      }
      return;
    }

    setAuthInfo("Hvis bruker finnes er det sendt en lenke på e-post for å tilbakestille passordet ditt. Sjekk søppelpost!");
  };

  const saveRecoveryPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Lagring krever nett.");
      return;
    }

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig.");
      return;
    }

    if (!password || password.length < 6) {
      setAuthError("Passordet må være minst 6 tegn.");
      return;
    }

    if (password !== confirmPassword) {
      setAuthError("Passordene er ikke like i de to feltene.");
      return;
    }

    setIsLoading(true);
    const res = await supabase.auth.updateUser({ password });
    setIsLoading(false);

    if (res.error) {
      setAuthError(res.error.message);
      return;
    }

    if (typeof window !== "undefined" && window.location.hash) {
      try {
        history.replaceState(null, "", " ");
      } catch {
        // ignore
      }
    }

    setAuthInfo("Passordet ditt er lagret! Nå er du logget inn og kan bruke passordet ditt neste gang. Laster arbeidsflaten…");
    setTimeout(() => void goAfterLogin(), 200);
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
    // Preserve ALL context for magic-link redirect tilbake hit, og next-path hvis satt
    const context = new URLSearchParams(
      preservedContextForLogin.replace(/^\?/, ""),
    );
    for (const [k, v] of context.entries()) {
      if (k === "next") continue;
      authRedirect.searchParams.set(k, v);
    }
    const np = context.get("next") ?? `${basePath}/admin/`;
    authRedirect.searchParams.set("authRedirect", np);

    setIsLoading(true);
    const res = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: authRedirect.toString(),
      },
    });
    setIsLoading(false);

    if (res.error) {
      const msg = res.error.message ?? "";
      if (msg.toLowerCase().includes("rate limit")) {
        setAuthError("E-postrate-begrensning. Vent noen minutter, eller registrer deg med passord i stedet.");
      } else {
        setAuthError(msg);
      }
      return;
    }

    setAuthInfo("Sjekk e-posten din (og søppelpost) for en innloggingslenke.");
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    await reload();
  };

  const setUserRole = async (
    targetUserId: string,
    opts: {
      role?: "STUDENT" | "FAGANSVARLIG" | null;
      banned?: boolean;
      expiresAt?: string | null;
    },
  ) => {
    if (!supabase) return;
    setUsersError(null);
    setAuthInfo(null);
    setAuthError(null);
    try {
      const res = await supabase.rpc("varroa_upsert_user_role", {
        p_target_user_id: targetUserId,
        p_new_role: opts.role ?? null,
        p_new_expires_at: opts.expiresAt ?? null,
        p_set_banned: opts.banned === undefined ? null : opts.banned,
        p_unused_dummy: null,
      });
      if (res.error) throw res.error;
      setAuthInfo(
        opts.banned
          ? "Bruker sperret."
          : opts.role === null
          ? "Rollen fjernet."
          : `Rollen er oppdatert til ${getRoleLabel(
              (opts.role as "STUDENT" | "FAGANSVARLIG") ?? null,
            )}.`,
      );
      await loadUsers();
      await reload();
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setUsersError(msg);
    }
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
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-2xl font-semibold text-zinc-50">
                  {authMode === "register"
                    ? "Registrer deg"
                    : authMode === "forgot"
                    ? "Glemt passord"
                    : authMode === "recovery"
                    ? "Sett nytt passord"
                    : isFromBiensVokterAdmin
                    ? "Logg inn for å åpne LEK-VarroaScan"
                    : "Logg inn"}
                </div>
                <div className="mt-2 text-sm text-zinc-400">
                  {authMode === "register"
                    ? "Lag deg en bruker med skole-e-post og eget passord. Får du automatisk STUDENT-tilgang."
                    : authMode === "forgot"
                    ? "Skriv inn e-posten din for å få en lenke for å sette nytt passord."
                    : authMode === "recovery"
                    ? "Skriv inn et nytt passord du kan huske."
                    : isFromBiensVokterAdmin
                    ? "Du kommer fra LEK-Biens Vokter™️ sitt adminpanel. Autentiser deg under for å åpne arbeidsflaten i LEK-VarroaScan. Etter login holder det seg ca. 30 dager i denne nettleseren."
                    : "Logg inn for å åpne kø, arbeidsflate og kontrollflyt."}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-1">
                <button
                  type="button"
                  onClick={() => { setAuthMode("login"); setAuthError(null); setAuthInfo(null); }}
                  className={[
                    "h-10 rounded-xl px-4 text-sm font-semibold transition",
                    authMode === "login"
                      ? "bg-amber-400 text-zinc-950"
                      : "text-zinc-300 hover:text-zinc-100",
                  ].join(" ")}
                >
                  Logg inn
                </button>
                {!isFromBiensVokterAdmin ? (
                  <button
                    type="button"
                    onClick={() => { setAuthMode("register"); setAuthError(null); setAuthInfo(null); setConfirmPassword(""); }}
                    className={[
                      "h-10 rounded-xl px-4 text-sm font-semibold transition",
                      authMode === "register"
                        ? "bg-amber-400 text-zinc-950"
                        : "text-zinc-300 hover:text-zinc-100",
                    ].join(" ")}
                  >
                    Registrer deg
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => { setAuthMode("forgot"); setAuthError(null); setAuthInfo(null); setPassword(""); setConfirmPassword(""); }}
                  className={[
                    "h-10 rounded-xl px-4 text-sm font-semibold transition",
                    authMode === "forgot"
                      ? "bg-amber-400 text-zinc-950"
                      : "text-zinc-300 hover:text-zinc-100",
                  ].join(" ")}
                >
                  Glemt passord?
                </button>
              </div>
            </div>

            {isFromBiensVokterAdmin && authMode === "login" ? (
              <div className="mt-5 rounded-2xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-4">
                <div className="text-base font-semibold text-emerald-200">
                  ✅ For deg som eier prosjektet
                </div>
                <div className="mt-2 text-sm text-emerald-100">
                  Velg din e-post under for å fylle den ut automatisk, skriv passord, logg inn. Studenter bruker den direkte lenken til <code className="text-zinc-100">/admin</code>.
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setEmail("richard141271@gmail.com")}
                    className="h-10 rounded-xl border border-emerald-700/60 bg-emerald-900/40 px-4 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/60"
                  >
                    rikhard@gmail.com (SUPERADMIN)
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmail("richard141271@icloud.com")}
                    className="h-10 rounded-xl border border-emerald-700/60 bg-emerald-900/40 px-4 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/60"
                  >
                    rikhard@icloud.com (FAGANSVARLIG)
                  </button>
                </div>
              </div>
            ) : null}

            {isFromBiensVokterAdmin ? (
              <div className="mt-4 rounded-2xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
                👉 Etter login kommer du tilbake til det du skulle gjøre.
                {requestedNextPath ? (
                  <>
                    {" "} Nåværende sti: <code className="rounded bg-zinc-900/70 px-2 py-0.5 text-amber-200">{requestedNextPath}</code>
                  </>
                ) : null}
              </div>
            ) : requestedNextPath ? (
              <div className="mt-4 rounded-2xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
                👉 Etter login sendes du videre til: <code className="rounded bg-zinc-900/70 px-2 py-0.5 text-amber-200">{requestedNextPath}</code>
              </div>
            ) : null}

            <div className={[
              "mt-5 rounded-2xl border",
              isFromBiensVokterAdmin ? "border-zinc-800 bg-zinc-950/60" : "border-indigo-900/60 bg-indigo-950/30",
              "px-4 py-4 text-sm",
              isFromBiensVokterAdmin ? "text-zinc-200" : "text-indigo-200"
            ].join(" ")}>
              {!isFromBiensVokterAdmin ? (
                <>
                  <div className="font-semibold text-base">
                    🎓 HIØ-student / fagansvarlig?
                  </div>
                  <div className="mt-2 text-indigo-100">
                    {authMode === "register" ? (
                      <>
                        <b>Registrer deg med skole-e-post + eget passord</b> under. Får du automatisk rolle som STUDENT (eller FAGANSVARLIG hvis e-posten din er hvitelistet).
                      </>
                    ) : (
                      <>
                        Velg <b>Registrer deg</b> øverst hvis du ikke har bruker enda.
                        Skole-e-post: <b>@hiof.no, @stud.hiof.no, @hit.no, @stud.hit.no</b> → automatisk STUDENT-tilgang
                        til <b>31. desember 2026</b>. Annen e-post: fagansvarlig legger deg til manuelt.
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-base">
                    🧑‍🎓 Studenter?
                  </div>
                  <div className="mt-2 text-zinc-100">
                    Ikke bruk denne innloggingslenken for studenter. Gi dem den direkte lenken til <code className="text-zinc-50">/admin</code> i LEK-VarroaScan, der kan de <b>registrere seg med skole-e-post + eget passord</b> selv.
                  </div>
                </>
              )}
              {authMode === "register" && (
                <div className="mt-2 text-xs text-indigo-300">
                  Etter registrering logges du rett inn. Vær inne i arbeidsflaten umiddelbart! Ingen e-postbekreftelse trengs (utenom du skrudd på manuelt i Supabase).
                </div>
              )}
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
                  placeholder={
                    authMode === "forgot"
                      ? "e-posten din registrert tidligere"
                      : "fornavn.etternavn@stud.hiof.no"
                  }
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (authMode === "login") {
                      if (password) void signInWithPassword();
                    } else if (authMode === "register") {
                      void registerWithPassword();
                    } else if (authMode === "forgot") {
                      void resetPassword();
                    } else if (authMode === "recovery") {
                      void saveRecoveryPassword();
                    }
                  }}
                  className="mt-1 h-14 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-base text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                />
              </div>

              {authMode !== "forgot" ? (
                <div>
                  <label className="text-xs font-semibold text-zinc-300">
                    Passord
                  </label>
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    placeholder={
                      authMode === "register"
                        ? "Minst 6 tegn"
                        : authMode === "recovery"
                        ? "Nytt passord (minst 6 tegn)"
                        : "••••••••"
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (authMode === "login") void signInWithPassword();
                        if (authMode === "register") void registerWithPassword();
                        if (authMode === "recovery") void saveRecoveryPassword();
                      }
                    }}
                    className="mt-1 h-14 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-base text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                </div>
              ) : null}

              {authMode === "register" || authMode === "recovery" ? (
                <div>
                  <label className="text-xs font-semibold text-zinc-300">
                    Gjenta passord
                  </label>
                  <input
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    type="password"
                    placeholder="Skriv samme passord igjen"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (authMode === "register") void registerWithPassword();
                        if (authMode === "recovery") void saveRecoveryPassword();
                      }
                    }}
                    className="mt-1 h-14 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-base text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3">
              {authMode === "login" ? (
                <>
                  <button
                    type="button"
                    onClick={signInWithPassword}
                    className="h-14 rounded-2xl bg-amber-400 text-base font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-amber-300"
                    disabled={!isOnline || isLoading}
                  >
                    {isLoading ? "Logger inn…" : "🔐 Logg inn med passord"}
                  </button>
                  <button
                    type="button"
                    onClick={sendLoginLink}
                    className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60 hover:bg-zinc-900"
                    disabled={!isOnline || isLoading}
                  >
                    📧 Send meg en innloggingslenke på e-post (alternativ)
                  </button>
                </>
              ) : null}

              {authMode === "register" ? (
                <>
                  <button
                    type="button"
                    onClick={registerWithPassword}
                    className="h-14 rounded-2xl bg-amber-400 text-base font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-amber-300"
                    disabled={!isOnline || isLoading}
                  >
                    {isLoading ? "Oppretter bruker…" : "✨ Opprett bruker og logg inn"}
                  </button>
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                    ✅ Registreringen lager deg rett inn umiddelbart, venter du <b>ikke</b> på e-postbekreftelse (med mindre det er skrudd på manuelt i Supabase).
                  </div>
                </>
              ) : null}

              {authMode === "forgot" ? (
                <>
                  <button
                    type="button"
                    onClick={resetPassword}
                    className="h-14 rounded-2xl bg-amber-400 text-base font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-amber-300"
                    disabled={!isOnline || isLoading}
                  >
                    {isLoading ? "Sender…" : "📧 Send lenke for nytt passord"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode("login")}
                    className="h-10 text-sm font-semibold text-zinc-300 hover:text-zinc-100"
                  >
                    ← Tilbake til innlogging
                  </button>
                </>
              ) : null}

              {authMode === "recovery" ? (
                <>
                  <div className="rounded-2xl border border-amber-900/60 bg-amber-950/30 px-4 py-4 text-sm text-amber-100">
                    <div className="font-semibold text-base">
                      🔑 Sett nytt passord
                    </div>
                    <div className="mt-2">
                      Nettleseren din husket at du kom hit fra en lenke i
                      e-posten. Skriv inn et nytt passord du kan huske, så
                      lagrer vi det på brukeren din umiddelbart.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={saveRecoveryPassword}
                    className="h-14 rounded-2xl bg-amber-400 text-base font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-amber-300"
                    disabled={!isOnline || isLoading}
                  >
                    {isLoading ? "Lagrer passord…" : "💾 Lagre nytt passord og logg inn"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode("login");
                      setAuthInfo(null);
                      setAuthError(null);
                    }}
                    className="h-10 text-sm font-semibold text-zinc-300 hover:text-zinc-100"
                  >
                    ← Tilbake til innlogging
                  </button>
                </>
              ) : null}
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

            {access?.canManageSystem ? (
              <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="text-xl font-semibold text-zinc-50">
                      Brukere og tilganger
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">
                      Godkjenn ventende brukere, endre roller eller sperr.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={loadUsers}
                    disabled={usersLoading}
                    className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-100 active:opacity-90 disabled:opacity-60"
                  >
                    {usersLoading ? "Laster…" : "↻ Oppdater"}
                  </button>
                </div>

                {usersError ? (
                  <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                    {usersError}
                  </div>
                ) : null}

                <div className="mt-5 space-y-3">
                  {(() => {
                    const pendingUsers = users.filter(
                      (u) => u.role == null && !u.banned_at,
                    );
                    if (pendingUsers.length > 0) {
                      return (
                        <div className="rounded-2xl border border-amber-900/50 bg-amber-950/30 p-4">
                        <div className="text-sm font-semibold text-amber-100">
                          ⏳ Ventende på godkjenning ({pendingUsers.length})
                        </div>
                        <div className="mt-1 text-xs text-amber-300">
                          Disse har registrert seg, men mangler rolle enda. Gi dem STUDENT for å gi tilgang.
                        </div>
                        <div className="mt-4 space-y-3">
                          {pendingUsers.map((u) => (
                            <div
                              key={u.user_id}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-900/40 bg-zinc-950 px-4 py-3"
                            >
                              <div>
                                <div className="text-sm font-semibold text-zinc-50">
                                  {u.email ?? "(mangler e-post)"}
                                </div>
                                <div className="mt-0.5 text-xs text-zinc-400">
                                  Opprettet {formatDateTime(u.created_at)}
                                  {u.last_sign_in_at
                                    ? ` • Sist pålogget ${formatDateTime(u.last_sign_in_at)}`
                                    : ""}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, {
                                      role: "STUDENT",
                                      expiresAt: "2026-12-31T23:59:59+01:00",
                                    })
                                  }
                                  className="h-10 rounded-xl bg-emerald-500 px-4 text-xs font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60 hover:bg-emerald-400"
                                >
                                  ✅ Gi STUDENT-tilgang
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setUserRole(u.user_id, { banned: true })}
                                  className="h-10 rounded-xl border border-red-900/50 bg-red-950/40 px-4 text-xs font-semibold text-red-200 active:opacity-90 disabled:opacity-60 hover:bg-red-900/40"
                                >
                                  🛑 Sperr bruker
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                    <div className="px-4 py-3 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                    Alle brukere ({users.length})
                  </div>
                    <div className="divide-y divide-zinc-800">
                      {users.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-zinc-400">
                          {usersLoading
                            ? "Laster brukere…"
                            : "Ingen brukere enda."}
                        </div>
                      ) : null}
                      {users.map((u) => {
                        const isBanned = Boolean(u.banned_at);
                        const isPending = u.role == null && !isBanned;
                        return (
                          <div
                            key={u.user_id}
                            className={[
                              "flex flex-wrap items-center justify-between gap-3 px-4 py-3",
                              isBanned ? "bg-red-950/20" : "",
                            ].join(" ")}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-zinc-50">
                                {u.email ?? "(mangler e-post)"}
                              </div>
                              <div className="mt-0.5 text-xs text-zinc-400">
                                {isPending ? (
                                  <span className="text-amber-300 font-semibold">⏳ Ventende</span>
                                ) : isBanned ? (
                                  <span className="text-red-300 font-semibold">🛑 Sperret {u.banned_at ? `(${formatDateTime(u.banned_at)})` : ""}</span>
                                ) : (
                                  <>
                                    <span className="font-semibold text-emerald-300">
                                      {getRoleLabel(
                                        (u.role as "SUPERADMIN" | "FAGANSVARLIG" | "STUDENT") ??
                                          null,
                                      )}
                                    </span>
                                    {u.expires_at ? (
                                      <span className="text-zinc-500">
                                        {" "}• utløper {formatDateTime(u.expires_at)}
                                      </span>
                                    ) : null}
                                  </>
                                )}
                                {" "}• Opprettet {formatDateTime(u.created_at)}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {u.role !== "STUDENT" && !isBanned ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, {
                                      role: "STUDENT",
                                      expiresAt: "2026-12-31T23:59:59+01:00",
                                    })
                                  }
                                  className="h-9 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-[11px] font-semibold text-zinc-100 active:opacity-90 hover:bg-zinc-800"
                                >
                                  Gi STUDENT
                                </button>
                              ) : null}
                              {u.role !== "FAGANSVARLIG" && u.role !== "SUPERADMIN" && !isBanned ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, {
                                      role: "FAGANSVARLIG"})
                                  }
                                  className="h-9 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-[11px] font-semibold text-zinc-100 active:opacity-90 hover:bg-zinc-800"
                                >
                                  Gi FAGANSVARLIG
                                </button>
                              ) : null}
                              {!isBanned ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, { banned: true })}
                                  className="h-9 rounded-xl border border-red-900/50 bg-red-950/40 px-3 text-[11px] font-semibold text-red-200 active:opacity-90 hover:bg-red-900/40"
                                >
                                  🛑 Sperr
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, { banned: false })}
                                  className="h-9 rounded-xl border border-emerald-900/50 bg-emerald-950/40 px-3 text-[11px] font-semibold text-emerald-200 active:opacity-90 hover:bg-emerald-900/40"
                                >
                                  ✅ Fjern sperr
                                </button>
                              )}
                              {u.role && !isBanned ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUserRole(u.user_id, {
                                      role: null,
                                      banned: false,
                                    })
                                  }
                                  className="h-9 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-[11px] font-semibold text-zinc-300 active:opacity-90 hover:bg-zinc-800"
                                >
                                  Fjern rolle
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
