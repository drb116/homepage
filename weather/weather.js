const API_ROOT = "/api/weather";
const REFRESH_MS = 600000;

const $ = selector => document.querySelector(selector);

const esc = value =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function fmt(value) {
  if (!value) return "Unknown";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function color(event = "", severity = "") {
  const text = `${event} ${severity}`.toLowerCase();

  if (
    text.includes("tornado warning") ||
    text.includes("hurricane warning") ||
    text.includes("extreme")
  ) {
    return "#ff4d63";
  }

  if (text.includes("warning")) return "#ff7b63";
  if (text.includes("watch")) return "#ffb45e";

  if (
    text.includes("advisory") ||
    text.includes("statement")
  ) {
    return "#f7d66b";
  }

  return "#56a8ff";
}

function summary(text = "", maxLength = 220) {
  const clean = String(text)
    .replace(/\s+/g, " ")
    .trim();

  return clean.length > maxLength
    ? `${clean.slice(0, maxLength).trim()}…`
    : clean;
}

async function get(url) {
  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  return response.json();
}


/* Alerts */

let currentAlerts = [];

function alerts(data) {
  const list = Array.isArray(data.alerts)
    ? data.alerts
    : [];

  currentAlerts = list;

  $("#alert-count").textContent =
    list.length === 1
      ? "1 alert"
      : `${list.length} alerts`;

  if (!list.length) {
    $("#alerts-list").innerHTML = `
      <div class="quiet-card">
        <strong>No active NWS alerts</strong>
        <p>
          No watches, warnings, or advisories currently
          match Brevard County or nearby Atlantic waters.
        </p>
      </div>
    `;
    return;
  }

  $("#alerts-list").innerHTML = list
    .map((alert, index) => `
      <article
        class="alert-card"
        style="--alert-color:${color(alert.event, alert.severity)}"
      >
        <h3>${esc(alert.event || "Weather alert")}</h3>

        <div class="alert-meta">
          <span>${esc(alert.areaDesc || "Brevard area")}</span>
          <span>Ends ${esc(fmt(alert.ends || alert.expires))}</span>
        </div>

        <p class="alert-summary">
          ${esc(
            summary(
              alert.headline ||
              alert.description ||
              "",
              180
            )
          )}
        </p>

        <button
          type="button"
          class="alert-open"
          data-alert-index="${index}"
        >
          View full alert
        </button>
      </article>
    `)
    .join("");

  document
    .querySelectorAll(".alert-open")
    .forEach(button => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.alertIndex);
        openAlert(currentAlerts[index]);
      });
    });
}

function openAlert(alert) {
  if (!alert) return;

  $("#alert-modal-title").textContent =
    alert.event || "Weather Alert";

  $("#alert-modal-meta").innerHTML = `
    <span>${esc(alert.areaDesc || "Brevard area")}</span>
    <span>Issued ${esc(fmt(alert.sent))}</span>
    <span>Ends ${esc(fmt(alert.ends || alert.expires))}</span>
  `;

  let html = "";

  if (alert.headline) {
    html += `
      <p class="alert-modal-headline">
        ${esc(alert.headline)}
      </p>
    `;
  }

  if (alert.description) {
    html += `
      <div class="alert-modal-description">
        ${esc(alert.description).replace(/\n/g, "<br>")}
      </div>
    `;
  }

  if (alert.instruction) {
    html += `
      <div class="alert-modal-instructions">
        <strong>Recommended action</strong>
        <p>
          ${esc(alert.instruction).replace(/\n/g, "<br>")}
        </p>
      </div>
    `;
  }

  $("#alert-modal-body").innerHTML =
    html ||
    "<p>No additional alert details were provided.</p>";

  $("#alert-modal").showModal();
}


/* Buoy */

const val = (value, suffix = "") =>
  value === null ||
  value === undefined ||
  value === ""
    ? "—"
    : `${value}${suffix}`;

function buoy(data) {
  const b = data.observation || {};

  $("#buoy-data").innerHTML = `
    <div class="metric">
      <span class="metric-value">${val(b.waveHeightFt, " ft")}</span>
      <span class="metric-label">Significant wave height</span>
    </div>

    <div class="metric">
      <span class="metric-value">${val(b.dominantPeriodSec, " sec")}</span>
      <span class="metric-label">Dominant period</span>
    </div>

    <div class="metric">
      <span class="metric-value">${val(b.windMph, " mph")}</span>
      <span class="metric-label">
        ${b.windDirection ? `${esc(b.windDirection)} wind` : "Wind speed"}
      </span>
    </div>

    <div class="metric">
      <span class="metric-value">${val(b.waterTempF, "°F")}</span>
      <span class="metric-label">Water temperature</span>
    </div>
  `;

  const details = [];

  if (b.gustMph != null) {
    details.push(`gusting ${b.gustMph} mph`);
  }

  if (b.meanWaveDirection) {
    details.push(`waves from ${b.meanWaveDirection}`);
  }

  if (b.pressureMb != null) {
    details.push(`${b.pressureMb} mb`);
  }

  $("#buoy-time").textContent =
    `Observed ${fmt(b.observedAt)}${
      details.length
        ? ` · ${details.join(" · ")}`
        : ""
    }`;
}


/* Caribbean wave map */

let waveMap;
let waveLayer;
let currentWaveHour = 0;

let waveRequestController = null;
let waveMoveTimer = null;

let initialMapReady = false;

const waveCache = new Map();

const WAVE_CACHE_MS =
  10 * 60 * 1000;

const WAVE_REGION = {
  south: 7,
  north: 34,
  west: -92,
  east: -55
};

function initWaveMap() {
  waveMap = L.map("wave-map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 3,
    maxZoom: 10
  });

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }
  ).addTo(waveMap);

  waveLayer =
    L.layerGroup().addTo(waveMap);

  waveMap.fitBounds([
    [8.0, -91.0],
    [33.0, -57.0]
  ]);

  /*
   * fitBounds() itself can fire moveend.
   * Ignore that initial event so we do not
   * immediately make two identical API calls.
   */
  setTimeout(() => {
    initialMapReady = true;
  }, 1000);

  waveMap.on("moveend", () => {
    if (!initialMapReady) {
      return;
    }

    clearTimeout(waveMoveTimer);

    /*
     * Wait until the user has actually finished
     * zooming/panning before requesting more data.
     */
    waveMoveTimer =
      setTimeout(() => {
        loadWave(
          currentWaveHour,
          {
            preserveExisting: true
          }
        );
      }, 900);
  });
}

function waveColor(feet) {
  if (feet == null) return "#7a8794";
  if (feet < 3) return "#4cb3d4";
  if (feet < 5) return "#65c466";
  if (feet < 8) return "#e2cf4f";
  if (feet < 12) return "#ef8c3d";
  return "#e84f5f";
}

function waveRadius(feet) {
  if (feet == null) return 4;

  // Keep dense zoomed-in maps readable.
  const zoom = waveMap ? waveMap.getZoom() : 5;
  const base =
    zoom >= 8 ? 4 :
    zoom >= 7 ? 4.5 :
    zoom >= 6 ? 5 :
    5.5;

  return Math.max(
    base,
    Math.min(base + 4, base + feet * 0.22)
  );
}

function waveCacheKey(
  hour,
  query
) {
  /*
   * Round the viewport so tiny movements don't
   * cause completely new API requests.
   */

  const precision =
    query.zoom >= 8
      ? 1
      : 0;

  const round = value => {
    const factor =
      10 ** precision;

    return (
      Math.round(
        value * factor
      ) / factor
    );
  };

  return [
    hour,
    round(query.south),
    round(query.north),
    round(query.west),
    round(query.east),
    query.step
  ].join("|");
}

function waveStepForZoom(zoom) {
  // Broad view: enough points to show the overall pattern
  // without hammering the marine API.
  if (zoom >= 8) return 0.20;
  if (zoom === 7) return 0.35;
  if (zoom === 6) return 0.60;
  if (zoom === 5) return 1.00;

  return 2.00;
}

function currentWaveQuery() {
  const bounds = waveMap.getBounds();
  const zoom = waveMap.getZoom();
  const step = waveStepForZoom(zoom);

  const south = Math.max(
    WAVE_REGION.south,
    bounds.getSouth()
  );

  const north = Math.min(
    WAVE_REGION.north,
    bounds.getNorth()
  );

  const west = Math.max(
    WAVE_REGION.west,
    bounds.getWest()
  );

  const east = Math.min(
    WAVE_REGION.east,
    bounds.getEast()
  );

  if (
    south >= north ||
    west >= east
  ) {
    return null;
  }

  return {
    south,
    north,
    west,
    east,
    step,
    zoom
  };
}

function renderWaveGrid(data) {
  waveLayer.clearLayers();

  const points = Array.isArray(data.points)
    ? data.points
    : [];

  for (const point of points) {
    if (
      point.waveHeightFt == null ||
      point.latitude == null ||
      point.longitude == null
    ) {
      continue;
    }

    const feet = Number(point.waveHeightFt);

    const marker = L.circleMarker(
      [point.latitude, point.longitude],
      {
        radius: waveRadius(feet),
        color: "rgba(255,255,255,0.62)",
        weight: 0.8,
        fillColor: waveColor(feet),
        fillOpacity: 0.82
      }
    );

    marker.bindTooltip(
      `${feet.toFixed(1)} ft`,
      {
        permanent: false,
        direction: "top",
        className: "wave-dot-label"
      }
    );

    marker.bindPopup(`
      <strong>${feet.toFixed(1)} ft</strong><br>
      Significant wave height<br>
      ${esc(fmt(data.validTime))}
    `);

    marker.addTo(waveLayer);
  }

  const density =
    data.stepDegrees != null
      ? `${data.stepDegrees}° grid`
      : "model grid";

  $("#wave-time-label").textContent =
    `${data.modelLabel || "GFS-Wave"} · valid ${fmt(data.validTime)} · ${points.length} ocean points · ${density}`;

  $("#wave-loading").hidden = true;
}

async function loadWave(
  hour,
  {
    preserveExisting = false
  } = {}
) {
  currentWaveHour = hour;

  document
    .querySelectorAll(".wave-time")
    .forEach(button => {
      button.classList.toggle(
        "active",
        Number(
          button.dataset.hour
        ) === hour
      );
    });

  if (!waveMap) {
    return;
  }

  const query =
    currentWaveQuery();

  if (!query) {
    return;
  }


  /*
   * Check browser cache first.
   */

  const cacheKey =
    waveCacheKey(
      hour,
      query
    );

  const cached =
    waveCache.get(
      cacheKey
    );

  if (
    cached &&
    Date.now() -
      cached.savedAt <
      WAVE_CACHE_MS
  ) {
    renderWaveGrid(
      cached.data
    );

    return;
  }


  /*
   * Cancel an older request if the user moved
   * the map again before it finished.
   */

  if (
    waveRequestController
  ) {
    waveRequestController.abort();
  }

  waveRequestController =
    new AbortController();


  /*
   * Only cover the map with the loading message
   * when there is currently no useful data.
   *
   * If we're merely refining an existing map,
   * leave the old data visible.
   */

  if (
    !preserveExisting ||
    waveLayer
      .getLayers()
      .length === 0
  ) {
    $("#wave-loading").hidden =
      false;

    $("#wave-loading").textContent =
      query.zoom >= 8
        ? "Loading high-resolution wave guidance…"
        : "Loading wave guidance…";
  }


  const params =
    new URLSearchParams({
      hour:
        String(hour),

      south:
        query.south.toFixed(4),

      north:
        query.north.toFixed(4),

      west:
        query.west.toFixed(4),

      east:
        query.east.toFixed(4),

      step:
        String(query.step)
    });


  try {
    const response =
      await fetch(
        `${API_ROOT}/wave-grid?${params.toString()}`,
        {
          cache:
            "no-store",

          signal:
            waveRequestController.signal
        }
      );


    /*
     * A rate-limit response should NOT destroy
     * the valid map that's already on screen.
     */

    if (
      response.status === 429
    ) {
      $("#wave-loading").hidden =
        true;

      console.warn(
        "Wave API rate limited; keeping existing map."
      );

      return;
    }


    if (!response.ok) {
      throw new Error(
        `Request failed (${response.status})`
      );
    }


    const data =
      await response.json();


    /*
     * Save this viewport/hour combination for
     * ten minutes.
     */

    waveCache.set(
      cacheKey,
      {
        savedAt:
          Date.now(),

        data
      }
    );


    renderWaveGrid(
      data
    );

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {
      return;
    }


    /*
     * If there are already points on the map,
     * leave them alone.
     */

    if (
      waveLayer
        .getLayers()
        .length > 0
    ) {
      $("#wave-loading").hidden =
        true;

      console.warn(
        "Wave refinement failed; keeping existing data.",
        error
      );

      return;
    }


    $("#wave-loading").hidden =
      false;

    $("#wave-loading").textContent =
      "Wave guidance could not be loaded.";
  }
}

/* Main refresh */

async function load() {
  const button = $("#refresh-button");

  button.disabled = true;

  $("#dashboard-status").textContent =
    "Refreshing official data…";

  loadWave(currentWaveHour);

  const results = await Promise.allSettled([
    get(`${API_ROOT}/alerts`),
    get(`${API_ROOT}/buoy`)
  ]);

  let ok = 0;

  if (results[0].status === "fulfilled") {
    alerts(results[0].value);
    ok++;
  } else {
    $("#alerts-list").innerHTML = `
      <div class="error-card">
        NWS alerts could not be loaded.
        Use the official NWS Melbourne link below.
      </div>
    `;

    $("#alert-count").textContent = "Unavailable";
  }

  if (results[1].status === "fulfilled") {
    buoy(results[1].value);
    ok++;
  } else {
    $("#buoy-data").innerHTML = `
      <div class="error-card">
        Buoy data could not be loaded.
      </div>
    `;

    $("#buoy-time").textContent =
      "Use the NOAA station link for current observations.";
  }

  const time = new Intl.DateTimeFormat(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }
  ).format(new Date());

  $("#dashboard-status").textContent =
    ok === 2
      ? `Official data updated ${time}`
      : `Updated ${time} · Some sources unavailable`;

  $("#footer-update").textContent =
    `Updated ${time}`;

  $("#outlook-image").src =
    `https://www.nhc.noaa.gov/xgtwo/two_atl_7d0.png?t=${
      Math.floor(Date.now() / REFRESH_MS)
    }`;

  button.disabled = false;
}


/* Events */

document.querySelectorAll(".wave-time").forEach(button => {
  button.addEventListener("click", () => {
    loadWave(Number(button.dataset.hour));
  });
});

$("#refresh-button").addEventListener("click", load);

$("#alert-modal-close").addEventListener("click", () => {
  $("#alert-modal").close();
});

$("#alert-modal").addEventListener("click", event => {
  if (event.target === $("#alert-modal")) {
    $("#alert-modal").close();
  }
});

window.addEventListener(
  "DOMContentLoaded",
  () => {
    initWaveMap();

    /*
     * Allow Leaflet's initial fitBounds()
     * to finish before the first wave request.
     */
    setTimeout(
      load,
      300
    );
  }
);

setInterval(load, REFRESH_MS);
