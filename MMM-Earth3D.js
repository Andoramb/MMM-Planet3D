/* global Module, Earth3DRenderer, window */

/*
 * MMM-Earth3D
 * A MagicMirror module for a rotating 3D Earth (globe.gl).
 */
Module.register("MMM-Earth3D", {
	// Default module config.
	defaults: {
		// null = auto: fills the screen on a fullscreen_* position, or falls
		// back to 500x500 (with a warning) on a normal position, which can't
		// auto-size a WebGL canvas from flow layout alone. Set both to a
		// number to force a fixed pixel size regardless of position.
		width: null,
		height: null,

		rotationSpeed: 20, // 0-100, spin speed around the globe's own polar axis

		theme: "custom", // string id from presets/themes.js, or "custom" to use the asset configs below

		atmosphere: {
			preset: "custom", // string id from presets/atmosphere.js, or "custom" for the fields below
			color: "#4aa8ff",
			altitude: 0.15,
			opacity: 1
		},

		texture: {
			preset: "blue-marble", // string id from presets/earthTextures.js, or "custom" with imageUrl/bumpImageUrl below
			imageUrl: null,
			bumpImageUrl: null
		},

		camera: {
			preset: "custom", // string id from presets/camera.js, or "custom" for the fields below
			zoom: 50, // 0-100, 0 = close, 100 = far
			rotate: { x: 0, y: 0, z: 0 }, // degrees, fixed tilt of the globe's resting orientation - also accepts [x, y, z]
			position: { x: 0, y: 0, z: 0 } // scene-unit offset (globe radius = 100 units, not CSS pixels) - also accepts [x, y, z]
		},

		quality: "medium", // low | medium | high | ultra

		dayNight: {
			mode: "disabled", // "disabled" | "realtime" | "custom"
			rotate: 0 // degrees, terminator angle - only used when mode is "custom"
		},

		clouds: {
			enabled: false,
			source: "static", // "static" (vendored Blue Marble clouds) | "realtime" (NASA GIBS, polled every 24h - that's how often the underlying satellite composite actually updates)
			opacity: 0.8 // 0-1
		}
	},

	// Every default field above (rotationSpeed, quality, atmosphere,
	// texture, camera, dayNight, clouds) can also be set directly inside a
	// presets/themes.js entry - a theme isn't limited to referencing other
	// presets by id, it can supply literal values for anything, and any
	// field it doesn't mention just falls back to its normal preset/default.
	// See "Custom themes" in README.md.

	renderer: null,
	userOverrides: null,

	start: function () {
		Log.info("Starting module: " + this.name);

		window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
		window.EARTH3D_PRESETS.atmosphere = this.validatePresets(window.EARTH3D_PRESETS.atmosphere, "atmosphere", ["color", "altitude"]);
		window.EARTH3D_PRESETS.texture = this.validatePresets(window.EARTH3D_PRESETS.texture, "texture", ["images"]);
		window.EARTH3D_PRESETS.camera = this.validatePresets(window.EARTH3D_PRESETS.camera, "camera", ["zoom", "rotate", "position"]);
		window.EARTH3D_THEMES = this.validateThemes(window.EARTH3D_THEMES || []);

		this.captureUserOverrides();
		this.resolveConfig();
	},

	getStyles: function () {
		return [this.file("css/MMM-Earth3D.css")];
	},

	getScripts: function () {
		return [
			this.file("public/vendor/globe.gl.min.js"),
			this.file("public/vendor/suncalc.js"),
			this.file("presets/atmosphere.js"),
			this.file("presets/earthTextures.js"),
			this.file("presets/camera.js"),
			this.file("presets/stars.js"),
			this.file("presets/themes.js"),
			this.file("public/EarthCompositor.js"),
			this.file("public/CloudsLayer.mjs"),
			this.file("public/Earth3DRenderer.js")
		];
	},

	// --- Preset/theme validation -----------------------------------------
	// Runs once at startup. A malformed preset is dropped with a warning
	// instead of crashing the module, so a broken hand-edited entry in
	// presets/*.js can't take down the whole globe.

	validatePresets: function (list, assetType, requiredFields) {
		if (!Array.isArray(list)) {
			return [];
		}
		return list.filter((preset) => {
			if (!preset || typeof preset.id !== "string" || typeof preset.name !== "string") {
				Log.warn(this.name + ": skipping malformed " + assetType + " preset (missing id/name)");
				return false;
			}
			const payload = preset[assetType];
			if (!payload || typeof payload !== "object") {
				Log.warn(this.name + ': skipping ' + assetType + ' preset "' + preset.id + '" (missing ' + assetType + ' payload)');
				return false;
			}
			for (let i = 0; i < requiredFields.length; i++) {
				if (payload[requiredFields[i]] === undefined) {
					Log.warn(this.name + ': skipping ' + assetType + ' preset "' + preset.id + '" (missing field "' + requiredFields[i] + '")');
					return false;
				}
			}
			return true;
		});
	},

	validateThemes: function (list) {
		if (!Array.isArray(list)) {
			return [];
		}
		return list.filter((theme) => {
			if (!theme || typeof theme.id !== "string" || typeof theme.name !== "string") {
				Log.warn(this.name + ": skipping malformed theme (missing id/name)");
				return false;
			}
			return true;
		});
	},

	// --- Config resolution -------------------------------------------------
	// MM's default config merge is shallow: if the user sets e.g.
	// `atmosphere: { altitude: 0.22 }`, that object is a new reference
	// distinct from this.defaults.atmosphere and is missing sibling fields
	// (like color). We capture the raw object here, before refilling the
	// full default shape, so it can be re-applied as the highest-priority
	// layer after theme/preset resolution - this is what lets
	// `theme: "nasa", atmosphere: { altitude: 0.22 }` work as a selective
	// override instead of silently losing the rest of the atmosphere fields.
	// Scalars (rotationSpeed, quality) don't have this problem - MM's merge
	// handles plain values fine - but we still need to know whether the
	// user set one explicitly so a theme doesn't override it; a value that
	// happens to equal the default is treated as "not overridden", which is
	// an acceptable, rare ambiguity for a single number.

	captureUserOverrides: function () {
		this.userOverrides = {
			rotationSpeed: this.config.rotationSpeed !== this.defaults.rotationSpeed ? this.config.rotationSpeed : undefined,
			quality: this.config.quality !== this.defaults.quality ? this.config.quality : undefined,
			atmosphere: this.captureOverride("atmosphere"),
			texture: this.captureOverride("texture"),
			camera: this.captureOverride("camera", ["rotate", "position"]),
			dayNight: this.captureOverride("dayNight"),
			clouds: this.captureOverride("clouds")
		};
	},

	captureOverride: function (key, deepKeys) {
		const raw = this.config[key];
		if (raw === this.defaults[key]) {
			return null;
		}
		const copy = Object.assign({}, raw);
		(deepKeys || []).forEach((deepKey) => {
			if (raw[deepKey]) {
				copy[deepKey] = normalizeVec3(raw[deepKey]);
			}
		});
		return copy;
	},

	// Resolves theme + per-asset preset + explicit overrides into a
	// complete this.config for every configurable field. Used both at
	// start() and (via applyLiveConfig) on live updates, so theme switches
	// and per-field preset/value changes go through one path.
	resolveConfig: function () {
		const theme = this.config.theme !== "custom"
			? window.EARTH3D_THEMES.find((entry) => entry.id === this.config.theme)
			: null;
		if (this.config.theme !== "custom" && !theme) {
			Log.warn(this.name + ': no theme with id "' + this.config.theme + '", using custom values instead');
		}

		this.config.rotationSpeed = this.resolveScalar("rotationSpeed", theme);
		this.config.quality = this.resolveScalar("quality", theme);

		this.resolveAssetConfig("atmosphere", theme, []);
		this.resolveAssetConfig("texture", theme, []);
		this.resolveAssetConfig("camera", theme, ["rotate", "position"]);
		this.resolveDirectConfig("dayNight", theme, []);
		this.resolveDirectConfig("clouds", theme, []);
	},

	// Plain top-level values (rotationSpeed, quality): override > theme > default.
	resolveScalar: function (key, theme) {
		if (this.userOverrides[key] !== undefined) {
			return this.userOverrides[key];
		}
		if (theme && theme[key] !== undefined) {
			return theme[key];
		}
		return this.defaults[key];
	},

	// atmosphere/texture/camera: a theme can point at another preset's id
	// (string, existing behaviour) OR supply literal values inline (object,
	// merged the same way a preset's own payload would be) - either way,
	// any field not mentioned anywhere falls back to the module default.
	resolveAssetConfig: function (assetType, theme, deepKeys) {
		const defaults = this.defaults[assetType];
		const override = this.userOverrides[assetType];

		const resolved = Object.assign({}, defaults);
		deepKeys.forEach((key) => {
			resolved[key] = Object.assign({}, defaults[key]);
		});

		const themeValue = theme ? theme[assetType] : undefined;

		if (themeValue && typeof themeValue === "object") {
			this.mergeAssetPayload(resolved, themeValue, deepKeys);
			resolved.preset = "custom";
		} else {
			const presetId = (override && override.preset !== undefined) ? override.preset
				: (themeValue !== undefined) ? themeValue
					: defaults.preset;

			if (presetId && presetId !== "custom") {
				const preset = (window.EARTH3D_PRESETS[assetType] || []).find((entry) => entry.id === presetId);
				if (preset) {
					this.mergeAssetPayload(resolved, preset[assetType], deepKeys);
				} else {
					Log.warn(this.name + ': no ' + assetType + ' preset with id "' + presetId + '"');
				}
			}
			resolved.preset = presetId || "custom";
		}

		if (override) {
			this.mergeAssetPayload(resolved, override, deepKeys);
			if (override.preset !== undefined) {
				resolved.preset = override.preset;
			}
		}

		this.config[assetType] = resolved;
	},

	// dayNight/clouds: no preset-registry indirection (they're not a
	// choose-from-a-style-list kind of asset), just default < theme's
	// inline object < user override, merged the same way.
	resolveDirectConfig: function (key, theme, deepKeys) {
		const defaults = this.defaults[key];
		const override = this.userOverrides[key];

		const resolved = Object.assign({}, defaults);
		deepKeys.forEach((k) => {
			resolved[k] = Object.assign({}, defaults[k]);
		});

		if (theme && theme[key]) {
			this.mergeAssetPayload(resolved, theme[key], deepKeys);
		}
		if (override) {
			this.mergeAssetPayload(resolved, override, deepKeys);
		}

		this.config[key] = resolved;
	},

	// Shared by preset/theme/override merging: copies payload's fields onto
	// resolved, normalizing [x, y, z] array shorthand into {x, y, z} for
	// deep (rotate/position) fields so it works the same everywhere -
	// preset files, theme files, config.js, and live EARTH3D_SET_CONFIG
	// payloads.
	mergeAssetPayload: function (resolved, payload, deepKeys) {
		Object.keys(payload).forEach((key) => {
			if (deepKeys.indexOf(key) !== -1 || key === "preset") {
				return;
			}
			resolved[key] = payload[key];
		});
		deepKeys.forEach((key) => {
			if (payload[key] !== undefined) {
				resolved[key] = Object.assign({}, resolved[key], normalizeVec3(payload[key]));
			}
		});
	},

	// Merges a live-update patch into the tracked override for one asset
	// type. A field value of `null` means "reset this field" - it deletes
	// the key from the override instead of setting it, so resolveConfig()
	// falls through to the preset/theme/default for it again (rather than
	// pinning whatever value happened to be resolved at reset time, which
	// would go stale if the theme changes later).
	mergeOverride: function (assetType, patch, deepKeys) {
		// Deliberately {} rather than a copy of this.defaults[assetType]: an
		// override must stay sparse, holding only fields the caller actually
		// touched (here or in an earlier call). Falling back to full
		// defaults would bake in e.g. the default color the first time
		// altitude alone is live-updated, silently discarding whatever a
		// theme had set for color (and flipping preset back to "custom",
		// discarding a theme's referenced preset entirely).
		const existing = this.userOverrides[assetType] || {};
		const merged = Object.assign({}, existing);

		Object.keys(patch).forEach((key) => {
			if ((deepKeys || []).indexOf(key) !== -1) {
				return;
			}
			if (patch[key] === null) {
				delete merged[key];
			} else {
				merged[key] = patch[key];
			}
		});

		(deepKeys || []).forEach((key) => {
			if (!patch[key]) {
				return;
			}
			merged[key] = Object.assign({}, existing[key]);
			const normalized = normalizeVec3(patch[key]);
			Object.keys(normalized).forEach((subKey) => {
				if (normalized[subKey] === null) {
					delete merged[key][subKey];
				} else {
					merged[key][subKey] = normalized[subKey];
				}
			});
		});

		this.userOverrides[assetType] = merged;
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "MMM-Earth3D";
		wrapper.id = "earth3d-" + this.identifier;

		if (typeof this.config.width === "number" && typeof this.config.height === "number") {
			wrapper.style.width = this.config.width + "px";
			wrapper.style.height = this.config.height + "px";
		} else if (this.isFullscreenPosition()) {
			// fullscreen_above/below are meant to cover the whole display -
			// position:fixed to the viewport sidesteps whatever intrinsic
			// size (or lack thereof) MM's region/container chain has, so the
			// globe fills the actual screen instead of needing a guessed
			// width/height. The renderer measures this after layout.
			wrapper.classList.add("MMM-Earth3D--fullscreen");
		} else {
			Log.warn(this.name + ": width/height not set and position \"" + this.data.position
				+ "\" isn't fullscreen_above/below, so the module can't auto-size from layout alone - "
				+ "falling back to 500x500. Set width/height explicitly, or use a fullscreen_* position.");
			wrapper.style.width = "500px";
			wrapper.style.height = "500px";
		}

		return wrapper;
	},

	isFullscreenPosition: function () {
		return typeof this.data.position === "string" && this.data.position.indexOf("fullscreen") === 0;
	},

	// globe.gl needs the container attached to the live DOM to measure its
	// size, so the globe is built after MM's initial DOM pass completes.
	notificationReceived: function (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			const container = document.getElementById("earth3d-" + this.identifier);
			this.renderer = new Earth3DRenderer(container, this.config);
			return;
		}

		if (notification === "EARTH3D_SET_CONFIG" && this.renderer) {
			this.applyLiveConfig(payload || {});
		}
	},

	// Live-tunes the running globe without a page reload. Send this
	// notification from a MMM-Remote-Control custom notification, e.g.:
	// POST /api/notification/EARTH3D_SET_CONFIG  { "camera": { "zoom": 30 } }
	// or { "theme": "nasa" } to switch the whole look at once.
	applyLiveConfig: function (partial) {
		if (partial.rotationSpeed !== undefined) {
			this.userOverrides.rotationSpeed = partial.rotationSpeed === null ? undefined : partial.rotationSpeed;
		}
		if (partial.quality !== undefined) {
			this.userOverrides.quality = partial.quality === null ? undefined : partial.quality;
		}
		if (partial.theme !== undefined) {
			this.config.theme = partial.theme;
		}

		const atmosphereChanged = Boolean(partial.atmosphere);
		const textureChanged = Boolean(partial.texture);
		const cameraChanged = Boolean(partial.camera);
		const dayNightChanged = Boolean(partial.dayNight);
		const cloudsChanged = Boolean(partial.clouds);
		const themeChanged = partial.theme !== undefined;

		if (atmosphereChanged) {
			this.mergeOverride("atmosphere", partial.atmosphere, []);
		}
		if (textureChanged) {
			this.mergeOverride("texture", partial.texture, []);
		}
		if (cameraChanged) {
			this.mergeOverride("camera", partial.camera, ["rotate", "position"]);
		}
		if (dayNightChanged) {
			this.mergeOverride("dayNight", partial.dayNight, []);
		}
		if (cloudsChanged) {
			this.mergeOverride("clouds", partial.clouds, []);
		}

		const previousQuality = this.config.quality;

		if (themeChanged || atmosphereChanged || textureChanged || cameraChanged
			|| dayNightChanged || cloudsChanged
			|| partial.rotationSpeed !== undefined || partial.quality !== undefined) {
			this.resolveConfig();
		}

		if (themeChanged || partial.rotationSpeed !== undefined) {
			this.renderer.applyRotationSpeed();
		}
		if (themeChanged || atmosphereChanged) {
			this.renderer.applyAtmosphere();
		}
		if (themeChanged || textureChanged) {
			this.renderer.applyTexture();
		}
		if (themeChanged || cameraChanged) {
			this.renderer.applyZoom();
			this.renderer.applyGlobeTransform();
		}
		if (themeChanged || dayNightChanged) {
			this.renderer.applyDayNight();
		}
		if (themeChanged || cloudsChanged) {
			this.renderer.applyClouds();
		}
		if (this.config.quality !== previousQuality) {
			this.renderer.applyQuality();
		}
	},

	stop: function () {
		if (this.renderer) {
			this.renderer.destroy();
			this.renderer = null;
		}
	}
});

// Accepts [x, y, z] (array shorthand, any axis may be omitted) or {x, y, z}
// and always returns an {x, y, z}-shaped object, so rotate/position fields
// can be written either way in config.js, presets/*.js, or live updates.
function normalizeVec3(value) {
	if (!Array.isArray(value)) {
		return value;
	}
	const result = {};
	if (value[0] !== undefined) {
		result.x = value[0];
	}
	if (value[1] !== undefined) {
		result.y = value[1];
	}
	if (value[2] !== undefined) {
		result.z = value[2];
	}
	return result;
}
