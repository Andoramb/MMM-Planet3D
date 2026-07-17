# MMM-Earth3D

A [MagicMirror²](https://magicmirror.builders/) module that renders a rotating,
photorealistic 3D Earth using [three-globe](https://github.com/vasturiano/three-globe)
and [Three.js](https://threejs.org/).

Status: **under active development** (scaffold stage).

## Roadmap

- [x] Module scaffold
- [x] Hello World validation
- [x] three-globe/Three.js integration (Earth texture, atmosphere, auto-rotation)
- [x] Cloud layer (static Blue Marble + realtime NASA GIBS)
- [x] Day/night terminator (realtime sun position + fixed custom angle)
- [ ] City lights
- [x] City location marker (see [City marker](#city-marker)) - any bundled city, not just Gothenburg
- [ ] Home Assistant MQTT data
- [ ] Weather overlay
- [ ] Moon phase
- [ ] ISS tracking

## Installation

Clone this module into your MagicMirror `modules/` directory as `MMM-Earth3D`,
then add it to `config.js` - no `npm install` needed. The globe renders via
[three-globe](https://github.com/vasturiano/three-globe) and
[Three.js](https://threejs.org/), whose browser builds and Earth textures are
vendored under `public/` so the module has no runtime CDN or npm dependency.
`public/vendor/three-globe.mjs` isn't a hand-downloaded file - it's produced
by a small esbuild script under `tools/vendor-three-globe/` (see that
directory's README for why, and how to regenerate it after a version bump).

## Configuration

```js
{
	module: "MMM-Earth3D",
	position: "fullscreen_below",
	config: {
		rotationSpeed: 20,
		theme: "custom",
		atmosphere: {
			preset: "custom",
			color: "#4aa8ff",
			altitude: 0.15,
			opacity: 1
		},
		texture: {
			preset: "blue-marble"
		},
		background: {
			enabled: false,
			preset: "night-sky"
		},
		camera: {
			preset: "custom",
			zoom: 50,
			rotate: { x: 0, y: 0, z: 0 },
			position: { x: 0, y: 0, z: 0 }
		},
		quality: "medium",
		dayNight: {
			mode: "disabled",
			rotate: 0
		},
		clouds: {
			enabled: false,
			source: "static",
			opacity: 0.8
		},
		city: {
			name: ""
		}
	}
}
```

| Option                | Type   | Default | Description |
| ---------------------- | ------ | ------- | ----------- |
| `width`                 | number | `null`  | Fixed width of the globe canvas in pixels. Leave unset (`null`) to auto-size: on a `fullscreen_above`/`fullscreen_below` position the globe fills the whole screen and tracks resizes automatically; on any other position, since normal MM regions don't give a WebGL canvas an intrinsic size to fill, it falls back to `500` with a console warning unless you set this explicitly. |
| `height`                 | number | `null`  | Same as `width`, for the canvas height. Must be set together with `width` to force a fixed size - setting only one is ignored. |
| `rotationSpeed`          | number | `20`    | Spin speed, `0` (stopped) to `100` (fast, ~36s/revolution). Always spins around the globe's own polar axis, so it stays correct even when `camera.rotate` tilts the globe. |
| `theme`                  | string \| `"custom"` | `"custom"` | A theme id from `presets/themes.js` bundling atmosphere/texture/camera together, or `"custom"` to configure them individually below. See [Themes](#themes) for the full resolution order. |
| `atmosphere.preset`      | string \| `"custom"` | `"custom"` | An id from `presets/atmosphere.js`, or `"custom"` for the fields below. |
| `atmosphere.color`       | string | `"#4aa8ff"` | Atmosphere glow color. Only used when `preset` is `"custom"`. |
| `atmosphere.altitude`    | number | `0.15`  | Atmosphere glow thickness (three-globe's `atmosphereAltitude`, roughly `0`-`0.5`). Only used when `preset` is `"custom"`. |
| `atmosphere.opacity`     | number | `1`     | `0` hides the atmosphere entirely, `>0` shows it. Not a native three-globe concept - approximated as an on/off threshold rather than true alpha blending. Only used when `preset` is `"custom"`. |
| `texture.preset`         | string \| `"custom"` | `"blue-marble"` | An id from `presets/earthTextures.js`, or `"custom"` with `texture.imageUrl` / `texture.bumpImageUrl` for your own fixed texture. |
| `background.enabled`     | boolean | `false` | Whether to show the background starfield sphere. Off by default. |
| `background.preset`      | string \| `"custom"` | `"night-sky"` | An id from `presets/backgrounds.js`, or `"custom"` with `background.imageUrl` for your own fixed background. Only used when `enabled` is `true`. See [Background](#background). |
| `camera.preset`          | string \| `"custom"` | `"custom"` | An id from `presets/camera.js` (overrides zoom/rotate/position below), or `"custom"` to use those fields directly. |
| `camera.zoom`            | number | `50`    | Camera distance, `0` (far) to `100` (close). Only used when `preset` is `"custom"`. Needs fine-tuning by eye once visible. |
| `camera.rotate`          | `{x,y,z}` \| `[x,y,z]` | `{0,0,0}` | Fixed tilt of the globe's resting orientation, in degrees (`0`-`360`). Only used when `preset` is `"custom"`. Independent of `rotationSpeed` — the globe spins while sitting at this tilt. |
| `camera.position`        | `{x,y,z}` \| `[x,y,z]` | `{0,0,0}` | Offset of the globe within the scene. Only used when `preset` is `"custom"`. Units are **3D scene units, not CSS pixels** (globe radius = 100 units) — there's no literal pixel mapping in a 3D perspective view, so this also needs fine-tuning by eye. |
| `quality`                | string | `"medium"` | `"low"` \| `"medium"` \| `"high"` \| `"ultra"` — trades render cost for realism: texture resolution (2k/2k/4k/8k), sphere smoothness, antialiasing, and display pixel ratio. Use a lower tier when zoomed out or on constrained hardware (e.g. Raspberry Pi), higher when zoomed in. |
| `dayNight.mode`          | string | `"disabled"` | `"disabled"` \| `"realtime"` (actual sun position, recomputed every 5 min) \| `"custom"` (fixed terminator angle, no astronomy). |
| `dayNight.rotate`        | number | `0`     | Terminator angle in degrees (`0`-`360`). Only used when `mode` is `"custom"`. |
| `clouds.enabled`         | boolean | `false` | Whether to show the cloud layer. |
| `clouds.source`          | string | `"static"` | `"static"` (vendored Blue Marble clouds, no network) \| `"realtime"` (fetched from NASA GIBS, polled every 24h - see [Clouds](#daynight-and-clouds) below). Only used when `enabled` is `true`. |
| `clouds.opacity`         | number | `0.8`   | `0` (invisible) to `1` (fully opaque). |
| `city.name`              | string | `""`    | A city name, matched case-insensitively against `presets/cities.js` (exact, then prefix, then substring match). Shows a dot + label marker at that location; empty string shows no marker. See [City marker](#city-marker). |
| `debug`                  | boolean | `false` | Logs every live-config notification (arrival, resolved config, which `apply*()` calls fired) to the browser console via `Log.info`. The node_helper side always logs incoming `/MMM-Earth3D/set-config` requests regardless of this flag - useful for telling "never reached the server" apart from "arrived but the browser dropped it" when a live-tune silently does nothing. |

### Themes

`presets/` is a visual asset registry, not just a camera-angle list — each
file holds a numbered/named list of presets for one asset type:

```
MMM-Earth3D/
├── presets/
│   ├── atmosphere.js     # color, altitude, opacity
│   ├── earthTextures.js  # texture image sets (per resolution tier)
│   ├── backgrounds.js    # background starfield images
│   ├── camera.js         # zoom, rotate, position
│   ├── themes.js         # named bundles covering every config field
│   └── themes-user.js    # themes made via control.html - gitignored, see below
```

`presets/themes.js` bundles settings under one name, so `config.theme =
"close-up"` changes several things in one line instead of configuring each
separately. Ships with four starter themes (`realistic`, `minimal`,
`close-up`, `mission-control`) that only combine assets that actually exist
today — see the note in that file about adding more once new texture assets
(night lights, Mars, etc.) are vendored. `presets/themes-user.js` holds
anything *you* create via control.html's theme buttons (see "Live tuning"
below) - kept separate and gitignored so your customizations never conflict
with a `git pull` of this file, and the module treats both files as one
combined theme list.

**A theme can set literally any config field** — `rotationSpeed`, `quality`,
`atmosphere`, `texture`, `background`, `camera`, `dayNight`, `clouds` — not
just reference other presets by id. For `atmosphere`/`texture`/`background`/
`camera`, a theme field can be either:
- a **string**, referencing another preset's id (e.g. `camera: "close-up"`), or
- an **object**, with literal values inline (e.g. `camera: { zoom: 30, rotate: [10, 0, 0] }`)

Any field a theme doesn't mention falls back to its normal preset/default,
exactly as if `theme` were `"custom"` for that one field. `rotate` and
`position` accept either `{ x, y, z }` or the more compact `[x, y, z]` array
form (any axis may be omitted) — this works everywhere those fields appear:
`config.js`, preset files, theme files, and live `EARTH3D_SET_CONFIG`
updates. See `presets/themes.js`'s `mission-control` entry for a worked
example combining all of this.

**Resolution order**, most to least authoritative, per field:
1. An explicit raw value in `config.js` (e.g. `atmosphere: { altitude: 0.22 }`) or in a live `EARTH3D_SET_CONFIG` update.
2. For `atmosphere`/`texture`/`background`/`camera`: that asset's own `preset` id, if set (e.g. `camera: { preset: "close-up" }`).
3. The active `theme`'s value for that field, if a theme is set (literal or a referenced preset id, per above).
4. The module default.

**Switching `theme` via a live update clears every field the new theme sets**
(unless that same update also sets the field directly), so picking a theme
always gives you that theme's whole look - including a `config.js` value
like `camera: { zoom: 80 }` that would otherwise permanently outrank every
theme's camera settings by rule 1 above. This only applies to live theme
switches; a `config.js` that sets both `theme` and an explicit field at
startup still resolves via the order above (explicit wins), since that's a
deliberate "use this theme but tweak one field" combination you wrote by hand.

This is what makes `{ theme: "close-up", atmosphere: { altitude: 0.22 } }`
work as "use the close-up theme, but tweak just this one field" instead of
having to duplicate the whole theme as a custom preset.

Every preset and theme is validated once at startup - an entry missing a
required field (or malformed) is dropped with a `Log.warn`, not a crash.
Atmosphere/texture/background/camera preset schemas nest their fields under a key
matching the config property they configure (e.g. `{ id, name, atmosphere:
{ color, altitude, opacity } }`), so the renderer can safely ignore fields
it doesn't use yet (like `opacity`'s blending) without a schema change
later.

There's no `presets/clouds.js` — the real cloud layer (below) is a `clouds.*`
config namespace, not a preset-registry asset, since it's fetched/composited
rather than picked from a fixed style list; set it directly in a theme or
config.js the same way as any other field, e.g. `clouds: { enabled: true }`.

Earth textures are sourced from [Solar System Scope](https://www.solarsystemscope.com/textures/) (2k/8k daymaps, CC BY 4.0) and [three-globe](https://github.com/vasturiano/three-globe)'s example assets (4k daymap, bump map). The `night-sky` background is also one of three-globe's example assets.

### Background

`background.enabled` turns on a giant textured sphere surrounding the whole
scene, viewed from inside; `background.preset` (from `presets/backgrounds.js`)
picks which image. This is inspired by globe.gl's `backgroundImageUrl`
([choropleth-countries example](https://github.com/vasturiano/globe.gl/blob/master/example/choropleth-countries/index.html))
but deliberately **not** a re-implementation of it: globe.gl's version (see
its underlying [three-render-objects](https://github.com/vasturiano/three-render-objects)
package) adds the sphere directly to the scene, independent of the globe, so
it stays fixed like a real sky while only the globe spins. This module
instead attaches the background sphere as a child of the same rotating globe
group the surface texture and clouds sit on, so it visibly spins in lockstep
with the planet — a deliberate stylistic choice, not an astronomy simulator.
Radius is a fixed multiple of the globe's own radius (see
`BACKGROUND_SPHERE_RADIUS_MULTIPLIER` in `public/Earth3DRenderer.js`), sized
to stay inside the camera's far plane and well outside its closest zoom.

### Day/Night and Clouds

These two use different techniques, deliberately:

**Day/Night** (`dayNight.mode`) blends a night-lights texture onto the day
texture on an offscreen `<canvas>` (`public/EarthCompositor.js`), then hands
the composited result to three-globe as a single `globeImageUrl`. This keeps
day/night a simple 2D image pipeline, independent of the render loop - a flat
terminator blend doesn't need real 3D geometry, just per-pixel math, so
there's no reason to make it a shader even though `Earth3DRenderer.js` has
direct access to the Three.js scene now.
- `"realtime"` computes actual solar illumination using [SunCalc](https://github.com/mourner/suncalc) (vendored, pure date/time math, no network calls - exposed as `window.MMMEarth3DSunCalc` rather than the usual `window.SunCalc`, since MagicMirror core ships different major SunCalc versions with different, incompatible units across different core releases via that name, and core's own default `clock`/`weather` modules can overwrite it too - see `public/vendor/suncalc.js`'s header comment), recomputed every 5 minutes - plenty, since the terminator only moves ~0.25°/minute. The "now" it feeds to SunCalc comes from **node_helper.js's clock** (`Date.now()` on the machine actually running MagicMirror), not the browser's - `MMM-Earth3D.js` asks for it once at startup (`EARTH3D_REQUEST_SERVER_TIME`/`EARTH3D_SERVER_TIME`) and applies the resulting offset in `EarthCompositor.computeAltitudeGrid()`. This matters because the page can be opened from a browser on a different machine/timezone than the mirror itself (e.g. this control panel) - without it, "realtime" would reflect whoever's viewing it instead of where the globe actually lives.
- `"custom"` fixes the terminator at a single longitude set by `dayNight.rotate`, using the same rendering path but without any real astronomy.
- `"disabled"` (default) skips this entirely - just the day texture, as before.

**Clouds** (`clouds.*`) is a real second sphere (`public/CloudsLayer.mjs`),
slightly larger than the globe and rotating independently, for a proper
parallax effect - unlike day/night, this genuinely needs Three.js geometry
(`SphereGeometry` + `MeshPhongMaterial` + `Mesh`). `CloudsLayer.mjs` is loaded
as an ES module (`type="module"`, picked up from its `.mjs` extension)
importing `public/vendor/three.module.min.js` - the same Three.js instance
`Earth3DRenderer.js` and `public/vendor/three-globe.mjs` use (same technique
as [three-globe's own official clouds example](https://github.com/vasturiano/three-globe/tree/master/example/clouds)) - and attaches its mesh as a child of the globe object.
- `source: "static"` uses a vendored Blue Marble Next Generation cloud texture ([matteason/live-cloud-maps](https://github.com/matteason/live-cloud-maps), MIT, sourced from NASA imagery) - no network dependency.
- `source: "realtime"` fetches a live image from [NASA GIBS](https://www.earthdata.nasa.gov/data/tools/worldview) via its [Worldview Snapshots API](https://wvs.earthdata.nasa.gov/), free, no API key, CORS-open. It's polled every 24 hours (hardcoded, not configurable) because that's how often the underlying MODIS satellite composite actually updates - confirmed against GIBS' own capabilities document, so polling more often would just re-fetch the same image. If the fetch fails (network issue, etc.), it silently falls back to the static texture rather than showing nothing.
- `opacity` is the only clouds knob exposed as config; **size and rotation speed are constants in `public/CloudsLayer.mjs`**, at the top of the file:
  ```js
  const CLOUDS_ALTITUDE = 0.006; // how far above the globe surface, as a fraction of its radius
  const CLOUDS_ROTATION_SPEED_X_DEG_PER_SEC = 0.3; // relative to the globe's own rotation
  const CLOUDS_ROTATION_SPEED_Y_DEG_PER_SEC = 0.5;
  const CLOUDS_SPEED_VARIATION = 0.4; // 0-1, how much the two speeds above slowly wander (0 = constant speed)
  const CLOUDS_VARIATION_PERIOD_X_SEC = 95; // seconds per wander cycle, per axis
  const CLOUDS_VARIATION_PERIOD_Y_SEC = 140;
  ```
  These aren't live-updatable config (a size/rotation change needs a page reload, not a `EARTH3D_SET_CONFIG` notification) since they're rarely-tweaked constants, not something you'd want a slider for.
- When `dayNight.mode` isn't `"disabled"`, clouds are also darkened on the night side - **the strength is a constant in `public/EarthCompositor.js`**:
  ```js
  const CLOUDS_NIGHT_DARKEN = 0.85; // 0 = no darkening, 1 = fully black at full night
  ```
  This is deliberately *not* baked into the clouds texture itself: since the clouds mesh spins independently (the parallax effect above), anything painted directly into its own texture (or a second, non-rotating sphere layered on top - tried first, but two near-coincident transparent spheres z-fight, showing up as visible flicker between the layers) would drift out of alignment with the true terminator, or fight with it visually. Instead, `EarthCompositor` hands `CloudsLayer.mjs` the same small black/transparent alpha mask it always did, but it's applied as a **shader effect on the clouds' own single mesh** (a small patch on `MeshPhongMaterial` via `onBeforeCompile`): each fragment's raw, rotation-invariant object-space normal is rotated by a `cloudRotation` uniform - the clouds mesh's own current accumulated parallax spin, updated once per frame, cheap - before being converted back to (lat, lng) and used to sample the mask. That's exactly "where is this fragment over the Earth right now," so it stays correctly aligned with the real day/night line (realtime or custom) regardless of how long the clouds have been drifting, with no second mesh and no z-fighting.

  The atmosphere glow is *not* shaded this way - three-globe's atmosphere is a single-color shader shell around the whole globe, not a texture, so it has no per-longitude "night side" to darken without forking that shader.

### City marker

`city.name` places a dot + text-label marker at a named city, matched
against the bundled `presets/cities.js` lookup table (a few hundred world
capitals/major cities with hand-entered coordinates) - like the earth
textures in `public/img/`, this is vendored rather than a live geocoding API
call, so it works with no runtime internet dependency. Add your own entries
to `presets/cities.js` for anywhere not already covered.

Unlike three-globe's own `pointsData`/`labelsData` layers (3D geometry -
`CylinderGeometry` dots and `TextGeometry` text, styled only via three-globe's
own JS API), the marker is a real HTML element mounted over the WebGL canvas
via a vendored [`CSS2DRenderer`](https://github.com/mrdoob/three.js/blob/master/examples/jsm/renderers/CSS2DRenderer.js)
(`public/vendor/CSS2DRenderer.js`, same three.js r185 instance as
everything else - see `public/Earth3DRenderer.js`'s `createCssRenderer()`),
set via three-globe's `htmlElementsData`. That's what makes it stylable from
CSS: `.earth3d-city-marker` (the wrapper), `.earth3d-city-dot`, and
`.earth3d-city-label` in `css/MMM-Earth3D.css`.

A separate one-shot action - `{"city": {"center": true}}` over
`EARTH3D_SET_CONFIG`/`set-config`, or the "Center on this city" button on the
control panel's Layers page - eases the globe's spin so that city ends up
facing the camera, without stopping or resetting the normal auto-rotation
(`rotationSpeed` keeps running from wherever the globe lands). This solves
for the spin angle analytically (`Earth3DRenderer.js`'s `centerOnCity()`):
conjugating the target rotation by the fixed `camera.rotate` tilt turns
"rotate around the globe's own tilted polar axis" into "rotate around a
fixed world-space axis", which reduces to projecting the city's position and
the camera direction onto the plane perpendicular to that axis and finding
the signed angle between them - the same trick used to align any vector to
another via rotation about a fixed axis.

## Live tuning (no restart or reload)

`theme`, `rotationSpeed`, `atmosphere`, `texture`, `background`, `camera`,
`quality`, `dayNight`, `clouds`, and `city` can all be changed on the running
globe without editing `config.js` or restarting MagicMirror, by sending an
`EARTH3D_SET_CONFIG` notification with a partial config object as payload -
the same resolution order described above applies, so `{"theme": "nasa"}` or
`{"camera": {"preset": "close-up"}}` or `{"atmosphere": {"altitude": 0.22}}`
or `{"clouds": {"enabled": true, "source": "realtime"}}` or
`{"city": {"name": "Tokyo", "center": true}}` are all valid on their own.
Every camera/atmosphere/rotationSpeed property eases smoothly to its new
value over ~0.7s instead of jumping; `quality` rebuilds the WebGL context
(antialiasing can't be toggled live) and so changes instantly; `dayNight`/
`clouds` changes take effect on their next recompute (near-instant for
mode/enabled changes, or the next successful fetch for clouds sources); and
`city.center` (a one-shot action, not persisted state - see
[City marker](#city-marker)) eases the globe's spin to the requested city
over ~2s.

Any field can be reset back to its theme/preset-derived value (instead of
whatever you last set it to) by sending `null` for that field, e.g.
`{"atmosphere": {"altitude": null}}` or `{"rotationSpeed": null}` - this is
what the reset (↺) buttons in `control.html` do.

This module ships its own `node_helper.js` for this - no other module needs to be
installed:

```bash
curl -X POST "http://<mirror-host>:8080/MMM-Earth3D/set-config" \
	-H "content-type: application/json" \
	-d '{"camera": {"zoom": 30}}'
```

For interactive tuning, open the control panel in a browser at
**`http://<mirror-host>:8080/earth3d.html`** — a short URL registered directly
on MagicMirror's shared Express app (`node_helper.js`), the same way
MMM-Remote-Control serves itself at `/remote.html` instead of under its own
`/modules/...` path. The full path still works too
(`.../modules/MMM-Earth3D/public/control/home.html`, or the even older
`.../public/control.html`, which redirects there) - `/earth3d/*` is just a
second mount point for the exact same files, not a copy. Three pages
(**Home**, **Planet & Env**, **Layers**) with sliders for every option above,
wired to the same endpoint. This is a standalone dev tool, not part of the
MagicMirror module itself, so it isn't rendered on the mirror.

The control panel's own source lives under `public/control/`:
```
public/control/
├── style.css       # shared styles, linked from every page
├── core.js         # send()/fetch()/status/reset-button helpers, plus the
│                    # panel loader below
├── home.html, planet-env.html, layers.html
└── panels/         # one small ES module per config panel - theme.js,
    ├── theme.js    # rotation-speed.js, texture.js, background.js,
    ├── ...         # camera.js, atmosphere.js, day-night.js, clouds.js
```
Each page marks the fieldsets it contains with `data-panel="<name>"`; `core.js`
scans for those attributes on load and dynamically `import()`s the matching
`panels/<name>.js` - so a page only loads the panels it actually declares, and
adding a new control to a page is just adding a `data-panel` block to its HTML
plus a `panels/<name>.js` file exporting `init(ctx)`/`applyConfig(config, ctx)`,
not editing a central script. This is unrelated to `MMM-Earth3D.js`'s own
`getScripts()` (see [Themes](#themes) above) - the control panel is fetched
directly by a browser hitting its URL, not loaded through MagicMirror's module
loader, so it's free to use real ES modules across multiple files.

Picking a theme (or anything else) refreshes every control on the page to match
what actually got resolved, via `GET /MMM-Earth3D/config` - node_helper.js asks
the running module (`EARTH3D_REQUEST_CONFIG`/`EARTH3D_CONFIG_STATE` over the
same socket channel) for its current resolved config *and* its sparse
`userOverrides`, and answers with whatever it reports back. This is also what
lets the page reflect a theme/config set in `config.js` at startup, not just
values changed from the page itself.

The Home page's **Duplicate current theme** / **Save current settings to
theme** / **Delete theme** buttons only ever edit `presets/themes-user.js`
on disk (gitignored - created automatically on first use, holds nothing but
what you make with these buttons), via `POST /MMM-Earth3D/theme`
(`{"action": "duplicate" | "save" | "delete", ...}`). The shipped
`presets/themes.js` is read-only from here: **Save**/**Delete** on a built-in
theme is rejected (duplicate it first, then save into the copy), so a
`git pull` of upstream default-theme changes never conflicts with your own
customizations and they never show up as a dirty diff on `presets/themes.js`.
"Save" merges only the fields you've actually changed (`userOverrides` above)
into the selected theme, so untouched fields keep whatever the theme already
had rather than being pinned to today's values. These edit the *file*, not the
live scene - like any other `presets/*.js` edit, the already-running display
needs a reload/restart to pick it up (this control page itself reloads
automatically after a successful edit, since it just re-reads the file via a
plain `<script>` tag). Also worth knowing: each write regenerates the whole
`presets/themes-user.js` file from its parsed contents, so it normalizes
formatting and **will strip any hand-written comments inside individual
theme entries** (the file's top-of-file doc comment is preserved) - not just
from the theme you touched. `presets/themes.js` is never written to, so its
formatting/comments are untouched no matter how many times you use these
buttons.

If you already have [MMM-Remote-Control](https://github.com/Jopyth/MMM-Remote-Control)
installed, its generic notification API works too (`POST
/api/notification/EARTH3D_SET_CONFIG?apiKey=<your-api-key>` with the same JSON
body) - it's just not required anymore.

## License

MIT
