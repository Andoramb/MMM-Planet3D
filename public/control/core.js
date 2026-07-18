// Shared core for the control panel - scans each page for [data-panel="<name>"], dynamically imports panels/<name>.js, and mounts it (exports: init(ctx), applyConfig(config, ctx)).

// Mirrors MMM-Earth3D.js's `defaults` - keep in sync if those change.
export const MODULE_DEFAULTS = {
	rotationSpeed: 20,
	atmosphere: { color: "#4aa8ff", altitude: 0.15, opacity: 1 },
	camera: { zoom: 50, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0 } }
};

const statusEl = document.getElementById("status");

function setStatus (message, isError) {
	statusEl.textContent = message;
	statusEl.className = "status" + (isError ? " error" : "");
}

// --- Networking ---------------------------------------------------------

let debounceTimer = null;

// Returns a Promise so callers that need it can chain .then(refetch) - plain slider drags just fire-and-forget it.
function send (payload) {
	clearTimeout(debounceTimer);
	return new Promise((resolve, reject) => {
		debounceTimer = setTimeout(() => {
			fetch("/MMM-Earth3D/set-config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			})
				.then((res) => {
					if (!res.ok) {
						throw new Error("Request failed (" + res.status + ")");
					}
					setStatus("Updated " + new Date().toLocaleTimeString());
					resolve();
				})
				.catch((err) => {
					setStatus(err.message, true);
					reject(err);
				});
		}, 120);
	});
}

function postThemeAction (body) {
	return fetch("/MMM-Earth3D/theme", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})
		.then((res) => res.json().then((data) => {
			if (!res.ok) {
				throw new Error(data.error || ("Request failed (" + res.status + ")"));
			}
			return data;
		}))
		.then((data) => {
			setStatus(data.message || "Theme updated");
			window.location.reload();
		})
		.catch((err) => setStatus(err.message, true));
}

// --- Resolved config readback: asks node_helper (GET /MMM-Earth3D/config), which relays to the real module instance for the actual resolution ---

let currentConfig = null;
let currentOverrides = {};

function fetchResolvedConfig () {
	return fetch("/MMM-Earth3D/config")
		.then((res) => {
			if (!res.ok) {
				return res.json().then((body) => {
					throw new Error((body && body.error) || ("Request failed (" + res.status + ")"));
				});
			}
			return res.json();
		})
		.then((state) => {
			currentConfig = state.config;
			currentOverrides = state.overrides || {};
			panels.forEach((panel) => panel.applyConfig && panel.applyConfig(currentConfig, ctx));
		})
		.catch((err) => setStatus(err.message, true));
}

// --- Shared DOM helpers -------------------------------------------------

function bindSlider (id, onChange) {
	const input = document.getElementById(id);
	const valueEl = document.getElementById(id + "-val");
	input.addEventListener("input", () => {
		if (valueEl) {
			valueEl.textContent = input.value;
		}
		onChange(Number(input.value));
	});
}

function setSliderValue (id, value) {
	document.getElementById(id).value = value;
	const valueEl = document.getElementById(id + "-val");
	if (valueEl) {
		valueEl.textContent = value;
	}
}

// firstId pulls that preset (e.g. an atmosphere "Disabled" entry) ahead of the "Custom" option.
function populatePresetSelect (selectEl, presets, includeCustom, firstId) {
	while (selectEl.firstChild) {
		selectEl.removeChild(selectEl.firstChild);
	}

	const appendOption = (preset) => {
		const option = document.createElement("option");
		option.value = preset.id;
		option.textContent = preset.name;
		selectEl.append(option);
	};

	const firstPreset = firstId ? (presets || []).find((entry) => entry.id === firstId) : null;
	if (firstPreset) {
		appendOption(firstPreset);
	}
	if (includeCustom) {
		appendOption({ id: "custom", name: "Custom" });
	}
	for (const preset of presets || []) {
		if (preset === firstPreset) {
			continue;
		}
		appendOption(preset);
	}
}

function findPreset (assetType, id) {
	const list = (window.EARTH3D_PRESETS && window.EARTH3D_PRESETS[assetType]) || [];
	return list.find((entry) => entry.id === id);
}

// Built-in and user-created (gitignored presets/themes-user.js) themes as one combined list, for resolveThemeValue() below and reset (↺) buttons.
const themes = (window.EARTH3D_THEMES || []).concat(window.EARTH3D_USER_THEMES || []);
const defaultThemeIds = new Set((window.EARTH3D_THEMES || []).map((theme) => theme.id));

// Resolves a field's value without any manual override: preset -> active theme -> hardcoded default. Feeds the reset (↺) buttons' target values.
function resolveThemeValue (assetType, presetSelectEl, field, deepKey) {
	const presetId = presetSelectEl.value;
	if (presetId !== "custom") {
		const preset = findPreset(assetType, presetId);
		if (preset) {
			const payload = preset[assetType];
			return deepKey ? payload[deepKey][field] : payload[field];
		}
	}

	const themeId = currentConfig ? currentConfig.theme : "custom";
	if (themeId !== "custom") {
		const theme = themes.find((entry) => entry.id === themeId);
		if (theme && theme[assetType]) {
			const preset = findPreset(assetType, theme[assetType]);
			if (preset) {
				const payload = preset[assetType];
				return deepKey ? payload[deepKey][field] : payload[field];
			}
		}
	}

	const fallback = MODULE_DEFAULTS[assetType];
	return deepKey ? fallback[deepKey][field] : fallback[field];
}

// --- Panel context: passed to every panel module's init()/applyConfig() ---

const ctx = {
	send,
	postThemeAction,
	setStatus,
	bindSlider,
	setSliderValue,
	populatePresetSelect,
	findPreset,
	resolveThemeValue,
	MODULE_DEFAULTS,
	themes,
	defaultThemeIds,
	getOverrides: () => currentOverrides,
	refetch: fetchResolvedConfig
};

// --- Panel discovery ------------------------------------------------

const panelNames = Array.from(new Set(
	Array.from(document.querySelectorAll("[data-panel]")).map((el) => el.dataset.panel)
));
let panels = [];

Promise.all(panelNames.map((name) => import(`./panels/${name}.js`)))
	.then((modules) => {
		panels = modules;
		panels.forEach((panel) => panel.init && panel.init(ctx));
		return fetchResolvedConfig();
	})
	.catch((err) => setStatus("Failed to load control panel: " + err.message, true));
