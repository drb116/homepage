function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return jsonResponse({
        ok: true,
        app: "DavidB Family Home"
      });
    }

    if (url.pathname === "/api/menu") {
      return handleMenuApi(request, env, url);
    }

    // Keep the recipe collection in the existing davidb.xyz project.
    // Requests from the Family Home are proxied through this Worker so
    // the planner and shopping-list code can fetch them as same-origin pages.
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
