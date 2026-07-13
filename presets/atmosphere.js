/* global window */

/*
 * Atmosphere presets for MMM-Earth3D.
 *
 * Select one via config.atmosphere.preset = "<id>", or leave
 * config.atmosphere.preset = "custom" (the default) to use the manual
 * color/altitude/opacity fields in config.js instead.
 *
 * Each entry's fields live under an "atmosphere" key matching the config
 * property they configure, so preset application is just
 * Object.assign(config.atmosphere, preset.atmosphere). The renderer only
 * uses color/altitude/opacity today, but unknown fields are safely
 * ignored - add more here later without needing a schema migration.
 */
window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
window.EARTH3D_PRESETS.atmosphere = [
	{
		id: "none",
		name: "Disabled",
		atmosphere: { color: "#ffffff", altitude: 0, opacity: 0 }
	},
	{
		id: "realistic",
		name: "Realistic",
		atmosphere: { color: "#4aa8ff", altitude: 0.15, opacity: 1 }
	},
	{
		id: "vivid",
		name: "Vivid Blue",
		atmosphere: { color: "#66ccff", altitude: 0.22, opacity: 1 }
	},
	{
		id: "subtle",
		name: "Subtle Haze",
		atmosphere: { color: "#a8c8ff", altitude: 0.08, opacity: 0.6 }
	}
];
