/* global window */

/*
 * Background presets for MMM-Earth3D.
 *
 * Select one via config.background.preset = "<id>", or set
 * config.background.preset = "custom" with your own imageUrl field for a
 * fixed background of your choosing. The background is only shown at all
 * when config.background.enabled is true - see "Background" in README.md.
 *
 * Unlike presets/earthTextures.js, there's no per-resolution `images` map
 * here - the background sphere is viewed from deep inside a huge radius, so
 * a single fixed-resolution image looks the same regardless of `quality`.
 */
window.EARTH3D_PRESETS = window.EARTH3D_PRESETS || {};
window.EARTH3D_PRESETS.background = [
	{
		id: "night-sky",
		name: "Night Sky",
		background: {
			imageUrl: "img/backgrounds/night-sky.png"
		}
	},
	{
		id: "star-particles",
		name: "Star Particles",
		background: {
			// No imageUrl - flags Earth3DRenderer.js's resolveBackgroundSelection() to
			// use StarfieldLayer.mjs's real 3D point-cloud stars instead of a flat image.
			starfield: true
		}
	}
];
