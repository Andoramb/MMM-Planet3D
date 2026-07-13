const fs = require("fs");
const path = require("path");
const vm = require("vm");
const NodeHelper = require("node_helper");
const express = require("express");
const Log = require("logger");

const THEMES_FILE = path.join(__dirname, "presets", "themes.js");
const THEMES_ASSIGNMENT = "window.EARTH3D_THEMES = ";

// How long to wait for the module's front-end to answer an
// EARTH3D_REQUEST_CONFIG round-trip before giving up on a GET
// /MMM-Earth3D/config request - generous, since it's just socket.io
// same-host latency, but bounded so a caller (e.g. control.html) never hangs
// forever if the module isn't loaded/running.
const CONFIG_REQUEST_TIMEOUT_MS = 3000;

/*
 * node_helper for MMM-Earth3D
 *
 * Three jobs, all existing to let control.html (or curl, or any other client
 * on the LAN) drive the running globe without needing MMM-Remote-Control
 * installed:
 *
 * - POST /MMM-Earth3D/set-config relays its body to the module over MM's
 *   normal node_helper<->module socket channel; MMM-Earth3D.js's
 *   socketNotificationReceived() does the actual work via applyLiveConfig().
 * - GET /MMM-Earth3D/config asks the module (over that same socket channel)
 *   for its current resolved config + active overrides, and answers the HTTP
 *   request with whatever it replies - this is how control.html finds out
 *   what a theme switch (or anything else) actually resolved to, since that
 *   resolution logic lives client-side in the browser tab running the actual
 *   module, not here.
 * - POST /MMM-Earth3D/theme reads/rewrites presets/themes.js directly on
 *   disk - control.html's Duplicate/Save/Delete theme buttons. Editing that
 *   file doesn't affect an already-running module instance (same as hand-
 *   editing any other presets/*.js file - needs a reload/restart to pick up),
 *   only what a *future* load of the page sees.
 *
 * express.json() is applied only to routes that need it (not app-wide) since
 * MM core doesn't register a body parser on the shared Express app itself,
 * and other modules' routes shouldn't be affected by a parser they didn't
 * ask for.
 *
 * Also relays server time on request: EARTH3D_REQUEST_SERVER_TIME ->
 * EARTH3D_SERVER_TIME with this process's Date.now() - so realtime dayNight
 * uses the clock of the machine actually running MagicMirror, not whichever
 * device's browser happens to be viewing the page (which could be a laptop
 * on a different timezone/clock opening the server remotely).
 */
module.exports = NodeHelper.create({
	start: function () {
		this.pendingConfigRequests = [];

		this.expressApp.post("/MMM-Earth3D/set-config", express.json(), (req, res) => {
			// Unconditional (not gated by config.debug - that's a client-side
			// setting this server-side code has no visibility into anyway):
			// low-frequency, and the single most useful line for telling "the
			// request never reached the server" apart from "it arrived but the
			// browser dropped it" when a live-tune silently does nothing.
			Log.info("[MMM-Earth3D node_helper] set-config: " + JSON.stringify(req.body || {}));
			this.sendSocketNotification("EARTH3D_SET_CONFIG", req.body || {});
			res.json({ success: true });
		});

		this.expressApp.get("/MMM-Earth3D/config", (req, res) => {
			const timer = setTimeout(() => {
				this.pendingConfigRequests = this.pendingConfigRequests.filter((entry) => entry.res !== res);
				res.status(504).json({ error: "Timed out waiting for MMM-Earth3D to report its config - is MagicMirror running with the module loaded?" });
			}, CONFIG_REQUEST_TIMEOUT_MS);
			this.pendingConfigRequests.push({ res, timer });
			this.sendSocketNotification("EARTH3D_REQUEST_CONFIG");
		});

		this.expressApp.post("/MMM-Earth3D/theme", express.json(), (req, res) => {
			try {
				const result = this.handleThemeAction(req.body || {});
				Log.info("[MMM-Earth3D node_helper] theme " + (req.body || {}).action + ": " + result.message);
				res.json(Object.assign({ success: true }, result));
			} catch (err) {
				Log.error("[MMM-Earth3D node_helper] theme action failed: " + err.message);
				res.status(400).json({ error: err.message });
			}
		});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "EARTH3D_REQUEST_SERVER_TIME") {
			this.sendSocketNotification("EARTH3D_SERVER_TIME", { now: Date.now() });
			return;
		}

		if (notification === "EARTH3D_CONFIG_STATE") {
			const pending = this.pendingConfigRequests;
			this.pendingConfigRequests = [];
			pending.forEach((entry) => {
				clearTimeout(entry.timer);
				entry.res.json(payload);
			});
		}
	},

	// --- Theme file management (presets/themes.js) --------------------------

	handleThemeAction: function (body) {
		const { header, themes } = readThemes();

		if (body.action === "duplicate") {
			return this.duplicateTheme(header, themes, body);
		}
		if (body.action === "save") {
			return this.saveThemeOverrides(header, themes, body);
		}
		if (body.action === "delete") {
			return this.deleteTheme(header, themes, body);
		}
		throw new Error('Unknown theme action "' + body.action + '"');
	},

	duplicateTheme: function (header, themes, body) {
		const source = themes.find((entry) => entry.id === body.sourceId);
		if (!source) {
			throw new Error('No theme with id "' + body.sourceId + '"');
		}
		const name = (body.name || (source.name + " copy")).trim();
		if (!name) {
			throw new Error("New theme name can't be empty");
		}
		const id = uniqueId(themes, slugify(name));
		const clone = JSON.parse(JSON.stringify(source));
		clone.id = id;
		clone.name = name;
		themes.push(clone);
		writeThemes(header, themes);
		return { id, message: 'Duplicated "' + source.name + '" as "' + name + '"' };
	},

	// Merges only the fields the caller says are actively overridden
	// (body.overrides, the module's sparse userOverrides - not a full
	// resolved-config snapshot) into the theme's existing entry, so
	// untouched fields keep whatever the theme already had instead of being
	// pinned to today's resolved value.
	saveThemeOverrides: function (header, themes, body) {
		const index = themes.findIndex((entry) => entry.id === body.themeId);
		if (index === -1) {
			throw new Error('No theme with id "' + body.themeId + '"');
		}
		const overrides = body.overrides || {};
		const theme = Object.assign({}, themes[index]);

		if (overrides.rotationSpeed !== undefined) {
			theme.rotationSpeed = overrides.rotationSpeed;
		}
		if (overrides.quality !== undefined) {
			theme.quality = overrides.quality;
		}
		if (overrides.atmosphere) {
			theme.atmosphere = mergeAssetOverride(theme.atmosphere, overrides.atmosphere, []);
		}
		if (overrides.texture) {
			theme.texture = mergeAssetOverride(theme.texture, overrides.texture, []);
		}
		if (overrides.camera) {
			theme.camera = mergeAssetOverride(theme.camera, overrides.camera, ["rotate", "position"]);
		}
		if (overrides.dayNight) {
			theme.dayNight = Object.assign({}, theme.dayNight, overrides.dayNight);
		}
		if (overrides.clouds) {
			theme.clouds = Object.assign({}, theme.clouds, overrides.clouds);
		}

		themes[index] = theme;
		writeThemes(header, themes);
		return { message: 'Saved current settings into "' + theme.name + '"' };
	},

	deleteTheme: function (header, themes, body) {
		const index = themes.findIndex((entry) => entry.id === body.themeId);
		if (index === -1) {
			throw new Error('No theme with id "' + body.themeId + '"');
		}
		const [removed] = themes.splice(index, 1);
		writeThemes(header, themes);
		return { message: 'Deleted "' + removed.name + '"' };
	}
});

// Splits off everything before the `window.EARTH3D_THEMES = ` assignment
// (the file's hand-written doc-comment header) so writeThemes() can put it
// back afterward - a machine-rewritten themes.js still reads like it was
// written by a person. Evaluated via `vm` rather than JSON.parse since the
// file is real JS (unquoted keys, [x,y,z] array shorthand, comments) - this
// is our own trusted local file, not user input, so running it is fine.
function readThemes() {
	const source = fs.readFileSync(THEMES_FILE, "utf8");
	const index = source.indexOf(THEMES_ASSIGNMENT);
	if (index === -1) {
		throw new Error('presets/themes.js doesn\'t contain the expected "' + THEMES_ASSIGNMENT + '" assignment');
	}
	const header = source.slice(0, index);
	const sandbox = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: THEMES_FILE });
	const themes = Array.isArray(sandbox.window.EARTH3D_THEMES) ? sandbox.window.EARTH3D_THEMES : [];
	return { header, themes };
}

function writeThemes(header, themes) {
	fs.writeFileSync(THEMES_FILE, header + THEMES_ASSIGNMENT + JSON.stringify(themes, null, "\t") + ";\n");
}

function slugify(name) {
	return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "theme";
}

function uniqueId(themes, base) {
	let id = base;
	let suffix = 2;
	while (themes.some((entry) => entry.id === id)) {
		id = base + "-" + suffix;
		suffix++;
	}
	return id;
}

// Merges a sparse override patch into a theme's existing asset field, which
// may currently be a bare preset-id string (e.g. "close-up"), a literal
// object, or absent - mirrors MMM-Earth3D.js's own mergeOverride() semantics
// (null deletes a key) closely enough for the save-to-theme use case.
function mergeAssetOverride(themeValue, override, deepKeys) {
	const base = typeof themeValue === "string" ? { preset: themeValue }
		: (themeValue && typeof themeValue === "object") ? Object.assign({}, themeValue)
			: {};

	Object.keys(override).forEach((key) => {
		if (deepKeys.indexOf(key) !== -1) {
			return;
		}
		if (override[key] === null) {
			delete base[key];
		} else {
			base[key] = override[key];
		}
	});
	deepKeys.forEach((key) => {
		if (!override[key]) {
			return;
		}
		base[key] = Object.assign({}, base[key], override[key]);
	});

	// Collapse back down to a bare preset-id string if that's all this
	// field ends up being - matches how most existing theme entries
	// reference a preset rather than spelling out its fields inline.
	const keys = Object.keys(base);
	if (keys.length === 1 && keys[0] === "preset" && base.preset && base.preset !== "custom") {
		return base.preset;
	}
	return base;
}
