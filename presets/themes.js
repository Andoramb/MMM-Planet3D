/* global window */

// Themes: named bundles covering any config field, selected via config.theme (or "custom" to set fields individually) - see "Custom themes" in README.md.
window.EARTH3D_THEMES = [
	{
		id: "realistic",
		name: "Realistic Earth",
		atmosphere: "realistic",
		texture: "blue-marble",
		camera: "default"
	},
	{
		id: "minimal",
		name: "Minimal",
		// For low-end/constrained hardware: lowest quality tier, no spin, every optional layer off.
		rotationSpeed: 0,
		quality: "low",
		atmosphere: "none",
		texture: "blue-marble",
		camera: "wide",
		dayNight: { mode: "disabled" },
		clouds: { enabled: false }
	},
	{
		id: "close-up",
		name: "Close-up",
		atmosphere: "subtle",
		texture: "blue-marble",
		camera: "close-up"
	},
	{
		id: "mission-control",
		name: "Mission Control",
		rotationSpeed: 35,
		quality: "ultra",
		atmosphere: { color: "#7fd4ff", altitude: 0.18 },
		texture: "blue-marble",
		camera: {
			zoom: 40,
			rotate: [15, 0, 0], // array shorthand for { x: 15, y: 0, z: 0 }
			position: [0, 0] // array shorthand for { x: 0, y: 0 }
		},
		dayNight: { mode: "realtime" },
		clouds: { enabled: true, source: "static" }
	}
];
