/* global window */

/*
 * Earth texture presets for MMM-Earth3D.
 *
 * Select one via config.texture.preset = "<id>", or set
 * config.texture.preset = "custom" with your own imageUrl/bumpImageUrl
 * fields for a single fixed texture regardless of the quality tier.
 *
 * `images` maps resolution keys ("2k"/"4k"/"8k") to files under public/ -
 * the renderer picks the resolution matching the current `quality` config
 * (low/medium -> 2k, high -> 4k, ultra -> 8k). Add a new preset here with
 * its own set of vendored images to create another named texture style
 * (e.g. a future "night-lights" or "mars" preset).
 */
// Stored under the "texture" key (matching config.texture), not
// "earthTextures" - this file just groups the earth-texture-specific
// presets together for readability, per the project's presets/ layout.
window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
window.EARTH3D_PRESETS.texture = [
	{
		id: "blue-marble",
		name: "NASA Blue Marble",
		texture: {
			images: {
				"2k": "img/earth-2k.jpg",
				"4k": "img/earth-4k.jpg",
				"8k": "img/earth-8k.jpg"
			},
			bumpImage: "img/earth-topology.png"
		}
	},
	{
		id: "tile-engine",
		name: "Live Tiles (NASA GIBS)",
		// tileEngine: true routes this preset through Earth3DRenderer's applyTileEngine() instead of images/bumpImage - see gibsBlueMarbleTileUrl() there.
		texture: {
			images: {},
			tileEngine: true
		}
	}
];
