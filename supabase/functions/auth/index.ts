import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

// Single Auth endpoint. Deploy with JWT verification disabled because login and
// bootstrap-admin are unauthenticated at the Supabase gateway layer.
// Example: supabase functions deploy auth --no-verify-jwt

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-setup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AuthAction = "login" | "me" | "bootstrap-admin";

type AuthBody = {
  action?: AuthAction;
  identifier?: string;
  email?: string;
  password?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function apiError(code: string, message: string, status = 400) {
  return json({
    success: false,
    error: { code, message },
    request_id: crypto.randomUUID(),
  }, status);
}

function readPublishableKey() {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  }
  return Deno.env.get("SUPABASE_ANON_KEY");
}

function readSecretKey() {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function normalizeEmail(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  if (normalized === "admin") return "admin@admin.local";
  return normalized;
}

function profileFromUser(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}) {
  return {
    id: user.id,
    username: String(
      user.user_metadata?.username ??
        user.email?.split("@")[0] ??
        "user",
    ),
    email: user.email ?? "",
    role: user.app_metadata?.role === "admin" ? "admin" : "user",
    display_name: typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name
      : null,
  };
}

async function readBody(req: Request): Promise<AuthBody | Response> {
  try {
    return await req.json() as AuthBody;
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.");
  }
}

async function login(
  body: AuthBody,
  supabaseUrl: string,
  publishableKey: string,
) {
  const identifier = body.identifier ?? body.email ?? "";
  const password = body.password ?? "";
  if (!identifier.trim() || !password) {
    return apiError("INVALID_INPUT", "Identifier and password are required.");
  }

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.signInWithPassword({
    email: normalizeEmail(identifier),
    password,
  });

  if (error || !data.session || !data.user) {
    return apiError(
      "UNAUTHORIZED",
      error?.message ?? "Invalid email or password.",
      401,
    );
  }

  return json({
    success: true,
    data: {
      session: data.session,
      user: data.user,
      profile: profileFromUser(data.user),
    },
    request_id: crypto.randomUUID(),
  });
}

async function me(req: Request, supabaseUrl: string, publishableKey: string) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return apiError("UNAUTHORIZED", "Missing bearer token.", 401);
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return apiError("UNAUTHORIZED", "Invalid user session.", 401);
  }

  return json({
    success: true,
    data: {
      user: data.user,
      profile: profileFromUser(data.user),
    },
    request_id: crypto.randomUUID(),
  });
}

async function bootstrapAdmin(req: Request, supabaseUrl: string) {
  const setupSecret = Deno.env.get("SETUP_ADMIN_SECRET");
  if (!setupSecret) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "SETUP_ADMIN_SECRET is required.",
      500,
    );
  }

  if (req.headers.get("X-Setup-Secret") !== setupSecret) {
    return apiError("UNAUTHORIZED", "Invalid setup secret.", 401);
  }

  const secretKey = readSecretKey();
  if (!secretKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase secret key.",
      500,
    );
  }

  const adminEmail = Deno.env.get("ADMIN_EMAIL") ?? "admin@admin.local";
  const adminPassword = Deno.env.get("ADMIN_PASSWORD") ?? "admin";
  const adminUsername = Deno.env.get("ADMIN_USERNAME") ?? "admin";

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userAttributes = {
    email_confirm: true,
    password: adminPassword,
    user_metadata: {
      username: adminUsername,
      display_name: "Admin",
    },
    app_metadata: { role: "admin" },
  };

  const { data: created, error: createError } = await adminClient.auth.admin
    .createUser({
      email: adminEmail,
      ...userAttributes,
    });

  let user = created.user;
  if (createError) {
    const { data: listData, error: listError } = await adminClient.auth.admin
      .listUsers();
    if (listError) return apiError("SUPABASE_ERROR", listError.message, 500);

    user = listData.users.find((item) =>
      item.email?.toLowerCase() === adminEmail.toLowerCase()
    ) ?? null;
    if (!user) {
      return apiError("SUPABASE_ERROR", createError.message, 500);
    }

    const { data: updated, error: updateError } = await adminClient.auth.admin
      .updateUserById(user.id, userAttributes);

    if (updateError) {
      return apiError("SUPABASE_ERROR", updateError.message, 500);
    }
    user = updated.user;
  }

  if (!user) {
    return apiError("SUPABASE_ERROR", "Admin user could not be created.", 500);
  }

  return json({
    success: true,
    data: {
      user_id: user.id,
      email: adminEmail,
      profile: profileFromUser(user),
    },
    request_id: crypto.randomUUID(),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return apiError("INVALID_METHOD", "Use POST.", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = readPublishableKey();
  if (!supabaseUrl || !publishableKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL or publishable key.",
      500,
    );
  }

  const body = await readBody(req);
  if (body instanceof Response) return body;

  switch (body.action) {
    case "login":
      return login(body, supabaseUrl, publishableKey);
    case "me":
      return me(req, supabaseUrl, publishableKey);
    case "bootstrap-admin":
      return bootstrapAdmin(req, supabaseUrl);
    default:
      return apiError(
        "INVALID_ACTION",
        "Use action login, me, or bootstrap-admin.",
      );
  }
});
