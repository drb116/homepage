import { handleWeatherCard } from "./weather.js";
const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const DEFAULT_TIME_ZONE = "America/New_York";


function jsonResponse(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store"
        }
    });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
    return new Response(html, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            ...extraHeaders
        }
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function getCookie(request, name) {
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = cookieHeader.split(";");

    for (const cookie of cookies) {
        const [rawName, ...rawValue] = cookie.trim().split("=");
        if (rawName === name) {
            try {
                return decodeURIComponent(rawValue.join("="));
            } catch {
                return rawValue.join("=");
            }
        }
    }

    return null;
}

function validWeekKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

async function handleMenuApi(request, env, url) {
    if (request.method === "GET") {
        const weekStart = url.searchParams.get("week");

        if (!validWeekKey(weekStart)) {
            return jsonResponse({ ok: false, error: "A valid week=YYYY-MM-DD is required." }, 400);
        }

        const row = await env.family_home_db
            .prepare(
                `SELECT week_start, menu_json, updated_at
         FROM weekly_menus
         WHERE week_start = ?1`
            )
            .bind(weekStart)
            .first();

        if (!row) {
            return jsonResponse({
                ok: true,
                week_start: weekStart,
                menu: null,
                updated_at: null
            });
        }

        let menu;
        try {
            menu = JSON.parse(row.menu_json);
        } catch {
            return jsonResponse({ ok: false, error: "Stored menu data is invalid." }, 500);
        }

        return jsonResponse({
            ok: true,
            week_start: row.week_start,
            menu,
            updated_at: row.updated_at
        });
    }

    if (request.method === "PUT") {
        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ ok: false, error: "Request body must be JSON." }, 400);
        }

        const weekStart = body?.week_start;
        const menu = body?.menu;

        if (!validWeekKey(weekStart)) {
            return jsonResponse({ ok: false, error: "A valid week_start is required." }, 400);
        }

        if (!menu || typeof menu !== "object" || Array.isArray(menu)) {
            return jsonResponse({ ok: false, error: "A menu object is required." }, 400);
        }

        await env.family_home_db
            .prepare(
                `INSERT INTO weekly_menus (week_start, menu_json, updated_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(week_start) DO UPDATE SET
           menu_json = excluded.menu_json,
           updated_at = CURRENT_TIMESTAMP`
            )
            .bind(weekStart, JSON.stringify(menu))
            .run();

        return jsonResponse({
            ok: true,
            week_start: weekStart
        });
    }

    return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, PUT" }
    });
}

async function getGoogleAccessToken(env) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
        throw new Error("Google Calendar secrets are not fully configured.");
    }

    const body = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token"
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
    });

    let data;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok || !data?.access_token) {
        const detail = data?.error_description || data?.error || `HTTP ${response.status}`;
        const error = new Error(`Google token refresh failed: ${detail}`);
        error.code = data?.error || "token_refresh_failed";
        throw error;
    }

    return data.access_token;
}

function addDaysUtc(date, days) {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

async function handleCalendarApi(request, env) {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET" }
        });
    }

    if (!env.GOOGLE_CALENDAR_ID) {
        return jsonResponse({ ok: false, error: "GOOGLE_CALENDAR_ID is not configured." }, 500);
    }

    try {
        const accessToken = await getGoogleAccessToken(env);
        const now = new Date();
        const end = addDaysUtc(now, 7);
        const timeZone = env.GOOGLE_TIME_ZONE || DEFAULT_TIME_ZONE;

        const calendarUrl = new URL(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`
        );

        calendarUrl.searchParams.set("timeMin", now.toISOString());
        calendarUrl.searchParams.set("timeMax", end.toISOString());
        calendarUrl.searchParams.set("singleEvents", "true");
        calendarUrl.searchParams.set("orderBy", "startTime");
        calendarUrl.searchParams.set("maxResults", "75");
        calendarUrl.searchParams.set("timeZone", timeZone);

        const response = await fetch(calendarUrl.toString(), {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json"
            }
        });

        let data;
        try {
            data = await response.json();
        } catch {
            data = null;
        }

        if (!response.ok) {
            const detail = data?.error?.message || `Google Calendar returned HTTP ${response.status}`;
            return jsonResponse({ ok: false, error: detail }, 502);
        }

        const events = (data?.items || [])
            .filter(event => event?.status !== "cancelled")
            .map(event => ({
                title: event.summary || "Untitled event",
                start: event.start?.dateTime || event.start?.date || null,
                end: event.end?.dateTime || event.end?.date || null,
                all_day: Boolean(event.start?.date && !event.start?.dateTime),
                location: event.location || null,
                html_link: event.htmlLink || null
            }))
            .filter(event => event.start);

        return jsonResponse({
            ok: true,
            calendar: "Family",
            time_zone: timeZone,
            generated_at: new Date().toISOString(),
            events
        });
    } catch (error) {
        console.error("Calendar API error:", error);
        return jsonResponse({
            ok: false,
            error: error?.message || "Could not load Google Calendar.",
            reauthorize: error?.code === "invalid_grant"
        }, 500);
    }
}

function googleSetupError(message) {
    return htmlResponse(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Calendar Setup</title>
<style>body{margin:0;background:#07111f;color:#f3f7fb;font:16px/1.6 system-ui,sans-serif}.wrap{max-width:760px;margin:60px auto;padding:0 24px}.card{padding:28px;border:1px solid rgba(148,180,215,.18);border-radius:22px;background:rgba(17,31,50,.88)}h1{margin-top:0}code{color:#59e1dc}</style></head>
<body><div class="wrap"><div class="card"><h1>Google Calendar setup</h1><p>${escapeHtml(message)}</p></div></div></body></html>`, 500);
}

// Kept as a recovery route in case the refresh token is ever revoked or expires.
async function handleGoogleConnect(request, env) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
        return googleSetupError("Google OAuth credentials or redirect URI are missing from the Worker configuration.");
    }

    const state = crypto.randomUUID();
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");

    authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_CALENDAR_READONLY_SCOPE);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    return new Response(null, {
        status: 302,
        headers: {
            Location: authUrl.toString(),
            "Cache-Control": "no-store",
            "Set-Cookie": `google_oauth_state=${encodeURIComponent(state)}; Path=/api/google/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
        }
    });
}

async function handleGoogleCallback(request, env, url) {
    const clearStateCookie = "google_oauth_state=; Path=/api/google/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

    const oauthError = url.searchParams.get("error");
    if (oauthError) {
        return htmlResponse(`<h1>Google authorization was not completed.</h1><p>${escapeHtml(oauthError)}</p>`, 400, {
            "Set-Cookie": clearStateCookie
        });
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const expectedState = getCookie(request, "google_oauth_state");

    if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
        return htmlResponse(`<h1>Authorization could not be verified.</h1><p>Start again from <code>/api/google/connect</code>.</p>`, 400, {
            "Set-Cookie": clearStateCookie
        });
    }

    const tokenBody = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString()
    });

    let tokenData;
    try {
        tokenData = await tokenResponse.json();
    } catch {
        tokenData = null;
    }

    if (!tokenResponse.ok) {
        const detail = tokenData?.error_description || tokenData?.error || `HTTP ${tokenResponse.status}`;
        return googleSetupError(`Google token exchange failed: ${detail}`);
    }

    const refreshToken = tokenData?.refresh_token;
    if (!refreshToken) {
        return googleSetupError("Google completed authorization but did not return a refresh token. Start the connection again.");
    }

    return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Calendar Connected</title>
<style>body{margin:0;background:#07111f;color:#f3f7fb;font:16px/1.6 system-ui,sans-serif}.wrap{max-width:820px;margin:56px auto;padding:0 24px}.card{padding:30px;border:1px solid rgba(148,180,215,.18);border-radius:24px;background:rgba(17,31,50,.9)}textarea{width:100%;min-height:110px;box-sizing:border-box;padding:14px;border-radius:14px;background:#050b14;color:#f3f7fb}</style></head>
<body><main class="wrap"><section class="card"><h1>Google Calendar authorized.</h1><p>Store this new refresh token using <code>npx wrangler secret put GOOGLE_REFRESH_TOKEN</code>.</p><textarea readonly>${escapeHtml(refreshToken)}</textarea></section></main></body></html>`, 200, {
        "Set-Cookie": clearStateCookie
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/weather-card") {
            return handleWeatherCard(request, env);
        }

        if (url.pathname === "/api/status") {
            return jsonResponse({ ok: true, app: "DavidB Family Home" });
        }

        if (url.pathname === "/api/menu") {
            return handleMenuApi(request, env, url);
        }

        if (url.pathname === "/api/calendar") {
            return handleCalendarApi(request, env);
        }

        if (url.pathname === "/api/google/connect" && request.method === "GET") {
            return handleGoogleConnect(request, env);
        }

        if (url.pathname === "/api/google/callback" && request.method === "GET") {
            return handleGoogleCallback(request, env, url);
        }

        // Keep the recipe collection in the existing davidb.xyz project.
        if (url.pathname.startsWith("/recipes/")) {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return new Response("Method not allowed", { status: 405 });
            }

            const target = new URL(url.pathname + url.search, "https://davidb.xyz");
            return fetch(target.toString(), {
                method: request.method,
                redirect: "follow"
            });
        }

        return env.ASSETS.fetch(request);
    }
};
