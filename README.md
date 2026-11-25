# Arthur desktop companion

By MuChuan. A fan-made desktop pet of Arthur Kirkland (Hetalia); not affiliated with the original work.

A desktop pet for macOS: Arthur Kirkland as a small cat-eared figure who lives on
your screen — walks along window tops, climbs, gets picked up, sulks, naps under
a blanket, drinks tea, embroiders, and has a great deal to say about all of it
(lines are in Chinese).

## Pieces

- `desktop_companion/macos/` — the native app (Swift, one file): a borderless
  panel with a web view, window-ledge physics, dragging, falling, chasing.
  Build with `desktop_companion/macos/build_app.sh <output>.app`.
- `desktop_companion/web/` — the figure and his behaviour: an SVG rig
  (`arthur-desktop-rig-v3.svg`) animated by `arthur-life-runtime-v2.js` and
  `arthur-desktop-runtime-v3.js`; `live-client.js` wires in the app and all the
  lines; poke menu, idle chatter, fairy friends and pockets in their own files.
  `arthur-gpu-renderer-v2.js` draws him with WebGL instead of having the browser
  repaint a thousand vector parts every frame (each part is rasterised once and
  reused): roughly a quarter less CPU. The SVG stays the model the runtime moves;
  without WebGL2, or if frames keep failing, the real SVG simply comes back.
  Add `?svg=1` to the page URL to compare.
- `desktop_companion/server.py` + `status_sources.py` — a small local server that
  serves the page and a *coarse* status of the "real" Arthur (asleep or awake,
  at home or out, rough weather...), read from a separately running Arthur
  runtime on the Mac or over SSH from a VPS. Only categories cross over, never
  text.
- `vps_runtime/switch/` — the status contract (`companion_status.py`,
  `companion-status.schema.json`) and the runtime checks it relies on.

## Running on its own (no Arthur, no VPS)

```
python3 -m desktop_companion.standalone
```

serves the page and his status at http://127.0.0.1:15174/. His day is
mechanical and probability-driven (`desktop_companion/schedule_life.py`): every
~45 minutes the next activity is drawn from weighted tables for that part of
the day (tea about four, the garden in the morning, the pub some evenings,
more outings at weekends), each lasting a few runs and costing some energy;
he goes to bed between about half nine and midnight and gets up between six
and eight, both by chance; weather comes from British odds (umbrella weather
is common); fairies drop in now and then. No language model, no decisions of
his own. His day is kept in `~/.arthur-desktop-pet/life.json`, so it carries on
across restarts.

## Running with the real Arthur

The page works on its own in a browser: serve `desktop_companion/web/` and open
`index.html`. The native app expects the local server; see
`desktop_companion/config.mac.example.json` and `install_mac_candidate.py`.

Tests: `python3 -m pytest tests` and `node desktop_companion/web/test_live_client.js`.

Icons: `web/public-assets/` includes OpenMoji artwork (CC BY-SA 4.0, see the
attribution file there).

## Windows (Electron)

`windows/` is the same pet for Windows: an Electron port of the macOS shell
(`desktop_companion/macos/ArthurDesktopCompanion.swift`) that loads the very same
page from `desktop_companion/web`, with his day from `windows/life.js` (a JS port
of `schedule_life.py`, checked against the Python version field by field). No
Python, no server, nothing leaves the computer.

```bash
cd windows
npm install
npm start                 # run it here (works on macOS too, for testing)
npm test                  # the schedule
npm run dist:win          # → dist/Arthur Desktop Pet-1.0.0-win.zip
```

Phase 1 (done): transparent always-on-top window, stands on the taskbar, walks,
drag / fling / wall bonks / landings, every touch and poke-menu interaction,
outfits, stolen things and peace offerings, sent away and coming back, tray menu,
Ctrl+Alt+A / Ctrl+Alt+P, start at login. Not yet: standing on other windows,
the screenshot reaction. `README.txt` (Chinese) goes in the zip for whoever
installs it. Debugging without a mouse: `ARTHUR_DEBUG=1 ARTHUR_DEBUG_SCRIPT=fling npm start`.
