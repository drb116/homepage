const API_ROOT = "/api/weather", REFRESH_MS = 600000, $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
function fmt(v) { if (!v) return "Unknown"; const d = new Date(v); return Number.isNaN(d.getTime()) ? "Unknown" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d) }
function color(e = "", s = "") { const t = `${e} ${s}`.toLowerCase(); if (t.includes("tornado warning") || t.includes("hurricane warning") || t.includes("extreme")) return "#ff4d63"; if (t.includes("warning")) return "#ff7b63"; if (t.includes("watch")) return "#ffb45e"; if (t.includes("advisory") || t.includes("statement")) return "#f7d66b"; return "#56a8ff" }
function summary(t = "", m = 280) { const x = String(t).replace(/\s+/g, " ").trim(); return x.length > m ? `${x.slice(0, m).trim()}…` : x }
async function get(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`Request failed (${r.status})`); return r.json() }
function alerts(data) {
  const a = Array.isArray(data.alerts)
    ? data.alerts
    : [];

  $("#alert-count").textContent =
    a.length === 1
      ? "1 alert"
      : `${a.length} alerts`;

  if (!a.length) {
    $("#alerts-list").innerHTML = `
      <div class="quiet-card">
        <strong>No active NWS alerts</strong>
        <p>
          No watches, warnings, or advisories currently
          match Brevard County or the adjacent Atlantic coastal zones.
        </p>
      </div>
    `;
    return;
  }

  $("#alerts-list").innerHTML = a.map(x => {

    const description =
      x.description || "";

    const instruction =
      x.instruction || "";

    const shortText =
      x.headline ||
      description ||
      "";

    return `
      <article
        class="alert-card"
        style="--alert-color:${color(x.event, x.severity)}"
      >

        <h3>
          ${esc(x.event || "Weather alert")}
        </h3>

        <div class="alert-meta">

          <span>
            ${esc(x.areaDesc || "Brevard area")}
          </span>

          <span>
            Ends ${esc(fmt(x.ends || x.expires))}
          </span>

        </div>

        <p class="alert-summary">
          ${esc(summary(shortText, 220))}
        </p>

        <details class="alert-details">

          <summary>
            View full alert
          </summary>

          <div class="alert-full-text">

            ${
              description
                ? `
                  <p>
                    ${esc(description).replace(/\n/g, "<br>")}
                  </p>
                `
                : ""
            }

            ${
              instruction
                ? `
                  <div class="alert-instructions">

                    <strong>
                      Recommended action
                    </strong>

                    <p>
                      ${esc(instruction).replace(/\n/g, "<br>")}
                    </p>

                  </div>
                `
                : ""
            }

            <p class="alert-issued">
              Issued ${esc(fmt(x.sent))}
            </p>

          </div>

        </details>

      </article>
    `;

  }).join("");
}
const val = (v, s = "") => v === null || v === undefined || v === "" ? "—" : `${v}${s}`;
function buoy(data) { const b = data.observation || {}; $("#buoy-data").innerHTML = `<div class="metric"><span class="metric-value">${val(b.waveHeightFt, " ft")}</span><span class="metric-label">Significant wave height</span></div><div class="metric"><span class="metric-value">${val(b.dominantPeriodSec, " sec")}</span><span class="metric-label">Dominant period</span></div><div class="metric"><span class="metric-value">${val(b.windMph, " mph")}</span><span class="metric-label">${b.windDirection ? `${esc(b.windDirection)} wind` : "Wind speed"}</span></div><div class="metric"><span class="metric-value">${val(b.waterTempF, "°F")}</span><span class="metric-label">Water temperature</span></div>`; const d = []; if (b.gustMph != null) d.push(`gusting ${b.gustMph} mph`); if (b.meanWaveDirection) d.push(`waves from ${b.meanWaveDirection}`); if (b.pressureMb != null) d.push(`${b.pressureMb} mb`); $("#buoy-time").textContent = `Observed ${fmt(b.observedAt)}${d.length ? ` · ${d.join(" · ")}` : ""}` }
async function load() { const btn = $("#refresh-button"); btn.disabled = true; $("#dashboard-status").textContent = "Refreshing official data…"; const r = await Promise.allSettled([get(`${API_ROOT}/alerts`), get(`${API_ROOT}/buoy`)]); let ok = 0; if (r[0].status === "fulfilled") { alerts(r[0].value); ok++ } else { $("#alerts-list").innerHTML = '<div class="error-card">NWS alerts could not be loaded. Use the official NWS Melbourne link below.</div>'; $("#alert-count").textContent = "Unavailable" } if (r[1].status === "fulfilled") { buoy(r[1].value); ok++ } else { $("#buoy-data").innerHTML = '<div class="error-card" style="grid-column:1/-1">Buoy data could not be loaded.</div>'; $("#buoy-time").textContent = "Use the NOAA station link for current observations." } const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date()); $("#dashboard-status").textContent = ok === 2 ? `Official data updated ${time}` : `Updated ${time} · Some sources unavailable`; $("#footer-update").textContent = `Updated ${time}`; $("#outlook-image").src = `https://www.nhc.noaa.gov/xgtwo/two_atl_7d0.png?t=${Math.floor(Date.now() / REFRESH_MS)}`; btn.disabled = false }
$("#refresh-button").addEventListener("click", load); window.addEventListener("DOMContentLoaded", load); setInterval(load, REFRESH_MS);
