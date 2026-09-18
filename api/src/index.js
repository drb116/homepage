import { Resvg } from "@cf-wasm/resvg/workerd";
import sourceSansRegular from "./source-sans-3-latin-400-normal.woff2";
import sourceSansSemibold from "./source-sans-3-latin-600-normal.woff2";

var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", { value, configurable: true });

// --------------------------------------------------
// Constants here
// --------------------------------------------------

var YOLINK_TOKEN_URL =
  "https://api.yosmart.com/open/yolink/token";

var YOLINK_API_URL =
  "https://api.yosmart.com/open/yolink/v2/api";

var HOME_BASE_URL =
  "https://home.davidb.xyz";

var TIME_ZONE =
  "America/New_York";

var READING_CACHE_MS =
  45 * 1000;

var DEVICE_CACHE_MS =
  60 * 60 * 1000;

var cachedReadings = new Map();

var cachedDevices = new Map();

var cachedAccessToken = null;
var cachedAccessTokenUntil = 0;


// --------------------------------------------------
// General helpers
// --------------------------------------------------

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}

__name(json, "json");


function numberOrNull(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

__name(numberOrNull, "numberOrNull");


function cToF(celsius) {
  return celsius * 9 / 5 + 32;
}

__name(cToF, "cToF");


function isAuthorized(request, env) {
  if (!env.DASHBOARD_API_KEY) {
    return false;
  }

  return (
    request.headers.get(
      "x-dashboard-key"
    ) ===
    env.DASHBOARD_API_KEY
  );
}

__name(isAuthorized, "isAuthorized");


// Senate API
const SENATE_URL = "https://www.dailypress.senate.gov/";

async function getSenateStatus() {
  const response = await fetch(SENATE_URL, {
    headers: { "User-Agent": "davidb.xyz senate-status/1.0" }
  });
  if (!response.ok) throw new Error(`Senate site returned ${response.status}`);

  const text = htmlToText(await response.text());
  const adjourned = /senate (?:stands|has)?\s*adjourned/i.test(text);
  const status = adjourned
    ? "out"
    : /senate convened/i.test(text) ? "in_session" : "unknown";

  let nextSessionText = null;
  const nextSessionPatterns = [
    /the senate returns for business\s+(?:on\s+)?([^.\n]+)/i,
    /except for pro forma sessions,\s*the senate stands adjourned until\s*((?:\d{1,2}:\d{2}\s*(?:AM|PM))\s+on\s+[^.\n]+)/i,
    /the senate (?:stands|has)?\s*adjourned until\s*((?:\d{1,2}:\d{2}\s*(?:AM|PM))\s+on\s+[^.\n]+)/i,
    /will reconvene at\s*([^.\n]+)/i
  ];
  for (const pattern of nextSessionPatterns) {
    const match = text.match(pattern);
    if (match) {
      const candidate = cleanSentence(match[1]);
      if (!/pro forma/i.test(candidate)) { nextSessionText = candidate; break; }
    }
  }

  let nextVoteText = null;
  const votePatterns = [
    /next vote:\s*([^.\n]+)/i,
    /there is one vote that evening at\s*([^.\n]+)/i,
    /at approximately\s+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))[^.]*the senate will vote/i,
    /at\s+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))[^.]*the senate will (?:proceed to )?(?:a |two |three )?roll call vote/i
  ];
  for (const pattern of votePatterns) {
    const match = text.match(pattern);
    if (match) { nextVoteText = cleanSentence(match[1]); break; }
  }

  return {
    status,
    next_vote: nextVoteText,
    next_session: nextSessionText,
    display: {
      headline: status === "in_session" ? "IN SESSION" : status === "out" ? "ADJOURNED" : "STATUS UNKNOWN",
      next_vote: nextVoteText,
      next_session: nextSessionText
    },
    source: "U.S. Senate Daily Press",
    source_url: SENATE_URL,
    checked_at: new Date().toISOString(),
    debug: {
      pro_forma_mentioned: /pro forma session/i.test(text),
      adjourned,
      raw_status: findStatusSentence(text)
    }
  };
}

async function handleSenate() {
  try {
    const response = await fetch(SENATE_URL, {
      headers: {
        "User-Agent": "davidb.xyz senate-status/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Senate site returned ${response.status}`);
    }

    const html = await response.text();
    const text = htmlToText(html);

    const now = new Date();

    // --------------------------------------------------
    // Determine whether this is just a pro forma session
    // --------------------------------------------------

    const proFormaMentioned =
      /pro forma session/i.test(text);

    // --------------------------------------------------
    // Determine whether Senate is adjourned
    // --------------------------------------------------

    const adjourned =
      /senate (?:stands|has)?\s*adjourned/i.test(text) ||
      /senate stands adjourned/i.test(text);

    let status = "unknown";

    if (adjourned) {
      status = "out";
    } else {
      const convened =
        /senate convened/i.test(text);

      if (convened) {
        status = "in_session";
      }
    }

    // --------------------------------------------------
    // Next NON-pro-forma session
    // --------------------------------------------------

    let nextSessionText = null;

    const nextSessionPatterns = [
      /the senate returns for business\s+(?:on\s+)?([^.\n]+)/i,

      /except for pro forma sessions,\s*the senate stands adjourned until\s*((?:\d{1,2}:\d{2}\s*(?:AM|PM))\s+on\s+[^.\n]+)/i,

      /the senate (?:stands|has)?\s*adjourned until\s*((?:\d{1,2}:\d{2}\s*(?:AM|PM))\s+on\s+[^.\n]+)/i,

      /will reconvene at\s*([^.\n]+)/i
    ];

    for (const pattern of nextSessionPatterns) {
      const match = text.match(pattern);

      if (match) {
        const candidate = cleanSentence(match[1]);

        if (!/pro forma/i.test(candidate)) {
          nextSessionText = candidate;
          break;
        }
      }
    }

    // --------------------------------------------------
    // Next vote
    // --------------------------------------------------

    let nextVoteText = null;

    const votePatterns = [
      /next vote:\s*([^.\n]+)/i,

      /there is one vote that evening at\s*([^.\n]+)/i,

      /at approximately\s+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))[^.]*the senate will vote/i,

      /at\s+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))[^.]*the senate will (?:proceed to )?(?:a |two |three )?roll call vote/i
    ];

    for (const pattern of votePatterns) {
      const match = text.match(pattern);

      if (match) {
        nextVoteText = cleanSentence(match[1]);
        break;
      }
    }

    // --------------------------------------------------
    // Current floor status text, useful while testing
    // --------------------------------------------------

    const rawStatus = findStatusSentence(text);

    const display = {
      headline: status === "in_session" ? "IN SESSION" : "ADJOURNED",
      next_vote: nextVoteText || null,
      next_session: nextSessionText || null
    };
    return json({
      status,
      next_vote: nextVoteText,
      next_session: nextSessionText,

      display,

      source: "U.S. Senate Daily Press",
      source_url: SENATE_URL,
      checked_at: now.toISOString(),

      debug: {
        pro_forma_mentioned: proFormaMentioned,
        adjourned,
        raw_status: rawStatus
      }
    });

  } catch (error) {
    return json({
      error: "Unable to retrieve Senate status",
      detail: String(error)
    }, 502);
  }
}

const PNG_WIDTH = 600;
const PNG_HEIGHT = 800;
const FONT = {
  "A":"01110100011000111111100011000110001","B":"11110100011000111110100011000111110","C":"01111100001000010000100001000001111","D":"11110100011000110001100011000111110","E":"11111100001000011110100001000011111","F":"11111100001000011110100001000010000","G":"01111100001000010111100011000101111","H":"10001100011000111111100011000110001","I":"11111001000010000100001000010011111","J":"00111000100001000010100101001001100","K":"10001100101010011000101001001010001","L":"10000100001000010000100001000011111","M":"10001110111010110101100011000110001","N":"10001110011010110011100011000110001","O":"01110100011000110001100011000101110","P":"11110100011000111110100001000010000","Q":"01110100011000110001101011001001101","R":"11110100011000111110101001001010001","S":"01111100001000001110000010000111110","T":"11111001000010000100001000010000100","U":"10001100011000110001100011000101110","V":"10001100011000110001100010101000100","W":"10001100011000110101101011101110001","X":"10001100010101000100010101000110001","Y":"10001100010101000100001000010000100","Z":"11111000010001000100010001000011111",
  "0":"01110100011001110101110011000101110","1":"00100011000010000100001000010001110","2":"01110100010000100010001000100011111","3":"11110000010000101110000010000111110","4":"00010001100101010010111110001000010","5":"11111100001000011110000010000111110","6":"01110100001000011110100011000101110","7":"11111000010001000100010000100001000","8":"01110100011000101110100011000101110","9":"01110100011000101111000010000101110",
  " ":"00000000000000000000000000000000000",".":"00000000000000000000000000010000100",",":"00000000000000000000000000010001000",":":"00000001000000000000001000000000000","-":"00000000000000011111000000000000000","/":"00001000100001000100010001000010000","?":"01110100010000100110001000000000100","'":"00100001000000000000000000000000000"
};

function setPixel(pixels, x, y, value = 0) {
  if (x >= 0 && x < PNG_WIDTH && y >= 0 && y < PNG_HEIGHT) pixels[y * PNG_WIDTH + x] = value;
}

function fillRect(pixels, x, y, width, height, value = 0) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) setPixel(pixels, px, py, value);
  }
}

function drawText(pixels, text, x, y, scale) {
  let cursor = x;
  for (const character of String(text).toUpperCase()) {
    const glyph = FONT[character] || FONT["?"];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row * 5 + col] === "1") fillRect(pixels, cursor + col * scale, y + row * scale, scale, scale);
      }
    }
    cursor += 6 * scale;
  }
}

function wrapText(value, maxCharacters) {
  const words = String(value || "NOT SCHEDULED").toUpperCase().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters) line = candidate;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function scheduleLines(value) {
  if (!value) return ["NOT SCHEDULED"];

  const normalized = String(value)
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const match = normalized.match(
    /^(.*?)(?:\s+AT\s+)(\d{1,2}(?::\d{2})?\s*(?:AM|PM))(?:\b.*)?$/
  );

  if (match) {
    return [
      match[1].replace(/,?\s*$/, ""),
      match[2]
    ];
  }

  return wrapText(normalized, 30).slice(0, 2);
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function senateSvg(data) {
  const session = scheduleLines(data.next_session);
  const vote = scheduleLines(data.next_vote);
  const checked = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(data.checked_at));

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
      <rect width="600" height="800" fill="#ffffff"/>
      <g font-family="Source Sans 3" fill="#111111">
        <text x="48" y="72" font-size="22" font-weight="650" letter-spacing="3">U.S. SENATE</text>
        <line x1="48" y1="96" x2="552" y2="96" stroke="#111111" stroke-width="2"/>

        <text x="300" y="174" text-anchor="middle" font-size="58" font-weight="680" letter-spacing="1">${escapeSvg(data.display.headline)}</text>
        <line x1="48" y1="210" x2="552" y2="210" stroke="#b7b7b7" stroke-width="1"/>

        <text x="48" y="276" font-size="18" font-weight="650" letter-spacing="2.5">NEXT SESSION</text>
        <text x="48" y="327" font-size="31" font-weight="520">${escapeSvg(session[0])}</text>
        <text x="48" y="371" font-size="31" font-weight="650">${escapeSvg(session[1] || "")}</text>

        <line x1="48" y1="420" x2="552" y2="420" stroke="#dedede" stroke-width="1"/>

        <text x="48" y="486" font-size="18" font-weight="650" letter-spacing="2.5">NEXT VOTE</text>
        <text x="48" y="537" font-size="31" font-weight="520">${escapeSvg(vote[0])}</text>
        <text x="48" y="581" font-size="31" font-weight="650">${escapeSvg(vote[1] || "")}</text>

        <line x1="48" y1="700" x2="552" y2="700" stroke="#111111" stroke-width="2"/>
        <text x="48" y="739" font-size="16" font-weight="500" fill="#555555" letter-spacing="1">UPDATED ${escapeSvg(checked.toUpperCase())}</text>
      </g>
    </svg>`;
}

function uint32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = new TextEncoder().encode(type);
  const payload = new Uint8Array(name.length + data.length);
  payload.set(name); payload.set(data, name.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(uint32(data.length), 0); chunk.set(payload, 4); chunk.set(uint32(crc32(payload)), 8 + data.length);
  return chunk;
}

async function encodeGrayscalePng(pixels) {
  const raw = new Uint8Array((PNG_WIDTH + 1) * PNG_HEIGHT);
  for (let y = 0; y < PNG_HEIGHT; y++) {
    raw[y * (PNG_WIDTH + 1)] = 0;
    raw.set(pixels.subarray(y * PNG_WIDTH, (y + 1) * PNG_WIDTH), y * (PNG_WIDTH + 1) + 1);
  }
  const compressed = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))
  ).arrayBuffer());
  const header = new Uint8Array(13);
  header.set(uint32(PNG_WIDTH), 0); header.set(uint32(PNG_HEIGHT), 4); header.set([8, 0, 0, 0, 0], 8);
  const parts = [new Uint8Array([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function rgbaPngToGrayscale(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = png[24];
  const colorType = png[25];

  if (width !== PNG_WIDTH || height !== PNG_HEIGHT || bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Unexpected rendered PNG format: ${width}x${height}, depth ${bitDepth}, color type ${colorType}`);
  }

  const idatChunks = [];
  let idatLength = 0;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      const data = png.subarray(offset + 8, offset + 8 + length);
      idatChunks.push(data);
      idatLength += data.length;
    }
    offset += 12 + length;
  }

  const compressed = new Uint8Array(idatLength);
  let compressedOffset = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }

  const inflated = new Uint8Array(await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))
  ).arrayBuffer());
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const pixels = new Uint8Array(width * height);
  let sourceOffset = 0;
  let previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[sourceOffset++];
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 0) row[x] = raw;
      else if (filter === 1) row[x] = raw + left;
      else if (filter === 2) row[x] = raw + up;
      else if (filter === 3) row[x] = raw + Math.floor((left + up) / 2);
      else if (filter === 4) row[x] = raw + paethPredictor(left, up, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
    }

    for (let x = 0; x < width; x++) {
      const index = x * bytesPerPixel;
      const alpha = colorType === 6 ? row[index + 3] / 255 : 1;
      const luminance = 0.2126 * row[index] + 0.7152 * row[index + 1] + 0.0722 * row[index + 2];
      pixels[y * width + x] = Math.round(luminance * alpha + 255 * (1 - alpha));
    }
    previous = row;
  }

  return pixels;
}

async function handleSenatePng(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  try {
    const data = await getSenateStatus();
    const renderer = await Resvg.async(senateSvg(data), {
      font: {
        fontBuffers: [
          new Uint8Array(sourceSansRegular),
          new Uint8Array(sourceSansSemibold)
        ],
        loadSystemFonts: false,
        defaultFontFamily: "Source Sans 3"
      }
    });
    const renderedPng = renderer.render().asPng();
    const grayscalePixels = await rgbaPngToGrayscale(renderedPng);
    const png = await encodeGrayscalePng(grayscalePixels);
    return new Response(png, { headers: {
      "Content-Type": "image/png", "Content-Length": String(png.length),
      "Cache-Control": "public, max-age=300", "Content-Disposition": "inline; filename=senate.png"
    }});
  } catch (error) {
    return json({ error: "Unable to render Senate image", detail: String(error) }, 502);
  }
}

function htmlToText(html) {
  return html
    // Remove scripts/styles.
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")

    // Convert useful breaks to newlines.
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")

    // Remove all remaining tags.
    .replace(/<[^>]+>/g, " ")

    // Decode common entities.
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

    // Normalize AM/PM before parsing.
    .replace(/\ba\.?\s*m\.?\b/gi, "AM")
    .replace(/\bp\.?\s*m\.?\b/gi, "PM")

    // Normalize whitespace.
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanSentence(value) {
  return value
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+$/g, "")
    .trim();
}


function findStatusSentence(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim());

  return (
    sentences.find(s =>
      /senate stands adjourned/i.test(s) ||
      /senate has adjourned/i.test(s) ||
      /senate convened/i.test(s)
    ) || null
  );
}


// --------------------------------------------------
// YoLink
// --------------------------------------------------

async function getAccessToken(env) {
  const now = Date.now();

  if (
    cachedAccessToken &&
    now < cachedAccessTokenUntil
  ) {
    return cachedAccessToken;
  }

  if (
    !env.YOLINK_UAID ||
    !env.YOLINK_SECRET
  ) {
    throw new Error(
      "YoLink credentials are not configured."
    );
  }

  const body =
    new URLSearchParams({
      grant_type:
        "client_credentials",

      client_id:
        env.YOLINK_UAID,

      client_secret:
        env.YOLINK_SECRET
    });

  const response =
    await fetch(
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
    await response
      .json()
      .catch(() => null);

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

  cachedAccessToken =
    data.access_token;

  const expiresIn =
    numberOrNull(
      data.expires_in
    ) || 3600;

  cachedAccessTokenUntil =
    now +
    Math.max(
      60,
      expiresIn - 60
    ) *
    1000;

  return cachedAccessToken;
}

__name(
  getAccessToken,
  "getAccessToken"
);


async function callYoLink(
  accessToken,
  payload
) {
  const response =
    await fetch(
      YOLINK_API_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${accessToken}`
        },

        body:
          JSON.stringify(payload)
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      `YoLink API returned HTTP ${response.status}`
    );
  }

  if (
    !data ||
    data.code !== "000000"
  ) {
    throw new Error(
      data?.desc ||
      data?.message ||
      `YoLink API error ${data?.code || "unknown"
      }`
    );
  }

  return data;
}

__name(
  callYoLink,
  "callYoLink"
);


async function getTemperatureDevice(
  accessToken,
  deviceId,
  variableName
) {
  const now = Date.now();
  const cached =
    cachedDevices.get(deviceId);

  if (
    cached &&
    now < cached.until
  ) {
    return cached.device;
  }

  if (!deviceId) {
    throw new Error(
      `${variableName} is not configured.`
    );
  }

  const result =
    await callYoLink(
      accessToken,
      {
        method:
          "Home.getDeviceList",

        time:
          Date.now()
      }
    );

  const devices =
    Array.isArray(
      result.data?.devices
    )
      ? result.data.devices
      : [];

  const device =
    devices.find(
      item =>
        item.deviceId ===
        deviceId
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

  cachedDevices.set(
    deviceId,
    {
      device,
      until:
        now +
        DEVICE_CACHE_MS
    }
  );

  return device;
}

__name(
  getTemperatureDevice,
  "getTemperatureDevice"
);


async function getTemperature(
  env,
  deviceId =
    env.YOLINK_TEMPERATURE_DEVICE_ID,
  variableName =
    "YOLINK_TEMPERATURE_DEVICE_ID"
) {
  const now = Date.now();
  const cached =
    cachedReadings.get(deviceId);

  if (
    cached &&
    now < cached.until
  ) {
    return cached.reading;
  }

  const accessToken =
    await getAccessToken(env);

  const device =
    await getTemperatureDevice(
      accessToken,
      deviceId,
      variableName
    );

  const result =
    await callYoLink(
      accessToken,
      {
        method:
          "THSensor.getState",

        time:
          Date.now(),

        targetDevice:
          device.deviceId,

        token:
          device.token,

        params: {}
      }
    );

  const state =
    result.data?.state;

  const temperatureC =
    numberOrNull(
      state?.temperature
    );

  if (temperatureC == null) {
    throw new Error(
      "YoLink sensor response did not contain a temperature."
    );
  }

  const humidity =
    numberOrNull(
      state?.humidity
    );

  const battery =
    numberOrNull(
      state?.battery
    );

  const reading = {
    ok: true,

    temperature_c:
      Math.round(
        temperatureC * 10
      ) / 10,

    temperature_f:
      Math.round(
        cToF(
          temperatureC
        ) * 10
      ) / 10,

    humidity,

    battery,

    online:
      result.data?.online ??
      null,

    reported_at:
      result.data?.reportAt ??
      null,

    device: {
      id:
        device.deviceId,

      name:
        device.name ??
        null,

      model:
        device.modelName ??
        null,

      type:
        device.type ??
        null
    }
  };

  cachedReadings.set(
    deviceId,
    {
      reading,
      until:
        now +
        READING_CACHE_MS
    }
  );

  return reading;
}

__name(
  getTemperature,
  "getTemperature"
);



// --------------------------------------------------
// Cloudflare Access -> family-home
// --------------------------------------------------

function homeHeaders(env) {
  if (
    !env.CF_ACCESS_CLIENT_ID ||
    !env.CF_ACCESS_CLIENT_SECRET
  ) {
    throw new Error(
      "Cloudflare Access service-token secrets are not configured."
    );
  }

  return {
    "CF-Access-Client-Id":
      env.CF_ACCESS_CLIENT_ID,

    "CF-Access-Client-Secret":
      env.CF_ACCESS_CLIENT_SECRET,

    Accept:
      "application/json"
  };
}


async function fetchHomeJson(path, env) {
  const response = await fetch(
    HOME_BASE_URL + path,
    {
      headers: homeHeaders(env),
      redirect: "manual",
      cf: {
        cacheTtl: 0
      }
    }
  );

  const contentType =
    response.headers.get("content-type") || "";

  const raw =
    await response.text();

  console.log(
    "HOME FETCH",
    path,
    "status:",
    response.status,
    "content-type:",
    contentType,
    "body:",
    raw.slice(0, 500)
  );

  let data = null;

  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      `Home API ${path} returned HTTP ${response.status}: ${raw.slice(0, 150)}`
    );
  }

  if (!data) {
    throw new Error(
      `Home API ${path} returned non-JSON: ${raw.slice(0, 150)}`
    );
  }

  if (data.ok === false) {
    throw new Error(
      data.error ||
      `Home API ${path} returned an error`
    );
  }

  if (data.ok !== true) {
    throw new Error(
      `Home API ${path} missing ok=true. Body: ${raw.slice(0, 150)}`
    );
  }

  return data;
}


// --------------------------------------------------
// Date helpers
// --------------------------------------------------

function partsForDate(date) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TIME_ZONE,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        weekday:
          "long"
      }
    );

  const values =
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(
          part =>
            part.type !==
            "literal"
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return {
    year:
      Number(values.year),

    month:
      Number(values.month),

    day:
      Number(values.day),

    weekday:
      values.weekday
  };
}


function dateKeyFromParts(parts) {
  return (
    `${parts.year}-` +
    `${String(parts.month)
      .padStart(2, "0")}-` +
    `${String(parts.day)
      .padStart(2, "0")}`
  );
}


function addCalendarDays(
  date,
  days
) {
  return new Date(
    date.getTime() +
    days *
    86400000
  );
}


function sundayWeekKey(date) {
  const p =
    partsForDate(date);

  const temp =
    new Date(
      Date.UTC(
        p.year,
        p.month - 1,
        p.day
      )
    );

  const sunday =
    new Date(
      temp.getTime() -
      temp.getUTCDay() *
      86400000
    );

  return (
    `${sunday.getUTCFullYear()}-` +
    `${String(
      sunday.getUTCMonth() + 1
    ).padStart(2, "0")}-` +
    `${String(
      sunday.getUTCDate()
    ).padStart(2, "0")}`
  );
}


const DAY_KEYS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat"
];


function dayKeyForDate(date) {
  const p =
    partsForDate(date);

  const utc =
    new Date(
      Date.UTC(
        p.year,
        p.month - 1,
        p.day
      )
    );

  return DAY_KEYS[
    utc.getUTCDay()
  ];
}


// --------------------------------------------------
// Menu helpers
// --------------------------------------------------

function dinnerFromMenu(
  menu,
  date
) {
  if (
    !menu ||
    typeof menu !==
    "object"
  ) {
    return "";
  }

  const dayKey =
    dayKeyForDate(date);

  const entries =
    Array.isArray(
      menu[dayKey]
    )
      ? menu[dayKey]
      : [];

  const meal =
    entries.find(
      entry =>
        entry &&
        entry.type !== "note" &&
        String(
          entry.title || ""
        ).trim()
    );

  return meal
    ? String(
      meal.title
    ).trim()
    : "";
}


// --------------------------------------------------
// Calendar helpers
// --------------------------------------------------

function eventDateKey(event) {
  if (!event?.start) {
    return null;
  }

  if (event.all_day) {
    return String(
      event.start
    ).slice(0, 10);
  }

  return dateKeyFromParts(
    partsForDate(
      new Date(
        event.start
      )
    )
  );
}


function formatEventTime(event) {
  if (event.all_day) {
    return "All day";
  }

  const start =
    new Date(event.start);

  const end =
    event.end
      ? new Date(event.end)
      : null;

  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TIME_ZONE,

        hour:
          "numeric",

        minute:
          "2-digit"
      }
    );

  const startText =
    formatter.format(start);

  if (!end) {
    return startText;
  }

  const endText =
    formatter.format(end);

  return (
    `${startText} - ` +
    `${endText}`
  );
}


function compactTime(text) {
  return String(text)
    .replaceAll(":00", "")
    .replaceAll(" AM", "")
    .replaceAll(" PM", "")
    .replaceAll("AM", "")
    .replaceAll("PM", "");
}


function formatEvent(event) {
  const title =
    String(
      event?.title ||
      "Untitled event"
    ).trim();

  if (event.all_day) {
    return title;
  }

  return (
    `${compactTime(
      formatEventTime(event)
    )}: ${title}`
  );
}


// --------------------------------------------------
// E-paper endpoint
// --------------------------------------------------

async function handleEpaper(
  request,
  env
) {
  if (request.method !== "GET") {
    return new Response(
      "Method not allowed",
      {
        status: 405,
        headers: {
          Allow: "GET"
        }
      }
    );
  }

  try {
    const now =
      new Date();

    const currentWeek =
      sundayWeekKey(now);

    const nextWeek =
      sundayWeekKey(
        addCalendarDays(
          now,
          7
        )
      );

    const [
      weather,
      calendar,
      currentMenu,
      nextMenu,
      indoor
    ] =
      await Promise.all([
        fetchHomeJson(
          "/api/weather-card",
          env
        ),

        fetchHomeJson(
          "/api/calendar",
          env
        ),

        fetchHomeJson(
          `/api/menu?week=${encodeURIComponent(
            currentWeek
          )}`,
          env
        ),

        fetchHomeJson(
          `/api/menu?week=${encodeURIComponent(
            nextWeek
          )}`,
          env
        ),

        getTemperature(
          env,
          env.YOLINK_INDOOR_DEVICE_ID,
          "YOLINK_INDOOR_DEVICE_ID"
        )
      ]);

    const events =
      Array.isArray(
        calendar.events
      )
        ? calendar.events
        : [];

    const days = [];

    /*
       Give the ESP32 five candidate
       days. The display itself can
       stop drawing when it runs out
       of vertical room.
    */
    for (
      let i = 0;
      i < 5;
      i++
    ) {
      const date =
        addCalendarDays(
          now,
          i
        );

      const p =
        partsForDate(date);

      const dateKey =
        dateKeyFromParts(p);

      const weekKey =
        sundayWeekKey(date);

      const menu =
        weekKey ===
          currentWeek
          ? currentMenu.menu
          : nextMenu.menu;

      const dinner =
        dinnerFromMenu(
          menu,
          date
        );

      const dayEvents =
        events
          .filter(
            event =>
              eventDateKey(
                event
              ) ===
              dateKey
          )
          .sort(
            (a, b) =>
              new Date(
                a.start
              ) -
              new Date(
                b.start
              )
          )
          .map(
            formatEvent
          );

      days.push({
        day:
          p.weekday,

        date:
          String(p.day),

        dinner,

        events:
          dayEvents
      });
    }

    return json({
      ok: true,

      generated_at:
        new Date()
          .toISOString(),

      weather: {
        current_f:
          numberOrNull(
            weather.current
              ?.temperature_f
          ),

        code:
          numberOrNull(
            weather.forecast
              ?.weather_code
          ),

        today_high_f:
          numberOrNull(
            weather.forecast
              ?.today
              ?.high_f
          ),

        today_low_f:
          numberOrNull(
            weather.forecast
              ?.today
              ?.low_f
          ),

        tomorrow_high_f:
          numberOrNull(
            weather.forecast
              ?.tomorrow
              ?.high_f
          ),

        tomorrow_low_f:
          numberOrNull(
            weather.forecast
              ?.tomorrow
              ?.low_f
          )
      },

      indoor: {
        temperature_f:
          indoor.temperature_f,

        humidity:
          indoor.humidity
      },

      days
    });
  } catch (error) {
    console.error(
      "E-paper API error:",
      error
    );

    return json(
      {
        ok: false,

        error:
          error?.message ||
          "E-paper data unavailable."
      },
      502
    );
  }
}


// --------------------------------------------------
// Worker
// --------------------------------------------------

var index_default = {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "GET" &&
      url.pathname === "/"
    ) {
      return json({
        ok: true,
        service:
          "DavidB API"
      });
    }

    if (url.pathname === "/senate") {
      return handleSenate();
    }

    if (
      url.pathname === "/kindle/senate.png" ||
      url.pathname === "/senate.png"
    ) {
      return handleSenatePng(request);
    }

    // New real e-paper route
    if (
      url.pathname ===
      "/epaper"
    ) {
      return handleEpaper(
        request,
        env
      );
    }

    if (
      request.method ===
      "GET" &&
      url.pathname ===
      "/yolink/temperature"
    ) {
      if (
        !isAuthorized(
          request,
          env
        )
      ) {
        return json(
          {
            ok: false,
            error:
              "Unauthorized"
          },
          401
        );
      }

      try {
        const data =
          await getTemperature(
            env
          );

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
        error:
          "Not found"
      },
      404
    );
  }
};

export {
  index_default as default
};
