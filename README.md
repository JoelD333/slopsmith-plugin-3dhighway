# 3D Highway

A 3D note highway visualization for [Slopsmith](https://github.com/topkoa/slopsmith) — an alternative to the default 2D highway, with a sense of depth and perspective inspired by stage views in modern rhythm games.

## What you get

- A camera-perspective highway with notes flying down toward a virtual fretboard at the bottom of the screen
- Glowing strings that pulse and brighten on each hit
- Chord frame-boxes, named-chord labels, and a top-left chord diagram so you can read shapes at a glance
- A barre indicator that paints across the fret when a barre chord lands
- A heat-colored fret number row that lights up around your active playing region
- Selectable color palettes for the strings — pick the look you want
- Audio-reactive ambient background animations (particles, silhouettes, stage lights, geometric — pick one or turn it off)
- Lyrics overlay synced to the song
- Works as the main player view *or* per-panel inside the splitscreen plugin

## Install

The 3D Highway is a Slopsmith plugin. Drop this directory into your Slopsmith install's `plugins/` folder (or `git clone` it there), restart the server, and pick **3D Highway** from the visualization picker in the player.

## Settings

Most of the visual controls (background style, intensity, audio reactivity, color palette) live on Slopsmith's **Settings** screen under the *3D Highway* section.

## Contributing / development

For maintainers and AI assistants working on the codebase, see [`CLAUDE.md`](CLAUDE.md) — it's a navigation guide that maps every visual element to where it lives in `screen.js`, plus the gotchas worth knowing before tweaking.
