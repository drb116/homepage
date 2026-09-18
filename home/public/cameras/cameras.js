const CAMERA_BASE_URL = "http://192.168.1.119";
const CAMERA_STORAGE_KEY = "familyHome.reolink.credentials.v1";
const CAMERA_CHANNELS = [1, 8, 9, 2, 0, 6, 3, 5, 7];
const ROTATE_REFRESH_MS = 1_000;

let cameraCredentials = null;
let refreshTimer = null;
let nextChannelIndex = 0;

const $ = selector => document.querySelector(selector);

function readCameraCredentials() {
  try {
    const value = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value);
    if (!parsed?.user || !parsed?.password) return null;
    return { user: String(parsed.user), password: String(parsed.password) };
  } catch (error) {
    console.warn("Could not read local camera credentials:", error);
    return null;
  }
}

function saveCameraCredentials(user, password) {
  const credentials = { user: String(user).trim(), password: String(password) };
  localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(credentials));
  cameraCredentials = credentials;
}

function snapshotUrl(channel) {
  if (!cameraCredentials) return "";
  const url = new URL("/cgi-bin/api.cgi", CAMERA_BASE_URL);
  url.searchParams.set("cmd", "Snap");
  url.searchParams.set("channel", String(channel));
  url.searchParams.set("rs", String(Date.now()));
  url.searchParams.set("user", cameraCredentials.user);
  url.searchParams.set("password", cameraCredentials.password);
  return url.toString();
}

function tileForChannel(channel) {
  return document.querySelector(`.camera-tile[data-channel="${channel}"]`);
}

function refreshChannel(channel) {
  const tile = tileForChannel(channel);
  const image = tile?.querySelector("img");
  if (!tile || !image || !cameraCredentials) return;

  const probe = new Image();
  probe.onload = () => {
    image.src = probe.src;
    tile.classList.remove("error");
  };
  probe.onerror = () => {
    tile.classList.add("error");
  };
  probe.src = snapshotUrl(channel);
}

function loadInitialWall() {
  CAMERA_CHANNELS.forEach(channel => refreshChannel(channel));
}

function refreshNextChannel() {
  if (document.hidden || !cameraCredentials) return;
  const channel = CAMERA_CHANNELS[nextChannelIndex];
  refreshChannel(channel);
  nextChannelIndex = (nextChannelIndex + 1) % CAMERA_CHANNELS.length;
  const status = $("#camera-wall-status");
  if (status) status.textContent = `Local network • refreshing Camera ${channel} • each camera every 9 seconds`;
}

function startRotation() {
  stopRotation();
  if (!cameraCredentials || document.hidden) return;
  refreshTimer = window.setInterval(refreshNextChannel, ROTATE_REFRESH_MS);
}

function stopRotation() {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function openCameraSetup() {
  const dialog = $("#camera-setup-dialog");
  const username = $("#camera-username");
  const password = $("#camera-password");
  if (!dialog || !username || !password) return;
  const existing = readCameraCredentials();
  username.value = existing?.user || "familyHome";
  password.value = existing?.password || "";
  dialog.showModal();
}

function closeCameraSetup() {
  const dialog = $("#camera-setup-dialog");
  if (dialog?.open) dialog.close();
}

function handleSetupSubmit(event) {
  event.preventDefault();
  const username = $("#camera-username")?.value.trim();
  const password = $("#camera-password")?.value ?? "";
  if (!username || !password) return;
  saveCameraCredentials(username, password);
  closeCameraSetup();
  loadInitialWall();
  startRotation();
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    console.warn("Fullscreen request was not available:", error);
  }
}

function initCameraWall() {
  cameraCredentials = readCameraCredentials();
  $("#btn-camera-setup")?.addEventListener("click", openCameraSetup);
  $("#btn-camera-cancel")?.addEventListener("click", closeCameraSetup);
  $("#camera-setup-form")?.addEventListener("submit", handleSetupSubmit);
  $("#btn-fullscreen")?.addEventListener("click", toggleFullscreen);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRotation();
    } else if (cameraCredentials) {
      refreshNextChannel();
      startRotation();
    }
  });

  if (!cameraCredentials) {
    const status = $("#camera-wall-status");
    if (status) status.textContent = "Camera setup required";
    window.setTimeout(openCameraSetup, 0);
    return;
  }

  loadInitialWall();
  startRotation();
}

initCameraWall();
