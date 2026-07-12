/* global Module, Earth3DRenderer */

/*
 * MMM-Earth3D
 * A MagicMirror module for a rotating 3D Earth (globe.gl).
 */
Module.register("MMM-Earth3D", {
	// Default module config.
	defaults: {
		width: 500,
		height: 500,
		rotationSpeed: 0.3
	},

	renderer: null,

	start: function () {
		Log.info("Starting module: " + this.name);
	},

	getStyles: function () {
		return ["MMM-Earth3D.css"];
	},

	getScripts: function () {
		return [this.file("public/vendor/globe.gl.min.js"), this.file("public/Earth3DRenderer.js")];
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "MMM-Earth3D";
		wrapper.id = "earth3d-" + this.identifier;
		wrapper.style.width = this.config.width + "px";
		wrapper.style.height = this.config.height + "px";
		return wrapper;
	},

	// globe.gl needs the container attached to the live DOM to measure its
	// size, so the globe is built after MM's initial DOM pass completes.
	notificationReceived: function (notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			const container = document.getElementById("earth3d-" + this.identifier);
			this.renderer = new Earth3DRenderer(container, this.config);
		}
	},

	stop: function () {
		if (this.renderer) {
			this.renderer.destroy();
			this.renderer = null;
		}
	}
});
