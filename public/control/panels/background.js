// Background panel (planet-env.html) - single select combining on/off and preset choice, "Disabled" last.

let backgroundSelectEl;
let backgroundHintEl;
let starfieldControlsEl;
let starfieldColorEl;
let starfieldFadingEl;
let starfieldEffectVariationRow;
let starfieldEffectSpeedRow;

function syncHint () {
	backgroundHintEl.classList.toggle("visible", backgroundSelectEl.value !== "disabled");
	starfieldControlsEl.classList.toggle("visible", backgroundSelectEl.value === "star-particles");
}

function syncFadingRows () {
	const fading = starfieldFadingEl.checked;
	starfieldEffectVariationRow.classList.toggle("visible", fading);
	starfieldEffectSpeedRow.classList.toggle("visible", fading);
}

export function init (ctx) {
	backgroundSelectEl = document.getElementById("backgroundPreset");
	backgroundHintEl = document.getElementById("backgroundHint");
	starfieldControlsEl = document.getElementById("starfieldControls");
	starfieldColorEl = document.getElementById("starfieldColor");
	starfieldFadingEl = document.getElementById("starfieldFading");
	starfieldEffectVariationRow = document.getElementById("starfieldEffectVariationRow");
	starfieldEffectSpeedRow = document.getElementById("starfieldEffectSpeedRow");

	const presets = (window.EARTH3D_PRESETS && window.EARTH3D_PRESETS.background) || [];
	for (const preset of presets) {
		const option = document.createElement("option");
		option.value = preset.id;
		option.textContent = preset.name;
		backgroundSelectEl.append(option);
	}
	const disabledOption = document.createElement("option");
	disabledOption.value = "disabled";
	disabledOption.textContent = "Disabled";
	backgroundSelectEl.append(disabledOption);

	backgroundSelectEl.addEventListener("change", () => {
		syncHint();
		if (backgroundSelectEl.value === "disabled") {
			ctx.send({ background: { enabled: false } });
		} else {
			ctx.send({ background: { enabled: true, preset: backgroundSelectEl.value } });
		}
	});

	function sendStarfield (patch) {
		ctx.send({ background: { starfield: patch } });
	}

	ctx.bindSlider("starfieldCount", (value) => sendStarfield({ count: Math.round(value) }));
	ctx.bindSlider("starfieldSize", (value) => sendStarfield({ size: value / 100 }));
	ctx.bindSlider("starfieldSizeVariation", (value) => sendStarfield({ sizeVariation: value / 100 }));
	starfieldColorEl.addEventListener("input", () => sendStarfield({ color: starfieldColorEl.value }));
	ctx.bindSlider("starfieldColorVariation", (value) => sendStarfield({ colorVariation: value / 100 }));
	starfieldFadingEl.addEventListener("change", () => {
		syncFadingRows();
		sendStarfield({ fading: starfieldFadingEl.checked });
	});
	ctx.bindSlider("starfieldEffectVariation", (value) => sendStarfield({ effectVariation: value / 100 }));
	ctx.bindSlider("starfieldEffectSpeed", (value) => sendStarfield({ effectSpeed: value / 100 }));

	syncHint();
	syncFadingRows();
}

export function applyConfig (config, ctx) {
	backgroundSelectEl.value = config.background.enabled ? config.background.preset : "disabled";
	const starfield = config.background.starfield;
	ctx.setSliderValue("starfieldCount", starfield.count);
	ctx.setSliderValue("starfieldSize", Math.round(starfield.size * 100));
	ctx.setSliderValue("starfieldSizeVariation", Math.round(starfield.sizeVariation * 100));
	starfieldColorEl.value = starfield.color;
	ctx.setSliderValue("starfieldColorVariation", Math.round(starfield.colorVariation * 100));
	starfieldFadingEl.checked = Boolean(starfield.fading);
	ctx.setSliderValue("starfieldEffectVariation", Math.round(starfield.effectVariation * 100));
	ctx.setSliderValue("starfieldEffectSpeed", Math.round(starfield.effectSpeed * 100));
	syncHint();
	syncFadingRows();
}
