/* global window */

// Camera presets - select via config.camera.preset, or "custom" for the manual zoom/rotate/position fields.
window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
window.EARTH3D_PRESETS.camera = [
	{
		id: "default",
		name: "Default",
		camera: {
			zoom: 50,
			rotate: { x: 0, y: 0, z: 0 },
			position: { x: 0, y: 0 }
		}
	},
	{
		id: "close-up",
		name: "Close-up",
		camera: {
			zoom: 85,
			rotate: { x: 0, y: 0, z: 0 },
			position: { x: 0, y: 0 }
		}
	},
	{
		id: "wide",
		name: "Wide / far",
		camera: {
			zoom: 15,
			rotate: { x: 0, y: 0, z: 0 },
			position: { x: 0, y: 0 }
		}
	},
	{
		id: "tilted-north",
		name: "Tilted north",
		camera: {
			zoom: 50,
			rotate: { x: 20, y: 0, z: 0 },
			position: { x: 0, y: 0 }
		}
	}
];
