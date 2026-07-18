/* global Module, Earth3DRenderer, window */

// MMM-Earth3D: a MagicMirror module for a rotating 3D Earth (three-globe/Three.js).
Module.register("MMM-Earth3D", {
	// Default module config.
	defaults: {
		// null = auto: fills the screen on a fullscreen_* position, or falls back to 500x500 on a normal position. Set both to force a fixed pixel size.
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

		background: {
			enabled: false, // off by default - opt in once you've picked a look you like
			preset: "night-sky", // string id from presets/backgrounds.js, or "custom" with imageUrl below
			imageUrl: null,
			// Live tuning for the "star-particles" preset - see StarfieldLayer.mjs's DEFAULT_CONFIG (kept in sync with these).
			starfield: {
				count: 6600, // total stars across all 4 depth layers
				size: 1, // multiplier on each layer's base point size
				sizeVariation: 0.5, // 0-1, per-star size randomness spread
				color: "#ffffff", // base star color
				colorVariation: 0.4, // 0-1, hue/saturation scatter away from color
				fading: true, // breathing/twinkle size pulse
				effectVariation: 0, // 0-1, desyncs each star's twinkle phase (0 = all pulse in unison)
				effectSpeed: 1 // multiplier on each layer's base twinkle speed
			}
		},

		camera: {
			preset: "custom", // string id from presets/camera.js, or "custom" for the fields below
			zoom: 50, // 0-100, 0 = far (zoomed out), 100 = close (zoomed in)
			rotate: { x: 0, y: 0, z: 0 }, // degrees, fixed tilt of the globe's resting orientation - also accepts [x, y, z]
			position: { x: 0, y: 0 } // scene-unit offset (globe radius = 100 units, not CSS pixels) - also accepts [x, y]; also live-settable by Shift+drag on the display itself (see Earth3DRenderer.js's setupInteraction())
		},

		quality: "medium", // low | medium | high | ultra

		dayNight: {
			mode: "disabled", // "disabled" | "realtime" | "custom"
			rotate: 0 // degrees, terminator angle - only used when mode is "custom"
		},

		clouds: {
			enabled: false,
			source: "static", // "static" (vendored Blue Marble clouds) | "realtime" (NASA GIBS, polled every 24h - that's how often the underlying satellite composite actually updates) | "dynamic" (same vendored texture, animated with a layered/noise-warped shader for a more lifelike drift - no network)
			opacity: 0.8 // 0-1
		},

		// Session/operational, not a visual look - excluded from theme switching and "Save into theme" (see SKILL.md); node_helper's poller learns this over EARTH3D_FLIGHTS_STATE.
		flights: {
			enabled: false, // shows the tracked flight's marker and drives node_helper's OpenSky polling
			flightNumber: "", // IATA flight number, e.g. "UA123" - resolved to an OpenSky callsign server-side (see lib/iataToIcaoAirlines.js)
			track: false, // true = globe/background rotate to keep the tracked flight centered on camera (see Earth3DRenderer.tick()); false = normal camera behavior
			pollInterval: 20 // seconds between OpenSky polls while enabled, 10-300
		},

		city: {
			name: "" // ";"-separated list matched case-insensitively against presets/cities.js by findCity() below, one marker per name. Empty = no marker.
		},

		// OpenSky OAuth2 client credentials for the registered tier - config.js-only, kept out of `flights`/`this.config` entirely since the latter is echoed verbatim over the LAN and persisted into theme files. Set directly: flightCredentials: { clientId, clientSecret } (or manage live via POST /MMM-Earth3D/flights/credentials - config.js wins on restart if both are used).
		flightCredentials: null,

		debug: false // logs every live-config notification and apply*() call to the browser console via Log.info
	},

	// Every default field above can also be set directly inside a presets/themes.js entry (id reference or literal values) - see "Custom themes" in README.md.

	renderer: null,
	userOverrides: null,
	serverTimeOffsetMs: 0,

	debugLog: function () {
		if (!this.config || !this.config.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:" + this.identifier + "]"].concat(Array.prototype.slice.call(arguments)));
	},

	start: function () {
		Log.info("Starting module: " + this.name);

		// MM's per-module socket is lazily created only by sendSocketNotification() - calling socket() directly establishes it so node_helper's un-prompted emits actually have a listener.
		this.socket();

		// Asks node_helper (on the actual MagicMirror host) for its clock, not whatever machine's browser is viewing this page - stays 0 (trust this browser) until the reply arrives.
		this.serverTimeOffsetMs = 0;
		this.sendSocketNotification("EARTH3D_REQUEST_SERVER_TIME");

		window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
		window.EARTH3D_PRESETS.atmosphere = this.validatePresets(window.EARTH3D_PRESETS.atmosphere, "atmosphere", ["color", "altitude"]);
		window.EARTH3D_PRESETS.texture = this.validatePresets(window.EARTH3D_PRESETS.texture, "texture", ["images"]);
		// No single required field - a background preset is either image-based (imageUrl) or
		// particle-based (starfield: true, see presets/backgrounds.js/StarfieldLayer.mjs).
		window.EARTH3D_PRESETS.background = this.validatePresets(window.EARTH3D_PRESETS.background, "background", []);
		window.EARTH3D_PRESETS.camera = this.validatePresets(window.EARTH3D_PRESETS.camera, "camera", ["zoom", "rotate", "position"]);
		// User-created themes (gitignored presets/themes-user.js) are merged in after the shipped defaults into one combined list.
		window.EARTH3D_THEMES = this.validateThemes((window.EARTH3D_THEMES || []).concat(window.EARTH3D_USER_THEMES || []));

		this.captureUserOverrides();
		this.resolveConfig();
		this.sendFlightsState();
		this.sendFlightCredentials();
	},

	getStyles: function () {
		return [this.file("css/MMM-Earth3D.css")];
	},

	// ES-module assets (CloudsLayer.mjs, three.js, three-globe, OrbitControls) are NOT listed here - MM core's getScripts() extension-sniffing can silently no-op on them, so Earth3DRenderer.js loads them itself via dynamic import(). Do NOT append "?v=" cache-busters to these URLs (tried, reverted - broke MM core's own script-vs-style detection entirely). public/vendor/suncalc.js is deliberately vendored, not MM core's own window.SunCalc (incompatible units/versions across core releases).
	getScripts: function () {
		this.cacheBust = Date.now();
		return [
			this.file("public/vendor/suncalc.js"),
			this.file("presets/atmosphere.js"),
			this.file("presets/earthTextures.js"),
			this.file("presets/backgrounds.js"),
			this.file("presets/camera.js"),
			this.file("presets/cities.js"),
			this.file("presets/themes.js"),
			this.file("presets/themes-user.js"),
			this.file("public/EarthCompositor.js"),
			this.file("public/Earth3DRenderer.js")
		];
	},

	// --- Preset/theme validation: runs once at startup, drops a malformed preset with a warning instead of crashing the module ---

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

	// --- Config resolution: MM's default merge is shallow (a set atmosphere.altitude loses sibling fields), so the raw override is captured here to re-apply as the highest-priority layer after theme/preset resolution ---

	captureUserOverrides: function () {
		this.userOverrides = {
			rotationSpeed: this.config.rotationSpeed !== this.defaults.rotationSpeed ? this.config.rotationSpeed : undefined,
			quality: this.config.quality !== this.defaults.quality ? this.config.quality : undefined,
			atmosphere: this.captureOverride("atmosphere"),
			texture: this.captureOverride("texture"),
			background: this.captureOverride("background", ["starfield"]),
			camera: this.captureOverride("camera", ["rotate", "position"]),
			dayNight: this.captureOverride("dayNight"),
			clouds: this.captureOverride("clouds"),
			flights: this.captureOverride("flights"),
			city: this.captureOverride("city")
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

	// Resolves theme + per-asset preset + explicit overrides into a complete this.config - used at start() and via applyLiveConfig on live updates, one path for both.
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
		this.resolveAssetConfig("background", theme, ["starfield"]);
		this.resolveAssetConfig("camera", theme, ["rotate", "position"]);
		this.resolveDirectConfig("dayNight", theme, []);
		this.resolveDirectConfig("clouds", theme, []);
		this.resolveDirectConfig("flights", theme, []);
		this.resolveCity();
	},

	// city isn't preset/theme-driven - a ";"-separated list of names resolved via findCity(), one marker per name; top-level lat/lng/matchedName mirror the first entry.
	resolveCity: function () {
		const override = this.userOverrides.city;
		const name = (override && override.name !== undefined) ? override.name : this.defaults.city.name;
		const cities = String(name || "").split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const match = findCity(part);
				if (!match) {
					Log.warn(this.name + ': no city found matching "' + part + '"');
				}
				return {
					name: part,
					lat: match ? match.lat : null,
					lng: match ? match.lng : null,
					matchedName: match ? match.name : null
				};
			});
		this.config.city = {
			name,
			cities,
			lat: cities.length ? cities[0].lat : null,
			lng: cities.length ? cities[0].lng : null,
			matchedName: cities.length ? cities[0].matchedName : null
		};
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

	// atmosphere/texture/camera: a theme can point at another preset's id (string) or supply literal values inline (object) - either way, unmentioned fields fall back to the module default.
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

	// dayNight/clouds: no preset-registry indirection, just default < theme's inline object < user override.
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

	// Shared by preset/theme/override merging: copies payload's fields onto resolved, normalizing [x,y,z] shorthand into {x,y,z} for deep fields.
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

	// Merges a live-update patch into the tracked override - a field value of `null` deletes the key so resolveConfig() falls through to preset/theme/default again, instead of pinning a stale resolved value.
	mergeOverride: function (assetType, patch, deepKeys) {
		// Deliberately {} not a copy of this.defaults[assetType] - an override must stay sparse, or a single-field update would bake in and discard the rest of a theme's asset payload.
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
			// position:fixed to the viewport sidesteps MM's region/container chain, so the globe fills the screen instead of needing a guessed size.
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

	// The renderer needs the container attached to the live DOM to measure its size, so it's built after MM's initial DOM pass completes.
	notificationReceived: function (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.debugLog("DOM_OBJECTS_CREATED - constructing Earth3DRenderer");
			const container = document.getElementById("earth3d-" + this.identifier);
			this.renderer = new Earth3DRenderer(container, this.config, this.cacheBust, (patch) => this.handleInteractiveCameraChange(patch));
			this.renderer.setServerTimeOffset(this.serverTimeOffsetMs);
			return;
		}

		if (notification === "EARTH3D_SET_CONFIG") {
			this.handleSetConfig("notification", payload);
		}
	},

	// Same live-tune entry point as notificationReceived's EARTH3D_SET_CONFIG, but from this module's own node_helper (POST /MMM-Earth3D/set-config), which is what control.html actually uses.
	socketNotificationReceived: function (notification, payload) {
		if (notification === "EARTH3D_SET_CONFIG") {
			this.handleSetConfig("socket", payload);
			return;
		}

		if (notification === "EARTH3D_SERVER_TIME") {
			this.serverTimeOffsetMs = payload.now - Date.now();
			this.debugLog("EARTH3D_SERVER_TIME", payload, "offsetMs:", this.serverTimeOffsetMs);
			if (this.renderer) {
				this.renderer.setServerTimeOffset(this.serverTimeOffsetMs);
			}
			return;
		}

		// Live position from node_helper's OpenSky poller - not a config change, so bypasses handleSetConfig()/applyLiveConfig() and goes straight to the renderer.
		if (notification === "EARTH3D_FLIGHT_POSITION") {
			this.debugLog("EARTH3D_FLIGHT_POSITION", payload);
			if (this.renderer) {
				this.renderer.updateFlightPosition(payload);
			}
			return;
		}

		// control.html's Home page buttons need the resolved config/overrides - answered via node_helper's GET /MMM-Earth3D/config, which relays the request/reply here.
		if (notification === "EARTH3D_REQUEST_CONFIG") {
			// this.config.flightCredentials is never sent here - the exact "echoed back verbatim over the LAN" path defaults.flightCredentials exists to protect against.
			const safeConfig = Object.assign({}, this.config);
			delete safeConfig.flightCredentials;
			this.sendSocketNotification("EARTH3D_CONFIG_STATE", {
				config: safeConfig,
				overrides: this.userOverrides
			});
		}
	},

	// Shared by both delivery paths above - warns unconditionally when the renderer isn't ready yet, since a dropped update is otherwise completely silent.
	handleSetConfig: function (via, payload) {
		this.debugLog("EARTH3D_SET_CONFIG via " + via, JSON.stringify(payload), "renderer ready:", Boolean(this.renderer));
		if (!this.renderer) {
			Log.warn(this.name + ": EARTH3D_SET_CONFIG received via " + via + " before the renderer was ready - ignoring: " + JSON.stringify(payload));
			return;
		}
		this.applyLiveConfig(payload || {});
	},

	// Fired by Earth3DRenderer.js's Shift+drag/scroll interaction once a gesture ends - the renderer already reflects the change live, this just pins it into the tracked override so it survives future resolveConfig() calls and shows up next time control.html reads this.config over EARTH3D_REQUEST_CONFIG.
	handleInteractiveCameraChange: function (patch) {
		this.debugLog("handleInteractiveCameraChange", JSON.stringify(patch));
		this.mergeOverride("camera", Object.assign({ preset: "custom" }, patch), ["rotate", "position"]);
		this.resolveConfig();
	},

	// Tells node_helper's flight tracker the resolved flights config, so its OpenSky polling stays in sync regardless of which of the three ways a config change can arrive.
	sendFlightsState: function () {
		this.sendSocketNotification("EARTH3D_FLIGHTS_STATE", this.config.flights);
	},

	// A completely separate path from sendFlightsState() (see defaults.flightCredentials) - only sent once at start(), since config.js doesn't change without a restart.
	sendFlightCredentials: function () {
		const creds = this.config.flightCredentials;
		if (creds && creds.clientId && creds.clientSecret) {
			this.sendSocketNotification("EARTH3D_FLIGHT_CREDENTIALS", { clientId: creds.clientId, clientSecret: creds.clientSecret });
		}
	},

	// Live-tunes the running globe without a page reload - reachable via this module's own node_helper (POST /MMM-Earth3D/set-config, what control.html uses) or MMM-Remote-Control's generic notification API.
	applyLiveConfig: function (partial) {
		const themeChanged = partial.theme !== undefined;

		// Picking a theme means "give me that theme's whole look" - clear a field's override (unless this same payload also sets it directly) so an earlier override doesn't permanently outrank every future theme switch.
		if (themeChanged) {
			if (partial.rotationSpeed === undefined) {
				this.userOverrides.rotationSpeed = undefined;
			}
			if (partial.quality === undefined) {
				this.userOverrides.quality = undefined;
			}
			["atmosphere", "texture", "background", "camera", "dayNight", "clouds"].forEach((key) => {
				if (partial[key] === undefined) {
					this.userOverrides[key] = null;
				}
			});
		}

		if (partial.rotationSpeed !== undefined) {
			this.userOverrides.rotationSpeed = partial.rotationSpeed === null ? undefined : partial.rotationSpeed;
		}
		if (partial.quality !== undefined) {
			this.userOverrides.quality = partial.quality === null ? undefined : partial.quality;
		}
		if (themeChanged) {
			this.config.theme = partial.theme;
		}

		const atmosphereChanged = Boolean(partial.atmosphere);
		const textureChanged = Boolean(partial.texture);
		const backgroundChanged = Boolean(partial.background);
		const cameraChanged = Boolean(partial.camera);
		const dayNightChanged = Boolean(partial.dayNight);
		const cloudsChanged = Boolean(partial.clouds);
		const flightsChanged = Boolean(partial.flights);

		// "center" is a one-shot action, not persisted state - stripped out here so it never bakes into userOverrides.city and re-triggers on every future resolve.
		const cityPatch = partial.city ? Object.assign({}, partial.city) : null;
		const shouldCenterCity = Boolean(cityPatch && cityPatch.center);
		if (cityPatch) {
			delete cityPatch.center;
		}
		const cityChanged = Boolean(cityPatch && Object.keys(cityPatch).length > 0);

		this.debugLog("applyLiveConfig flags", { themeChanged, atmosphereChanged, textureChanged, backgroundChanged, cameraChanged, dayNightChanged, cloudsChanged, flightsChanged, cityChanged, shouldCenterCity, rotationSpeedChanged: partial.rotationSpeed !== undefined, qualityChanged: partial.quality !== undefined });

		if (atmosphereChanged) {
			this.mergeOverride("atmosphere", partial.atmosphere, []);
		}
		if (textureChanged) {
			this.mergeOverride("texture", partial.texture, []);
		}
		if (backgroundChanged) {
			this.mergeOverride("background", partial.background, ["starfield"]);
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
		if (flightsChanged) {
			this.mergeOverride("flights", partial.flights, []);
		}
		if (cityChanged) {
			this.mergeOverride("city", cityPatch, []);
		}

		const previousQuality = this.config.quality;

		if (themeChanged || atmosphereChanged || textureChanged || backgroundChanged || cameraChanged
			|| dayNightChanged || cloudsChanged || flightsChanged || cityChanged
			|| partial.rotationSpeed !== undefined || partial.quality !== undefined) {
			this.resolveConfig();
			// flightCredentials redacted even in debug output.
			const debugConfig = Object.assign({}, this.config);
			if (debugConfig.flightCredentials) {
				debugConfig.flightCredentials = "[redacted]";
			}
			this.debugLog("resolved config after applyLiveConfig", JSON.stringify(debugConfig));
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
		if (themeChanged || backgroundChanged) {
			this.renderer.applyBackground();
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
		if (flightsChanged) {
			// Not gated by themeChanged (unlike every field above) - flights is deliberately not part of theme switching.
			this.renderer.applyFlights();
			this.sendFlightsState();
		}
		if (cityChanged) {
			this.renderer.applyCity();
		}
		// After applyCity() so a combined {name, center:true} request centers on the marker it just placed, not the previous one.
		if (shouldCenterCity && this.config.city.lat !== null) {
			this.renderer.centerOnCity(this.config.city.lat, this.config.city.lng);
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

// Accepts [x, y, z] (any axis omittable) or {x, y, z} and always returns {x, y, z}, so rotate/position fields can be written either way.
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

// Looks up config.city.name in window.EARTH3D_CITIES case-insensitively: exact match, then prefix, then substring.
function findCity(query) {
	const cities = window.EARTH3D_CITIES || [];
	const needle = String(query).trim().toLowerCase();
	if (!needle) {
		return null;
	}
	return cities.find((city) => city.name.toLowerCase() === needle)
		|| cities.find((city) => city.name.toLowerCase().startsWith(needle))
		|| cities.find((city) => city.name.toLowerCase().includes(needle))
		|| null;
}
