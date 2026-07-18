/*
 * City panel (layers.html) - a text field that sets config.city.name, a
 * ";"-separated list of one or more names (the module resolves each against
 * presets/cities.js client-side, in the browser tab actually running the
 * globe - see MMM-Earth3D.js's findCity()/resolveCity()) plus a button that
 * recenters the globe on the first configured city, without touching the
 * name field.
 */

let cityNameEl;
let cityFoundEl;
let cityCenterBtn;

export function init (ctx) {
	cityNameEl = document.getElementById("cityName");
	cityFoundEl = document.getElementById("cityFound");
	cityCenterBtn = document.getElementById("cityCenterBtn");

	// "change" (fires on blur/Enter), not "input" - looking a name up and
	// warning on no match makes sense once the user is done typing, not on
	// every keystroke of a partial name.
	cityNameEl.addEventListener("change", () => {
		ctx.send({ city: { name: cityNameEl.value } }).then(ctx.refetch);
	});

	cityCenterBtn.addEventListener("click", () => {
		ctx.send({ city: { center: true } });
	});
}

export function applyConfig (config) {
	cityNameEl.value = config.city.name || "";
	const cities = config.city.cities || [];
	cityFoundEl.textContent = cities.map((city) => city.lat !== null
		? "Found: " + city.matchedName + " (" + city.lat.toFixed(2) + ", " + city.lng.toFixed(2) + ")"
		: "No match for \"" + city.name + "\"").join(" · ");
	cityCenterBtn.disabled = config.city.lat === null;
}
