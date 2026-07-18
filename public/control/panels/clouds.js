/*
 * Clouds panel (layers.html).
 */

let cloudsSourceEl;
let cloudsSourceHint;
let cloudsDynamicHint;
let cloudsOpacityRow;

function syncVisibility () {
	cloudsOpacityRow.classList.toggle("visible", cloudsSourceEl.value !== "disabled");
	cloudsSourceHint.classList.toggle("visible", cloudsSourceEl.value === "realtime");
	cloudsDynamicHint.classList.toggle("visible", cloudsSourceEl.value === "dynamic");
}

export function init (ctx) {
	cloudsSourceEl = document.getElementById("cloudsSource");
	cloudsSourceHint = document.getElementById("cloudsSourceHint");
	cloudsDynamicHint = document.getElementById("cloudsDynamicHint");
	cloudsOpacityRow = document.getElementById("cloudsOpacityRow");

	cloudsSourceEl.addEventListener("change", () => {
		syncVisibility();
		if (cloudsSourceEl.value === "disabled") {
			ctx.send({ clouds: { enabled: false } });
		} else {
			ctx.send({ clouds: { enabled: true, source: cloudsSourceEl.value } });
		}
	});
	ctx.bindSlider("cloudsOpacity", (value) => ctx.send({ clouds: { opacity: value / 100 } }));
	syncVisibility();
}

export function applyConfig (config, ctx) {
	cloudsSourceEl.value = config.clouds.enabled ? config.clouds.source : "disabled";
	ctx.setSliderValue("cloudsOpacity", Math.round(config.clouds.opacity * 100));
	syncVisibility();
}
