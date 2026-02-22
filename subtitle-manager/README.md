# Subtitle Manager (IINA Plugin)
Release Documentation (v1.0)

Subtitle Manager is an IINA plugin that lets you browse subtitle cues, adjust subtitle sync, and copy subtitle lines with timestamps.

The UI is available in two places:
- Sidebar tab: "Subtitles"
- Detachable standalone window: "Subtitle Manager"

For internal maintenance notes and detailed version history, see `subtitle-manager/DOCUMENTATION.md`.

## Installation
1. Install the plugin (`.iinaplgz`) using IINA's plugin installation flow.
2. Open IINA.
3. Use the plugin menu to open either the Sidebar or the Window:
   - "Show Subtitle Manager Sidebar"
   - "Show Subtitle Manager Window"

## Shortcuts
Default plugin shortcuts (configurable in plugin Preferences):
- Show Subtitle Manager Sidebar: `Cmd+Option+S`
- Show Subtitle Manager Window: `Cmd+Option+E`
- Copy Current Subtitle (Timestamped): `Cmd+Option+C` (recommended default to avoid conflicts with Edit > Copy)

You can also bind shortcuts using macOS:
System Settings > Keyboard > Keyboard Shortcuts > App Shortcuts
Add an App Shortcut for IINA using the exact menu item title.

Recommended mapping for timestamped copy:
- Keep the plugin default at `Cmd+Option+C` to avoid conflicts.
- If you want `Cmd+C`, set a macOS App Shortcut for IINA with menu title:
  - `Copy Current Subtitle (Timestamped)`
  and assign `Cmd+C`.

## Preferences
IINA: Preferences > Plugins > Subtitle Manager

Options include:
- Show/hide informational OSD messages
- Configure menu shortcuts (applied after plugin reload or app restart)

## Tracks And Roles
IINA can expose subtitle tracks in (at least) two ways:
- External subtitle files (usually accessible as a cue list)
- Embedded / bitmap-based tracks (often not accessible as a full cue list)

Subtitle Manager shows each subtitle track as a tab.

The plugin also distinguishes subtitle roles:
- Primary subtitle (IINA `sid`)
- Secondary subtitle (IINA `secondary-sid`)

The currently selected primary/secondary tracks are shown first, then other available subtitle tracks.

If you select a track that is not currently selected in IINA, the plugin shows an action banner to:
- Set Primary
- Set Secondary

All delay/sync operations apply to the role (primary/secondary) of the currently active track.

## Cue List
When cue list data is available (typically external subtitle files), the list shows:
- Time: effective time range for each cue (includes current delay for the role)
- Text: cue text flattened to a single line
- ms: start timestamp in milliseconds (effective start time)

Row interactions:
- Single click: select cue
- Double click: seek playback to the cue's effective start time (cue start + current delay)

If the track is embedded/bitmap-based and the full cue list cannot be read, the plugin shows a message instead of a list.

## Toolbar Functions
The toolbar controls are available in both the window and the sidebar.

### Delay / Sync Controls
- `-0.5` / `+0.5`: decrease/increase delay by 0.5 seconds.
- Manual delay:
  - Window mode: a numeric delay button shows the current delay; clicking opens an input panel.
  - Compact mode (sidebar / narrow UI): the manual delay button label is "M" to keep the toolbar compact; tooltip shows the current delay.
- Apply manual delay:
  - Window mode label: "A"
  - Compact mode label: "AP"
- "Sync Selected" (compact: "SS"): set delay so the selected (or current) cue start aligns to the current playback time.
- "Reset" (compact: "R"): set delay to `0`.
- "Find" (compact: "F"): scroll to and select the currently active cue (even if Auto is off).
- "Auto": when enabled, the list auto-scrolls to follow the active cue during playback.

### Search
Search does not filter the list. It highlights matches and sets a "focus" highlight for the closest match.

Keyboard behavior in the search box:
- `Enter`: jump to next match (wraps)
- `Shift+Enter`: jump to previous match (wraps)
- `Esc`: clear search

### Copy
Copy behavior:
- `Cmd+C`: copies the selected cue, or the currently active cue.
- If you have highlighted text in the cue list, `Cmd+C` copies the highlighted selection (default behavior) instead of forcing "copy current cue".
- "Copy" button: same behavior.
- Also installs a native menu item: "Copy Current Subtitle (Timestamped)" (shortcut is configurable; default: Cmd+Option+C)

Copy format:
`HH:MM:SS.mmm ~ HH:MM:SS.mmm Subtitle text...`

The text is flattened into one line, joining original line breaks with ` / `.

For embedded tracks (no cue list), "current line copy" still works via mpv properties (e.g. `sub-text` / `sub-start` / `sub-end`).

### Attach
"Attach" opens a file picker and loads a subtitle file into IINA (selects it).

## Compact Mode (Sidebar)
The sidebar UI uses a compact layout to fit narrow widths:
- Time is displayed in a shorter format (e.g. `MM:SS ~ MM:SS` when under 1 hour).
- Some buttons use abbreviated labels (e.g. `SS`, `R`, `F`, `C`, `AT`, `W`).
- The manual delay trigger uses "M" (value shown in tooltip).
- The toolbar can scroll horizontally so controls are still reachable in very narrow widths.

## Resizable Time Column
The divider between the Time and Text columns is draggable.

The chosen width is stored per mode:
- Normal/window mode: `sm.timeCol.normal`
- Compact/sidebar mode: `sm.timeCol.compact`

In compact/sidebar mode, the Time column is intentionally constrained to `50-90px` so it doesn't steal too much horizontal space from subtitle text.

## Auto-Hide Window In Fullscreen (Optional)
The plugin includes a menu toggle:
- "Auto-hide Window in Fullscreen"

Behavior (when enabled):
- Fullscreen + paused: opens the window (if it is wanted)
- Fullscreen + playing: closes the window programmatically

Manual override:
- While fullscreen + playing, pressing "Show Subtitle Manager Window" will force-show the window even though auto-hide would normally keep it hidden.
- Press it again (while fullscreen + playing) to hide it and return to the normal auto-hide behavior.

### Menu And Shortcut Interaction
The plugin provides:
- Menu item (toggle): "Show Subtitle Manager Window" (shortcut is configurable)
- Menu item (toggle): "Show Subtitle Manager Sidebar" (shortcut is configurable)
- Menu item (toggle): "Auto-hide Window in Fullscreen"

Window toggle behavior depends on Auto-hide state and playback state:
- Auto-hide OFF:
  - "Show Subtitle Manager Window" always behaves as a simple toggle: show now, hide now.
  - Fullscreen vs non-fullscreen does not matter.
- Auto-hide ON, not fullscreen:
  - Same as Auto-hide OFF: show now, hide now.
- Auto-hide ON, fullscreen + paused:
  - "Show Subtitle Manager Window" shows the window (if closed) or hides it (if open).
  - If you hide it here, it is treated as "not wanted" and will not auto-open on future pauses until you show it again manually.
- Auto-hide ON, fullscreen + playing:
  - Default auto-hide keeps the window hidden during playback.
  - Press "Show Subtitle Manager Window" once: force-shows it during playback (manual override).
  - Press it again (still fullscreen + playing): cancels the manual override and hides it again.
  - Note: canceling the manual override does not disable "wanted". This means the window can still auto-open on the next pause.
    - If you want it to stay closed (not wanted), hide it while paused (or exit fullscreen and hide it).

If you close the window manually (red titlebar X), the plugin attempts to treat that as "do not auto-reopen" until you open it again manually.

Due to IINA/macOS window lifecycle behavior, user-close detection can be unreliable on some setups. The plugin uses a heartbeat + visibility heuristics to improve this, but if it still misbehaves, the most reliable workaround is to disable auto-hide or use a dedicated in-UI close action (if provided by your build).

## OSD Notifications (Optional)
The plugin can show OSD feedback for actions like copy success, sidebar reload, and toggle changes.

You can control this from the plugin menu:
- "Show Subtitle Manager OSD" (on/off)

## Permissions And Privacy
The plugin requests the following IINA plugin permissions:
- `show-osd`: to display OSD feedback (copy success/failure, etc.)
- `file-system`: to read subtitle files and to implement reliable clipboard copy on macOS

The plugin does not intentionally send data over the network.

## Debug Mode
The plugin includes a backend debug flag for development diagnostics:
- `subtitle-manager/index.js`: `const DEBUG = false;`

When enabled, additional diagnostic menu items may appear (e.g. "Clipboard Copy Test").

Enable it by changing the flag to `true` and rebuilding/reinstalling the plugin (or reloading the plugin in IINA).

## License
GNU General Public License v3.0 (GPLv3). See `subtitle-manager/LICENSE`.

## Author
Uzay Teker
