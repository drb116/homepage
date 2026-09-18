export async function mountRecipeCollection({
  root,
  dataUrl = "/shared/recipes/recipe-data.json",
  actionLabel = "",
  draggable = false,
  linkTarget = "",
  onAction,
  onDragStart
} = {}) {
  const container = typeof root === "string" ? document.querySelector(root) : root;
  if (!container) throw new Error("Recipe collection root was not found.");

  container.classList.add("recipe-collection");
  container.innerHTML = collectionMarkup();

  const get = selector => container.querySelector(selector);
  const getAll = selector => Array.from(container.querySelectorAll(selector));
  const selectedCategories = new Set();
  const response = await fetch(dataUrl, { credentials: "same-origin" });

  if (!response.ok) {
    showLoadError(container);
    throw new Error(`Could not load recipe data (${response.status}).`);
  }

  const library = await response.json();
  if (!Array.isArray(library)) {
    showLoadError(container);
    throw new Error("Recipe data must be an array.");
  }

  buildCategoryFilter(library, get("[data-recipe-category-options]"));

  function render() {
    const search = (get("[data-recipe-search]").value || "").trim().toLowerCase();
    const sectionFilter = get("[data-recipe-section]").value;
    const effortFilter = get("[data-recipe-effort]").value;

    const filtered = library.filter(item => {
      const categories = itemCategories(item);
      const matchesSearch =
        !search ||
        item.title.toLowerCase().includes(search) ||
        categories.some(category => category.toLowerCase().includes(search));
      const matchesSection = sectionFilter === "all" || libraryGroup(item) === sectionFilter;
      const matchesEffort = effortFilter === "all" || item.effort === effortFilter;
      const matchesCategories = [...selectedCategories].every(category =>
        categories.includes(category)
      );

      return matchesSearch && matchesSection && matchesEffort && matchesCategories;
    });

    const grid = get("[data-recipe-grid]");
    grid.innerHTML = "";

    filtered.forEach(item => {
      const card = document.createElement("article");
      card.className = "recipe-collection__card";
      card.dataset.effort = item.effort || "medium";
      card.draggable = Boolean(draggable);

      const effortLabel =
        item.effort === "quick" ? "Quick" :
        item.effort === "long" ? "Longer" : "Medium";
      const categoryLabel = itemCategories(item).map(cleanCategory).join(" · ") || "Dinner";
      const targetAttributes = linkTarget
        ? ` target="${escapeAttribute(linkTarget)}" rel="noopener"`
        : "";

      card.innerHTML = `
        <div class="recipe-collection__meta">
          <i class="recipe-collection__effort-dot ${escapeHtml(item.effort || "medium")}"></i>
          <span>${escapeHtml(effortLabel)} · ${escapeHtml(categoryLabel)}</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="recipe-collection__card-actions">
          ${item.href
            ? `<a class="recipe-collection__link" href="${escapeAttribute(normalizeHref(item.href))}"${targetAttributes}>View recipe →</a>`
            : `<span class="recipe-collection__link">No recipe needed</span>`
          }
        </div>
      `;

      if (actionLabel && typeof onAction === "function") {
        const button = document.createElement("button");
        button.className = "recipe-collection__action";
        button.type = "button";
        button.textContent = actionLabel;
        button.addEventListener("click", () => onAction(item));
        card.querySelector(".recipe-collection__card-actions").appendChild(button);
      }

      if (draggable && typeof onDragStart === "function") {
        card.addEventListener("dragstart", event => onDragStart(event, item));
      }

      grid.appendChild(card);
    });

    get("[data-recipe-count]").textContent =
      `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;
    get("[data-recipe-empty]").hidden = filtered.length !== 0;
  }

  function updateCategoryLabel() {
    const label = get("[data-recipe-category-value]");
    if (selectedCategories.size === 0) label.textContent = "All categories";
    else if (selectedCategories.size === 1) {
      label.textContent = cleanCategory([...selectedCategories][0]);
    } else label.textContent = `${selectedCategories.size} selected`;
  }

  const handleCategoryChange = event => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) selectedCategories.add(input.value);
    else selectedCategories.delete(input.value);
    updateCategoryLabel();
    render();
  };

  const clearCategories = () => {
    selectedCategories.clear();
    getAll('[data-recipe-category-options] input[type="checkbox"]').forEach(input => {
      input.checked = false;
    });
    updateCategoryLabel();
    render();
  };

  const closeCategoryMenu = event => {
    const categoryFilter = get("[data-recipe-category-filter]");
    if (categoryFilter.open && !categoryFilter.contains(event.target)) {
      categoryFilter.removeAttribute("open");
    }
  };

  get("[data-recipe-search]").addEventListener("input", render);
  get("[data-recipe-section]").addEventListener("change", render);
  get("[data-recipe-effort]").addEventListener("change", render);
  get("[data-recipe-category-options]").addEventListener("change", handleCategoryChange);
  get("[data-recipe-category-clear]").addEventListener("click", clearCategories);
  document.addEventListener("click", closeCategoryMenu);

  render();

  return {
    library,
    render,
    destroy() {
      document.removeEventListener("click", closeCategoryMenu);
      container.innerHTML = "";
    }
  };
}

function collectionMarkup() {
  return `
    <div class="recipe-collection__heading">
      <div>
        <p class="recipe-collection__kicker">Recipe collection</p>
        <h2 class="recipe-collection__title">What sounds good?</h2>
      </div>
      <p class="recipe-collection__count" data-recipe-count>Loading…</p>
    </div>

    <div class="recipe-collection__tools">
      <label class="recipe-collection__search">
        <span class="recipe-collection__sr-only">Search recipes</span>
        <span aria-hidden="true">⌕</span>
        <input data-recipe-search type="search" placeholder="Search recipes…" autocomplete="off">
      </label>

      <div class="recipe-collection__filters" aria-label="Recipe filters">
        <label class="recipe-collection__field">
          <span>Section</span>
          <select data-recipe-section>
            <option value="all">All sections</option>
            <option value="dinners">Dinners</option>
            <option value="sides">Side dishes</option>
            <option value="breads">Breads &amp; rolls</option>
            <option value="desserts">Desserts</option>
            <option value="drinks">Drinks</option>
          </select>
        </label>

        <details class="recipe-collection__category-filter" data-recipe-category-filter>
          <summary>
            <span class="recipe-collection__filter-label">Category</span>
            <span class="recipe-collection__filter-value" data-recipe-category-value>All categories</span>
          </summary>
          <div class="recipe-collection__category-menu">
            <div class="recipe-collection__category-options" data-recipe-category-options></div>
            <button class="recipe-collection__category-clear" data-recipe-category-clear type="button">Clear categories</button>
          </div>
        </details>

        <label class="recipe-collection__field">
          <span>Effort</span>
          <select data-recipe-effort>
            <option value="all">All effort levels</option>
            <option value="quick">Quick</option>
            <option value="medium">Medium</option>
            <option value="long">Longer</option>
          </select>
        </label>
      </div>
    </div>

    <div class="recipe-collection__grid" data-recipe-grid></div>
    <div class="recipe-collection__empty" data-recipe-empty hidden>No recipes match those filters.</div>
  `;
}

function showLoadError(container) {
  const count = container.querySelector("[data-recipe-count]");
  const empty = container.querySelector("[data-recipe-empty]");
  if (count) count.textContent = "";
  if (empty) {
    empty.textContent = "Recipes could not be loaded.";
    empty.hidden = false;
  }
}

function buildCategoryFilter(library, options) {
  const categories = [...new Set(library.flatMap(itemCategories))]
    .sort((left, right) => cleanCategory(left).localeCompare(cleanCategory(right)));

  categories.forEach(category => {
    const label = document.createElement("label");
    label.className = "recipe-collection__category-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = category;
    const text = document.createElement("span");
    text.textContent = cleanCategory(category);
    label.append(input, text);
    options.appendChild(label);
  });
}

function libraryGroup(item) {
  const section = (item.section || "").toLowerCase();
  if (section.includes("side")) return "sides";
  if (section.includes("bread")) return "breads";
  if (section.includes("dessert")) return "desserts";
  if (section.includes("drink")) return "drinks";
  return "dinners";
}

function itemCategories(item) {
  if (Array.isArray(item.category)) {
    return item.category.map(String).map(category => category.trim()).filter(Boolean);
  }
  return item.category ? [String(item.category).trim()].filter(Boolean) : [];
}

function cleanCategory(category = "") {
  return String(category)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+Dinners$/i, "")
    .trim() || "Dinner";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
