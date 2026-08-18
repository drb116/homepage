const YOLINK_TOKEN_URL =
  "https://api.yosmart.com/open/yolink/token";

const YOLINK_API_URL =
  "https://api.yosmart.com/open/yolink/v2/api";

const READING_CACHE_MS = 45 * 1000;
const DEVICE_CACHE_MS = 60 * 60 * 1000;

// These are only in-memory optimizations.
// Cloudflare can discard them at any time and the code
// will simply fetch fresh data again.
let cachedReading = null;
let cachedReadingUntil = 0;

let cachedDevice = null;
let cachedDeviceUntil = 0;

let cachedAccessToken = null;
let cachedAccessTokenUntil = 0;


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}


function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


function cToF(celsius) {
  return (celsius * 9) / 5 + 32;
}


function isAuthorized(request, env) {
  if (!env.DASHBOARD_API_KEY) {
    return false;
  }

  return (
    request.headers.get("x-dashboard-key") ===
    env.DASHBOARD_API_KEY
  );
}


async function getAccessToken(env) {
  const now = Date.now();

  if (
    cachedAccessToken &&
    now < cachedAccessTokenUntil
  ) {
    return cachedAccessToken;
  }

  if (!env.YOLINK_UAID || !env.YOLINK_SECRET) {
    throw new Error(
      "YoLink credentials are not configured."
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.YOLINK_UAID,
    client_secret: env.YOLINK_SECRET
  });

  const response = await fetch(
    YOLINK_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data =
    await response.json().catch(() => null);

  if (
    !response.ok ||
    !data?.access_token
  ) {
    throw new Error(
      data?.error_description ||
      data?.error ||
      `YoLink token request returned HTTP ${response.status}`
    );
  }

  cachedAccessToken = data.access_token;

  // Leave a one-minute safety margin.
  const expiresIn =
    numberOrNull(data.expires_in) || 3600;

  cachedAccessTokenUntil =
    now +
    Math.max(60, expiresIn - 60) * 1000;

  return cachedAccessToken;
}


async function callYoLink(
  accessToken,
  payload
) {
  const response = await fetch(
    YOLINK_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    }
  );

  const data =
    await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `YoLink API returned HTTP ${response.status}`
    );
  }

  if (!data || data.code !== "000000") {
    throw new Error(
      data?.desc ||
      data?.message ||
      `YoLink API error ${data?.code || "unknown"}`
    );
  }

  return data;
}


async function getTemperatureDevice(
  env,
  accessToken
) {
  const now = Date.now();

  if (
    cachedDevice &&
    now < cachedDeviceUntil
  ) {
    return cachedDevice;
  }

  if (!env.YOLINK_TEMPERATURE_DEVICE_ID) {
    throw new Error(
      "YOLINK_TEMPERATURE_DEVICE_ID is not configured."
    );
  }

  const result = await callYoLink(
    accessToken,
    {
      method: "Home.getDeviceList",
      time: Date.now()
    }
  );

  const devices =
    Array.isArray(result.data?.devices)
      ? result.data.devices
      : [];

  const device = devices.find(
    item =>
      item.deviceId ===
      env.YOLINK_TEMPERATURE_DEVICE_ID
  );

  if (!device) {
    throw new Error(
      "Temperature sensor was not found in the YoLink device list."
    );
  }

  if (!device.token) {
    throw new Error(
      "Temperature sensor did not include a network token."
    );
  }

  cachedDevice = device;
  cachedDeviceUntil =
    now + DEVICE_CACHE_MS;

  return device;
}


async function getTemperature(env) {
  const now = Date.now();

  if (
    cachedReading &&
    now < cachedReadingUntil
  ) {
    return cachedReading;
  }

  const accessToken =
    await getAccessToken(env);

  const device =
    await getTemperatureDevice(
      env,
      accessToken
    );

  const result = await callYoLink(
    accessToken,
    {
      method: "THSensor.getState",
      time: Date.now(),
      targetDevice: device.deviceId,
      token: device.token,
      params: {}
    }
  );

  const state = result.data?.state;

  const temperatureC =
    numberOrNull(state?.temperature);

  if (temperatureC == null) {
    throw new Error(
      "YoLink sensor response did not contain a temperature."
    );
  }

  const humidity =
    numberOrNull(state?.humidity);

  const battery =
    numberOrNull(state?.battery);

  cachedReading = {
    ok: true,

    temperature_c:
      Math.round(temperatureC * 10) / 10,

    temperature_f:
      Math.round(cToF(temperatureC) * 10) /
      10,

    humidity,

    battery,

    online:
      result.data?.online ?? null,

    reported_at:
      result.data?.reportAt ?? null,

    device: {
      id: device.deviceId,
      name: device.name ?? null,
      model: device.modelName ?? null,
      type: device.type ?? null
    }
  };

  cachedReadingUntil =
    now + READING_CACHE_MS;

  return cachedReading;
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return json({
        ok: true,
        service: "DavidB API"
      });
    }

    if (
      request.method === "GET" &&
      url.pathname ===
        "/yolink/temperature"
    ) {
      if (!isAuthorized(request, env)) {
        return json(
          {
            ok: false,
            error: "Unauthorized"
          },
          401
        );
      }

      try {
        const data =
          await getTemperature(env);

        return json(data);
      } catch (error) {
        console.error(
          "YoLink temperature error:",
          error
        );

        return json(
          {
            ok: false,
            error:
              error?.message ||
              "Temperature unavailable."
          },
          502
        );
      }
    }

    return json(
      {
        ok: false,
        error: "Not found"
      },
      404
    );
  }
};