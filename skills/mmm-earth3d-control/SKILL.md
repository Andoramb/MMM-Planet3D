---
name: mmm-earth3d-control
description: Control a running MMM-Earth3D 3D globe module (MagicMirror) over its local HTTP API — change theme, camera, atmosphere, texture, background, quality, day/night, clouds, rotation speed, real-time flight tracking, highlight/center a city, or manage saved themes. Use when asked to change, tune, animate, track a flight on, highlight/center a city, or inspect the Earth3D globe display.
metadata:
  base_url: http://192.168.1.42:8090
---

# MMM-Earth3D control API

MMM-Earth3D is a MagicMirror² module that renders a rotating 3D Earth. It
ships its own `node_helper.js` HTTP API — no auth, no other module required —
that lets any client on the LAN read and change the running globe's
configuration in real time (no MagicMirror restart or page reload needed).

**Base URL for this deployment: `http://192.168.1.42:8090`**

All endpoints below are relative to that base URL. This is a bare LAN HTTP
API with no authentication — treat the base URL itself as the access
control boundary.

## Mental model

There is exactly one thing you are manipulating: a JSON **config object**
with these top-level fields:

| Field | Type | Notes |
|---|---|---|
| `theme` | string \| `"custom"` | id from the theme list (see below), or `"custom"` to use the fields below individually |
| `rotationSpeed` | number 0-100 | spin speed, 0 = stopped, saturates at 25 (see below) |
| `quality` | `"low"` \| `"medium"` \| `"high"` \| `"ultra"` | render/texture quality tier |
| `atmosphere` | object | `{ preset, color, altitude, opacity }` |
| `texture` | object | `{ preset, imageUrl, bumpImageUrl }` |
| `background` | object | `{ enabled, preset, imageUrl }` — starfield sphere that spins together with the globe |
| `camera` | object | `{ preset, zoom, rotate: {x,y,z}, position: {x,y,z} }` |
| `dayNight` | object | `{ mode: "disabled"\|"realtime"\|"custom", rotate }` |
| `clouds` | object | `{ enabled, source: "static"\|"realtime", opacity }` |
| `flights` | object | `{ enabled, flightNumber, track, pollInterval }` — real-time flight tracking, see below. **Not** part of `theme` (switching theme never changes or clears it, and it's never included in `theme` save/duplicate) — it's session/operational state, not a visual look. |
| `city` | object | `{ name, center }` — labeled marker (dot + text) per city; `name` is a single name or a `;`-separated list for multiple markers (e.g. `"Tokyo;Gothenburg"`); `center: true` is a one-shot action, not persisted state (see below) |

You change it by **POSTing a sparse partial** — only include the fields you
want to change. Everything else keeps its current value. Send `null` for a
field to reset it back to its theme/preset/default value instead of a
literal.

`rotate`/`position` accept either `{x,y,z}` or the compact array form
`[x, y, z]` (any axis may be omitted).

## Endpoints

### 1. `POST /MMM-Earth3D/set-config` — change the live globe

Body: any partial config object (see fields above). Applies immediately on
the running display, with atmosphere/camera/rotationSpeed easing smoothly
over ~0.7s (not an instant jump). `quality` changes rebuild the WebGL
context (instant, no animation). `dayNight`/`clouds` changes apply on their
next recompute.

```bash
# Switch to a whole different look in one call
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"theme": "close-up"}'

# Tweak just the camera zoom, leaving everything else as-is
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"camera": {"zoom": 80}}'

# Turn on realtime clouds and realtime day/night together
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"clouds": {"enabled": true, "source": "realtime"}, "dayNight": {"mode": "realtime"}}'

# Reset atmosphere altitude back to its theme/preset/default value
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"atmosphere": {"altitude": null}}'

# Stop rotation entirely
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"rotationSpeed": 0}'

# Highlight a city (dot + label marker), without moving the camera
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"city": {"name": "Tokyo"}}'

# Highlight multiple cities at once - ";"-separated, one marker each
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"city": {"name": "Tokyo;Gothenburg"}}'

# Rotate the globe (auto-spin keeps running, it just eases toward this
# orientation) so the first city in the currently-configured list ends up
# centered on screen
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"city": {"center": true}}'

# Set and center in one request
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"city": {"name": "Sydney", "center": true}}'

# Clear the city marker
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/set-config \
  -H "content-type: application/json" \
  -d '{"city": {"name": ""}}'
```

Response: `{"success": true}` (fire-and-forget — the server relays the
payload over MM's internal socket channel to the browser tab actually
rendering the globe; it does not wait for the browser to apply it).

**Important semantics:**
- Setting `theme` clears every field that theme controls (unless the *same*
  request also sets that field explicitly), so `{"theme": "nasa"}` gives you
  that theme's whole look. `{"theme": "close-up", "camera": {"zoom": 90}}`
  applies the theme but overrides just the zoom on top of it.
- A field set once (e.g. `camera.zoom`) stays pinned at that value across
  future theme switches until explicitly reset with `null` — it "wins" over
  any theme by design.
- `city.name` is a single name or a `;`-separated list (e.g.
  `"Tokyo;Gothenburg"`), each matched case-insensitively against a bundled
  city list (exact match, then prefix, then substring), no geocoding API
  involved - see `GET /MMM-Earth3D/config`'s `config.city.cities` below to
  check what actually matched per name (`matchedName: null` for any that
  didn't - an unrecognized name is just skipped, not an error; if every name
  is unrecognized, no marker is shown). `city.center` is a **one-shot
  action** that recenters on the *first* name in the list, not a stored
  value - it's never reflected back in `GET /MMM-Earth3D/config`'s
  `overrides`, and switching `theme` never clears a configured city marker
  (unlike every other field in the table above).

### 2. `GET /MMM-Earth3D/config` — read current resolved state

Returns the globe's fully-resolved current config plus the sparse overrides
currently pinned on top of it. Round-trips to the browser tab over MM's
socket channel (timeout 3s → `504` if no module/browser is actually running).

```bash
curl -sS http://192.168.1.42:8090/MMM-Earth3D/config
```

Response shape:
```json
{
  "config": { "rotationSpeed": 20, "quality": "medium", "atmosphere": {...}, "texture": {...}, "camera": {...}, "dayNight": {...}, "clouds": {...}, "city": {"name": "Tokyo;Gothenburg", "lat": 35.6762, "lng": 139.6503, "matchedName": "Tokyo", "cities": [{"name": "Tokyo", "lat": 35.6762, "lng": 139.6503, "matchedName": "Tokyo"}, {"name": "Gothenburg", "lat": 57.7089, "lng": 11.9746, "matchedName": "Gothenburg"}]} },
  "overrides": { "rotationSpeed": undefined, "atmosphere": null, "camera": {"zoom": 80}, ... }
}
```
`config.city.cities` has one entry per `;`-separated name, each with its own
`lat`/`lng`/`matchedName` (`null` for an unmatched name). `config.city.lat`/
`lng`/`matchedName` mirror the *first* entry (`null` if `name` is empty or
its first entry didn't match), for callers that only care about one city.
Use this before/after a `set-config` call to confirm what actually applied,
or to read current state before computing a relative change (e.g. "zoom in
10 more" requires reading current `camera.zoom` first, then POSTing
`current + 10`).

### 3. `POST /MMM-Earth3D/theme` — manage saved (user) themes

Only ever writes to the module's user-theme file, never the built-in
`presets/themes.js` — built-in themes are read-only from this endpoint.

Body: `{"action": "duplicate" | "save" | "delete", ...}`

**duplicate** — clone an existing theme (built-in or user) into a new user theme:
```bash
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/theme \
  -H "content-type: application/json" \
  -d '{"action": "duplicate", "sourceId": "close-up", "name": "My close-up"}'
```
`name` is optional (defaults to `"<source name> copy"`). Response includes
the new theme's generated `id`.

**save** — merge field overrides into an existing *user* theme (rejected for
built-in themes — duplicate first):
```bash
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/theme \
  -H "content-type: application/json" \
  -d '{"action": "save", "themeId": "my-close-up", "overrides": {"rotationSpeed": 35, "camera": {"zoom": 90}}}'
```
`overrides` may contain any of: `rotationSpeed`, `quality`, `atmosphere`,
`texture`, `background`, `camera`, `dayNight`, `clouds` — same shapes as `set-config`.

**delete** — remove a user theme (rejected for built-in themes):
```bash
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/theme \
  -H "content-type: application/json" \
  -d '{"action": "delete", "themeId": "my-close-up"}'
```

All three respond `{"success": true, "message": "...", ...}` on success, or
HTTP 400 `{"error": "..."}` on failure (e.g. unknown id, empty name, trying
to save/delete a built-in theme).

**Note:** editing the theme file does not affect the *currently rendering*
globe — it only affects what a future page load/reload resolves. To see a
new/edited theme live immediately, `duplicate`/`save` it, then also
`POST /MMM-Earth3D/set-config` with `{"theme": "<its id>"}` if you want the
live display to pick it up without a reload — though note a running globe
already has its own resolved config; theme *file* edits only matter on next
load, while `set-config` with a theme id switches the live display right now
regardless of whether that theme is user- or built-in-sourced.

### 4. `GET /MMM-Earth3D/flights/status` — read live flight-tracking state

Unlike `GET /MMM-Earth3D/config`, this answers directly from node_helper's own
state (no round-trip to the browser tab) since node_helper itself owns the
OpenSky polling loop, not the module.

```bash
curl -sS http://192.168.1.42:8090/MMM-Earth3D/flights/status
```

Response shape:
```json
{
  "flightNumber": "UA123", "found": true, "lat": 40.71, "lng": -73.99,
  "altitude": 10500, "heading": 271, "velocity": 230, "onGround": false,
  "timestamp": 1730000000000, "lastPollAt": 1730000005000, "lastError": null,
  "apiMode": "anonymous", "enabled": true, "track": false, "pollInterval": 20,
  "credentialsConfigured": false
}
```
`found: false` means no current match for `flightNumber` — either it isn't
airborne right now, or OpenSky has no live position report for it.

### 5. `GET`/`POST /MMM-Earth3D/flights/credentials` — optional OpenSky API tier

The Flight layer works with **zero setup** (anonymous OpenSky access, 400
requests/day). Setting a free OpenSky account's OAuth2 client credentials
here raises that to 4000/day, with automatic fallback to anonymous for any
poll where the registered call fails. Credentials are stored server-side
only and **never** echoed back — `GET` only ever reports whether one is set.

```bash
curl -sS http://192.168.1.42:8090/MMM-Earth3D/flights/credentials
# => {"configured": false}

curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/flights/credentials \
  -H "content-type: application/json" \
  -d '{"clientId": "...", "clientSecret": "..."}'

# Remove saved credentials, revert to anonymous:
curl -sS -X POST http://192.168.1.42:8090/MMM-Earth3D/flights/credentials \
  -H "content-type: application/json" -d '{"clear": true}'
```

## Reference: built-in preset and theme IDs

These ids exist out of the box (a deployment may also have extra ids in its
gitignored `presets/themes-user.js`, discoverable via `GET /MMM-Earth3D/config`'s
`overrides`, or by asking the operator).

**Themes** (`theme` field) — each bundles multiple fields at once:
| id | summary |
|---|---|
| `realistic` | realistic atmosphere + blue-marble texture + default camera |
| `minimal` | no spin, lowest quality, no atmosphere, wide camera — for constrained hardware |
| `close-up` | subtle atmosphere, close-up camera |
| `mission-control` | fast spin, ultra quality, custom cyan atmosphere, tilted camera, realtime day/night, static clouds on |

**Atmosphere presets** (`atmosphere.preset`): `none`, `realistic`, `vivid`, `subtle`

**Camera presets** (`camera.preset`): `default`, `close-up`, `wide`, `tilted-north`

**Texture presets** (`texture.preset`): `blue-marble` (only one shipped today)

**Background presets** (`background.preset`): `night-sky` (only one shipped today; `background.enabled` defaults to `false`)

## Field value ranges quick-reference

| Field | Range/values |
|---|---|
| `rotationSpeed` | `0`-`100` accepted, but `25` and above all give the same (fastest) speed - ~144s/revolution. `0` = stopped. |
| `camera.zoom` | `0`-`100` (0 = far, 100 = close) |
| `camera.rotate.{x,y,z}` / `camera.position.{x,y,z}` | degrees / scene units — needs tuning by eye |
| `quality` | `low` \| `medium` \| `high` \| `ultra` |
| `atmosphere.altitude` | roughly `0`-`0.5` |
| `atmosphere.opacity` | `0` (hidden) - `1` (shown); on/off threshold, not true alpha |
| `dayNight.mode` | `disabled` \| `realtime` \| `custom` |
| `dayNight.rotate` | `0`-`360` degrees, only used when `mode: "custom"` |
| `clouds.source` | `static` (no network) \| `realtime` (NASA GIBS, refreshed every 24h) |
| `clouds.opacity` | `0`-`1` |
| `background.enabled` | `true` \| `false` |
| `background.preset` | `night-sky` \| `custom` (with `background.imageUrl`) |
| `flights.flightNumber` | IATA flight number string, e.g. `"UA123"` (converted to an OpenSky callsign server-side; obscure airlines may need the ICAO form directly, e.g. `"UAL123"`) |
| `flights.enabled` | `true` \| `false` — shows the marker and drives polling |
| `flights.track` | `true` \| `false` — `true` rotates the globe/background to keep the tracked flight centered on camera instead of the normal camera behavior |
| `flights.pollInterval` | `10`-`300` seconds between OpenSky polls |

## Common agent recipes

**"Zoom in":** `GET /MMM-Earth3D/config`, read `config.camera.zoom`, POST
`{"camera": {"zoom": <current + delta, clamped 0-100>}}`.

**"Speed up/slow down rotation":** same pattern with `rotationSpeed`.

**"Switch to night mode" / "show day and night":** `{"dayNight": {"mode": "realtime"}}`.

**"Turn on clouds":** `{"clouds": {"enabled": true}}` (add `"source": "realtime"` for live satellite clouds).

**"Turn on/off the starry background":** `{"background": {"enabled": true}}` / `{"background": {"enabled": false}}`.

**"Make it look like <theme name>":** `{"theme": "<id>"}` from the table above.

**"Track flight UA123":** `{"flights": {"enabled": true, "flightNumber": "UA123"}}`.

**"Center the camera on the tracked flight" / "follow it":** `{"flights": {"track": true}}` (needs `flights.enabled` already true from a prior call).

**"Stop tracking":** `{"flights": {"enabled": false}}` (leaves `flightNumber`/`track` as-is, so re-enabling resumes the same flight).

**"Is the flight actually showing up?":** `GET /MMM-Earth3D/flights/status` — check `found` and `lastError`.

**"Highlight/show/mark <city>":** `{"city": {"name": "<city>"}}`. For multiple cities, join with `;`: `{"city": {"name": "<city1>;<city2>"}}`.

**"Center the globe on <city>" / "rotate to <city>":** `{"city": {"name": "<city>", "center": true}}` (omit `name` to just recenter on whatever city is already marked).

**"Remove/clear the city marker":** `{"city": {"name": ""}}`.

**"Go back to normal/default":** `{"theme": "custom"}` alone is enough — switching theme resets every field's override (rotationSpeed, quality, atmosphere, texture, background, camera, dayNight, clouds) back to its config.js/module default, as long as that same request doesn't also set one of those fields directly. This does **not** clear a city marker (`{"city": {"name": ""}}`) and does not disable flights (`{"flights": {"enabled": false}}`), because both are operational/session controls rather than visual theme fields.
