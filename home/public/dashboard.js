const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AUTO_REFRESH_MS = 60_000;
const UPCOMING_DAY_COUNT = 5;

let refreshInProgress = false;

const $ = selector => document.querySelector(selector);

updateClock();
loadMealDashboard({ showLoading: true });
wireDashboardEvents();
startDashboardRefresh();
window.setInterval(updateClock, 30_000);

function atMidnightLocal(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeekSundayLocal(date) {
  const result = atMidnightLocal(date);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function addDays(date, count) {
  const result = new Date(date);
  result.setDate(result.getDate() + count);
  return result;
}

function keyFromDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyWeek() {
  return Object.fromEntries(DAYS.map(day => [day, []]));
}

function normalizeWeek(value) {
  const week = emptyWeek();
  if (!value || typeof value !== "object") return week;

  DAYS.forEach(day => {
    week[day] = Array.isArray(value[day]) ? value[day] : [];
  });

  return week;
}

function updateClock() {
  const now = new Date();

  $("#header-date").textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });

  $("#header-time").textContent = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });


  $("#tonight-date").textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric"
  });
}

function setSyncStatus(text, state = "") {
  const status = $("#meal-sync-status");
  status.className = `sync-status${state ? ` ${state}` : ""}`;
  status.innerHTML = `<span class="sync-dot"></span>${escapeHtml(text)}`;
}

async function fetchWeek(weekStart) {
  const weekKey = keyFromDateLocal(weekStart);
  const response = await fetch(`/api/menu?week=${encodeURIComponent(weekKey)}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Could not load ${weekKey} (${response.status})`);
  }

  const data = await response.json();
  return normalizeWeek(data.menu);
}

async function loadMealDashboard({ showLoading = false } = {}) {
  if (refreshInProgress) return;
  refreshInProgress = true;

  const refreshButton = $("#btn-refresh-meals");
  if (refreshButton) refreshButton.disabled = true;
  if (showLoading) setSyncStatus("Refreshing…", "loading");

  try {
    const today = atMidnightLocal(new Date());
    const currentWeekStart = startOfWeekSundayLocal(today);
    const nextWeekStart = addDays(currentWeekStart, 7);

    // Fetch both weeks so a Friday/Saturday dashboard can still show
    // upcoming dinners from the following week.
    const [currentWeek, nextWeek] = await Promise.all([
      fetchWeek(currentWeekStart),
      fetchWeek(nextWeekStart)
    ]);

    renderTonight(today, currentWeek);
    renderUpcoming(today, currentWeekStart, currentWeek, nextWeek);
    setSyncStatus("Up to date");
  } catch (error) {
    console.error("Could not refresh meal dashboard:", error);
    setSyncStatus("Could not refresh", "error");
    renderLoadError();
  } finally {
    refreshInProgress = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

function entriesForDate(date, currentWeekStart, currentWeek, nextWeek) {
  const offset = Math.round((atMidnightLocal(date) - currentWeekStart) / 86_400_000);

  if (offset >= 0 && offset <= 6) {
    return currentWeek[DAYS[offset]] || [];
  }

  if (offset >= 7 && offset <= 13) {
    return nextWeek[DAYS[offset - 7]] || [];
  }

  return [];
}

function splitEntries(entries) {
  return {
    meals: entries.filter(entry => entry && entry.type !== "note" && (entry.title || "").trim()),
    notes: entries.filter(entry => entry && entry.type === "note" && (entry.text || "").trim())
  };
}

function renderTonight(today, currentWeek) {
  const dayName = DAYS[today.getDay()];
  const { meals, notes } = splitEntries(currentWeek[dayName] || []);
  const container = $("#tonight-content");

  if (!meals.length) {
    container.innerHTML = `
      <p class="no-dinner">Nothing planned yet.</p>
      <p class="no-dinner-detail">Open the weekly planner to add tonight's dinner.</p>
      ${notes.map(note => `<span class="tonight-note">${escapeHtml(note.text)}</span>`).join("")}
    `;
    return;
  }

  const mealHtml = meals.map(meal => {
    const title = escapeHtml(meal.title);
    if (meal.href) {
      return `<p class="tonight-meal"><a href="${escapeAttribute(normalizeRecipeHref(meal.href))}" target="_blank" rel="noopener">${title}</a></p>`;
    }
    return `<p class="tonight-meal">${title}</p>`;
  }).join("");

  const noteHtml = notes
    .map(note => `<span class="tonight-note">${escapeHtml(note.text)}</span>`)
    .join("");

  container.innerHTML = `<div class="tonight-meals">${mealHtml}${noteHtml}</div>`;
}

function renderUpcoming(today, currentWeekStart, currentWeek, nextWeek) {
  const list = $("#upcoming-list");
  const rows = [];
  const firstDate = addDays(today, 1);
  const lastDate = addDays(today, UPCOMING_DAY_COUNT);

  $("#upcoming-range").textContent = `${formatShortDate(firstDate)} – ${formatShortDate(lastDate)}`;

  for (let i = 1; i <= UPCOMING_DAY_COUNT; i += 1) {
    const date = addDays(today, i);
    const entries = entriesForDate(date, currentWeekStart, currentWeek, nextWeek);
    const { meals, notes } = splitEntries(entries);

    const mealHtml = meals.length
      ? meals.map(meal => {
          const title = escapeHtml(meal.title);
          if (meal.href) {
            return `<a class="upcoming-meal recipe" href="${escapeAttribute(normalizeRecipeHref(meal.href))}" target="_blank" rel="noopener">${title}</a>`;
          }
          return `<span class="upcoming-meal">${title}</span>`;
        }).join("")
      : `<span class="upcoming-empty">Not planned</span>`;

    const noteHtml = notes.length
      ? notes.map(note => `<span class="upcoming-note">${escapeHtml(note.text)}</span>`).join("")
      : "";

    rows.push(`
      <div class="upcoming-row">
        <div class="upcoming-day">
          <strong>${escapeHtml(date.toLocaleDateString(undefined, { weekday: "short" }))}</strong>
          <span>${escapeHtml(date.toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</span>
        </div>
        <div class="upcoming-meals">${mealHtml}${noteHtml}</div>
      </div>
    `);
  }

  list.innerHTML = rows.join("");
}

function renderLoadError() {
  $("#tonight-content").innerHTML = `
    <p class="no-dinner">Dinner plans unavailable.</p>
    <p class="no-dinner-detail">Use the refresh button to try again.</p>
  `;

  $("#upcoming-list").innerHTML = `
    <div class="upcoming-placeholder">Could not load upcoming dinners.</div>
  `;
}

function formatShortDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function normalizeRecipeHref(href) {
  if (!href) return "/meals/";

  try {
    const url = new URL(href, location.origin);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

function wireDashboardEvents() {
  $("#btn-refresh-meals").addEventListener("click", () => {
    loadMealDashboard({ showLoading: true });
  });
}

function startDashboardRefresh() {
  window.setInterval(() => {
    if (document.hidden) return;
    loadMealDashboard();
  }, AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateClock();
      loadMealDashboard();
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

function escapeAttribute(value) {
  return escapeHtml(value);
}
