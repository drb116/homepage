const DEFAULT_LATITUDE = 28.251578;
const DEFAULT_LONGITUDE = -80.742786;
const DEFAULT_TIME_ZONE = "America/New_York";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cToF(value) {
  const c = numberOrNull(value);
  return c == null ? null : (c * 9) / 5 + 32;
}

async function loadYoLinkTemperature(env) {
  if (!env.DASHBOARD_API_KEY) {
    throw new Error(
      "DASHBOARD_API_KEY is not configured."
    );
  }

  const response = await fetch(
    "https://api.davidb.xyz/yolink/temperature",
    {
      headers: {
        "x-dashboard-key":
          env.DASHBOARD_API_KEY,
        Accept: "application/json"
      },
      cf: {
        cacheTtl: 0
      }
    }
  );

  const data =
    await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.error ||
      `Temperature API returned HTTP ${response.status}`
    );
  }

  return {
    temperature_f:
      numberOrNull(data.temperature_f),

    online:
      data.online ?? null,

    reported_at:
      data.reported_at ?? null,

    sensor_name:
      data.device?.name ?? null
  };
}

async function loadForecast(env) {
  const latitude = numberOrNull(env.WEATHER_LATITUDE) ?? DEFAULT_LATITUDE;
  const longitude = numberOrNull(env.WEATHER_LONGITUDE) ?? DEFAULT_LONGITUDE;
  const timeZone = env.WEATHER_TIME_ZONE || DEFAULT_TIME_ZONE;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", timeZone);
  url.searchParams.set("forecast_days", "2");
  console.log(url.toString());
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.daily) {
    throw new Error(data?.reason || `Forecast returned HTTP ${response.status}`);
  }

  const daily = data.daily;
  if (!Array.isArray(daily.time) || daily.time.length < 2) {
    throw new Error("Forecast did not return two days.");
  }

  return {
    weather_code: numberOrNull(daily.weather_code?.[0]),
    today: {
      date: daily.time[0],
      high_f: numberOrNull(daily.temperature_2m_max?.[0]),
      low_f: numberOrNull(daily.temperature_2m_min?.[0])
    },
    tomorrow: {
      date: daily.time[1],
      high_f: numberOrNull(daily.temperature_2m_max?.[1]),
      low_f: numberOrNull(daily.temperature_2m_min?.[1])
    }
  };
}

export async function handleWeatherCard(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET" }
    });
  }

  const [sensorResult, forecastResult] = await Promise.allSettled([
    loadYoLinkTemperature(env),
    loadForecast(env)
  ]);

  const sensor = sensorResult.status === "fulfilled" ? sensorResult.value : null;
  const forecast = forecastResult.status === "fulfilled" ? forecastResult.value : null;

  if (!sensor && !forecast) {
    console.error("Weather card errors:", sensorResult.reason, forecastResult.reason);
    return json({
      ok: false,
      error: "Current temperature and forecast are unavailable."
    }, 502);
  }

  if (sensorResult.status === "rejected") {
    console.error("YoLink weather-card error:", sensorResult.reason);
  }
  if (forecastResult.status === "rejected") {
    console.error("Forecast weather-card error:", forecastResult.reason);
  }

  return json({
    ok: true,
    generated_at: new Date().toISOString(),
    current: sensor,
    forecast,
    partial: !sensor || !forecast
  });
}
