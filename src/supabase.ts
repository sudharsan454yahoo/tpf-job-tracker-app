// supabase.ts | version 1.0
import { createClient } from "@supabase/supabase-js";

// These two values are public by design. Row level security protects the data.
export const SUPABASE_URL = "https://ytqglyyzmoceymnqrcxc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_nreTgQ2sxryA8SurJj8YeQ_J_zhnreX";

export const APP_URL = window.location.origin + import.meta.env.BASE_URL;

// Never let Google tokens reach localStorage. They are handed to the server once and dropped.
const safeStorage = {
  getItem: (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      let out = value;
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          delete parsed.provider_token;
          delete parsed.provider_refresh_token;
          out = JSON.stringify(parsed);
        }
      } catch {
        /* not JSON, store as is */
      }
      window.localStorage.setItem(key, out);
    } catch {
      /* storage unavailable */
    }
  },
  removeItem: (key: string) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    storage: safeStorage,
  },
});

export function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      queryParams: { access_type: "offline", prompt: "consent" },
      redirectTo: APP_URL,
    },
  });
}
