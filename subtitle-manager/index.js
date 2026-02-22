/* global iina */

// Subtitle Manager plugin backend.
//
// This file runs in IINA's plugin JS runtime (not in the WebView).

const {
  core,
  sidebar,
  standaloneWindow,
  menu,
  preferences,
  event,
  mpv,
  utils,
  file,
  console,
} = iina;

// When IINA reloads plugins, it may re-run the entry script in the same JS context.
// Keep initialization idempotent by cleaning up timers/listeners from the previous run.
const GLOBAL_KEY = "__iina_subtitle_manager_backend";
try {
  const prev = globalThis[GLOBAL_KEY];
  if (prev && typeof prev.cleanup === "function") prev.cleanup();
} catch (_err) {
  // ignore
}
const self = { cleanup: null };
try {
  globalThis[GLOBAL_KEY] = self;
} catch (_err) {
  // ignore
}
try {
  if (typeof menu.removeAllItems === "function") menu.removeAllItems();
} catch (_err) {
  // ignore
}

const UI_FILE = "ui/index.html";
const PLUGIN_VERSION = "1.0.0";

// Debug flag (development only).
// When true, additional diagnostics are exposed in the plugin menu.
const DEBUG = false;

// Legacy config file (kept for migration and for IINA builds without iina.preferences).
const LEGACY_CONFIG_FILE = "@data/iina-subtitle-manager-config.json";

function loadLegacyConfig() {
  const defaults = { showOsd: true, autoHideWindowInFullscreen: true };
  try {
    if (!file.exists(LEGACY_CONFIG_FILE)) return { ...defaults, _fromDisk: false };
    const raw = file.read(LEGACY_CONFIG_FILE);
    const obj = JSON.parse(String(raw ?? "{}"));
    return { ...defaults, ...(obj && typeof obj === "object" ? obj : null), _fromDisk: true };
  } catch (_err) {
    return { ...defaults, _fromDisk: false };
  }
}

function saveLegacyConfig(next) {
  try {
    file.write(
      LEGACY_CONFIG_FILE,
      JSON.stringify(
        {
          showOsd: !!next.showOsd,
          autoHideWindowInFullscreen: !!next.autoHideWindowInFullscreen,
        },
        null,
        2,
      ),
    );
    return true;
  } catch (err) {
    console.error(`Failed to write legacy config: ${err?.toString?.() ?? err}`);
    return false;
  }
}

const hasPreferences =
  preferences && typeof preferences.get === "function" && typeof preferences.set === "function";

function prefGet(key, fallback) {
  if (!hasPreferences) return fallback;
  try {
    const v = preferences.get(key);
    return v == null ? fallback : v;
  } catch (_err) {
    return fallback;
  }
}

function prefSet(key, value) {
  if (!hasPreferences) return false;
  try {
    preferences.set(key, value);
    if (typeof preferences.sync === "function") preferences.sync();
    return true;
  } catch (_err) {
    return false;
  }
}

function normalizeKeyBinding(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function keyBindingOpt(v) {
  const kb = normalizeKeyBinding(v);
  return kb ? { keyBinding: kb } : {};
}

const legacy = loadLegacyConfig();

// Migrate legacy showOsd -> preferences if preferences exist and preference not set.
if (hasPreferences) {
  try {
    const current = preferences.get("show_osd");
    if (current == null && legacy && legacy._fromDisk) {
      prefSet("show_osd", !!legacy.showOsd);
    }
  } catch (_err) {
    // ignore
  }
  try {
    const current = preferences.get("auto_hide_window_fullscreen");
    if (current == null && legacy && legacy._fromDisk) {
      prefSet("auto_hide_window_fullscreen", !!legacy.autoHideWindowInFullscreen);
    }
  } catch (_err) {
    // ignore
  }
}

const config = {
  showOsd: !!prefGet("show_osd", !!legacy.showOsd),
  autoHideWindowInFullscreen: !!prefGet(
    "auto_hide_window_fullscreen",
    !!legacy.autoHideWindowInFullscreen,
  ),
};

function osdInfo(message) {
  if (!config.showOsd) return;
  try {
    core.osd(String(message ?? ""));
  } catch (_err) {
    // ignore
  }
}

function osdError(message) {
  // Errors are always surfaced.
  try {
    core.osd(String(message ?? ""));
  } catch (_err) {
    // ignore
  }
}

// Sidebar reload helpers.
let nextPingId = 1;
const sidebarPingWaiters = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let sidebarMessagingInstalled = false;

function handleSidebarPong({ id } = {}) {
  if (id == null) return;
  const resolve = sidebarPingWaiters.get(id);
  if (!resolve) return;
  sidebarPingWaiters.delete(id);
  resolve(true);
}

function pingSidebar(timeoutMs = 250) {
  const id = nextPingId++;
  return new Promise((resolve) => {
    sidebarPingWaiters.set(id, resolve);
    try {
      sidebar.postMessage("smPing", { id, version: PLUGIN_VERSION });
    } catch (_err) {
      sidebarPingWaiters.delete(id);
      resolve(false);
      return;
    }
    setTimeout(() => {
      const r = sidebarPingWaiters.get(id);
      if (!r) return;
      sidebarPingWaiters.delete(id);
      resolve(false);
    }, timeoutMs);
  });
}

standaloneWindow.loadFile(UI_FILE);
standaloneWindow.setProperty({
  title: "Subtitle Manager",
  resizable: true,
  hudWindow: false,
  fullSizeContentView: false,
  hideTitleBar: false,
});
standaloneWindow.setFrame(900, 600);

let sidebarLoaded = false;
let sidebarLoadAttempts = 0;
let sidebarLoadTimer = null;
let initialSidebarLoadTimer = null;

const eventHandlers = [];

function installSidebarMessaging() {
  // Important: register handlers after loadFile() so we don't lose them if the sidebar view
  // is created lazily by IINA.
  try {
    sidebar.onMessage("smPong", handleSidebarPong);
  } catch (err) {
    console.error(`sidebar.onMessage(smPong) failed: ${err?.toString?.() ?? err}`);
    return false;
  }

  try {
    const rpc = createRpcEndpoint(sidebar);
    registerRpc(rpc, sidebar, "sidebar");
    sidebarMessagingInstalled = true;
    return true;
  } catch (err) {
    console.error(`installSidebarMessaging failed: ${err?.toString?.() ?? err}`);
    sidebarMessagingInstalled = false;
    return false;
  }
}

function ensureSidebarLoaded({ force = false } = {}) {
  if (sidebarLoaded && sidebarMessagingInstalled && !force) return true;
  if (sidebarLoaded && !force) {
    // Sidebar webview may already exist; attempt to (re)install messaging.
    return installSidebarMessaging();
  }
  try {
    sidebar.loadFile(UI_FILE);
    sidebarLoaded = true;
    return installSidebarMessaging();
  } catch (err) {
    // The sidebar view may not be ready yet (e.g. when enabling the plugin at runtime).
    console.error(`sidebar.loadFile failed: ${err?.toString?.() ?? err}`);
    return false;
  }
}

function scheduleSidebarLoadRetry() {
  if (sidebarLoaded && sidebarMessagingInstalled) return;
  if (sidebarLoadTimer) return;

  // Keep retrying with backoff. On some IINA versions, the sidebar view is created lazily
  // and may not be ready at plugin init time.
  const delay = Math.min(5000, Math.round(250 * Math.pow(1.6, sidebarLoadAttempts)));
  sidebarLoadTimer = setTimeout(() => {
    sidebarLoadTimer = null;
    sidebarLoadAttempts++;
    if (!ensureSidebarLoaded()) scheduleSidebarLoadRetry();
  }, delay);
}

async function reloadSidebar() {
  // Ensure the sidebar view exists (and therefore messaging can be registered).
  try {
    sidebar.show();
  } catch (_err) {
    // ignore
  }

  // Best-effort: if an existing sidebar UI is alive, ask it to hard-reload itself
  // (uses a cache-busting URL so we don't rely on sidebar.loadFile supporting query strings).
  ensureSidebarLoaded();
  const alive = await pingSidebar(250);
  if (alive) {
    try {
      sidebar.postMessage("smReload", { token: Date.now(), version: PLUGIN_VERSION });
    } catch (err) {
      console.error(`sidebar.postMessage(smReload) failed: ${err?.toString?.() ?? err}`);
    }

    for (let i = 0; i < 8; i++) {
      await sleep(150);
      if (await pingSidebar(250)) {
        osdInfo("Subtitle Manager sidebar reloaded");
        return true;
      }
    }
  }

  // Fallback: reload via loadFile.
  sidebarLoaded = false;
  sidebarMessagingInstalled = false;
  sidebarLoadAttempts = 0;
  if (!ensureSidebarLoaded({ force: true })) {
    osdInfo("Subtitle Manager sidebar is not ready yet");
    scheduleSidebarLoadRetry();
    return false;
  }

  // Allow a moment for the WebView to come up.
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    if (await pingSidebar(250)) break;
  }

  osdInfo("Subtitle Manager sidebar reloaded");
  return true;
}

let windowWanted = false;
// Manual override: when true, keep the standalone window visible even while auto-hide would normally
// close it during fullscreen playback. This is toggled by the user explicitly.
let windowForceVisible = false;
let autoWindowInFullscreen = !!config.autoHideWindowInFullscreen;
let nextWillCloseToken = 1;
let lastProgrammaticCloseAt = 0;
let lastWindowAliveAt = 0;
let windowHeartbeatEver = false;
let windowSeenVisibleEver = false;
let lastWindowVisibilityState = "unknown";
let windowAliveTimer = null;

function isPaused() {
  return safeGetFlag("pause");
}

function isFullscreen() {
  try {
    return !!core.window.fullscreen;
  } catch (_err) {
    return false;
  }
}

function shouldAutoHideWindowNow() {
  return !!(autoWindowInFullscreen && isFullscreen() && !isPaused());
}

function resetWindowLivenessState() {
  // Reset liveness state for the new window session. We only start "user closed" inference
  // after we've seen at least one heartbeat from the WebView.
  windowHeartbeatEver = false;
  windowSeenVisibleEver = false;
  lastWindowVisibilityState = "unknown";
  lastWindowAliveAt = 0;
}

function openWindow({ forceVisible = false } = {}) {
  windowWanted = true;
  if (forceVisible) windowForceVisible = true;
  // Avoid flicker: if auto-hide is enabled and we're fullscreen+playing, the window is expected
  // to be closed. Mark it wanted but don't open it until pause.
  if (shouldAutoHideWindowNow() && !windowForceVisible) return;
  resetWindowLivenessState();
  try {
    standaloneWindow.open();
  } catch (err) {
    console.error(`standaloneWindow.open failed: ${err?.toString?.() ?? err}`);
  }
}

function toggleWindow() {
  // In fullscreen playback with auto-hide enabled, the window may be "wanted" but currently closed.
  // In that state, toggle acts as a manual show/hide override rather than disabling windowWanted.
  if (windowWanted && shouldAutoHideWindowNow()) {
    if (windowForceVisible) {
      windowForceVisible = false;
      updateWindowVisibility(); // will close programmatically if needed
    } else {
      openWindow({ forceVisible: true });
    }
    return;
  }

  if (windowWanted) {
    windowWanted = false;
    windowForceVisible = false;
    closeWindow({ programmatic: false });
    return;
  }

  // If the user explicitly opens the window during fullscreen playback, treat it as a manual override.
  openWindow({ forceVisible: shouldAutoHideWindowNow() });
  updateWindowVisibility();
}

let sidebarWanted = false;
function showSidebar() {
  sidebarWanted = true;
  if (!ensureSidebarLoaded()) scheduleSidebarLoadRetry();
  try {
    sidebar.show();
  } catch (_err) {
    // ignore
  }
}

function hideSidebar() {
  sidebarWanted = false;
  try {
    if (typeof sidebar.hide === "function") sidebar.hide();
    else if (typeof sidebar.close === "function") sidebar.close();
    else if (typeof sidebar.dismiss === "function") sidebar.dismiss();
  } catch (_err) {
    // ignore
  }
}

function toggleSidebar() {
  if (sidebarWanted) hideSidebar();
  else showSidebar();
}

function closeWindow({ programmatic = false } = {}) {
  // If we are closing due to auto-hide (fullscreen + playing), notify the UI so it
  // doesn't treat the unload/hide as a user intent to "stop wanting" the window.
  if (programmatic) {
    lastProgrammaticCloseAt = Date.now();
    try {
      standaloneWindow.postMessage("smWillClose", { token: nextWillCloseToken++ });
    } catch (_err) {
      // ignore
    }
  }
  try {
    standaloneWindow.close();
  } catch (err) {
    console.error(`standaloneWindow.close failed: ${err?.toString?.() ?? err}`);
  }
}

function updateWindowVisibility() {
  if (!windowWanted) return;
  if (!autoWindowInFullscreen) return;
  if (!isFullscreen()) return;

  if (isPaused()) openWindow();
  else if (!windowForceVisible) closeWindow({ programmatic: true });
}

menu.addItem(
  menu.item(
    "Show Subtitle Manager Window",
    () => {
      toggleWindow();
    },
    keyBindingOpt(prefGet("shortcut_show_window", "Meta+Alt+e")),
  ),
);
menu.addItem(
  menu.item(
    "Show Subtitle Manager Sidebar",
    () => {
      toggleSidebar();
    },
    keyBindingOpt(prefGet("shortcut_show_sidebar", "Meta+Alt+s")),
  ),
);
menu.addItem(
  menu.item(
    "Copy Current Subtitle (Timestamped)",
    () => {
      void copyCurrentSubtitleAuto();
    },
    keyBindingOpt(prefGet("shortcut_copy_current", "Meta+Alt+c")),
  ),
);

menu.addItem(menu.separator());
menu.addItem(
  menu.item("Reload Subtitle Manager Sidebar", () => {
    try {
      sidebar.show();
    } catch (_err) {
      // ignore
    }
    void reloadSidebar();
  }),
);
const autoHideWindowMenuItem = menu.item(
  "Auto-hide Window in Fullscreen",
  () => {
    autoWindowInFullscreen = !autoWindowInFullscreen;
    autoHideWindowMenuItem.selected = autoWindowInFullscreen;
    if (typeof menu.forceUpdate === "function") menu.forceUpdate();
    config.autoHideWindowInFullscreen = !!autoWindowInFullscreen;
    if (!prefSet("auto_hide_window_fullscreen", !!config.autoHideWindowInFullscreen)) {
      saveLegacyConfig(config);
    }
    osdInfo(`Auto-hide window in fullscreen: ${autoWindowInFullscreen ? "On" : "Off"}`);
    if (!autoWindowInFullscreen) windowForceVisible = false;
    updateWindowVisibility();
  },
  { selected: autoWindowInFullscreen },
);
menu.addItem(autoHideWindowMenuItem);

const showOsdMenuItem = menu.item(
  "Show Subtitle Manager OSD",
  () => {
    config.showOsd = !config.showOsd;
    showOsdMenuItem.selected = !!config.showOsd;
    if (typeof menu.forceUpdate === "function") menu.forceUpdate();
    if (!prefSet("show_osd", !!config.showOsd)) {
      saveLegacyConfig(config);
    }
    // Always show feedback for the toggle itself.
    core.osd(`Subtitle Manager OSD: ${config.showOsd ? "On" : "Off"}`);
  },
  { selected: !!config.showOsd },
);
menu.addItem(showOsdMenuItem);

if (DEBUG) {
  menu.addItem(
    menu.item("Clipboard Copy Test", () => {
      void (async () => {
        const payload = `Subtitle Manager clipboard test ${new Date().toISOString()}`;
        const res = await copyToClipboard(payload);
        if (res.ok) {
          core.osd(`Clipboard test copied (${res.method})`);
        } else {
          const msg = String(res.error ?? "unknown error");
          core.osd(`Clipboard test failed: ${msg.slice(0, 120)}`);
        }
      })();
    }),
  );
}

eventHandlers.push({
  name: "iina.window-loaded",
  id: event.on("iina.window-loaded", () => {
  // Defer the initial sidebar load to avoid races if this handler is invoked
  // synchronously when registering listeners (depending on IINA version).
  setTimeout(() => {
    if (!ensureSidebarLoaded()) scheduleSidebarLoadRetry();
  }, 0);
  updateWindowVisibility();
  }),
});

eventHandlers.push({
  name: "mpv.pause.changed",
  id: event.on("mpv.pause.changed", () => {
  updateWindowVisibility();
  }),
});

eventHandlers.push({
  name: "iina.window-fs.changed",
  id: event.on("iina.window-fs.changed", () => {
  updateWindowVisibility();
  }),
});

// Best-effort: if the main window was already loaded before this plugin initialized,
// try loading the sidebar view on the next tick.
initialSidebarLoadTimer = setTimeout(() => {
  if (!ensureSidebarLoaded()) scheduleSidebarLoadRetry();
}, 0);

self.cleanup = () => {
  try {
    if (sidebarLoadTimer) clearTimeout(sidebarLoadTimer);
  } catch (_err) {
    // ignore
  }
  try {
    if (initialSidebarLoadTimer) clearTimeout(initialSidebarLoadTimer);
  } catch (_err) {
    // ignore
  }

  try {
    sidebar.onMessage("rpc", null);
    sidebar.onMessage("smPong", null);
    sidebar.onMessage("error", null);
  } catch (_err) {
    // ignore
  }
  try {
    standaloneWindow.onMessage("rpc", null);
    standaloneWindow.onMessage("error", null);
    standaloneWindow.onMessage("smWindowClosed", null);
    standaloneWindow.onMessage("smWindowAlive", null);
  } catch (_err) {
    // ignore
  }

  for (const h of eventHandlers) {
    try {
      if (h && h.name && h.id) event.off(h.name, h.id);
    } catch (_err) {
      // ignore
    }
  }

  try {
    if (typeof menu.removeAllItems === "function") menu.removeAllItems();
  } catch (_err) {
    // ignore
  }

  try {
    standaloneWindow.close();
  } catch (_err) {
    // ignore
  }

  try {
    if (windowAliveTimer) clearInterval(windowAliveTimer);
  } catch (_err) {
    // ignore
  }
  windowAliveTimer = null;

  try {
    sidebarPingWaiters.clear();
  } catch (_err) {
    // ignore
  }
  sidebarMessagingInstalled = false;
};

function createRpcEndpoint(view) {
  const methods = Object.create(null);
  view.onMessage("rpc", async (msg = {}) => {
    const id = msg.id;
    const method = msg.method;
    const args = msg.args;
    if (id == null || typeof method !== "string") return;

    let res;
    try {
      const fn = methods[method];
      if (typeof fn !== "function") {
        res = { error: `Unknown method: ${method}` };
      } else {
        res = fn.apply(null, Array.isArray(args) ? args : []);
        if (res instanceof Promise) res = await res;
      }
    } catch (err) {
      console.error(`RPC error in ${method}: ${err?.toString?.() ?? err}`);
      res = { error: err?.toString?.() ?? String(err) };
    }

    view.postMessage("rpcResult", { id, res });
  });
  return methods;
}

const windowRpc = createRpcEndpoint(standaloneWindow);

registerRpc(windowRpc, standaloneWindow, "window");

// If the user closes the standalone window via the red "X", stop auto-reopening it.
standaloneWindow.onMessage("smWindowClosed", () => {
  // Guard: if this is an auto-hide close (fullscreen + playing), ignore it.
  // (User closes happen while the window is visible, i.e. paused.)
  if (autoWindowInFullscreen && isFullscreen() && !isPaused()) return;

  // Backup guard: if an auto-hide close just happened, ignore close signals that may arrive late.
  if (Date.now() - lastProgrammaticCloseAt < 600) return;
  windowWanted = false;
  windowForceVisible = false;
});

// Heartbeat from the window WebView. This is more reliable than unload/pagehide in some IINA builds.
standaloneWindow.onMessage("smWindowAlive", (msg = {}) => {
  windowHeartbeatEver = true;
  lastWindowAliveAt = Date.now();
  const vs = typeof msg.visibilityState === "string" ? msg.visibilityState : "unknown";
  if (vs) lastWindowVisibilityState = vs;
  if (vs === "visible") windowSeenVisibleEver = true;
});

// Start monitoring immediately; it stays idle until the window is wanted and a heartbeat is observed.
startWindowAliveMonitor();

function startWindowAliveMonitor() {
  if (windowAliveTimer) return;
  windowAliveTimer = setInterval(() => {
    if (!windowWanted) return;

    // When auto-hide is enabled and we're in fullscreen playing, the window is expected to be closed.
    if (autoWindowInFullscreen && isFullscreen() && !isPaused()) return;

    const now = Date.now();
    if (!windowHeartbeatEver || !lastWindowAliveAt) return;

    // Guard: if we very recently closed programmatically, don't treat the missing heartbeats as a user-close.
    if (now - lastProgrammaticCloseAt < 2000) return;

    // If the WebView is still alive but reports hidden while we expect the window visible,
    // treat it as a user close (red X often hides without unloading).
    if (windowSeenVisibleEver && lastWindowVisibilityState === "hidden") {
      windowWanted = false;
      windowForceVisible = false;
      return;
    }

    // If the window UI stops responding while it should be visible (e.g. user closed with X),
    // stop auto-reopening until the user manually opens it again.
    if (now - lastWindowAliveAt > 4500) {
      windowWanted = false;
      windowForceVisible = false;
    }
  }, 500);
}

function registerRpc(rpc, view, kind) {
  rpc.$getViewInfo = () => ({ kind, version: PLUGIN_VERSION });

  rpc.$openWindow = () => {
    openWindow();
    return true;
  };

  rpc.$showSidebar = () => {
    showSidebar();
    return true;
  };

  rpc.$getState = () => buildState();

  rpc.$getPlaybackState = () => ({
    timePos: numberOrNull(safeGetNative("time-pos")),
    sid: normalizeTrackId(safeGetNative("sid")),
    secondarySid: normalizeTrackId(safeGetNative("secondary-sid")),
    subDelay: numberOrZero(safeGetNative("sub-delay")),
    secondarySubDelay: numberOrZero(safeGetNative("secondary-sub-delay")),
    paused: safeGetFlag("pause"),
  });

  rpc.$seekTo = (seconds) => {
    const s = numberOrNull(seconds);
    if (s == null) return { error: "Invalid seek time" };
    const t = Math.max(0, s);
    try {
      mpv.command("seek", [String(t), "absolute", "exact"]);
      return { ok: true };
    } catch (err) {
      // Fall through to time-pos set.
    }
    try {
      mpv.set("time-pos", t);
      return { ok: true };
    } catch (err) {
      return { error: err?.toString?.() ?? String(err) };
    }
  };

  rpc.$setTrackRole = (trackId, role) => {
    const id = normalizeTrackId(trackId);
    if (!id) return { error: "Invalid track id" };
    if (role === "secondary") {
      safeSet("secondary-sid", id);
    } else {
      safeSet("sid", id);
    }
    // Invalidate any cached export attempt for embedded tracks.
    cueCacheByTrackId.delete(id);
    return buildState();
  };

  rpc.$disableRole = (role) => {
    if (role === "secondary") {
      safeSet("secondary-sid", "no");
    } else {
      safeSet("sid", "no");
    }
    return buildState();
  };

  rpc.$addDelay = (role, delta) => {
    const d = numberOrZero(delta);
    const cur = getDelay(role);
    setDelay(role, cur + d);
    return getDelay(role);
  };

  rpc.$setDelay = (role, value) => {
    setDelay(role, numberOrZero(value));
    return getDelay(role);
  };

  rpc.$getDelay = (role) => getDelay(role);

  rpc.$syncDelayToCueStart = (role, cueStart) => {
    const t = numberOrNull(safeGetNative("time-pos"));
    if (t == null) return { error: "No playback time (no file loaded?)" };
    const start = numberOrNull(cueStart);
    if (start == null) return { error: "Invalid cue start time" };
    const newDelay = t - start;
    setDelay(role, newDelay);
    return newDelay;
  };

  rpc.$getCues = async (trackId) => {
    const id = normalizeTrackId(trackId);
    if (!id) return { error: "Invalid track id" };
    return await loadCuesForTrack(id);
  };

  rpc.$getCurrentSubtitlePayload = (role) => {
    const r = role === "secondary" ? "secondary" : "primary";
    const info = getCurrentSubtitleInfo(r);
    if (!info.text) return { error: "No subtitle text available" };
    return { payload: formatCopyPayload(info.start, info.end, info.text) };
  };

  rpc.$copyCurrentSubtitle = async (role) => {
    const r = role === "secondary" ? "secondary" : "primary";
    const info = getCurrentSubtitleInfo(r);
    if (!info.text) return { error: "No subtitle text available" };
    const payload = formatCopyPayload(info.start, info.end, info.text);
    const res = await copyToClipboard(payload);
    if (!res.ok) {
      osdError("Failed to copy subtitle");
      return { error: res.error ?? "Copy failed", text: payload };
    }
    osdInfo("Subtitle copied to clipboard");
    return { ok: true, method: res.method, text: payload };
  };

  rpc.$copyCue = async (start, end, text) => {
    const payload = formatCopyPayload(numberOrNull(start), numberOrNull(end), String(text ?? ""));
    const res = await copyToClipboard(payload);
    if (!res.ok) {
      osdError("Failed to copy subtitle");
      return { error: res.error ?? "Copy failed" };
    }
    osdInfo("Subtitle copied to clipboard");
    return { ok: true, method: res.method };
  };

  rpc.$attachSubtitle = async () => {
    // Prefer native file chooser from plugin runtime.
    if (typeof utils.chooseFile !== "function") {
      return { error: "utils.chooseFile() is not available in this IINA version." };
    }
    const picked = utils.chooseFile();
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return { error: "No file selected" };
    const resolved = utils.resolvePath ? utils.resolvePath(path) : path;
    if (core?.subtitle?.loadTrack) {
      core.subtitle.loadTrack(resolved);
    } else {
      // Fallback to mpv directly.
      safeCommand("sub-add", [resolved, "select"]);
    }
    return buildState();
  };

  // Provide a lightweight push channel for errors from the UI.
  view.onMessage("error", (msg) => {
    console.error(`[ui:${kind}] ${msg}`);
  });
}

function buildState() {
  const tracks = getSubtitleTracks();
  const sid = normalizeTrackId(safeGetNative("sid"));
  const ssid = normalizeTrackId(safeGetNative("secondary-sid"));
  const primary = sid ? tracks.find((t) => t.id === sid) : null;
  const secondary = ssid ? tracks.find((t) => t.id === ssid) : null;

  const ordered = [];
  if (primary) ordered.push(annotateTrack(primary, "primary"));
  if (secondary && (!primary || secondary.id !== primary.id)) {
    ordered.push(annotateTrack(secondary, "secondary"));
  }
  for (const t of tracks) {
    if (primary && t.id === primary.id) continue;
    if (secondary && t.id === secondary.id) continue;
    ordered.push(annotateTrack(t, null));
  }

  return {
    timePos: numberOrNull(safeGetNative("time-pos")),
    paused: safeGetFlag("pause"),
    sid,
    secondarySid: ssid,
    subDelay: numberOrZero(safeGetNative("sub-delay")),
    secondarySubDelay: numberOrZero(safeGetNative("secondary-sub-delay")),
    tracks: ordered,
  };
}

function annotateTrack(track, role) {
  const externalPath = track["external-filename"] ?? null;
  const label = describeTrack(track);
  return {
    id: track.id,
    role,
    label,
    lang: track.lang ?? null,
    title: track.title ?? null,
    codec: track.codec ?? null,
    external: !!track.external,
    externalFilename: externalPath,
    selected: !!track.selected,
  };
}

function describeTrack(t) {
  const parts = [];
  if (typeof t.lang === "string" && t.lang.trim().length) {
    parts.push(t.lang.toUpperCase());
  }
  if (typeof t.title === "string" && t.title.trim().length) {
    parts.push(t.title.trim());
  }
  if (!parts.length && typeof t.codec === "string" && t.codec.trim().length) {
    parts.push(t.codec.trim());
  }
  if (t.external && typeof t["external-filename"] === "string") {
    parts.push(basename(t["external-filename"]));
  }
  return parts.join(" - ") || `Subtitle #${t.id}`;
}

function basename(p) {
  if (typeof p !== "string") return "";
  const s = p.replace(/\\/g, "/");
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function getSubtitleTracks() {
  const list = safeGetNative("track-list");
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && t.type === "sub" && typeof t.id === "number")
    .map((t) => t);
}

function normalizeTrackId(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function safeGetNative(prop) {
  try {
    return mpv.getNative(prop);
  } catch (err) {
    return null;
  }
}

function safeGetFlag(prop) {
  try {
    return mpv.getFlag(prop);
  } catch (err) {
    return false;
  }
}

function safeSet(prop, value) {
  try {
    mpv.set(prop, value);
  } catch (err) {
    console.error(`mpv.set failed for ${prop}: ${err?.toString?.() ?? err}`);
  }
}

function safeCommand(name, args) {
  try {
    mpv.command(name, Array.isArray(args) ? args : []);
  } catch (err) {
    console.error(`mpv.command failed for ${name}: ${err?.toString?.() ?? err}`);
  }
}

function numberOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numberOrZero(v) {
  const n = numberOrNull(v);
  return n == null ? 0 : n;
}

function getDelay(role) {
  if (role === "secondary") return numberOrZero(safeGetNative("secondary-sub-delay"));
  return numberOrZero(safeGetNative("sub-delay"));
}

function setDelay(role, value) {
  const v = numberOrZero(value);
  if (role === "secondary") safeSet("secondary-sub-delay", v);
  else safeSet("sub-delay", v);
}

function getCurrentSubtitleInfo(role) {
  const prefix = role === "secondary" ? "secondary-" : "";
  const text = safeGetString(`${prefix}sub-text`);
  let start = numberOrNull(safeGetNative(`${prefix}sub-start`));
  let end = numberOrNull(safeGetNative(`${prefix}sub-end`));

  // mpv's sub-start/sub-end may or may not include sub-delay depending on build/version.
  // Heuristic: prefer the interval that contains the current playback time.
  const t = numberOrNull(safeGetNative("time-pos"));
  const delay = getDelay(role === "secondary" ? "secondary" : "primary");
  if (t != null && start != null && end != null && Math.abs(delay) > 0.0005) {
    const eps = 0.05;
    const inRaw = t >= start - eps && t <= end + eps;
    const inShifted = t >= start + delay - eps && t <= end + delay + eps;
    if (!inRaw && inShifted) {
      start += delay;
      end += delay;
    }
  }

  return { text, start, end };
}

function safeGetString(prop) {
  try {
    const s = mpv.getString(prop);
    return typeof s === "string" ? s : "";
  } catch (err) {
    return "";
  }
}

async function copyCurrentSubtitleAuto() {
  // Prefer primary, fallback to secondary.
  const pri = getCurrentSubtitleInfo("primary");
  if (pri.text) {
    const payload = formatCopyPayload(pri.start, pri.end, pri.text);
    const res = await copyToClipboard(payload);
    if (res.ok) osdInfo("Subtitle copied to clipboard");
    else osdError("Failed to copy subtitle");
    return;
  }
  const sec = getCurrentSubtitleInfo("secondary");
  if (sec.text) {
    const payload = formatCopyPayload(sec.start, sec.end, sec.text);
    const res = await copyToClipboard(payload);
    if (res.ok) osdInfo("Secondary subtitle copied to clipboard");
    else osdError("Failed to copy subtitle");
    return;
  }
  osdInfo("No subtitle text to copy");
}

function formatCopyPayload(start, end, text) {
  const s = typeof start === "number" ? start : null;
  const e = typeof end === "number" ? end : null;
  const timeA = formatTimestamp(s ?? 0);
  const timeB = formatTimestamp(e ?? s ?? 0);
  const line = flattenSubtitleText(String(text ?? ""));
  return `${timeA} ~ ${timeB} ${line}`.trim();
}

function flattenSubtitleText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" / ");
}

function formatTimestamp(seconds) {
  const s = Math.max(0, seconds ?? 0);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const msec = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}.${pad3(msec)}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

async function copyToClipboard(text) {
  const payload = String(text ?? "");
  let lastError = null;

  // 1) Write to a temp file and feed pbcopy.
  // This is the most reliable way to integrate with macOS pasteboard from plugins.
  const tmp = "@tmp/iina-subtitle-manager-clipboard.txt";
  try {
    file.write(tmp, payload);
    const realPath = utils.resolvePath ? utils.resolvePath(tmp) : tmp;
    {
      // Use shell redirection to avoid piping/quoting surprises.
      const cmd = `/usr/bin/pbcopy < ${shQuote(realPath)}`;
      const res = await utils.exec("/bin/sh", ["-c", cmd]);
      if (res?.status === 0) {
        return { ok: true, method: "pbcopy" };
      }
      lastError = `pbcopy failed (exit ${res?.status ?? "?"}): ${res?.stderr ?? "unknown error"}`;
    }

    // 2) Fallback: AppleScript set clipboard to string.
    {
      const script = `set the clipboard to ${appleScriptQuote(payload)}\n`;
      const res = await utils.exec("/usr/bin/osascript", ["-e", script]);
      if (res?.status === 0) {
        return { ok: true, method: "osascript" };
      }
      lastError = `osascript failed (exit ${res?.status ?? "?"}): ${res?.stderr ?? "unknown error"}`;
    }
  } catch (err) {
    lastError = `pbcopy fallback failed: ${err?.toString?.() ?? err}`;
  }

  // 3) Last resort: try mpv's clipboard property (may be unavailable / no-op).
  try {
    // Some builds may accept mpv.set() but not actually provide a working clipboard bridge.
    // Only consider this a viable option if the property is readable.
    mpv.getString("clipboard/text");
    mpv.set("clipboard/text", payload);
    return { ok: true, method: "mpv" };
  } catch (err) {
    lastError = `mpv clipboard/text failed: ${err?.toString?.() ?? err}`;
  }

  console.error(lastError ?? "copyToClipboard failed with unknown error");
  return { ok: false, error: lastError ?? "copyToClipboard failed" };
}

function shQuote(s) {
  // POSIX shell single-quote escaping.
  // Example: abc'def -> 'abc'\''def'
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function appleScriptQuote(s) {
  // Wrap a string as an AppleScript double-quoted literal.
  // AppleScript uses backslash to escape quotes within strings.
  return `"${String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

// Subtitle cue parsing/caching.

const cueCacheByTrackId = new Map();

async function loadCuesForTrack(trackId) {
  const tracks = getSubtitleTracks();
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return { error: "Track not found" };

  const cached = cueCacheByTrackId.get(trackId);
  const externalFilename = typeof track["external-filename"] === "string" ? track["external-filename"] : null;
  if (cached && cached.externalFilename === externalFilename) {
    return cached.payload;
  }

  if (!externalFilename) {
    // Embedded tracks: we can only show the current subtitle line (mpv sub-text),
    // unless the user exports it externally.
    const payload = {
      trackId,
      source: "embedded",
      format: null,
      cues: [],
      error:
        "This subtitle track is embedded or bitmap-based, so the full cue list may not be accessible. Current-line copy still works.",
    };
    cueCacheByTrackId.set(trackId, { externalFilename: null, payload });
    return payload;
  }

  // Exclude non-file sources (edl://, memory://, etc).
  if (!looksLikeFilePath(externalFilename)) {
    const payload = {
      trackId,
      source: externalFilename,
      format: null,
      cues: [],
      error: `Unsupported subtitle source: ${externalFilename}`,
    };
    cueCacheByTrackId.set(trackId, { externalFilename, payload });
    return payload;
  }

  try {
    const content = await readTextFile(externalFilename);
    const { cues, format } = parseSubtitles(externalFilename, content);
    const payload = {
      trackId,
      source: externalFilename,
      format,
      cues,
      error: null,
    };
    cueCacheByTrackId.set(trackId, { externalFilename, payload });
    return payload;
  } catch (err) {
    const payload = {
      trackId,
      source: externalFilename,
      format: null,
      cues: [],
      error: err?.toString?.() ?? String(err),
    };
    cueCacheByTrackId.set(trackId, { externalFilename, payload });
    return payload;
  }
}

function looksLikeFilePath(p) {
  if (typeof p !== "string") return false;
  if (p.startsWith("edl://")) return false;
  if (p.startsWith("memory://")) return false;
  if (p.startsWith("http://") || p.startsWith("https://")) return false;
  return true;
}

async function readTextFile(path) {
  // Try iina.file first.
  try {
    if (file.exists(path)) {
      return file.read(path);
    }
  } catch (err) {
    // Ignore and fallback to cat.
  }

  const res = await utils.exec("/bin/cat", [path]);
  if (res?.status !== 0) {
    throw new Error(res?.stderr ?? `Failed to read file: ${path}`);
  }
  return res.stdout ?? "";
}

function parseSubtitles(path, content) {
  const text = String(content ?? "").replace(/^\uFEFF/, "");
  const ext = String(path ?? "").toLowerCase();
  if (ext.endsWith(".ass") || ext.endsWith(".ssa")) {
    return { cues: parseAss(text), format: "ass" };
  }
  if (ext.endsWith(".vtt")) {
    return { cues: parseVtt(text), format: "vtt" };
  }
  // Default: try SRT.
  return { cues: parseSrt(text), format: "srt" };
}

function parseSrt(text) {
  const t = normalizeNewlines(text);
  const blocks = t.split(/\n{2,}/g);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length);
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timeLine = lines[i] ?? "";
    const m = timeLine.match(/^(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/);
    if (!m) continue;
    const start = parseSrtTime(m[1]);
    const end = parseSrtTime(m[2]);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join("\n").trim();
    cues.push({ start, end, text: body });
  }
  return cues;
}

function parseVtt(text) {
  const t = normalizeNewlines(text).replace(/^WEBVTT.*\n/i, "");
  const blocks = t.split(/\n{2,}/g);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length);
    if (!lines.length) continue;
    // Skip NOTE/STYLE/REGION blocks quickly.
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
    let i = 0;
    if (!lines[0].includes("-->") && lines.length >= 2) i = 1; // cue id line
    const timeLine = lines[i] ?? "";
    const m = timeLine.match(/^(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/);
    if (!m) continue;
    const start = parseVttTime(m[1]);
    const end = parseVttTime(m[2]);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join("\n").trim();
    cues.push({ start, end, text: body });
  }
  return cues;
}

function parseAss(text) {
  const t = normalizeNewlines(text);
  const lines = t.split("\n");

  let inEvents = false;
  let format = null;
  let startIdx = -1;
  let endIdx = -1;
  let textIdx = -1;

  const cues = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const sec = line.match(/^\s*\[(.+?)\]\s*$/);
    if (sec) {
      inEvents = sec[1].toLowerCase() === "events";
      continue;
    }
    if (!inEvents) continue;

    if (/^\s*format\s*:/i.test(line)) {
      const rhs = line.replace(/^\s*format\s*:\s*/i, "");
      format = rhs.split(",").map((s) => s.trim().toLowerCase());
      startIdx = format.indexOf("start");
      endIdx = format.indexOf("end");
      textIdx = format.indexOf("text");
      continue;
    }

    if (!/^\s*dialogue\s*:/i.test(line)) continue;
    const rhs = line.replace(/^\s*dialogue\s*:\s*/i, "");
    const fields = splitCommaN(rhs, format?.length ?? 10);
    const s = fields[startIdx >= 0 ? startIdx : 1];
    const e = fields[endIdx >= 0 ? endIdx : 2];
    const txt = fields[textIdx >= 0 ? textIdx : fields.length - 1] ?? "";
    const start = parseAssTime(s);
    const end = parseAssTime(e);
    if (start == null || end == null) continue;
    cues.push({ start, end, text: cleanAssText(txt) });
  }

  return cues;
}

function cleanAssText(text) {
  return String(text ?? "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function splitCommaN(s, n) {
  const out = [];
  if (n <= 1) return [s];
  let cur = "";
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "," && count < n) {
      out.push(cur);
      cur = "";
      count++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseSrtTime(ts) {
  const m = String(ts ?? "")
    .trim()
    .match(/^(\d+):(\d\d):(\d\d)[,.](\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const frac = m[4].padEnd(3, "0").slice(0, 3);
  const ms = parseInt(frac, 10);
  return h * 3600 + mm * 60 + ss + ms / 1000;
}

function parseVttTime(ts) {
  const s = String(ts ?? "").trim();
  // Accept both HH:MM:SS.mmm and MM:SS.mmm
  const m = s.match(/^((\d+):)?(\d\d):(\d\d)\.(\d{1,3})$/);
  if (!m) return null;
  const h = m[2] ? parseInt(m[2], 10) : 0;
  const mm = parseInt(m[3], 10);
  const ss = parseInt(m[4], 10);
  const frac = m[5].padEnd(3, "0").slice(0, 3);
  const ms = parseInt(frac, 10);
  return h * 3600 + mm * 60 + ss + ms / 1000;
}

function parseAssTime(ts) {
  const s = String(ts ?? "").trim();
  const m = s.match(/^(\d+):(\d\d):(\d\d)\.(\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const frac = m[4].padEnd(3, "0").slice(0, 3);
  const ms = parseInt(frac, 10);
  return h * 3600 + mm * 60 + ss + ms / 1000;
}
