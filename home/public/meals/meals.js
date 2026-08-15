const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STORAGE_KEY = "familyMeals.local.v1";
const DIRTY_KEY = "familyMeals.dirty.v1";
const AUTO_REFRESH_MS = 60_000;
const LIBRARY = Array.isArray(window.RECIPE_LIBRARY) ? window.RECIPE_LIBRARY : [];
const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));

let currentWeekKey = keyFromDateLocal(startOfWeekSundayLocal(new Date()));
let weeks = loadWeeks();
let dirtyWeeks = loadDirtyWeeks();
let saveQueue = Promise.resolve();
const saveRevisions = {};
let activeFilter = "all";
let pendingAddItem = null;
let refreshInProgress = false;

const weekGrid = $("#week-grid");
const recipeGrid = $("#recipe-grid");

buildWeekScaffold();
renderWeek();
renderRecipeLibrary();
wireEvents();
refreshCurrentWeek({ showLoading: true, source: "initial" });
startAutoRefresh();

function emptyWeek() {
  return Object.fromEntries(DAYS.map(day => [day, []]));
}

function loadWeeks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {}
  return {};
}

function loadDirtyWeeks() {
  try {
    const raw = localStorage.getItem(DIRTY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {}
  return {};
}

function cacheWeeks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(weeks));
}

function cacheDirtyWeeks() {
  localStorage.setItem(DIRTY_KEY, JSON.stringify(dirtyWeeks));
}

function markWeekDirty(weekKey, dirty) {
  if (dirty) dirtyWeeks[weekKey] = true;
  else delete dirtyWeeks[weekKey];
  cacheDirtyWeeks();
}

function cloneWeek(week) {
  return JSON.parse(JSON.stringify(week || emptyWeek()));
}

function normalizeWeek(value) {
  const normalized = emptyWeek();
  if (!value || typeof value !== "object") return normalized;

  DAYS.forEach(day => {
    normalized[day] = Array.isArray(value[day]) ? value[day] : [];
  });

  return normalized;
}

function hasWeekContent(week) {
  return DAYS.some(day => Array.isArray(week?.[day]) && week[day].length > 0);
}

function setSaveStatus(text, state = "") {
  const status = $("#save-status");
  status.className = `save-status${state ? ` ${state}` : ""}`;
  status.innerHTML = `<span class="save-dot"></span>${text}`;
}

async function putWeekToServer(weekKey, menu) {
  const response = await fetch("/api/menu", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      week_start: weekKey,
      menu
    })
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
}

async function syncWeekFromServer(weekKey, { showLoading = false, source = "auto" } = {}) {
  const isCurrent = () => currentWeekKey === weekKey;
  const hadLocalWeek = Object.prototype.hasOwnProperty.call(weeks, weekKey);
  const localWeek = hadLocalWeek ? cloneWeek(weeks[weekKey]) : emptyWeek();

  if (isCurrent() && showLoading) {
    setSaveStatus(source === "manual" ? "Refreshing…" : "Loading shared menu…", "saving");
  }

  // If a previous save failed, the local copy is newer than D1. Push it first
  // so a reload cannot overwrite an unsynced change.
  if (dirtyWeeks[weekKey]) {
    try {
      await putWeekToServer(weekKey, localWeek);
      markWeekDirty(weekKey, false);
      if (isCurrent()) setSaveStatus("Saved");
    } catch (error) {
      console.error("Menu sync failed:", error);
      if (isCurrent()) setSaveStatus("Saved locally · sync failed", "error");
    }
    return;
  }

  try {
    const response = await fetch(`/api/menu?week=${encodeURIComponent(weekKey)}`, {
      cache: "no-store"
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    if (data.menu) {
      const serverWeek = normalizeWeek(data.menu);
      const localBeforeSync = normalizeWeek(weeks[weekKey]);
      const changed = JSON.stringify(serverWeek) !== JSON.stringify(localBeforeSync);

      weeks[weekKey] = serverWeek;
      cacheWeeks();

      if (isCurrent()) {
        if (changed) renderWeek();
        setSaveStatus(source === "manual" && !changed ? "Up to date" : "Saved");
      }
      return;
    }

    // No D1 row yet. If this browser already has a locally saved menu for
    // the week, migrate that menu into D1 automatically.
    if (hadLocalWeek && hasWeekContent(localWeek)) {
      await putWeekToServer(weekKey, localWeek);
      if (isCurrent()) setSaveStatus("Saved");
      return;
    }

    if (!weeks[weekKey]) weeks[weekKey] = emptyWeek();
    cacheWeeks();
    if (isCurrent()) setSaveStatus("Saved");
  } catch (error) {
    console.error("Could not load shared menu:", error);
    if (isCurrent()) setSaveStatus("Using local copy · sync failed", "error");
  }
}

async function refreshCurrentWeek({ showLoading = false, source = "auto" } = {}) {
  if (refreshInProgress) return;

  refreshInProgress = true;
  const refreshButton = $("#btn-refresh");
  if (refreshButton && source === "manual") refreshButton.disabled = true;

  try {
    await syncWeekFromServer(currentWeekKey, { showLoading, source });
  } finally {
    refreshInProgress = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

function startAutoRefresh() {
  window.setInterval(() => {
    // Do not spend requests refreshing a tab that is not currently visible.
    // It will refresh immediately when it becomes visible again.
    if (document.hidden) return;
    refreshCurrentWeek();
  }, AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCurrentWeek();
  });
}

function saveWeeks() {
  const weekKey = currentWeekKey;
  const menuSnapshot = cloneWeek(getWeekState(weekKey));
  const revision = (saveRevisions[weekKey] || 0) + 1;
  saveRevisions[weekKey] = revision;

  cacheWeeks();
  markWeekDirty(weekKey, true);
  setSaveStatus("Saving…", "saving");

  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      await putWeekToServer(weekKey, menuSnapshot);

      // Only clear the dirty flag if this is still the newest queued save
      // for this week.
      if (saveRevisions[weekKey] === revision) {
        markWeekDirty(weekKey, false);
        if (currentWeekKey === weekKey) setSaveStatus("Saved");
      }
    })
    .catch(error => {
      console.error("Menu save failed:", error);
      if (saveRevisions[weekKey] === revision && currentWeekKey === weekKey) {
        setSaveStatus("Saved locally · sync failed", "error");
      }
    });
}

function getWeekState(key = currentWeekKey) {
  if (!weeks[key]) weeks[key] = emptyWeek();
  return weeks[key];
}

function dateFromKeyLocal(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function keyFromDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function atMidnightLocal(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeekSundayLocal(date) {
  const result = atMidnightLocal(date);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function dayDate(weekKey, dayIndex) {
  const date = dateFromKeyLocal(weekKey);
  date.setDate(date.getDate() + dayIndex);
  return date;
}

function formatRange(weekKey) {
  const start = dayDate(weekKey, 0);
  const end = dayDate(weekKey, 6);
  const startText = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endText = end.toLocaleDateString(undefined, {
    month: start.getMonth() === end.getMonth() ? undefined : "short",
    day: "numeric",
    year: "numeric"
  });
  return `${startText} – ${endText}`;
}

function buildWeekScaffold() {
  weekGrid.innerHTML = "";

  DAYS.forEach((day, index) => {
    const element = document.createElement("article");
    element.className = "day";
    element.dataset.day = day;
    element.dataset.dayIndex = index;
    element.innerHTML = `
      <div class="day-head">
        <div>
          <span class="day-name">${day}</span>
          <span class="day-date"></span>
        </div>
        <div class="day-actions">
          <button class="mini-button" type="button" data-note="${day}" title="Add note">+</button>
          <button class="mini-button" type="button" data-clear="${day}" title="Clear day">×</button>
        </div>
      </div>
      <div class="day-list" aria-label="${day} menu"></div>
    `;

    addDayDropHandlers(element);
    weekGrid.appendChild(element);
  });
}

function renderWeek() {
  const state = getWeekState();
  const todayKey = keyFromDateLocal(new Date());

  $$(".day", weekGrid).forEach((dayElement, index) => {
    const day = dayElement.dataset.day;
    const date = dayDate(currentWeekKey, index);
    const dateKey = keyFromDateLocal(date);

    dayElement.classList.toggle("today", dateKey === todayKey);
    $(".day-date", dayElement).textContent = date.getDate();

    const list = $(".day-list", dayElement);
    list.innerHTML = "";

    (state[day] || []).forEach(entry => {
      list.appendChild(createMenuChip(entry, day));
    });
  });

  $("#planner-title").textContent =
    currentWeekKey === keyFromDateLocal(startOfWeekSundayLocal(new Date()))
      ? "This week"
      : "Weekly menu";
  $("#week-range").textContent = formatRange(currentWeekKey);
}

function createMenuChip(entry, day) {
  const chip = document.createElement("div");
  chip.className = `menu-chip${entry.type === "note" ? " note" : ""}`;
  chip.dataset.type = entry.type;
  chip.dataset.day = day;

  if (entry.href) chip.dataset.href = normalizeHref(entry.href);

  if (entry.type === "note") {
    const span = document.createElement("span");
    span.className = "note-text";
    span.textContent = entry.text;
    chip.appendChild(span);
  } else if (entry.href) {
    const link = document.createElement("a");
    link.href = normalizeHref(entry.href);
    link.target = "_blank";
    link.rel = "noopener";
    link.draggable = false;
    link.textContent = entry.title;
    chip.appendChild(link);
  } else {
    const span = document.createElement("span");
    span.className = "chip-title";
    span.textContent = entry.title;
    chip.appendChild(span);
  }

  const remove = document.createElement("button");
  remove.className = "remove-chip";
  remove.type = "button";
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${entry.title || entry.text || "item"}`);
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    removeEntry(day, entry);
  });
  chip.appendChild(remove);

  chip.draggable = true;
  chip.addEventListener("dragstart", event => {
    event.dataTransfer.setData("application/json", JSON.stringify({
      kind: "menu-entry",
      entry,
      fromDay: day
    }));
    event.dataTransfer.effectAllowed = "move";
  });

  if (entry.type === "note") {
    chip.addEventListener("dblclick", () => {
      const next = prompt("Edit note:", entry.text);
      if (next === null) return;
      const text = next.trim();
      if (!text) removeEntry(day, entry);
      else {
        entry.text = text;
        saveWeeks();
        renderWeek();
      }
    });
  }

  return chip;
}

function addEntry(day, entry) {
  const state = getWeekState();
  if (!state[day]) state[day] = [];

  const normalized = {
    type: entry.type || (entry.href ? "recipe" : "manual"),
    title: entry.title || "",
    href: entry.href ? normalizeHref(entry.href) : undefined,
    text: entry.text || undefined
  };

  const duplicate = state[day].some(existing => {
    if (normalized.type === "note") return false;
    if (normalized.href) return normalizeHref(existing.href || "") === normalized.href;
    return !existing.href &&
      (existing.title || "").trim().toLowerCase() === normalized.title.trim().toLowerCase();
  });

  if (!duplicate) state[day].push(normalized);

  saveWeeks();
  renderWeek();
}

function removeEntry(day, entryToRemove) {
  const state = getWeekState();
  const list = state[day] || [];

  const index = list.findIndex(entry => sameEntry(entry, entryToRemove));
  if (index >= 0) list.splice(index, 1);

  saveWeeks();
  renderWeek();
}

function sameEntry(a, b) {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === "note") return a.text === b.text;
  if (a.href || b.href) return normalizeHref(a.href || "") === normalizeHref(b.href || "");
  return (a.title || "").trim().toLowerCase() === (b.title || "").trim().toLowerCase();
}

function addDayDropHandlers(dayElement) {
  dayElement.addEventListener("dragover", event => {
    if (!event.dataTransfer.types.includes("application/json")) return;
    event.preventDefault();
    dayElement.classList.add("dragover");
  });

  dayElement.addEventListener("dragleave", () => dayElement.classList.remove("dragover"));

  dayElement.addEventListener("drop", event => {
    event.preventDefault();
    dayElement.classList.remove("dragover");

    let payload;
    try {
      payload = JSON.parse(event.dataTransfer.getData("application/json"));
    } catch {
      return;
    }

    const targetDay = dayElement.dataset.day;

    if (payload.kind === "library-item") {
      addEntry(targetDay, payload.entry);
      return;
    }

    if (payload.kind === "menu-entry") {
      if (payload.fromDay === targetDay) return;

      const sourceState = getWeekState()[payload.fromDay] || [];
      const index = sourceState.findIndex(entry => sameEntry(entry, payload.entry));
      if (index >= 0) sourceState.splice(index, 1);

      const targetState = getWeekState()[targetDay] || [];
      getWeekState()[targetDay] = targetState;
      targetState.push(payload.entry);

      saveWeeks();
      renderWeek();
    }
  });
}

function renderRecipeLibrary() {
  const search = ($("#recipe-search")?.value || "").trim().toLowerCase();

  const filtered = LIBRARY.filter(item => {
    const matchesSearch =
      !search ||
      item.title.toLowerCase().includes(search) ||
      (item.category || "").toLowerCase().includes(search);

    const matchesFilter =
      activeFilter === "all" ||
      libraryGroup(item) === activeFilter;

    return matchesSearch && matchesFilter;
  });

  recipeGrid.innerHTML = "";

  filtered.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "recipe-card";
    card.dataset.effort = item.effort || "medium";
    card.draggable = true;

    const effortLabel =
      item.effort === "quick" ? "Quick" :
      item.effort === "long" ? "Longer" : "Medium";

    const categoryLabel = cleanCategory(item.category);

    card.innerHTML = `
      <div class="recipe-meta">
        <i class="effort-dot ${escapeHtml(item.effort || "medium")}"></i>
        <span>${escapeHtml(effortLabel)} · ${escapeHtml(categoryLabel)}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="recipe-card-actions">
        ${item.href
          ? `<a class="recipe-link" href="${escapeAttribute(normalizeHref(item.href))}" target="_blank" rel="noopener">View recipe ↗</a>`
          : `<span class="recipe-link">No recipe needed</span>`
        }
        <button class="add-button" type="button" data-add-index="${index}">+ Add</button>
      </div>
    `;

    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("application/json", JSON.stringify({
        kind: "library-item",
        entry: libraryItemToEntry(item)
      }));
      event.dataTransfer.effectAllowed = "copy";
    });

    const addButton = $(".add-button", card);
    addButton.addEventListener("click", () => openAddModal(item));

    recipeGrid.appendChild(card);
  });

  $("#recipe-count").textContent = `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;
  $("#recipe-empty").hidden = filtered.length !== 0;
}

function libraryItemToEntry(item) {
  return item.href
    ? { type: "recipe", title: item.title, href: normalizeHref(item.href) }
    : { type: "manual", title: item.title };
}

function libraryGroup(item) {
  const section = (item.section || "").toLowerCase();
  if (section.includes("side")) return "sides";
  if (section.includes("bread")) return "breads";
  if (section.includes("dessert")) return "desserts";
  if (section.includes("drink")) return "drinks";
  return "dinners";
}

function cleanCategory(category = "") {
  return category
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+Dinners$/i, "")
    .trim() || "Dinner";
}

function openAddModal(item) {
  pendingAddItem = libraryItemToEntry(item);
  $("#add-recipe-name").textContent = item.title;

  const picker = $("#day-picker");
  picker.innerHTML = "";

  DAYS.forEach((day, index) => {
    const date = dayDate(currentWeekKey, index);
    const button = document.createElement("button");
    button.className = "day-pick-button";
    button.type = "button";
    button.innerHTML = `<strong>${day}</strong><span>${date.getDate()}</span>`;
    button.addEventListener("click", () => {
      addEntry(day, pendingAddItem);
      closeAddModal();
    });
    picker.appendChild(button);
  });

  $("#add-modal").classList.add("open");
}

function closeAddModal() {
  $("#add-modal").classList.remove("open");
  pendingAddItem = null;
}

function shiftWeek(days) {
  const date = dateFromKeyLocal(currentWeekKey);
  date.setDate(date.getDate() + days);
  currentWeekKey = keyFromDateLocal(startOfWeekSundayLocal(date));
  renderWeek();
  refreshCurrentWeek({ showLoading: true, source: "initial" });
}

function goToThisWeek() {
  currentWeekKey = keyFromDateLocal(startOfWeekSundayLocal(new Date()));
  renderWeek();
  refreshCurrentWeek({ showLoading: true, source: "initial" });
}

function normalizeHref(href) {
  if (!href) return "";
  try {
    const url = new URL(href, location.origin);
    return url.pathname + url.search;
  } catch {
    return href;
  }
}

function addCustomMeal() {
  const title = prompt("What should be added to the menu?");
  if (!title || !title.trim()) return;

  pendingAddItem = { type: "manual", title: title.trim() };
  $("#add-recipe-name").textContent = title.trim();

  const picker = $("#day-picker");
  picker.innerHTML = "";

  DAYS.forEach((day, index) => {
    const date = dayDate(currentWeekKey, index);
    const button = document.createElement("button");
    button.className = "day-pick-button";
    button.type = "button";
    button.innerHTML = `<strong>${day}</strong><span>${date.getDate()}</span>`;
    button.addEventListener("click", () => {
      addEntry(day, pendingAddItem);
      closeAddModal();
    });
    picker.appendChild(button);
  });

  $("#add-modal").classList.add("open");
}

function wireEvents() {
  $("#btn-prev-week").addEventListener("click", () => shiftWeek(-7));
  $("#btn-next-week").addEventListener("click", () => shiftWeek(7));
  $("#btn-this-week").addEventListener("click", goToThisWeek);
  $("#btn-refresh").addEventListener("click", () => {
    refreshCurrentWeek({ showLoading: true, source: "manual" });
  });
  $("#btn-custom").addEventListener("click", addCustomMeal);
  $("#btn-shopping").addEventListener("click", buildShoppingList);

  weekGrid.addEventListener("click", event => {
    const clearButton = event.target.closest("[data-clear]");
    const noteButton = event.target.closest("[data-note]");

    if (clearButton) {
      const day = clearButton.dataset.clear;
      if (!getWeekState()[day]?.length) return;
      if (!confirm(`Clear ${day}?`)) return;
      getWeekState()[day] = [];
      saveWeeks();
      renderWeek();
    }

    if (noteButton) {
      const day = noteButton.dataset.note;
      const text = prompt(`Add a note for ${day}:`, "Eat out");
      if (text && text.trim()) {
        addEntry(day, { type: "note", text: text.trim() });
      }
    }
  });

  $("#recipe-search").addEventListener("input", renderRecipeLibrary);

  $("#filter-row").addEventListener("click", event => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;

    activeFilter = button.dataset.filter;
    $$(".filter-chip", $("#filter-row")).forEach(chip => {
      chip.classList.toggle("active", chip === button);
    });
    renderRecipeLibrary();
  });

  $("#btn-add-close").addEventListener("click", closeAddModal);
  $("#add-modal").addEventListener("click", event => {
    if (event.target === $("#add-modal")) closeAddModal();
  });

  $("#btn-close-shopping").addEventListener("click", closeShoppingModal);
  $("#shopping-modal").addEventListener("click", event => {
    if (event.target === $("#shopping-modal")) closeShoppingModal();
  });

  $("#btn-copy").addEventListener("click", copyShoppingList);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeAddModal();
      closeShoppingModal();
    }
  });
}

/* ===== Shopping list ===== */

const PANTRY = [
  "salt", "oregano", "garlic", "basil", "parsley", "vegetable oil",
  "olive oil", "cornstarch", "white sugar", "taco seasoning",
  "chicken broth", "boiling water", "black pepper", "chili powder",
  "cumin", "garam masala", "onion powder", "turmeric"
];

function collectMenuRecipes() {
  const state = getWeekState();
  const recipes = [];

  DAYS.forEach(day => {
    (state[day] || []).forEach(entry => {
      if (entry.type === "recipe" && entry.href) recipes.push(entry);
    });
  });

  return recipes;
}

async function buildShoppingList() {
  const selections = collectMenuRecipes();

  if (!selections.length) {
    alert("There are no recipes in this week's menu yet.");
    return;
  }

  $("#shopping-list").innerHTML = "";
  $("#shopping-warnings").innerHTML = "";
  $("#shopping-errors").innerHTML = "";
  $("#shopping-summary").textContent = "Building list…";
  $("#shopping-modal").classList.add("open");

  const uniqueRecipes = new Map();
  selections.forEach(item => {
    const path = normalizeHref(item.href);
    if (!uniqueRecipes.has(path)) uniqueRecipes.set(path, { ...item, href: path });
  });

  const ingredients = [];
  const warnings = [];
  const errors = [];

  for (const item of uniqueRecipes.values()) {
    try {
      const response = await fetch(item.href, {
        credentials: "same-origin",
        redirect: "follow"
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const found = extractIngredientsFromHtml(html);

      if (!found.length) warnings.push(`No ingredients found: ${item.title}`);
      else ingredients.push(...found);
    } catch (error) {
      errors.push(`Could not read ${item.title}: ${error.message || "unknown error"}`);
    }
  }

  const normalized = ingredients.map(normalizeIngredient).filter(Boolean);
  const omitted = normalized.filter(isPantryItem);
  const kept = normalized.filter(item => !isPantryItem(item));
  const uniqueIngredients = Array.from(new Set(kept));

  uniqueIngredients.forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    $("#shopping-list").appendChild(li);
  });

  const summary = [
    `${uniqueIngredients.length} unique ingredient${uniqueIngredients.length === 1 ? "" : "s"}`,
    `from ${uniqueRecipes.size} recipe${uniqueRecipes.size === 1 ? "" : "s"}`
  ];

  if (omitted.length) summary.push(`(${omitted.length} pantry item${omitted.length === 1 ? "" : "s"} skipped)`);

  $("#shopping-summary").textContent = summary.join(" ");

  if (warnings.length) {
    $("#shopping-warnings").innerHTML =
      `<p class="warn">Warnings</p><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }

  if (errors.length) {
    $("#shopping-errors").innerHTML =
      `<p>Errors</p><ul>${errors.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }
}

function closeShoppingModal() {
  $("#shopping-modal").classList.remove("open");
}

function extractIngredientsFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const heading = $$("h1,h2,h3,h4", doc)
    .find(element => element.textContent.trim().toLowerCase() === "ingredients");

  if (heading) {
    const output = [];
    let element = heading.nextElementSibling;

    while (element) {
      if (/^H[1-6]$/i.test(element.tagName)) break;
      if (element.tagName === "UL") {
        $$("li", element).forEach(li => output.push(li.textContent.trim()));
      }
      element = element.nextElementSibling;
    }

    if (output.length) return output;
  }

  for (const ul of $$("ul", doc)) {
    const items = $$("li", ul).map(li => li.textContent.trim()).filter(Boolean);
    if (items.length >= 3) return items;
  }

  return $$("li", doc).slice(0, 50).map(li => li.textContent.trim()).filter(Boolean);
}

function normalizeIngredient(value) {
  if (!value) return "";
  return String(value)
    .replace(/\u00BD/g, "1/2")
    .replace(/\u00BC/g, "1/4")
    .replace(/\u00BE/g, "3/4")
    .replace(/\u2153/g, "1/3")
    .replace(/\u2154/g, "2/3")
    .replace(/\u00A0/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/^[*•\-\u2022]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPantryItem(text) {
  const lower = (text || "").toLowerCase();
  return PANTRY.some(item => lower.includes(item.toLowerCase()));
}

async function copyShoppingList() {
  const items = $$("#shopping-list li").map(li => li.textContent);
  if (!items.length) return;

  try {
    await navigator.clipboard.writeText(items.join("\n"));
    const button = $("#btn-copy");
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => button.textContent = previous, 900);
  } catch {
    alert("Copy failed; your browser may block clipboard access.");
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function escapeAttribute(value = "") {
  return escapeHtml(value);
}
