import "server-only";
import { createClient } from "@supabase/supabase-js";

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function hasSupabaseServerEnv() {
  return Boolean(
    firstEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) &&
      firstEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"])
  );
}

export function createSupabaseAdminClient() {
  const url = firstEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
  const key = firstEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

  if (!url || !key) {
    throw new Error("Missing Supabase URL or service role key.");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
