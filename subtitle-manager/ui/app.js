/* global iina */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let nextRpcId = 1;
const pendingRpc = new Map();

const RPC_TIMEOUT_MS = 900;

iina.onMessage("rpcResult", ({ id, res } = {}) => {
  if (id == null) return;
  const p = pendingRpc.get(id);
  if (!p) return;
  pendingRpc.delete(id);
  if (p.timeoutId) clearTimeout(p.timeoutId);
  p.resolve(res);
});

// Backend <-> UI health check / reload control for the sidebar.
iina.onMessage("smPing", ({ id } = {}) => {
  if (id == null) return;
  if (viewKind === "unknown") {
    viewKind = "sidebar";
    updateCompactMode();
    setDetachLabel(compactMode);
  }
  iina.postMessage("smPong", { id });
});

iina.onMessage("smReload", ({ token } = {}) => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("r", String(token ?? Date.now()));
    window.location.replace(url.toString());
  } catch (_err) {
    window.location.reload();
  }
});

// Standalone window: distinguish user closing the window (red X) from programmatic closes
// (auto-hide in fullscreen). The backend sends smWillClose right before programmatic close.
let ignoreWindowClosedUntil = 0;
iina.onMessage("smWillClose", () => {
  // Give programmatic closes enough time so any lifecycle/visibility events triggered by close()
  // are not misinterpreted as a user red-X close.
  ignoreWindowClosedUntil = Date.now() + 2500;
});

// Heartbeat: some IINA builds don't reliably emit pagehide/unload when the user closes the window
// via the titlebar red "X". A lightweight heartbeat lets the backend infer user-closed state.
let windowAliveTimer = null;
function startWindowAliveHeartbeat() {
  if (windowAliveTimer) return;
  windowAliveTimer = setInterval(() => {
    try {
      iina.postMessage("smWindowAlive", {
        ts: Date.now(),
        visibilityState: document.visibilityState || (document.hidden ? "hidden" : "visible"),
      });
    } catch (_err) {
      // ignore
    }
  }, 1000);
}

function notifyWindowClosedIfUserIntent() {
  if (Date.now() < ignoreWindowClosedUntil) return;
  try {
    iina.postMessage("smWindowClosed", { ts: Date.now() });
  } catch (_err) {
    // ignore
  }
}

function rpcCall(method, ...args) {
  const id = nextRpcId++;
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingRpc.delete(id);
      resolve({ error: `RPC timeout: ${method}` });
    }, RPC_TIMEOUT_MS);

    pendingRpc.set(id, { resolve, timeoutId });
    try {
      iina.postMessage("rpc", { id, method, args });
    } catch (err) {
      clearTimeout(timeoutId);
      pendingRpc.delete(id);
      resolve({ error: err?.toString?.() ?? String(err) });
    }
  });
}

const rpc = new Proxy(
  {},
  {
    get: (_t, name) => {
      if (typeof name !== "string" || !name.startsWith("$")) return undefined;
      return (...args) => rpcCall(name, ...args);
    },
  },
);

const el = {
  tabs: document.getElementById("tabs"),
  list: document.getElementById("list"),
  inactiveBanner: document.getElementById("inactiveBanner"),
  statusLeft: document.getElementById("statusLeft"),
  statusRight: document.getElementById("statusRight"),
  btnDec: document.getElementById("btnDec"),
  btnInc: document.getElementById("btnInc"),
  delayContainer: document.getElementById("delayContainer"),
  delayPanel: document.getElementById("delayPanel"),
  btnDelay: document.getElementById("btnDelay"),
  delayInput: document.getElementById("delayInput"),
  btnApplyDelay: document.getElementById("btnApplyDelay"),
  btnSyncSelected: document.getElementById("btnSyncSelected"),
  btnResetDelay: document.getElementById("btnResetDelay"),
  btnFindDelay: document.getElementById("btnFindDelay"),
  autoScrollToggle: document.getElementById("autoScrollToggle"),
  searchInput: document.getElementById("searchInput"),
  btnCopy: document.getElementById("btnCopy"),
  btnAttach: document.getElementById("btnAttach"),
  btnDetach: document.getElementById("btnDetach"),
  timeResizer: document.getElementById("timeResizer"),
};

let viewKind = "unknown";
let viewVersion = "";
let state = null;
let playback = null;

let activeTrackId = null;
let cuesPayload = null; // { cues, error, source, format }
let rowByCueIndex = new Map();
let visibleCueCount = null;

let selectedIndex = null;
let activeIndex = null;
let autoScroll = true;
let lastRenderedDelay = null;

let searchText = "";
let searchQuery = "";
let searchDebounceTimer = null;
let searchMatchIndices = [];
let searchMatchCount = 0;
let searchFocusIndex = null;
let searchPinned = false;
let pendingSearchScroll = false;
let suppressAutoScrollOnce = false;

let nextFullStateRetryAt = 0;

const fullLabels = {
  apply: el.btnApplyDelay?.textContent ?? "Apply",
  syncSelected: el.btnSyncSelected?.textContent ?? "Sync Selected",
  reset: el.btnResetDelay?.textContent ?? "Reset",
  find: el.btnFindDelay?.textContent ?? "Find",
  copy: el.btnCopy?.textContent ?? "Copy",
  attach: el.btnAttach?.textContent ?? "Attach",
};

let compactMode = false;

let delayPanelHomeParent = null;
let delayPanelPortaled = false;

function ensureDelayPanelHome() {
  if (!delayPanelHomeParent) delayPanelHomeParent = el.delayContainer ?? null;
}

function portalDelayPanelIfNeeded() {
  if (!compactMode) return;
  if (!el.delayPanel) return;
  ensureDelayPanelHome();

  if (delayPanelPortaled) return;
  try {
    document.body.appendChild(el.delayPanel);
    delayPanelPortaled = true;
  } catch (_err) {
    // ignore
  }
}

function unportalDelayPanelIfNeeded() {
  if (!el.delayPanel) return;
  ensureDelayPanelHome();
  if (!delayPanelPortaled) return;
  try {
    if (delayPanelHomeParent) delayPanelHomeParent.appendChild(el.delayPanel);
  } catch (_err) {
    // ignore
  }
  delayPanelPortaled = false;
  try {
    el.delayPanel.style.left = "";
    el.delayPanel.style.top = "";
  } catch (_err) {
    // ignore
  }
}

function closeDelayPanel() {
  el.delayContainer?.classList?.remove("sm-delay-open");
  try {
    el.delayPanel?.classList?.remove("sm-delay-panel-open");
  } catch (_err) {
    // ignore
  }
  unportalDelayPanelIfNeeded();
}

function openDelayPanel() {
  if (!el.delayContainer) return;
  el.delayContainer.classList.add("sm-delay-open");
  if (compactMode) {
    portalDelayPanelIfNeeded();
    try {
      el.delayPanel?.classList?.add("sm-delay-panel-open");
      positionDelayPanelPopup();
    } catch (_err) {
      // ignore
    }
  }
  try {
    el.delayInput?.focus?.();
    el.delayInput?.select?.();
  } catch (_err) {
    // ignore
  }
}

function positionDelayPanelPopup() {
  if (!compactMode) return;
  if (!el.btnDelay || !el.delayPanel) return;
  if (!el.delayPanel.classList.contains("sm-delay-panel-open")) return;

  // Position relative to viewport (panel is portaled to <body> in compact mode).
  const pad = 8;
  const btnRect = el.btnDelay.getBoundingClientRect();

  // Force layout after portaling/opening.
  const panelRect = el.delayPanel.getBoundingClientRect();

  let left = btnRect.left;
  let top = btnRect.bottom + pad;

  // Clamp horizontally.
  if (left + panelRect.width > window.innerWidth - pad) {
    left = window.innerWidth - pad - panelRect.width;
  }
  if (left < pad) left = pad;

  // Flip above if needed.
  if (top + panelRect.height > window.innerHeight - pad) {
    top = btnRect.top - pad - panelRect.height;
  }
  if (top < pad) top = pad;

  el.delayPanel.style.left = `${Math.round(left)}px`;
  el.delayPanel.style.top = `${Math.round(top)}px`;
}

function toggleDelayPanel() {
  if (!el.delayContainer) return;
  const open = el.delayContainer.classList.contains("sm-delay-open");
  if (open) closeDelayPanel();
  else openDelayPanel();
}

function updateDelayButtonLabel() {
  if (!el.btnDelay) return;
  const d = currentDelayForTrack(activeTrackId);
  const rounded = Math.round(d * 1000) / 1000;
  // Compact mode: keep the trigger stable/small ("M" for Manual), regardless of value.
  // Show the current delay in the tooltip.
  if (compactMode) {
    el.btnDelay.textContent = "M";
    el.btnDelay.title = `Manual sync (current ${rounded}s)`;
  } else {
    el.btnDelay.textContent = String(rounded);
    el.btnDelay.title = `Manual sync (${rounded}s)`;
  }
}

function updateDelayInputWidth() {
  // Only needed for the standalone window (non-compact). In compact mode the input is in a popover.
  if (!el.delayInput) return;
  if (compactMode) return;
  const v = String(el.delayInput.value ?? "").trim();
  // Keep it tight for small numbers but allow growth for longer manual values.
  const len = Math.max(4, v.length || 1);
  const ch = Math.max(6, Math.min(14, len + 1));
  el.delayInput.style.width = `${ch}ch`;
}

function setDetachLabel(compact) {
  if (viewKind === "sidebar") el.btnDetach.textContent = compact ? "W" : "Detach";
  else el.btnDetach.textContent = compact ? "SB" : "Sidebar";
}

function setCompactMode(compact) {
  compactMode = !!compact;
  document.body?.classList?.toggle("sm-compact", compactMode);

  el.btnApplyDelay.textContent = compactMode ? "AP" : fullLabels.apply;
  el.btnSyncSelected.textContent = compactMode ? "SS" : fullLabels.syncSelected;
  el.btnResetDelay.textContent = compactMode ? "R" : fullLabels.reset;
  el.btnFindDelay.textContent = compactMode ? "F" : fullLabels.find;
  el.btnCopy.textContent = compactMode ? "C" : fullLabels.copy;
  el.btnAttach.textContent = compactMode ? "AT" : fullLabels.attach;
  setDetachLabel(compactMode);
  updateDelayButtonLabel();
  updateDelayInputWidth();

  // Ensure we don't leave a portaled panel behind when switching modes.
  if (!compactMode) closeDelayPanel();
}

function updateCompactMode() {
  // Default to compact when the view kind is unknown, to avoid a "stuck" wide toolbar
  // if the initial RPC handshake is delayed or lost.
  const shouldCompact = viewKind === "sidebar" || viewKind === "unknown" || window.innerWidth < 540;
  if (shouldCompact !== compactMode) setCompactMode(shouldCompact);
}

function formatTimestamp(seconds) {
  const s = Math.max(0, seconds ?? 0);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const msec = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(
    2,
    "0",
  )}.${String(msec).padStart(3, "0")}`;
}

function formatTimestampCompact(seconds) {
  const s = Math.max(0, seconds ?? 0);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (!h) {
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatTimeRangeForList(startSeconds, endSeconds) {
  if (compactMode) {
    return `${formatTimestampCompact(startSeconds)} ~ ${formatTimestampCompact(endSeconds)}`;
  }
  return `${formatTimestamp(startSeconds)} ~ ${formatTimestamp(endSeconds)}`;
}

function loadColumnPrefs() {
  try {
    const normal = parseInt(localStorage.getItem("sm.timeCol.normal") ?? "", 10);
    if (Number.isFinite(normal) && normal > 0) {
      document.documentElement.style.setProperty("--sm-time-col", `${normal}px`);
    }
  } catch (_err) {
    // ignore
  }
  try {
    const compact = parseInt(localStorage.getItem("sm.timeCol.compact") ?? "", 10);
    if (Number.isFinite(compact) && compact > 0) {
      // Compact/sidebar mode is intentionally constrained so Time does not steal too much width.
      const clamped = Math.max(50, Math.min(90, compact));
      document.documentElement.style.setProperty("--sm-time-col-compact", `${clamped}px`);
    }
  } catch (_err) {
    // ignore
  }
}

function hookTimeResizer() {
  const handle = el.timeResizer;
  if (!handle) return;

  function varNameForMode() {
    return compactMode ? "--sm-time-col-compact" : "--sm-time-col";
  }

  function keyForMode() {
    return compactMode ? "sm.timeCol.compact" : "sm.timeCol.normal";
  }

  function parsePx(s) {
    const n = parseInt(String(s ?? "").trim().replace(/px$/i, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const rootStyle = getComputedStyle(document.documentElement);
    const startVar = varNameForMode();
    const startWidth = parsePx(rootStyle.getPropertyValue(startVar)) ?? (compactMode ? 150 : 180);
    const startX = e.clientX;

    // Compact sidebar: allow shrinking aggressively to maximize subtitle text width.
    // At very small sizes time will ellipsize, but that's expected.
    const minW = compactMode ? 50 : 90;
    const maxW = compactMode ? 90 : 340;

    document.body.classList.add("sm-resizing");

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const next = Math.max(minW, Math.min(maxW, Math.round(startWidth + dx)));
      document.documentElement.style.setProperty(startVar, `${next}px`);
      try {
        localStorage.setItem(keyForMode(), String(next));
      } catch (_err) {
        // ignore
      }
    };

    const onUp = () => {
      document.body.classList.remove("sm-resizing");
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  });
}

function flattenText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" / ");
}

function applySearchFromInput() {
  const raw = String(el.searchInput?.value ?? "").trim();
  searchText = raw;
  searchQuery = raw.toLowerCase();
  searchPinned = false;
  pendingSearchScroll = false;
  renderCues();
  renderContextualUI();
}

function scheduleSearchUpdate() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    applySearchFromInput();
  }, 70);
}

async function copyTextLocal(text) {
  const payload = String(text ?? "");

  // 1) Modern async clipboard API (may be restricted in WKWebView).
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(payload);
      return { ok: true, method: "navigator.clipboard" };
    }
  } catch (e) {
    // fallthrough
  }

  // 2) Legacy execCommand("copy") fallback.
  try {
    const ta = document.createElement("textarea");
    ta.value = payload;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok ? { ok: true, method: "execCommand" } : { ok: false, error: "execCommand(copy) returned false" };
  } catch (e) {
    return { ok: false, error: e?.toString?.() ?? String(e) };
  }
}

function currentRoleForTrack(trackId) {
  if (!state || !trackId) return null;
  if (trackId === state.sid) return "primary";
  if (trackId === state.secondarySid) return "secondary";
  return null;
}

function currentDelayForTrack(trackId) {
  if (!state || !trackId) return 0;
  if (trackId === state.sid) return state.subDelay ?? 0;
  if (trackId === state.secondarySid) return state.secondarySubDelay ?? 0;
  return 0;
}

function getTrackById(trackId) {
  if (!state || !Array.isArray(state.tracks)) return null;
  return state.tracks.find((t) => t.id === trackId) ?? null;
}

function setStatus(left, right) {
  el.statusLeft.textContent = left ?? "";
  el.statusRight.textContent = right ?? "";
}

function setBanner(htmlOrNull) {
  if (!htmlOrNull) {
    el.inactiveBanner.classList.add("sm-hidden");
    el.inactiveBanner.innerHTML = "";
    return;
  }
  el.inactiveBanner.classList.remove("sm-hidden");
  el.inactiveBanner.innerHTML = htmlOrNull;
}

function disableSyncControls(disabled) {
  for (const b of [
    el.btnDec,
    el.btnInc,
    el.btnApplyDelay,
    el.btnSyncSelected,
    el.btnResetDelay,
  ]) {
    b.disabled = !!disabled;
  }
  el.delayInput.disabled = !!disabled;
}

function renderTabs() {
  el.tabs.innerHTML = "";
  if (!state || !Array.isArray(state.tracks) || state.tracks.length === 0) {
    el.tabs.textContent = "No subtitle tracks";
    return;
  }

  const frag = document.createDocumentFragment();
  for (const t of state.tracks) {
    const btn = document.createElement("button");
    btn.className = "sm-tab" + (t.id === activeTrackId ? " sm-tab-active" : "");
    btn.type = "button";
    btn.dataset.trackId = String(t.id);

    const role = currentRoleForTrack(t.id);
    if (role === "primary" || role === "secondary") {
      const badge = document.createElement("span");
      badge.className = "sm-badge";
      badge.textContent = role === "primary" ? "P" : "S";
      btn.appendChild(badge);
    }

    const label = document.createElement("span");
    label.textContent = t.label ?? `Subtitle #${t.id}`;
    btn.appendChild(label);

    btn.addEventListener("click", () => {
      void activateTrack(t.id);
    });

    frag.appendChild(btn);
  }
  el.tabs.appendChild(frag);
}

function renderCues() {
  el.list.innerHTML = "";
  rowByCueIndex = new Map();
  visibleCueCount = null;

  if (!cuesPayload) {
    el.list.textContent = "Loading…";
    return;
  }

  if (cuesPayload.error) {
    el.list.textContent = cuesPayload.error;
    return;
  }

  const cues = Array.isArray(cuesPayload.cues) ? cuesPayload.cues : [];
  if (cues.length === 0) {
    el.list.textContent = "No cues available for this track.";
    visibleCueCount = 0;
    return;
  }

  const delay = currentDelayForTrack(activeTrackId);
  lastRenderedDelay = delay;

  const q = searchQuery;
  searchMatchIndices = [];
  searchMatchCount = 0;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];

    const flat = flattenText(cue.text);
    const isMatch = q ? flat.toLowerCase().includes(q) : false;
    if (isMatch) searchMatchIndices.push(i);

    const row = document.createElement("div");
    row.className = "sm-row" + (isMatch ? " sm-row-match" : "");
    row.role = "option";
    row.dataset.idx = String(i);

    const startEff = (cue.start ?? 0) + delay;
    const endEff = (cue.end ?? 0) + delay;

    const time = document.createElement("div");
    time.className = "sm-col sm-col-time";
    time.textContent = formatTimeRangeForList(startEff, endEff);

    const text = document.createElement("div");
    text.className = "sm-col sm-col-text";
    text.textContent = flat;

    const ms = document.createElement("div");
    ms.className = "sm-col sm-col-ms";
    ms.textContent = `${Math.round(startEff * 1000)}`;

    row.appendChild(time);
    row.appendChild(text);
    row.appendChild(ms);

    row.addEventListener("click", () => {
      setSelectedIndex(i);
    });

    row.addEventListener("dblclick", () => {
      setSelectedIndex(i);
      void seekToCue(i);
    });

    frag.appendChild(row);
    rowByCueIndex.set(i, row);
  }

  el.list.appendChild(frag);

  searchMatchCount = searchMatchIndices.length;
  visibleCueCount = q ? searchMatchCount : null;

  // Highlight the nearest match to the current cue (or selection), without changing selection.
  const anchor = selectedIndex ?? findActiveCueIndex(cues, playback?.timePos, delay) ?? activeIndex ?? 0;
  setSearchFocusIndex(q ? findNearestMatchIndex(anchor) : null);

  if (pendingSearchScroll && searchFocusIndex != null) {
    const row = rowByCueIndex.get(searchFocusIndex);
    if (row) {
      // Don't immediately snap back to the active cue after a search jump.
      suppressAutoScrollOnce = true;
      row.scrollIntoView({ block: "center" });
    }
  }
  pendingSearchScroll = false;

  // Re-apply selection highlight after rerenders (setSelectedIndex may no-op on same index).
  if (selectedIndex != null) {
    rowByCueIndex.get(selectedIndex)?.classList.add("sm-row-selected");
  }

  updateActiveCueHighlight();
}

function setSelectedIndex(idx) {
  if (selectedIndex != null) rowByCueIndex.get(selectedIndex)?.classList.remove("sm-row-selected");
  selectedIndex = idx;
  if (selectedIndex != null) rowByCueIndex.get(selectedIndex)?.classList.add("sm-row-selected");
}

function setActiveIndex(idx) {
  const suppress = suppressAutoScrollOnce;
  suppressAutoScrollOnce = false;

  if (idx === activeIndex) {
    const row = idx != null ? rowByCueIndex.get(idx) : null;
    if (row && !row.classList.contains("sm-row-active")) {
      row.classList.add("sm-row-active");
    }
    return;
  }

  if (activeIndex != null) rowByCueIndex.get(activeIndex)?.classList.remove("sm-row-active");
  activeIndex = idx;
  const row = activeIndex != null ? rowByCueIndex.get(activeIndex) : null;
  if (row) {
    row.classList.add("sm-row-active");
    if (autoScroll && !suppress) {
      row.scrollIntoView({ block: "center" });
    }
  }
}

function scrollActiveIntoView() {
  if (activeIndex == null) return;
  rowByCueIndex.get(activeIndex)?.scrollIntoView({ block: "center" });
}

function setSearchFocusIndex(idx) {
  if (searchFocusIndex != null) {
    rowByCueIndex.get(searchFocusIndex)?.classList.remove("sm-row-match-focus");
  }
  searchFocusIndex = typeof idx === "number" ? idx : null;
  if (searchFocusIndex != null) {
    rowByCueIndex.get(searchFocusIndex)?.classList.add("sm-row-match-focus");
  }
}

function findNearestMatchIndex(anchor) {
  if (!searchQuery) return null;
  const matches = Array.isArray(searchMatchIndices) ? searchMatchIndices : [];
  if (matches.length === 0) return null;
  const a = typeof anchor === "number" && Number.isFinite(anchor) ? anchor : 0;

  // Find the first match index >= a (lower_bound).
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid] < a) lo = mid + 1;
    else hi = mid;
  }

  const after = lo < matches.length ? matches[lo] : null;
  const before = lo > 0 ? matches[lo - 1] : null;
  if (before == null) return after;
  if (after == null) return before;
  return a - before <= after - a ? before : after;
}

function updateSearchFocusFromAnchor() {
  if (!searchQuery) {
    searchPinned = false;
    setSearchFocusIndex(null);
    return;
  }
  if (searchPinned && document.activeElement === el.searchInput) return;
  const anchor = selectedIndex ?? activeIndex ?? 0;
  setSearchFocusIndex(findNearestMatchIndex(anchor));
}

function scrollToSearchFocus() {
  if (searchFocusIndex == null) return;
  const row = rowByCueIndex.get(searchFocusIndex);
  if (!row) return;
  suppressAutoScrollOnce = true;
  row.scrollIntoView({ block: "center" });
}

function cycleSearchFocus(step) {
  if (!searchQuery) return false;
  const matches = Array.isArray(searchMatchIndices) ? searchMatchIndices : [];
  if (matches.length === 0) return false;

  const dir = step < 0 ? -1 : 1;
  const cur = typeof searchFocusIndex === "number" && Number.isFinite(searchFocusIndex) ? searchFocusIndex : null;

  // If we don't currently have a focus, anchor it to the closest match.
  if (cur == null) {
    const anchor = selectedIndex ?? activeIndex ?? 0;
    const idx = findNearestMatchIndex(anchor);
    if (idx == null) return false;
    setSearchFocusIndex(idx);
    return true;
  }

  let pos = matches.indexOf(cur);
  if (pos === -1) {
    // Find insertion point for cur.
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches[mid] < cur) lo = mid + 1;
      else hi = mid;
    }
    pos = dir > 0 ? lo : lo - 1;
  } else {
    pos += dir;
  }

  // Wrap around.
  pos %= matches.length;
  if (pos < 0) pos += matches.length;

  setSearchFocusIndex(matches[pos]);
  return true;
}

function findActiveCueIndex(cues, timePos, delay) {
  if (!Array.isArray(cues) || cues.length === 0) return null;
  if (typeof timePos !== "number" || !Number.isFinite(timePos)) return null;
  const t = timePos - (delay ?? 0);

  // Find the last cue with start <= t
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = cues[mid]?.start ?? 0;
    if (s <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0) {
    const e = cues[best]?.end ?? 0;
    if (t < e) return best;
  }
  return null;
}

function updateActiveCueHighlight() {
  if (!cuesPayload || cuesPayload.error) {
    setActiveIndex(null);
    updateSearchFocusFromAnchor();
    return;
  }
  const cues = cuesPayload.cues ?? [];
  const t = playback?.timePos;
  const delay = currentDelayForTrack(activeTrackId);
  const idx = findActiveCueIndex(cues, t, delay);
  setActiveIndex(idx);
  updateSearchFocusFromAnchor();
}

async function activateTrack(trackId) {
  activeTrackId = trackId;
  renderTabs();
  await loadCues(trackId);
  renderContextualUI();
}

async function loadCues(trackId) {
  cuesPayload = null;
  renderCues();
  const token = Symbol("cues");
  loadCues._token = token;
  const res = await rpc.$getCues(trackId);
  if (loadCues._token !== token) return;
  cuesPayload = res;
  renderCues();
  renderContextualUI();
}

function renderContextualUI() {
  const track = getTrackById(activeTrackId);
  const role = currentRoleForTrack(activeTrackId);
  const delay = currentDelayForTrack(activeTrackId);

  if (!track) {
    setBanner(null);
    disableSyncControls(true);
    return;
  }

  if (!role) {
    disableSyncControls(true);
    setBanner(
      `This track is not currently selected in IINA. ` +
        `<button class="sm-btn" id="bannerSetPrimary">Set Primary</button>` +
        `<button class="sm-btn" id="bannerSetSecondary">Set Secondary</button>`,
    );
    document.getElementById("bannerSetPrimary")?.addEventListener("click", () => void setRole("primary"));
    document.getElementById("bannerSetSecondary")?.addEventListener("click", () => void setRole("secondary"));
  } else {
    setBanner(null);
    disableSyncControls(false);
  }

  if (document.activeElement !== el.delayInput) {
    el.delayInput.value = String(Math.round(delay * 1000) / 1000);
  }
  updateDelayButtonLabel();
  updateDelayInputWidth();

  const subtitleCount = Array.isArray(cuesPayload?.cues) ? cuesPayload.cues.length : 0;
  const matchCount = typeof visibleCueCount === "number" ? visibleCueCount : null;
  const left = `${track.label ?? "Subtitle"}${role ? ` (${role})` : ""}  Delay: ${delay.toFixed(3)}s`;
  const timeRight =
    playback && typeof playback.timePos === "number" && Number.isFinite(playback.timePos)
      ? `Time: ${formatTimestamp(playback.timePos)}`
      : "";
  const right = viewVersion ? (timeRight ? `${timeRight}  ${viewVersion}` : viewVersion) : timeRight;
  const cuesLabel = searchQuery ? `Matches: ${matchCount ?? 0}/${subtitleCount}` : `Cues: ${subtitleCount}`;
  setStatus(`${left}  ${cuesLabel}`, right);
}

async function setRole(role) {
  const res = await rpc.$setTrackRole(activeTrackId, role === "secondary" ? "secondary" : "primary");
  if (res?.error) {
    iina.postMessage("error", res.error);
    return;
  }
  state = res;
  renderTabs();
  renderContextualUI();
  // Delay could have changed from role selection; rerender if necessary.
  maybeRerenderOnDelayChange();
}

function maybeRerenderOnDelayChange() {
  const delay = currentDelayForTrack(activeTrackId);
  if (lastRenderedDelay == null) return;
  if (Math.abs(delay - lastRenderedDelay) >= 0.001) {
    renderCues();
  } else {
    updateActiveCueHighlight();
  }
}

async function refreshFullState() {
  const res = await rpc.$getState();
  if (res?.error) {
    setStatus("Failed to load state", res.error);
    return;
  }
  state = res;
  if (!activeTrackId) {
    activeTrackId = state?.tracks?.[0]?.id ?? null;
  }
  if (activeTrackId && !getTrackById(activeTrackId)) {
    activeTrackId = state?.tracks?.[0]?.id ?? null;
  }
  renderTabs();
  renderContextualUI();
  if (activeTrackId) {
    await loadCues(activeTrackId);
  }
}

async function refreshPlaybackState() {
  const res = await rpc.$getPlaybackState();
  if (res?.error) return;

  playback = res;

  if (state) {
    const prevSid = state.sid;
    const prevSsid = state.secondarySid;
    state.sid = res.sid;
    state.secondarySid = res.secondarySid;
    state.subDelay = res.subDelay;
    state.secondarySubDelay = res.secondarySubDelay;
    state.timePos = res.timePos;
    state.paused = res.paused;

    // Reorder tabs if selection changed.
    if (prevSid !== res.sid || prevSsid !== res.secondarySid) {
      // Cheap: refresh full state occasionally; this is rare in practice.
      void refreshFullState();
    } else {
      renderTabs();
    }
  }

  // Keep input up-to-date unless editing.
  if (document.activeElement !== el.delayInput) {
    const d = currentDelayForTrack(activeTrackId);
    el.delayInput.value = String(Math.round(d * 1000) / 1000);
  }

  maybeRerenderOnDelayChange();
  renderContextualUI();
}

async function pollLoop() {
  for (;;) {
    const now = Date.now();
    if ((!state || !Array.isArray(state.tracks) || state.tracks.length === 0) && now >= nextFullStateRetryAt) {
      nextFullStateRetryAt = now + 800;
      try {
        await refreshFullState();
      } catch (_e) {
        // ignore
      }
    }
    try {
      await refreshPlaybackState();
    } catch (e) {
      // ignore
    }
    await sleep(250);
  }
}

async function applyDelayFromInput() {
  const role = currentRoleForTrack(activeTrackId);
  if (!role) return;
  const val = parseFloat(el.delayInput.value);
  if (!Number.isFinite(val)) return;
  const res = await rpc.$setDelay(role === "secondary" ? "secondary" : "primary", val);
  if (typeof res === "number") {
    if (state) {
      if (role === "secondary") state.secondarySubDelay = res;
      else state.subDelay = res;
    }
    maybeRerenderOnDelayChange();
    renderContextualUI();
  }
}

async function addDelay(delta) {
  const role = currentRoleForTrack(activeTrackId);
  if (!role) return;
  const res = await rpc.$addDelay(role === "secondary" ? "secondary" : "primary", delta);
  if (typeof res === "number") {
    if (state) {
      if (role === "secondary") state.secondarySubDelay = res;
      else state.subDelay = res;
    }
    maybeRerenderOnDelayChange();
    renderContextualUI();
  }
}

async function resetDelay() {
  const role = currentRoleForTrack(activeTrackId);
  if (!role) return;
  await rpc.$setDelay(role === "secondary" ? "secondary" : "primary", 0);
  await refreshPlaybackState();
}

async function findCurrentDelay() {
  const role = currentRoleForTrack(activeTrackId);
  if (!role) return;
  const res = await rpc.$getDelay(role === "secondary" ? "secondary" : "primary");
  if (typeof res === "number" && document.activeElement !== el.delayInput) {
    el.delayInput.value = String(Math.round(res * 1000) / 1000);
  }
}

async function findCurrentCue() {
  // One-shot "find": scroll/select the currently active cue even when Auto is off.
  await refreshPlaybackState();
  if (!cuesPayload || cuesPayload.error) return;
  const cues = cuesPayload.cues ?? [];
  const delay = currentDelayForTrack(activeTrackId);
  const idx = findActiveCueIndex(cues, playback?.timePos, delay);
  if (idx == null) return;

  // If the current cue is hidden by a filter, clear the filter so "Find" can jump to it.
  if (searchQuery && !rowByCueIndex.get(idx)) {
    searchText = "";
    searchQuery = "";
    if (el.searchInput) el.searchInput.value = "";
    renderCues();
    renderContextualUI();
  }

  const row = rowByCueIndex.get(idx);
  if (!row) return;
  setSelectedIndex(idx);
  row.scrollIntoView({ block: "center" });
}

async function syncToSelected() {
  const role = currentRoleForTrack(activeTrackId);
  if (!role) return;

  const cues = cuesPayload?.cues ?? [];
  const idx = selectedIndex ?? activeIndex;
  if (idx == null || !cues[idx]) return;

  const cueStart = cues[idx].start ?? 0;
  const res = await rpc.$syncDelayToCueStart(role === "secondary" ? "secondary" : "primary", cueStart);
  if (typeof res === "number") {
    await refreshPlaybackState();
  }
}

async function seekToCue(idx) {
  if (!cuesPayload || cuesPayload.error) return;
  const cues = cuesPayload.cues ?? [];
  if (idx == null || !cues[idx]) return;
  const cue = cues[idx];
  const delay = currentDelayForTrack(activeTrackId);
  const startEff = (cue.start ?? 0) + delay;
  const res = await rpc.$seekTo(startEff);
  if (res?.error) iina.postMessage("error", res.error);
}

async function copySelectedOrCurrent() {
  const cues = cuesPayload?.cues ?? [];
  const delay = currentDelayForTrack(activeTrackId);

  const idx = selectedIndex ?? activeIndex;
  if (idx != null && cues[idx]) {
    const cue = cues[idx];
    const start = (cue.start ?? 0) + delay;
    const end = (cue.end ?? 0) + delay;
    const payload = `${formatTimestamp(start)} ~ ${formatTimestamp(end)} ${flattenText(cue.text ?? "")}`.trim();
    const res = await rpc.$copyCue(start, end, cue.text ?? "");
    if (!res?.error) return;

    const local = await copyTextLocal(payload);
    if (local.ok) return;

    iina.postMessage("error", res.error);
    return;
  }

  const role = currentRoleForTrack(activeTrackId);
  const wantedRole = role === "secondary" ? "secondary" : "primary";
  const res = await rpc.$copyCurrentSubtitle(wantedRole);
  if (!res?.error) return;

  // If backend copy failed but still returned the text, attempt local copy as fallback.
  const payload = res?.text || (await rpc.$getCurrentSubtitlePayload(wantedRole))?.payload;
  if (payload) {
    const local = await copyTextLocal(payload);
    if (local.ok) return;
  }

  iina.postMessage("error", res.error);
}

function isTypingInInput(e) {
  const t = e.target;
  if (!t) return false;
  const tag = String(t.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA";
}

function hookUI() {
  // Help the WebView become first responder so Cmd+C key events are delivered reliably.
  if (document.body && typeof document.body.tabIndex === "number") {
    document.body.tabIndex = -1;
  }
  document.addEventListener(
    "mousedown",
    (e) => {
      if (isTypingInInput(e)) return;
      try {
        document.body?.focus?.();
      } catch (_err) {
        // ignore
      }
    },
    true,
  );

  el.btnDec.addEventListener("click", () => void addDelay(-0.5));
  el.btnInc.addEventListener("click", () => void addDelay(0.5));
  el.btnApplyDelay.addEventListener("click", () =>
    void (async () => {
      await applyDelayFromInput();
      closeDelayPanel();
    })(),
  );
  el.btnDelay?.addEventListener("click", () => {
    toggleDelayPanel();
  });
  el.btnResetDelay.addEventListener("click", () => void resetDelay());
  el.btnFindDelay.addEventListener("click", () => void findCurrentCue());
  el.btnSyncSelected.addEventListener("click", () => void syncToSelected());

  el.autoScrollToggle.addEventListener("change", () => {
    autoScroll = !!el.autoScrollToggle.checked;
    if (autoScroll) {
      updateActiveCueHighlight();
      scrollActiveIntoView();
    }
  });

  if (el.searchInput) {
    el.searchInput.addEventListener("input", () => {
      scheduleSearchUpdate();
    });
    el.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        searchPinned = true;
        cycleSearchFocus(e.shiftKey ? -1 : 1);
        scrollToSearchFocus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        el.searchInput.value = "";
        applySearchFromInput();
        el.searchInput.blur();
      }
    });
    el.searchInput.addEventListener("blur", () => {
      // Resume auto-focus near playback/selection when the user exits the search box.
      searchPinned = false;
      updateSearchFocusFromAnchor();
    });
  }

  el.btnCopy.addEventListener("click", () => void copySelectedOrCurrent());
  el.btnAttach.addEventListener("click", async () => {
    const res = await rpc.$attachSubtitle();
    if (res?.error) {
      iina.postMessage("error", res.error);
      return;
    }
    state = res;
    await refreshFullState();
  });

  el.btnDetach.addEventListener("click", () => {
    if (viewKind === "sidebar") void rpc.$openWindow();
    else void rpc.$showSidebar();
  });

  el.delayInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void (async () => {
        await applyDelayFromInput();
        closeDelayPanel();
      })();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeDelayPanel();
    }
  });
  el.delayInput.addEventListener("input", () => {
    updateDelayInputWidth();
  });

  document.addEventListener("keydown", (e) => {
    const key = String(e.key ?? "").toLowerCase();
    if (e.metaKey && !e.shiftKey && !e.altKey && key === "c") {
      if (isTypingInInput(e)) return;

      // If the user is explicitly selecting text (e.g. multiple cues), let the WebView perform
      // the default copy behavior. Otherwise, copy the selected/active cue.
      try {
        const s = window.getSelection?.()?.toString?.() ?? "";
        if (s && s.trim()) return;
      } catch (_err) {
        // ignore
      }

      e.preventDefault();
      void copySelectedOrCurrent();
    }
  });

  // Some WebView configurations don't deliver Cmd+C keydown reliably, but they do
  // fire the "copy" event. Prefer copying the selected/active cue synchronously.
  document.addEventListener("copy", (e) => {
    if (isTypingInInput(e)) return;

    // Respect explicit text selection: if the user highlighted a range in the cue list,
    // allow the default copy behavior.
    try {
      const s = window.getSelection?.()?.toString?.() ?? "";
      if (s && s.trim()) return;
    } catch (_err) {
      // ignore
    }

    const cues = cuesPayload?.cues ?? [];
    const idx = selectedIndex ?? activeIndex;
    if (idx == null || !cues[idx]) return;

    const cue = cues[idx];
    const delay = currentDelayForTrack(activeTrackId);
    const start = (cue.start ?? 0) + delay;
    const end = (cue.end ?? 0) + delay;
    const payload = `${formatTimestamp(start)} ~ ${formatTimestamp(end)} ${flattenText(cue.text ?? "")}`.trim();

    try {
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", payload);
        e.preventDefault();
      }
    } catch (_err) {
      // If this fails, the button handler still provides async fallback paths.
    }
  });

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!el.delayContainer) return;
      if (!el.delayContainer.classList.contains("sm-delay-open")) return;
      const t = e.target;
      if (t && (el.delayContainer.contains(t) || el.delayPanel?.contains?.(t))) return;
      closeDelayPanel();
    },
    true,
  );

  window.addEventListener(
    "resize",
    () => {
      positionDelayPanelPopup();
    },
    { passive: true },
  );

  document.querySelector(".sm-toolbar")?.addEventListener(
    "scroll",
    () => {
      // The toolbar can scroll horizontally in compact mode; keep the popup anchored.
      positionDelayPanelPopup();
    },
    { passive: true },
  );
}

async function init() {
  hookUI();
  loadColumnPrefs();
  hookTimeResizer();
  updateCompactMode();
  window.addEventListener("resize", updateCompactMode);

  // Start heartbeat early (before viewKind is known). The backend only listens for this
  // message on the standalone window, so sidebar posts are ignored.
  startWindowAliveHeartbeat();

  // In the standalone window, user-closing via the titlebar X is best detected by
  // page lifecycle events. (Sidebar doesn't get closed like this.)
  // Some IINA/WKWebView builds don't emit pagehide/unload on window close; visibility change is a useful signal.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") notifyWindowClosedIfUserIntent();
  });
  window.addEventListener("pagehide", () => notifyWindowClosedIfUserIntent());
  window.addEventListener("unload", () => notifyWindowClosedIfUserIntent());

  // Best-effort focus so keyboard shortcuts work without clicking an input.
  setTimeout(() => {
    try {
      document.body?.focus?.();
    } catch (_err) {
      // ignore
    }
  }, 0);

  // Don't block initialization on a potentially lost/delayed RPC message at app start.
  void (async () => {
    for (let i = 0; i < 30; i++) {
      const info = await rpc.$getViewInfo();
      if (info && !info.error) {
        viewKind = info.kind ?? "unknown";
        viewVersion = info.version ? `v${info.version}` : "";
        if (viewVersion) document.title = `Subtitle Manager ${viewVersion}`;
        updateCompactMode();
        setDetachLabel(compactMode);
        renderContextualUI();
        break;
      }
      await sleep(200);
    }
  })();

  void refreshFullState();
  void pollLoop();
}

init().catch((err) => {
  iina.postMessage("error", err?.toString?.() ?? String(err));
});
