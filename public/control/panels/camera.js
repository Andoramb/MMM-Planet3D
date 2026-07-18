// Camera panel (planet-env.html) - spans the "Camera" and "Position" fieldsets, both against the same config.camera object/preset.

let cameraPresetEl;

export function init (ctx) {
	cameraPresetEl = document.getElementById("cameraPreset");
	const cameraPresets = (window.EARTH3D_PRESETS && window.EARTH3D_PRESETS.camera) || [];
	ctx.populatePresetSelect(cameraPresetEl, cameraPresets, true);

	// Touching any manual camera/position slider switches the preset select back to "custom".
	function sendCustomCamera (cameraPatch) {
		cameraPresetEl.value = "custom";
		ctx.send({ camera: Object.assign({ preset: "custom" }, cameraPatch) });
	}

	ctx.bindSlider("zoom", (value) => sendCustomCamera({ zoom: value }));
	ctx.bindSlider("rotateX", (value) => sendCustomCamera({ rotate: { x: value } }));
	ctx.bindSlider("rotateY", (value) => sendCustomCamera({ rotate: { y: value } }));
	ctx.bindSlider("rotateZ", (value) => sendCustomCamera({ rotate: { z: value } }));
	ctx.bindSlider("positionX", (value) => sendCustomCamera({ position: { x: value } }));
	ctx.bindSlider("positionY", (value) => sendCustomCamera({ position: { y: value } }));

	cameraPresetEl.addEventListener("change", () => {
		if (cameraPresetEl.value === "custom") {
			ctx.send({ camera: { preset: "custom" } });
			return;
		}
		const preset = cameraPresets.find((entry) => entry.id === cameraPresetEl.value);
		if (!preset) {
			return;
		}
		ctx.setSliderValue("zoom", preset.camera.zoom);
		ctx.setSliderValue("rotateX", preset.camera.rotate.x);
		ctx.setSliderValue("rotateY", preset.camera.rotate.y);
		ctx.setSliderValue("rotateZ", preset.camera.rotate.z);
		ctx.setSliderValue("positionX", preset.camera.position.x);
		ctx.setSliderValue("positionY", preset.camera.position.y);
		ctx.send({ camera: { preset: preset.id } });
	});

	function bindCameraReset (target, field, deepKey) {
		document.querySelector(`[data-reset-target="${target}"]`).addEventListener("click", () => {
			const value = ctx.resolveThemeValue("camera", cameraPresetEl, field, deepKey);
			ctx.setSliderValue(target, value);
			const patch = deepKey ? { [deepKey]: { [field]: null } } : { [field]: null };
			ctx.send({ camera: patch });
		});
	}
	bindCameraReset("zoom", "zoom");
	bindCameraReset("rotateX", "x", "rotate");
	bindCameraReset("rotateY", "y", "rotate");
	bindCameraReset("rotateZ", "z", "rotate");
	bindCameraReset("positionX", "x", "position");
	bindCameraReset("positionY", "y", "position");

	// Shift+drag/scroll on the live display moves the globe/zoom directly, bypassing this panel - poll so those changes still show up here without a manual reload. Skipped while a camera slider is focused so it can't yank a value out from under an in-progress local drag.
	const liveSyncIds = ["zoom", "rotateX", "rotateY", "rotateZ", "positionX", "positionY"];
	setInterval(() => {
		if (document.visibilityState !== "visible" || liveSyncIds.includes(document.activeElement && document.activeElement.id)) {
			return;
		}
		ctx.refetch();
	}, 1000);
}

export function applyConfig (config, ctx) {
	cameraPresetEl.value = config.camera.preset;
	ctx.setSliderValue("zoom", config.camera.zoom);
	ctx.setSliderValue("rotateX", config.camera.rotate.x);
	ctx.setSliderValue("rotateY", config.camera.rotate.y);
	ctx.setSliderValue("rotateZ", config.camera.rotate.z);
	ctx.setSliderValue("positionX", config.camera.position.x);
	ctx.setSliderValue("positionY", config.camera.position.y);
}
