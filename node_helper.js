const fs = require("fs");
const path = require("path");
const vm = require("vm");
const NodeHelper = require("node_helper");
const express = require("express");
const Log = require("logger");
const { createFlightTracker } = require("./lib/flightTracker");

const THEMES_FILE = path.join(__dirname, "presets", "themes.js");
const THEMES_ASSIGNMENT = "window.EARTH3D_THEMES = ";

// User-created themes (control.html's Duplicate/Save/Delete buttons) live in a separate gitignored file, never presets/themes.js, so customizations never conflict with an upstream pull.
const USER_THEMES_FILE = path.join(__dirname, "presets", "themes-user.js");
const USER_THEMES_ASSIGNMENT = "window.EARTH3D_USER_THEMES = ";
const USER_THEMES_HEADER = "/* global window */\n\n"
	+ "// User-created MMM-Earth3D themes (control.html's Duplicate/Save/Delete buttons) - never presets/themes.js, gitignored, same format, hand-editable.\n";

const CONTROL_PANEL_DIR = path.join(__dirname, "public", "control");

// OpenSky OAuth2 client credentials - plain JSON (not the vm-evaluated presets/*.js convention), gitignored, never served to any client. Optional - anonymous access needs no file.
const FLIGHT_CREDENTIALS_FILE = path.join(__dirname, "presets", "flight-credentials.json");

// How long to wait for the module's front-end to answer an EARTH3D_REQUEST_CONFIG round-trip before a GET /MMM-Earth3D/config request gives up.
const CONFIG_REQUEST_TIMEOUT_MS = 3000;

// node_helper for MMM-Earth3D: lets control.html (or curl, or any LAN client) drive the running globe, manage themes, and run the Flight layer's OpenSky polling loop - without needing MMM-Remote-Control installed.
module.exports = NodeHelper.create({
	start: function () {
		// Best-effort - the theme HTTP route below has its own try/catch, so a failure here doesn't take down every other route.
		try {
			ensureUserThemesFile();
		} catch (err) {
			Log.error("[MMM-Earth3D node_helper] could not create presets/themes-user.js (" + err.message + ") - theme save/duplicate will fail until this is fixed");
		}
		this.pendingConfigRequests = [];

		this.flightTracker = createFlightTracker({
			sendSocketNotification: (notification, payload) => this.sendSocketNotification(notification, payload),
			credentialsFile: FLIGHT_CREDENTIALS_FILE
		});

		// Short-URL alias for the control panel, on the shared Express app rather than namespaced under /MMM-Earth3D/....
		this.expressApp.use("/earth3d", express.static(CONTROL_PANEL_DIR));
		this.expressApp.get("/earth3d.html", (req, res) => res.redirect("/earth3d/home.html"));

		this.expressApp.post("/MMM-Earth3D/set-config", express.json(), (req, res) => {
			// Unconditional (not gated by config.debug, a client-side setting this server code can't see) - the key line for telling "never reached the server" apart from "browser dropped it".
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

		this.expressApp.get("/MMM-Earth3D/flights/status", (req, res) => {
			res.json(this.flightTracker.getStatus());
		});

		this.expressApp.get("/MMM-Earth3D/flights/credentials", (req, res) => {
			res.json({ configured: this.flightTracker.getCredentialsConfigured() });
		});

		this.expressApp.post("/MMM-Earth3D/flights/credentials", express.json(), (req, res) => {
			try {
				this.flightTracker.setCredentials(req.body || {});
				Log.info("[MMM-Earth3D node_helper] flight credentials " + ((req.body || {}).clear ? "cleared" : "updated"));
				res.json({ success: true, configured: this.flightTracker.getCredentialsConfigured() });
			} catch (err) {
				res.status(400).json({ error: err.message });
			}
		});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "EARTH3D_REQUEST_SERVER_TIME") {
			this.sendSocketNotification("EARTH3D_SERVER_TIME", { now: Date.now() });
			return;
		}

		if (notification === "EARTH3D_FLIGHTS_STATE") {
			this.flightTracker.configure(payload);
			return;
		}

		// config.js's flightCredentials reuses the same setCredentials() the control panel's POST /MMM-Earth3D/flights/credentials calls - sent once per module start(), not on every config change.
		if (notification === "EARTH3D_FLIGHT_CREDENTIALS") {
			try {
				this.flightTracker.setCredentials(payload);
				Log.info("[MMM-Earth3D node_helper] flight credentials set from config.js");
			} catch (err) {
				Log.error("[MMM-Earth3D node_helper] config.js flightCredentials rejected: " + err.message);
			}
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

	// --- Theme file management (presets/themes.js + presets/themes-user.js) ---

	handleThemeAction: function (body) {
		// Retried here (not just at startup) in case start()'s attempt failed but the cause has since been fixed.
		ensureUserThemesFile();
		const defaultThemes = readThemesFile(THEMES_FILE, THEMES_ASSIGNMENT).themes;
		const { header, themes: userThemes } = readThemesFile(USER_THEMES_FILE, USER_THEMES_ASSIGNMENT);
		const allThemes = defaultThemes.concat(userThemes);

		if (body.action === "duplicate") {
			return this.duplicateTheme(header, allThemes, userThemes, body);
		}
		if (body.action === "save") {
			return this.saveThemeOverrides(header, defaultThemes, userThemes, body);
		}
		if (body.action === "delete") {
			return this.deleteTheme(header, defaultThemes, userThemes, body);
		}
		throw new Error('Unknown theme action "' + body.action + '"');
	},

	// allThemes is only used to find the source and keep the new id unique - the clone itself always goes into userThemes/themes-user.js.
	duplicateTheme: function (header, allThemes, userThemes, body) {
		const source = allThemes.find((entry) => entry.id === body.sourceId);
		if (!source) {
			throw new Error('No theme with id "' + body.sourceId + '"');
		}
		const name = (body.name || (source.name + " copy")).trim();
		if (!name) {
			throw new Error("New theme name can't be empty");
		}
		const id = uniqueId(allThemes, slugify(name));
		const clone = JSON.parse(JSON.stringify(source));
		clone.id = id;
		clone.name = name;
		userThemes.push(clone);
		writeThemesFile(USER_THEMES_FILE, header, USER_THEMES_ASSIGNMENT, userThemes);
		return { id, message: 'Duplicated "' + source.name + '" as "' + name + '"' };
	},

	// Only ever writes userThemes/themes-user.js - saving over a built-in theme isn't supported (duplicate it first).
	saveThemeOverrides: function (header, defaultThemes, userThemes, body) {
		const index = userThemes.findIndex((entry) => entry.id === body.themeId);
		if (index === -1) {
			if (defaultThemes.some((entry) => entry.id === body.themeId)) {
				throw new Error("Can't save over a built-in theme - duplicate it first, then save into the copy");
			}
			throw new Error('No theme with id "' + body.themeId + '"');
		}
		const overrides = body.overrides || {};
		const theme = Object.assign({}, userThemes[index]);

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
		if (overrides.background) {
			theme.background = mergeAssetOverride(theme.background, overrides.background, ["starfield"]);
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

		userThemes[index] = theme;
		writeThemesFile(USER_THEMES_FILE, header, USER_THEMES_ASSIGNMENT, userThemes);
		return { message: 'Saved current settings into "' + theme.name + '"' };
	},

	deleteTheme: function (header, defaultThemes, userThemes, body) {
		const index = userThemes.findIndex((entry) => entry.id === body.themeId);
		if (index === -1) {
			if (defaultThemes.some((entry) => entry.id === body.themeId)) {
				throw new Error("Can't delete a built-in theme");
			}
			throw new Error('No theme with id "' + body.themeId + '"');
		}
		const [removed] = userThemes.splice(index, 1);
		writeThemesFile(USER_THEMES_FILE, header, USER_THEMES_ASSIGNMENT, userThemes);
		return { message: 'Deleted "' + removed.name + '"' };
	}
});

function ensureUserThemesFile() {
	if (fs.existsSync(USER_THEMES_FILE)) {
		return;
	}
	fs.writeFileSync(USER_THEMES_FILE, USER_THEMES_HEADER + USER_THEMES_ASSIGNMENT + "[];\n");
}

// Splits off the header so writeThemesFile() can put it back - evaluated via `vm` (not JSON.parse) since these are real JS files, and both are trusted local files.
function readThemesFile(file, assignment) {
	const source = fs.readFileSync(file, "utf8");
	const index = source.indexOf(assignment);
	if (index === -1) {
		throw new Error(path.basename(file) + ' doesn\'t contain the expected "' + assignment + '" assignment');
	}
	const header = source.slice(0, index);
	const sandbox = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: file });
	const globalName = assignment.slice("window.".length, -3); // "window.EARTH3D_THEMES = " -> "EARTH3D_THEMES"
	const themes = Array.isArray(sandbox.window[globalName]) ? sandbox.window[globalName] : [];
	return { header, themes };
}

function writeThemesFile(file, header, assignment, themes) {
	fs.writeFileSync(file, header + assignment + JSON.stringify(themes, null, "\t") + ";\n");
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

// Merges a sparse override patch into a theme's asset field (bare preset-id string, literal object, or absent) - mirrors MMM-Earth3D.js's mergeOverride() (null deletes a key).
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

	// Collapse back to a bare preset-id string if that's all this field is, matching how most theme entries reference a preset.
	const keys = Object.keys(base);
	if (keys.length === 1 && keys[0] === "preset" && base.preset && base.preset !== "custom") {
		return base.preset;
	}
	return base;
}
