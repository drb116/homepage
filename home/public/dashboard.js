const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AUTO_REFRESH_MS = 60_000;
const DINNER_DAY_COUNT = 6; // Today + next five days
const CALENDAR_DAY_COUNT = 5;

let mealRefreshInProgress = false;
let calendarRefreshInProgress = false;
let weatherRefreshInProgress = false;

const $ = selector => document.querySelector(selector);

updateClock();
loadCalendarDashboard({ showLoading: true });
loadMealDashboard({ showLoading: true });
loadWeatherDashboard({ showLoading: true });
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

function dateFromDateOnly(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
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
}

function setMealSyncStatus(text, state = "") {
  const status = $("#meal-sync-status");
  status.className = `sync-status compact-sync-status${state ? ` ${state}` : ""}`;
  status.innerHTML = `<span class="sync-dot"></span>${escapeHtml(text)}`;
}

function setCalendarSyncStatus(text, state = "") {
  const status = $("#calendar-sync-status");
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
  if (mealRefreshInProgress) return;
  mealRefreshInProgress = true;

  const refreshButton = $("#btn-refresh-meals");
  if (refreshButton) refreshButton.disabled = true;
  if (showLoading) setMealSyncStatus("Refreshing…", "loading");

  try {
    const today = atMidnightLocal(new Date());
    const currentWeekStart = startOfWeekSundayLocal(today);
    const nextWeekStart = addDays(currentWeekStart, 7);

    const [currentWeek, nextWeek] = await Promise.all([
      fetchWeek(currentWeekStart),
      fetchWeek(nextWeekStart)
    ]);

    renderDinnerList(today, currentWeekStart, currentWeek, nextWeek);
    setMealSyncStatus("Up to date");
  } catch (error) {
    console.error("Could not refresh meal dashboard:", error);
    setMealSyncStatus("Could not refresh", "error");
    $("#dinner-list").innerHTML = `<div class="dinner-placeholder">Dinner plans unavailable.</div>`;
  } finally {
    mealRefreshInProgress = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

function entriesForDate(date, currentWeekStart, currentWeek, nextWeek) {
  const offset = Math.round((atMidnightLocal(date) - currentWeekStart) / 86_400_000);

  if (offset >= 0 && offset <= 6) return currentWeek[DAYS[offset]] || [];
  if (offset >= 7 && offset <= 13) return nextWeek[DAYS[offset - 7]] || [];
  return [];
}

function splitEntries(entries) {
  return {
    meals: entries.filter(entry => entry && entry.type !== "note" && (entry.title || "").trim()),
    notes: entries.filter(entry => entry && entry.type === "note" && (entry.text || "").trim())
  };
}

function renderDinnerList(today, currentWeekStart, currentWeek, nextWeek) {
  const rows = [];

  for (let i = 0; i < DINNER_DAY_COUNT; i += 1) {
    const date = addDays(today, i);
    const entries = entriesForDate(date, currentWeekStart, currentWeek, nextWeek);
    const { meals, notes } = splitEntries(entries);

    const mealHtml = meals.length
      ? meals.map(meal => {
          const title = escapeHtml(meal.title);
          if (meal.href) {
            return `<a class="dinner-meal recipe" href="${escapeAttribute(normalizeRecipeHref(meal.href))}" target="_blank" rel="noopener">${title}</a>`;
          }
          return `<span class="dinner-meal">${title}</span>`;
        }).join("")
      : `<span class="dinner-empty">Not planned</span>`;

    const noteHtml = notes.length
      ? notes.map(note => `<span class="dinner-note">${escapeHtml(note.text)}</span>`).join("")
      : "";

    rows.push(`
      <div class="dinner-row${i === 0 ? " today" : ""}">
        <div class="dinner-day">
          <strong>${i === 0 ? "Today" : escapeHtml(date.toLocaleDateString(undefined, { weekday: "short" }))}</strong>
          <span>${escapeHtml(date.toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</span>
        </div>
        <div class="dinner-meals">${mealHtml}${noteHtml}</div>
      </div>
    `);
  }

  $("#dinner-list").innerHTML = rows.join("");
}

async function loadWeatherDashboard({ showLoading = false } = {}) {
  if (weatherRefreshInProgress) return;
  weatherRefreshInProgress = true;

  const button = $("#btn-refresh-weather");
  if (button) button.disabled = true;
  if (showLoading) setWeatherStatus("Refreshing…");

  try {
    const response = await fetch("/api/weather-card", { cache: "no-store" });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Weather request failed (${response.status})`);
    }

    renderWeather(data);
    setWeatherStatus(data.partial ? "Some weather data unavailable" : "Updated just now", data.partial);
  } catch (error) {
    console.error("Could not refresh weather:", error);
    setWeatherStatus("Weather unavailable", true);
  } finally {
    weatherRefreshInProgress = false;
    if (button) button.disabled = false;
  }
}

function renderWeather(data) {
  const currentF = data?.current?.temperature_f;
  const forecast = data?.forecast;

  $("#weather-current-temp").textContent = Number.isFinite(Number(currentF))
    ? `${Math.round(Number(currentF))}°`
    : "--°";

  if (forecast) {
    $("#weather-icon").textContent = weatherIcon(forecast.weather_code);
    $("#weather-today").textContent = formatHighLow(forecast.today);
    $("#weather-tomorrow").textContent = formatHighLow(forecast.tomorrow);
  } else {
    $("#weather-icon").textContent = "–";
    $("#weather-today").textContent = "--° / --°";
    $("#weather-tomorrow").textContent = "--° / --°";
  }
}

function formatHighLow(day) {
  const high = Number(day?.high_f);
  const low = Number(day?.low_f);
  const highText = Number.isFinite(high) ? `${Math.round(high)}°` : "--°";
  const lowText = Number.isFinite(low) ? `${Math.round(low)}°` : "--°";
  return `${highText} / ${lowText}`;
}

function weatherIcon(codeValue) {
  const code = Number(codeValue);
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "🌨️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌤️";
}

function setWeatherStatus(text, isError = false) {
  const status = $("#weather-status");
  status.textContent = text;
  status.className = `weather-status${isError ? " error" : ""}`;
}

// Calendar code below is intentionally unchanged from the current dashboard.
async function loadCalendarDashboard({ showLoading = false } = {}) {
  if (calendarRefreshInProgress) return;
  calendarRefreshInProgress = true;

  const button = $("#btn-refresh-calendar");
  if (button) button.disabled = true;
  if (showLoading) setCalendarSyncStatus("Refreshing…", "loading");

  try {
    const response = await fetch("/api/calendar", { cache: "no-store" });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Calendar request failed (${response.status})`);
    }

    renderCalendar(data.events || []);
    setCalendarSyncStatus("Up to date");
  } catch (error) {
    console.error("Could not refresh family calendar:", error);
    setCalendarSyncStatus("Could not refresh", "error");
    renderCalendarError(error?.message || "Could not load the Family calendar.");
  } finally {
    calendarRefreshInProgress = false;
    if (button) button.disabled = false;
  }
}

function calendarEventDate(event) {
  if (event.all_day) return dateFromDateOnly(event.start);
  return new Date(event.start);
}

function eventDateKey(event) {
  return keyFromDateLocal(calendarEventDate(event));
}

function renderCalendar(events) {
  const container = $("#calendar-days");
  const today = atMidnightLocal(new Date());
  const byDate = new Map();

  events.forEach(event => {
    const key = eventDateKey(event);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(event);
  });

  const columns = [];

  for (let i = 0; i < CALENDAR_DAY_COUNT; i += 1) {
    const date = addDays(today, i);
    const key = keyFromDateLocal(date);
    const dayEvents = byDate.get(key) || [];

    dayEvents.sort((a, b) => {
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      return calendarEventDate(a) - calendarEventDate(b);
    });

    const eventHtml = dayEvents.length
      ? dayEvents.map(renderCalendarEvent).join("")
      : `<div class="calendar-empty">No events</div>`;

    columns.push(`
      <section class="calendar-day${i === 0 ? " today" : ""}">
        <div class="calendar-day-heading">
          <span class="calendar-day-name">${i === 0 ? "Today" : escapeHtml(date.toLocaleDateString(undefined, { weekday: "long" }))}</span>
          <span class="calendar-day-date">${escapeHtml(date.toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</span>
        </div>
        <div class="calendar-events">${eventHtml}</div>
      </section>
    `);
  }

  container.innerHTML = columns.join("");
}

function renderCalendarEvent(event) {
  const title = escapeHtml(event.title || "Untitled event");
  const time = event.all_day
    ? "All day"
    : new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const content = `
    <span class="calendar-event-time">${escapeHtml(time)}</span>
    <span class="calendar-event-title">${title}</span>
  `;

  if (event.html_link) {
    return `<a class="calendar-event${event.all_day ? " all-day" : ""}" href="${escapeAttribute(event.html_link)}" target="_blank" rel="noopener">${content}</a>`;
  }

  return `<div class="calendar-event${event.all_day ? " all-day" : ""}">${content}</div>`;
}

function renderCalendarError(message) {
  $("#calendar-days").innerHTML = `
    <div class="calendar-error">
      <div><strong>Family calendar unavailable.</strong>${escapeHtml(message)}</div>
    </div>
  `;
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

  $("#btn-refresh-calendar").addEventListener("click", () => {
    loadCalendarDashboard({ showLoading: true });
  });

  $("#btn-refresh-weather").addEventListener("click", () => {
    loadWeatherDashboard({ showLoading: true });
  });
}

function startDashboardRefresh() {
  window.setInterval(() => {
    if (document.hidden) return;
    loadMealDashboard();
    loadCalendarDashboard();
    loadWeatherDashboard();
  }, AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateClock();
      loadMealDashboard();
      loadCalendarDashboard();
      loadWeatherDashboard();
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
