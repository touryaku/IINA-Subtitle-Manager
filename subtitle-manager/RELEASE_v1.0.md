# Subtitle Manager v1.0 (Final Release)

Subtitle Manager v1.0 is now available — may it serve you well.
Happy watching, and happy subtitling!

## Summary
Subtitle Manager is an IINA plugin that helps you:
- Browse subtitle cues in a list (when available)
- Manage multiple subtitle tracks via tabs (primary/secondary shown first)
- Adjust subtitle sync (delay) quickly or precisely
- Seek by subtitle cue (double click)
- Search within cues (highlight + jump)
- Copy subtitle text with timestamps to the clipboard

The UI is available in two places:
- Sidebar tab: "Subtitles"
- Standalone window: "Subtitle Manager"

## Changelog (v1.0.0)
This release consolidates the stable feature set from the v0.1.x series and marks it as v1.0.

Key behavior highlights:
- Copy:
  - Cmd+C copies selection if you highlighted text in the cue list.
  - Otherwise, Cmd+C copies the selected cue or the current active cue (timestamped).
  - A native menu item is provided: "Copy Current Subtitle (Timestamped)".
- Auto-hide Window in Fullscreen:
  - When enabled: fullscreen+playing keeps the window hidden; fullscreen+paused shows it (when wanted).
  - Manual override: while fullscreen+playing, pressing "Show Subtitle Manager Window" can force-show the window; pressing again hides it and returns to normal auto-hide behavior.
- Compact sidebar layout:
  - Short button labels and tighter spacing to maximize visible subtitle text.
  - Draggable Time column constrained so Time does not steal too much width.

## Notes
- Embedded/bitmap subtitle tracks may not expose a full cue list; "copy current line" still works.
- Some window lifecycle behavior (red X close) depends on IINA/macOS; the plugin uses best-effort heuristics to interpret user-close correctly during auto-hide flows.

