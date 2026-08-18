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


/* =========================================================
   Alerts
   ========================================================= */

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
                const index =
                    Number(button.dataset.alertIndex);

                openAlert(
                    currentAlerts[index]
                );
            });
        });
}

function openAlert(alert) {
    if (!alert) return;

    $("#alert-modal-title").textContent =
        alert.event ||
        "Weather Alert";

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


/* =========================================================
   Buoy
   ========================================================= */

const val = (value, suffix = "") =>
    value === null ||
        value === undefined ||
        value === ""
        ? "—"
        : `${value}${suffix}`;

function buoy(data) {
    const b =
        data.observation || {};

    $("#buoy-data").innerHTML = `
    <div class="metric">
      <span class="metric-value">
        ${val(b.waveHeightFt, " ft")}
      </span>

      <span class="metric-label">
        Significant wave height
      </span>
    </div>

    <div class="metric">
      <span class="metric-value">
        ${val(b.dominantPeriodSec, " sec")}
      </span>

      <span class="metric-label">
        Dominant period
      </span>
    </div>

    <div class="metric">
      <span class="metric-value">
        ${val(b.windMph, " mph")}
      </span>

      <span class="metric-label">
        ${b.windDirection
            ? `${esc(b.windDirection)} wind`
            : "Wind speed"
        }
      </span>
    </div>

    <div class="metric">
      <span class="metric-value">
        ${val(b.waterTempF, "°F")}
      </span>

      <span class="metric-label">
        Water temperature
      </span>
    </div>
  `;

    const details = [];

    if (b.gustMph != null) {
        details.push(
            `gusting ${b.gustMph} mph`
        );
    }

    if (b.meanWaveDirection) {
        details.push(
            `waves from ${b.meanWaveDirection}`
        );
    }

    if (b.pressureMb != null) {
        details.push(
            `${b.pressureMb} mb`
        );
    }

    $("#buoy-time").textContent =
        `Observed ${fmt(b.observedAt)}${details.length
            ? ` · ${details.join(" · ")}`
            : ""
        }`;
}


/* =========================================================
   Atlantic GFS-Wave Animation
   ========================================================= */

let waveMap;
let waveOverlay;
let waveManifest = null;
let currentWaveHour = 0;

let waveLoadSerial = 0;
let wavePlayTimer = null;
let waveIsPlaying = false;

const WAVE_PLAY_MS = 650;

const DEFAULT_WAVE_BOUNDS = {
    south: 7,
    north: 40,
    west: -99,
    east: -30
};


function waveBounds() {

    const source =
        waveManifest?.bounds ||
        DEFAULT_WAVE_BOUNDS;


    const south =
        Number(source.south);

    const north =
        Number(source.north);

    const west =
        Number(source.west);

    const east =
        Number(source.east);


    if (
        Number.isFinite(south) &&
        Number.isFinite(north) &&
        Number.isFinite(west) &&
        Number.isFinite(east)
    ) {

        return [
            [south, west],
            [north, east]
        ];
    }


    return [
        [
            DEFAULT_WAVE_BOUNDS.south,
            DEFAULT_WAVE_BOUNDS.west
        ],
        [
            DEFAULT_WAVE_BOUNDS.north,
            DEFAULT_WAVE_BOUNDS.east
        ]
    ];
}


function initWaveMap() {

    waveMap =
        L.map(
            "wave-map",
            {
                zoomControl: true,
                attributionControl: true,
                minZoom: 2,
                maxZoom: 10
            }
        );


    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,

            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }
    ).addTo(
        waveMap
    );


    waveMap.fitBounds(
        waveBounds(),
        {
            padding: [4, 4]
        }
    );
}


function availableWaveHours() {

    const manifestHours =
        Array.isArray(
            waveManifest?.forecastHours
        )
            ? waveManifest.forecastHours
                .map(Number)
                .filter(Number.isFinite)
                .sort((a, b) => a - b)

            : [];


    if (
        manifestHours.length
    ) {
        return manifestHours;
    }


    return Array.from(
        {
            length:
                81
        },
        (
            _,
            index
        ) =>
            index * 3
    );
}


function normalizeWaveHour(
    value
) {

    const number =
        Number(value);


    const rounded =
        Number.isFinite(number)
            ? Math.round(number / 3) * 3
            : 0;


    const hours =
        availableWaveHours();


    if (
        hours.includes(
            rounded
        )
    ) {
        return rounded;
    }


    let best =
        hours[0] ??
        0;


    for (
        const hour
        of hours
    ) {

        if (
            Math.abs(
                hour -
                rounded
            ) <
            Math.abs(
                best -
                rounded
            )
        ) {

            best =
                hour;
        }
    }


    return best;
}


function waveFrameUrl(
    hour
) {

    const params =
        new URLSearchParams({
            hour:
                String(hour)
        });


    /*
     * The production Worker ignores this extra query
     * parameter, but it gives the browser a new URL
     * whenever a new model cycle is published.
     */

    if (
        waveManifest?.cycle
    ) {

        params.set(
            "cycle",
            waveManifest.cycle
        );
    }

    if (
        waveManifest?.generatedAt
    ) {
        params.set(
            "v",
            waveManifest.generatedAt
        );
    }

    return `${API_ROOT}/wave-frame?${params.toString()}`;
}


function waveHourLabel(
    hour
) {

    if (
        hour === 0
    ) {

        return "Analysis · +0h";
    }


    const days =
        hour /
        24;


    const dayText =
        Number.isInteger(days)
            ? `Day ${days}`
            : `Day ${days.toFixed(1)}`;


    return `${dayText} · +${hour}h`;
}


function waveValidTime(
    hour
) {

    const cycle =
        waveManifest?.cycleTime;


    if (
        !cycle
    ) {
        return null;
    }


    const start =
        new Date(
            cycle
        );


    if (
        Number.isNaN(
            start.getTime()
        )
    ) {
        return null;
    }


    return new Date(
        start.getTime() +
        hour * 60 * 60 * 1000
    );
}


function updateWaveControls(
    hour
) {

    const normalized =
        normalizeWaveHour(
            hour
        );


    const slider =
        $("#wave-slider");


    if (
        slider
    ) {

        slider.value =
            String(
                normalized
            );
    }


    const label =
        $("#wave-forecast-label");


    if (
        label
    ) {

        label.textContent =
            waveHourLabel(
                normalized
            );
    }


    document
        .querySelectorAll(
            ".wave-jump"
        )
        .forEach(
            button => {

                button.classList.toggle(
                    "active",
                    Number(
                        button.dataset.hour
                    ) ===
                    normalized
                );
            }
        );
}


function updateWaveNote(
    hour
) {

    const note =
        $("#wave-time-label");


    if (
        !note
    ) {
        return;
    }


    const pieces =
        [
            "Significant wave height + surface wind"
        ];


    if (
        waveManifest?.cycle
    ) {

        pieces.push(
            `cycle ${waveManifest.cycle}`
        );
    }


    const validTime =
        waveValidTime(
            hour
        );


    if (
        validTime
    ) {

        pieces.push(
            `valid ${fmt(
                validTime.toISOString()
            )}`
        );
    }


    note.textContent =
        pieces.join(
            " · "
        );
}


async function loadWaveManifest(
    {
        force = false
    } = {}
) {

    if (
        waveManifest &&
        !force
    ) {

        return waveManifest;
    }


    const response =
        await fetch(
            `${API_ROOT}/wave-manifest?t=${Date.now()}`,
            {
                cache:
                    "no-store"
            }
        );


    if (
        !response.ok
    ) {

        throw new Error(
            `Wave manifest request failed (${response.status})`
        );
    }


    const manifest =
        await response.json();


    if (
        !Array.isArray(
            manifest.forecastHours
        ) ||
        !manifest.forecastHours.length
    ) {

        throw new Error(
            "Wave manifest did not contain forecast hours."
        );
    }


    waveManifest =
        manifest;


    if (
        waveMap
    ) {

        /*
         * Bounds are expected to stay the same, but reading
         * them from the manifest keeps the frontend tied to
         * the actual generated product.
         */

        if (
            waveOverlay
        ) {

            waveOverlay.setBounds(
                waveBounds()
            );
        }
    }


    return waveManifest;
}


function preloadWaveFrames(
    hour
) {

    const hours =
        availableWaveHours();


    const index =
        hours.indexOf(
            hour
        );


    if (
        index < 0
    ) {
        return;
    }


    const candidates =
        [
            hours[index + 1],
            hours[index + 2],
            hours[index + 3],
            hours[index - 1]
        ]
            .filter(
                value =>
                    value !==
                    undefined
            );


    for (
        const candidate
        of candidates
    ) {

        const image =
            new Image();


        image.decoding =
            "async";


        image.src =
            waveFrameUrl(
                candidate
            );
    }
}


async function loadWaveFrame(
    hour,
    {
        showLoading = true
    } = {}
) {

    if (
        !waveManifest
    ) {

        await loadWaveManifest();
    }


    const normalized =
        normalizeWaveHour(
            hour
        );


    currentWaveHour =
        normalized;


    updateWaveControls(
        normalized
    );


    const loading =
        $("#wave-loading");


    if (
        loading &&
        (
            !waveOverlay ||
            showLoading
        )
    ) {

        loading.hidden =
            false;

        loading.textContent =
            "Loading GFS-Wave forecast…";
    }


    const serial =
        ++waveLoadSerial;


    const url =
        waveFrameUrl(
            normalized
        );


    const preloader =
        new Image();


    preloader.decoding =
        "async";


    await new Promise(
        (
            resolve,
            reject
        ) => {

            preloader.onload =
                resolve;

            preloader.onerror =
                () =>
                    reject(
                        new Error(
                            `Could not load wave frame +${normalized}h`
                        )
                    );

            preloader.src =
                url;
        }
    );


    if (
        serial !==
        waveLoadSerial
    ) {

        return;
    }


    if (
        !waveOverlay
    ) {

        waveOverlay =
            L.imageOverlay(
                url,
                waveBounds(),
                {
                    opacity:
                        0.94,

                    interactive:
                        false,

                    zIndex:
                        300
                }
            )
                .addTo(
                    waveMap
                );

    } else {

        waveOverlay.setBounds(
            waveBounds()
        );

        waveOverlay.setUrl(
            url
        );
    }


    if (
        loading
    ) {

        loading.hidden =
            true;
    }


    updateWaveNote(
        normalized
    );


    preloadWaveFrames(
        normalized
    );
}


async function refreshWave() {

    const loading =
        $("#wave-loading");


    try {

        await loadWaveManifest(
            {
                force:
                    true
            }
        );


        await loadWaveFrame(
            currentWaveHour,
            {
                showLoading:
                    !waveOverlay
            }
        );

    } catch (error) {

        console.error(
            "GFS-Wave refresh failed.",
            error
        );


        if (
            loading
        ) {

            if (
                waveOverlay
            ) {

                loading.hidden =
                    true;

            } else {

                loading.hidden =
                    false;

                loading.textContent =
                    "GFS-Wave guidance could not be loaded.";
            }
        }
    }
}


function setWavePlaying(
    playing
) {

    waveIsPlaying =
        Boolean(
            playing
        );


    const button =
        $("#wave-play");


    if (
        button
    ) {

        button.textContent =
            waveIsPlaying
                ? "❚❚ Pause"
                : "▶ Play";


        button.setAttribute(
            "aria-label",
            waveIsPlaying
                ? "Pause wave forecast animation"
                : "Play wave forecast animation"
        );
    }


    if (
        !waveIsPlaying &&
        wavePlayTimer
    ) {

        clearTimeout(
            wavePlayTimer
        );

        wavePlayTimer =
            null;
    }
}


function scheduleWavePlayback() {

    if (
        !waveIsPlaying
    ) {
        return;
    }


    if (
        wavePlayTimer
    ) {

        clearTimeout(
            wavePlayTimer
        );
    }


    wavePlayTimer =
        setTimeout(
            async () => {

                wavePlayTimer =
                    null;


                const hours =
                    availableWaveHours();


                const index =
                    hours.indexOf(
                        currentWaveHour
                    );


                const nextHour =
                    index >= 0 &&
                        index <
                        hours.length - 1

                        ? hours[index + 1]

                        : hours[0];


                try {

                    await loadWaveFrame(
                        nextHour,
                        {
                            showLoading:
                                false
                        }
                    );

                } catch (error) {

                    console.warn(
                        "Wave animation frame failed.",
                        error
                    );
                }


                scheduleWavePlayback();

            },
            WAVE_PLAY_MS
        );
}


function startWavePlayback() {

    if (
        waveIsPlaying
    ) {
        return;
    }


    setWavePlaying(
        true
    );


    scheduleWavePlayback();
}


function stopWavePlayback() {

    setWavePlaying(
        false
    );
}


function initWaveControls() {

    $("#wave-play")
        ?.addEventListener(
            "click",
            () => {

                if (
                    waveIsPlaying
                ) {

                    stopWavePlayback();

                } else {

                    startWavePlayback();
                }
            }
        );


    $("#wave-prev")
        ?.addEventListener(
            "click",
            async () => {

                stopWavePlayback();


                const hours =
                    availableWaveHours();


                const index =
                    hours.indexOf(
                        currentWaveHour
                    );


                const previous =
                    index > 0
                        ? hours[index - 1]
                        : hours[0];


                try {

                    await loadWaveFrame(
                        previous
                    );

                } catch (error) {

                    console.warn(
                        error
                    );
                }
            }
        );


    $("#wave-next")
        ?.addEventListener(
            "click",
            async () => {

                stopWavePlayback();


                const hours =
                    availableWaveHours();


                const index =
                    hours.indexOf(
                        currentWaveHour
                    );


                const next =
                    index >= 0 &&
                        index <
                        hours.length - 1

                        ? hours[index + 1]

                        : hours[
                        hours.length - 1
                        ];


                try {

                    await loadWaveFrame(
                        next
                    );

                } catch (error) {

                    console.warn(
                        error
                    );
                }
            }
        );


    document
        .querySelectorAll(
            ".wave-jump"
        )
        .forEach(
            button => {

                button.addEventListener(
                    "click",
                    async () => {

                        stopWavePlayback();


                        try {

                            await loadWaveFrame(
                                Number(
                                    button.dataset.hour
                                )
                            );

                        } catch (error) {

                            console.warn(
                                error
                            );
                        }
                    }
                );
            }
        );


    const slider =
        $("#wave-slider");


    slider
        ?.addEventListener(
            "input",
            () => {

                updateWaveControls(
                    Number(
                        slider.value
                    )
                );
            }
        );


    slider
        ?.addEventListener(
            "change",
            async () => {

                stopWavePlayback();


                try {

                    await loadWaveFrame(
                        Number(
                            slider.value
                        )
                    );

                } catch (error) {

                    console.warn(
                        error
                    );
                }
            }
        );
}


/* =========================================================
   Active Tropical Systems + Spaghetti Models
   ========================================================= */

/*
 * Testing:
 *
 * /weather/?testStorm=AL092024
 *
 * With no testStorm parameter, only live systems
 * returned by /tropical-systems are displayed.
 */

const TROPICAL_TEST_STORM =
    new URLSearchParams(
        window.location.search
    )
        .get("testStorm")
        ?.toUpperCase() ||
    null;

const TROPICAL_TEST_CYCLE =
    new URLSearchParams(
        window.location.search
    )
        .get("testCycle")
        ?.trim() ||
    null;

let tropicalMaps = [];


/*
 * One color per model line.
 */

const TROPICAL_MODEL_COLORS = [
    "#f4f7fb",
    "#56a8ff",
    "#56d49a",
    "#f7d66b",
    "#ff9f5e",
    "#c084fc",
    "#ff6b8a",
    "#61dafb",
    "#9aa7b5",
    "#e0aaff"
];


function tropicalDomId(value) {
    return String(
        value ||
        "system"
    )
        .replace(
            /[^a-z0-9_-]/gi,
            "-"
        )
        .toLowerCase();
}


function tropicalSystemPanel(
    system
) {

    const name =
        system.displayName ||
        system.name ||
        system.id ||
        "Tropical system";


    const classification =
        system.classification ||
        (
            system.isInvest
                ? "Tropical Disturbance"
                : "Tropical Cyclone"
        );


    const movement =
        [
            system.movementDirection,

            system.movementMph != null
                ? `at ${system.movementMph} mph`
                : null
        ]
            .filter(Boolean)
            .join(" ");


    const position =
        system.latitude != null &&
            system.longitude != null

            ? (
                `${Math.abs(
                    Number(
                        system.latitude
                    )
                ).toFixed(1)}°${Number(
                    system.latitude
                ) >= 0
                    ? "N"
                    : "S"
                }, ` +

                `${Math.abs(
                    Number(
                        system.longitude
                    )
                ).toFixed(1)}°${Number(
                    system.longitude
                ) >= 0
                    ? "E"
                    : "W"
                }`
            )

            : null;


    const metricCards =
        [];


    if (
        system.windMph != null
    ) {

        metricCards.push(`
      <div class="metric">
        <span class="metric-value">
          ${esc(system.windMph)} mph
        </span>

        <span class="metric-label">
          Maximum sustained wind
        </span>
      </div>
    `);
    }


    if (
        system.pressureMb != null
    ) {

        metricCards.push(`
      <div class="metric">
        <span class="metric-value">
          ${esc(system.pressureMb)} mb
        </span>

        <span class="metric-label">
          Minimum pressure
        </span>
      </div>
    `);
    }


    if (movement) {

        metricCards.push(`
      <div class="metric">
        <span class="metric-value">
          ${esc(movement)}
        </span>

        <span class="metric-label">
          Movement
        </span>
      </div>
    `);
    }


    if (position) {

        metricCards.push(`
      <div class="metric">
        <span class="metric-value">
          ${esc(position)}
        </span>

        <span class="metric-label">
          Current position
        </span>
      </div>
    `);
    }


    const details =
        [];


    if (
        system.updatedAt
    ) {

        details.push(`
      <li>
        <strong>Updated:</strong>
        ${esc(fmt(system.updatedAt))}
      </li>
    `);
    }


    if (
        system.id
    ) {

        details.push(`
      <li>
        <strong>ATCF ID:</strong>
        ${esc(system.id)}
      </li>
    `);
    }


    return `
    <div class="panel-heading">

      <div>
        <p class="panel-kicker">
          ${system._historicalTest
            ? "Historical tropical system"
            : "Active tropical system"
        }
        </p>

        <h2 class="tropical-system-name">
          ${esc(name)}
        </h2>

        <p class="tropical-system-type">
          ${esc(classification)}
        </p>
      </div>

      <span class="tropical-badge">
        ${esc(
            system.isInvest
                ? "Invest"
                : (
                    system.classificationCode ||
                    "Active"
                )
        )
        }
      </span>

    </div>


    ${metricCards.length
            ? `
          <div class="tropical-metrics">
            ${metricCards.join("")}
          </div>
        `
            : ""
        }


    ${details.length
            ? `
          <ul class="tropical-detail-list">
            ${details.join("")}
          </ul>
        `
            : ""
        }


    ${system._historicalTest
            ? `
          <p class="tropical-test-note">
            Historical test mode.
            Remove
            <code>?testStorm=...</code>
            from the URL to return to live systems only.
          </p>
        `
            : ""
        }
  `;
}


function tropicalRow(
    system,
    index
) {

    const id =
        tropicalDomId(
            system.id ||
            `system-${index}`
        );


    return `
    <section
      class="tropical-system-row"
      data-system-id="${esc(system.id || "")}"
    >

      <article
        class="weather-panel tropical-system-panel"
      >
        ${tropicalSystemPanel(system)}
      </article>


      <article
        class="weather-panel tropical-model-panel"
      >

        <div class="panel-heading">

          <div>
            <p class="panel-kicker">
              NHC / ATCF model guidance
            </p>

            <h2>
              Spaghetti models
            </h2>
          </div>

          <span class="source-link">
            ${esc(system.id || "")}
          </span>

        </div>


        <div class="tropical-map-shell">

          <div
            id="tropical-map-${id}"
            class="tropical-model-map"
            aria-label="Model guidance map for ${esc(
        system.displayName ||
        system.name ||
        system.id ||
        "tropical system"
    )}"
          ></div>


          <div
            id="tropical-loading-${id}"
            class="tropical-map-loading"
          >
            Loading model guidance…
          </div>

        </div>


        <div
          id="tropical-legend-${id}"
          class="tropical-model-legend"
        ></div>


        <p
          id="tropical-note-${id}"
          class="data-note"
        >
          Latest available ATCF forecast cycle
        </p>

      </article>

    </section>
  `;
}


function clearTropicalMaps() {

    for (
        const map
        of tropicalMaps
    ) {

        try {

            map.remove();

        } catch (_) {

            /*
             * Ignore Leaflet maps that have
             * already been removed.
             */
        }
    }


    tropicalMaps =
        [];
}


async function renderTropicalModelMap(
    system
) {

    const id =
        tropicalDomId(
            system.id
        );


    const mapElement =
        document.getElementById(
            `tropical-map-${id}`
        );


    const loading =
        document.getElementById(
            `tropical-loading-${id}`
        );


    const legend =
        document.getElementById(
            `tropical-legend-${id}`
        );


    const note =
        document.getElementById(
            `tropical-note-${id}`
        );


    if (!mapElement) {
        return;
    }


    try {

        let modelUrl =
            `${API_ROOT}/tropical-models?id=${encodeURIComponent(
                system.id
            )
            }`;

        if (
            TROPICAL_TEST_CYCLE
        ) {
            modelUrl +=
                `&cycle=${encodeURIComponent(
                    TROPICAL_TEST_CYCLE
                )
                }`;
        }

        const data =
            await get(
                modelUrl
            );


        const models =
            Array.isArray(
                data.models
            )

                ? data.models.filter(
                    model =>
                        Array.isArray(
                            model.points
                        ) &&
                        model.points.length >= 2
                )

                : [];


        if (
            !models.length
        ) {

            loading.textContent =
                "No model tracks are available for the latest cycle.";


            note.textContent =
                data.cycleTime

                    ? `ATCF cycle ${fmt(data.cycleTime)}`

                    : "No usable ATCF guidance was returned.";


            return;
        }


        const map =
            L.map(
                mapElement,
                {
                    zoomControl: true,
                    attributionControl: true,
                    minZoom: 2,
                    maxZoom: 10
                }
            );


        tropicalMaps.push(
            map
        );


        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                maxZoom:
                    19,

                attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            }
        ).addTo(
            map
        );


        const allLatLngs =
            [];


        models.forEach(
            (
                model,
                modelIndex
            ) => {

                const points =
                    model.points

                        .filter(
                            point =>
                                point.latitude != null &&
                                point.longitude != null
                        )

                        .map(
                            point => [
                                Number(
                                    point.latitude
                                ),

                                Number(
                                    point.longitude
                                )
                            ]
                        );


                if (
                    points.length < 2
                ) {

                    return;
                }


                allLatLngs.push(
                    ...points
                );


                const modelColor =
                    TROPICAL_MODEL_COLORS[
                    modelIndex %
                    TROPICAL_MODEL_COLORS.length
                    ];


                const weight =
                    model.official
                        ? 5
                        : 3;


                const opacity =
                    model.official
                        ? 1
                        : 0.85;


                const line =
                    L.polyline(
                        points,
                        {
                            color:
                                modelColor,

                            weight,

                            opacity
                        }
                    )
                        .addTo(
                            map
                        );


                line.bindTooltip(
                    `${esc(
                        model.label ||
                        model.code ||
                        "Model"
                    )
                    } ${model.code
                        ? `(${esc(model.code)})`
                        : ""
                    }`,
                    {
                        sticky:
                            true
                    }
                );


                /*
                 * Mark the starting point of each model.
                 */

                const firstPoint =
                    model.points.find(
                        point =>
                            point.latitude != null &&
                            point.longitude != null
                    );


                if (
                    firstPoint
                ) {

                    L.circleMarker(
                        [
                            Number(
                                firstPoint.latitude
                            ),

                            Number(
                                firstPoint.longitude
                            )
                        ],
                        {
                            radius:
                                model.official
                                    ? 5
                                    : 3.5,

                            color:
                                modelColor,

                            weight:
                                1,

                            fillColor:
                                modelColor,

                            fillOpacity:
                                0.9
                        }
                    )
                        .bindTooltip(
                            `${esc(
                                model.label ||
                                model.code ||
                                "Model"
                            )
                            } start`
                        )
                        .addTo(
                            map
                        );
                }


                /*
                 * Build legend.
                 */

                if (
                    legend
                ) {

                    const item =
                        document.createElement(
                            "span"
                        );


                    item.className =
                        "tropical-model-key";


                    const swatch =
                        document.createElement(
                            "i"
                        );


                    swatch.className =
                        `tropical-model-line${model.official
                            ? " official"
                            : ""
                        }`;


                    swatch.style.setProperty(
                        "--model-color",
                        modelColor
                    );


                    const label =
                        document.createElement(
                            "span"
                        );


                    label.textContent =
                        model.label ||
                        model.code ||
                        "Model";


                    item.append(
                        swatch,
                        label
                    );


                    legend.appendChild(
                        item
                    );
                }
            }
        );


        if (
            allLatLngs.length
        ) {

            const bounds =
                L.latLngBounds(
                    allLatLngs
                );


            map.fitBounds(
                bounds.pad(
                    0.16
                ),
                {
                    maxZoom:
                        6
                }
            );
        }


        loading.hidden =
            true;


        note.textContent =
            `${data.modelCount ||
            models.length
            } model tracks` +

            (
                data.cycleTime
                    ? ` · cycle ${fmt(data.cycleTime)}`
                    : ""
            );


        /*
         * Leaflet can occasionally measure a new
         * dynamically inserted panel too early.
         */

        setTimeout(
            () =>
                map.invalidateSize(),
            50
        );


    } catch (error) {

        console.error(
            `Tropical model load failed for ${system.id}:`,
            error
        );


        loading.textContent =
            "Model guidance could not be loaded.";


        note.textContent =
            "ATCF model data is temporarily unavailable.";
    }
}


async function tropicalSystems(
    data
) {

    const container =
        $("#tropical-systems");


    if (!container) {
        return;
    }


    clearTropicalMaps();


    let systems =
        Array.isArray(
            data?.systems
        )

            ? [
                ...data.systems
            ]

            : [];


    /*
     * Historical test mode.
     *
     * Example:
     *
     * /weather/?testStorm=AL092024
     */

    if (
        TROPICAL_TEST_STORM &&

        !systems.some(
            system =>
                String(
                    system.id ||
                    ""
                ).toUpperCase() ===
                TROPICAL_TEST_STORM
        )
    ) {

        systems.unshift(
            {
                id:
                    TROPICAL_TEST_STORM,

                name:
                    `Historical Test: ${TROPICAL_TEST_STORM}`,

                displayName:
                    `Historical Test: ${TROPICAL_TEST_STORM}`,

                classification:
                    "Historical model guidance test",

                classificationCode:
                    "TEST",

                isInvest:
                    false,

                _historicalTest:
                    true
            }
        );
    }


    /*
     * Quiet Atlantic:
     * hide the entire section.
     */

    if (
        !systems.length
    ) {

        container.innerHTML =
            "";

        return;
    }


    container.innerHTML =
        systems

            .map(
                (
                    system,
                    index
                ) =>
                    tropicalRow(
                        system,
                        index
                    )
            )

            .join("");


    /*
     * Each storm gets its own independent
     * Leaflet spaghetti map.
     */

    await Promise.allSettled(
        systems.map(
            system =>
                renderTropicalModelMap(
                    system
                )
        )
    );
}


/* =========================================================
   Main Refresh
   ========================================================= */

async function load() {

    const button =
        $("#refresh-button");


    button.disabled =
        true;


    $("#dashboard-status").textContent =
        "Refreshing official data…";


    refreshWave();


    const results =
        await Promise.allSettled([
            get(
                `${API_ROOT}/alerts`
            ),

            get(
                `${API_ROOT}/buoy`
            ),

            get(
                `${API_ROOT}/tropical-systems`
            )
        ]);


    let ok =
        0;


    /*
     * Alerts
     */

    if (
        results[0].status ===
        "fulfilled"
    ) {

        alerts(
            results[0].value
        );

        ok++;

    } else {

        $("#alerts-list").innerHTML = `
      <div class="error-card">
        NWS alerts could not be loaded.
        Use the official NWS Melbourne link below.
      </div>
    `;


        $("#alert-count").textContent =
            "Unavailable";
    }


    /*
     * Buoy
     */

    if (
        results[1].status ===
        "fulfilled"
    ) {

        buoy(
            results[1].value
        );

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


    /*
     * Tropical systems
     */

    if (
        results[2].status ===
        "fulfilled"
    ) {

        await tropicalSystems(
            results[2].value
        );

        ok++;

    } else {

        console.error(
            "Tropical systems could not be loaded.",
            results[2].reason
        );


        /*
         * If historical test mode is enabled,
         * still show the test storm even if the
         * live-system endpoint failed.
         */

        if (
            TROPICAL_TEST_STORM
        ) {

            await tropicalSystems(
                {
                    systems: []
                }
            );

        } else {

            const container =
                $("#tropical-systems");


            if (container) {

                container.innerHTML = `
          <div class="error-card">
            Active tropical systems could not be loaded.
          </div>
        `;
            }
        }
    }


    const time =
        new Intl.DateTimeFormat(
            "en-US",
            {
                hour:
                    "numeric",

                minute:
                    "2-digit",

                timeZoneName:
                    "short"
            }
        )
            .format(
                new Date()
            );


    $("#dashboard-status").textContent =
        ok === 3

            ? `Official data updated ${time}`

            : `Updated ${time} · Some sources unavailable`;


    $("#footer-update").textContent =
        `Updated ${time}`;


    /*
     * Cache-bust the NHC outlook image approximately
     * once per REFRESH_MS interval.
     */

    $("#outlook-image").src =
        `https://www.nhc.noaa.gov/xgtwo/two_atl_7d0.png?t=${Math.floor(
            Date.now() /
            REFRESH_MS
        )
        }`;


    button.disabled =
        false;
}


/* =========================================================
   Events
   ========================================================= */

$("#refresh-button")
    .addEventListener(
        "click",
        load
    );


$("#alert-modal-close")
    .addEventListener(
        "click",
        () => {

            $("#alert-modal")
                .close();
        }
    );


$("#alert-modal")
    .addEventListener(
        "click",
        event => {

            if (
                event.target ===
                $("#alert-modal")
            ) {

                $("#alert-modal")
                    .close();
            }
        }
    );


window.addEventListener(
    "DOMContentLoaded",
    () => {

        initWaveMap();
        initWaveControls();


        /*
         * Give Leaflet's initial fitBounds()
         * a moment to finish before loading data.
         */

        setTimeout(
            load,
            300
        );
    }
);

setInterval(
    load,
    REFRESH_MS
);