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

function initWaveMap() {
  waveMap = L.map("wave-map", {
    zoomControl: true,
    attributionControl: true
  });

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 8,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }
  ).addTo(waveMap);

  waveMap.fitBounds([
    [8.0, -91.0],
    [33.0, -57.0]
  ]);

  waveLayer = L.layerGroup().addTo(waveMap);
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
  if (feet == null) return 5;
  return Math.max(6, Math.min(14, 5 + feet * 0.7));
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
        color: "rgba(255,255,255,0.75)",
        weight: 1,
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

  $("#wave-time-label").textContent =
    `${data.modelLabel || "GFS-Wave"} · valid ${fmt(data.validTime)} · significant wave height`;

  $("#wave-loading").hidden = true;
}

async function loadWave(hour) {
  currentWaveHour = hour;

  document.querySelectorAll(".wave-time").forEach(button => {
    button.classList.toggle(
      "active",
      Number(button.dataset.hour) === hour
    );
  });

  $("#wave-loading").hidden = false;
  $("#wave-loading").textContent =
    "Loading wave guidance…";

  try {
    const data = await get(
      `${API_ROOT}/wave-grid?hour=${hour}`
    );

    renderWaveGrid(data);
  } catch (error) {
    $("#wave-loading").hidden = false;
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

  const results = await Promise.allSettled([
    get(`${API_ROOT}/alerts`),
    get(`${API_ROOT}/buoy`),
    loadWave(currentWaveHour)
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

  if (results[2].status === "fulfilled") {
    ok++;
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
    ok === 3
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

window.addEventListener("DOMContentLoaded", () => {
  initWaveMap();
  load();
});

setInterval(load, REFRESH_MS);
