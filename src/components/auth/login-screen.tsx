"use client";

import { Eye, EyeOff, Loader2, Lock, ShieldCheck } from "lucide-react";
import Image from "next/image";
import { FormEvent, useState } from "react";
import { platformApi } from "@/lib/api/edge-functions";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function signIn() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) {
      setErrorMessage(
        "Missing NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    const response = await platformApi.login(identifier, password);

    if (!response.success || !response.data?.session) {
      setLoading(false);
      setErrorMessage(response.error?.message ?? "Could not sign in.");
      return;
    }

    const { error } = await supabase.auth.setSession({
      access_token: response.data.session.access_token,
      refresh_token: response.data.session.refresh_token,
    });
    setLoading(false);

    if (error) {
      setErrorMessage(error.message);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loading && identifier && password) {
      void signIn();
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-brand-paper font-inter text-brand-ink lg:grid lg:grid-cols-[minmax(320px,42%)_1fr]">
      <section className="flex items-center justify-center bg-brand-cream px-4 pb-8 pt-10 lg:min-h-screen lg:px-10 lg:py-12">
        <div className="text-center">
          <Image
            src="/brand/baartwork-logo.png"
            alt="Baartwork"
            width={360}
            height={360}
            priority
            className="mx-auto h-auto w-[120px] lg:w-[180px]"
          />
          <p className="mt-5 font-montserrat text-[11px] font-medium uppercase tracking-[0.2em] text-[#474747]">
            WEARABLE ART · ART FOR LIVING
          </p>
        </div>
      </section>

      <section className="flex items-start justify-center bg-brand-paper px-4 py-8 lg:min-h-screen lg:items-center lg:px-12 lg:py-12">
        <div className="w-full max-w-[380px]">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <h1 className="font-montserrat text-3xl font-medium uppercase tracking-[0.05em] text-brand-ink">
                SIGN IN
              </h1>
              <div className="mt-3 h-0.5 w-8 bg-brand" />
              <p className="mt-4 text-sm text-[#474747]">Media Workflow Studio</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="identifier"
                  className="block font-montserrat text-xs font-medium uppercase tracking-[0.05em] text-brand-ink"
                >
                  Username or email
                </label>
                <input
                  id="identifier"
                  type="text"
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  className="h-11 w-full rounded-none border border-brand-line bg-white px-3 text-sm text-brand-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="password"
                  className="block font-montserrat text-xs font-medium uppercase tracking-[0.05em] text-brand-ink"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-11 w-full rounded-none border border-brand-line bg-white px-3 pr-11 text-sm text-brand-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((current) => !current)}
                    className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-[#474747] transition hover:text-brand-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {errorMessage ? (
              <div role="alert" className="border border-[#CB2B2B]/25 bg-[#F3CCCC] p-3 text-sm text-[#CB2B2B]">
                {errorMessage}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loading || !identifier || !password}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-none bg-primary px-4 font-montserrat text-sm font-semibold uppercase tracking-[0.05em] text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {loading ? "SIGNING IN…" : "SIGN IN"}
            </button>

            {process.env.NODE_ENV === "development" ? (
              <p className="text-xs text-[#474747]">Development admin: admin / admin</p>
            ) : null}

            <div className="grid gap-2 text-sm text-[#474747]">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-brand" />
                Google credentials stay in backend
              </div>
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-brand" />
                Frontend only talks to Supabase
              </div>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
