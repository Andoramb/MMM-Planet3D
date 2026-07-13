/* global SunCalc, Log */

/*
 * EarthCompositor
 * Builds the day+night texture handed to globe.gl's globeImageUrl() by
 * layering them on an offscreen canvas, then exporting a data URL. This
 * deliberately avoids touching Three.js directly for day/night (globe.gl
 * vendors its own bundled copy that isn't exposed globally) - compositing
 * into the existing texture pipeline sidesteps needing a second Three.js
 * instance for that.
 *
 * Clouds are handled differently: they're a real second sphere (see
 * CloudsLayer.mjs) for an independently-rotating, slightly-larger layer,
 * which genuinely does need Three.js geometry - but EarthCompositor still
 * owns *fetching* the clouds image (static/GIBS/fallback/poll), handing
 * the loaded image off via onCloudsImage() rather than drawing it itself.
 */

// Day/night terminator recompute interval. The terminator moves ~0.25
// deg/minute, imperceptibly slow, so this only needs to be a few minutes.
const DAY_NIGHT_RECOMPUTE_MS = 5 * 60 * 1000;

// Low-res grid for the day/night mask - the terminator is a smooth curve,
// so computing it densely and upscaling looks identical to full-res but is
// far cheaper (a full-res 8k grid would be 33M SunCalc calls per recompute).
const MASK_WIDTH = 180;
const MASK_HEIGHT = 90;

// Twilight band half-width in degrees of solar altitude, roughly matching
// civil twilight - gives a soft terminator edge instead of a hard line.
const TWILIGHT_DEG = 6;

// How much darker the clouds layer gets on the night side, when dayNight is
// enabled - multiplies the clouds texture's brightness there, blended
// smoothly across the same twilight band as the globe's own terminator.
// 0 = no darkening (clouds stay full brightness everywhere), 1 = fully
// black at full night. Tweak this to taste.
const CLOUDS_NIGHT_DARKEN = 0.65;

// NASA GIBS' underlying satellite composite only updates once per day (see
// README), so polling more often than this just re-requests the same image.
const CLOUDS_POLL_MS = 24 * 60 * 60 * 1000;

class EarthCompositor {
	constructor(config, onReady, onCloudsImage, assetPath) {
		this.config = config;
		this.onReady = onReady;
		this.onCloudsImage = onCloudsImage;
		this.assetPath = assetPath;

		this.dayImage = null;
		this.nightImage = null;
		this.cloudsRawImage = null;

		this.canvas = document.createElement("canvas");
		this.ctx = this.canvas.getContext("2d");
		this.maskCanvas = document.createElement("canvas");
		this.maskCanvas.width = MASK_WIDTH;
		this.maskCanvas.height = MASK_HEIGHT;
		this.nightScratchCanvas = document.createElement("canvas");
		this.cloudShadeCanvas = document.createElement("canvas");
		this.cloudShadeCanvas.width = MASK_WIDTH;
		this.cloudShadeCanvas.height = MASK_HEIGHT;
		this.cloudsCanvas = document.createElement("canvas");

		this.dayNightTimer = null;
		this.cloudsTimer = null;
		this.destroyed = false;
	}

	loadImage(url) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = "anonymous"; // required for toDataURL() on cross-origin sources (e.g. GIBS)
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("Failed to load image: " + url));
			img.src = url;
		});
	}

	async start(dayImageUrl) {
		this.destroyed = false;
		const tasks = [this.setDayImage(dayImageUrl, false)];
		if (!this.nightImage) {
			tasks.push(this.loadImage(this.assetPath("img/earth-night.jpg")).then((img) => {
				this.nightImage = img;
			}));
		}
		await Promise.all(tasks);
		await this.applyCloudsConfig();
		this.recompute();
		this.scheduleDayNight();
	}

	async setDayImage(url, recomputeAfter) {
		this.dayImage = await this.loadImage(url);
		if (recomputeAfter !== false) {
			this.recompute();
		}
	}

	scheduleDayNight() {
		clearInterval(this.dayNightTimer);
		if (this.config.dayNight.mode === "disabled") {
			return;
		}
		this.dayNightTimer = setInterval(() => this.recompute(), DAY_NIGHT_RECOMPUTE_MS);
	}

	// Called on init and whenever config.clouds changes. Loads the right
	// clouds image (or does nothing if disabled) and (re)starts the polling
	// schedule for realtime sources.
	async applyCloudsConfig() {
		clearTimeout(this.cloudsTimer);

		if (!this.config.clouds.enabled) {
			return;
		}

		await this.refreshClouds();
		if (this.config.clouds.source === "realtime") {
			this.cloudsTimer = setTimeout(() => this.applyCloudsConfig(), CLOUDS_POLL_MS);
		}
	}

	async refreshClouds() {
		const url = this.config.clouds.source === "realtime" ? this.buildGibsUrl() : this.assetPath("img/clouds-static.png");
		try {
			this.cloudsRawImage = await this.loadImage(url);
		} catch (err) {
			// GIBS is an external service and can fail/timeout - fall back to
			// the vendored static texture rather than showing nothing.
			Log.warn("MMM-Earth3D: clouds image failed to load (" + err.message + "), falling back to static clouds");
			try {
				this.cloudsRawImage = await this.loadImage(this.assetPath("img/clouds-static.png"));
			} catch (fallbackErr) {
				return; // no-op: keep whatever clouds image (if any) was already showing
			}
		}
		this.recomputeClouds(null);
	}

	// NASA GIBS' Worldview Snapshot API. Note: the underlying satellite
	// composite only updates once per day (see README) - polling more often
	// just re-requests the same image until that daily update lands.
	buildGibsUrl() {
		const date = new Date().toISOString().slice(0, 10);
		return "https://wvs.earthdata.nasa.gov/api/v1/snapshot"
			+ "?REQUEST=GetSnapshot&TIME=" + date
			+ "&BBOX=-90,-180,90,180&CRS=EPSG:4326"
			+ "&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor"
			+ "&WRAP=x&FORMAT=image/jpeg&WIDTH=2048&HEIGHT=1024";
	}

	recompute() {
		if (this.destroyed || !this.dayImage) {
			return;
		}

		const width = this.dayImage.naturalWidth;
		const height = this.dayImage.naturalHeight;
		this.canvas.width = width;
		this.canvas.height = height;

		this.ctx.clearRect(0, 0, width, height);
		this.ctx.drawImage(this.dayImage, 0, 0, width, height);

		// Computed once and shared with recomputeClouds() below so toggling/
		// polling day-night doesn't run the SunCalc grid twice per tick.
		const dayNightEnabled = this.config.dayNight.mode !== "disabled";
		const grid = dayNightEnabled ? this.computeAltitudeGrid() : null;

		if (dayNightEnabled && this.nightImage) {
			this.drawNightOverlay(width, height, grid);
		}

		this.onReady(this.canvas.toDataURL("image/jpeg", 0.85));

		this.recomputeClouds(grid);
	}

	// Grid of solar altitude (degrees), one entry per mask pixel - shared by
	// drawNightOverlay (globe night-lights alpha) and buildCloudShadeMask
	// (clouds darkening) so both derive from the exact same terminator.
	computeAltitudeGrid() {
		const mode = this.config.dayNight.mode;
		const now = new Date();
		// custom mode: fixed subsolar point at the equator, longitude set by
		// config.dayNight.rotate (0-360 -> -180..180) - no real astronomy.
		const customLng = ((this.config.dayNight.rotate % 360) + 360) % 360 - 180;

		const grid = new Float32Array(MASK_WIDTH * MASK_HEIGHT);
		for (let y = 0; y < MASK_HEIGHT; y++) {
			const lat = 90 - (y / (MASK_HEIGHT - 1)) * 180;
			for (let x = 0; x < MASK_WIDTH; x++) {
				const lng = (x / (MASK_WIDTH - 1)) * 360 - 180;
				grid[y * MASK_WIDTH + x] = mode === "realtime"
					? SunCalc.getPosition(now, lat, lng).altitude
					: solarAltitudeDeg(lat, lng, 0, customLng);
			}
		}
		return grid;
	}

	drawNightOverlay(width, height, grid) {
		const maskCtx = this.maskCanvas.getContext("2d");
		const imageData = maskCtx.createImageData(MASK_WIDTH, MASK_HEIGHT);
		for (let i = 0; i < grid.length; i++) {
			const idx = i * 4;
			imageData.data[idx] = 255;
			imageData.data[idx + 1] = 255;
			imageData.data[idx + 2] = 255;
			imageData.data[idx + 3] = nightAlpha(grid[i]);
		}
		maskCtx.putImageData(imageData, 0, 0);

		this.nightScratchCanvas.width = width;
		this.nightScratchCanvas.height = height;
		const nightCtx = this.nightScratchCanvas.getContext("2d");
		nightCtx.globalCompositeOperation = "source-over";
		nightCtx.clearRect(0, 0, width, height);
		nightCtx.drawImage(this.nightImage, 0, 0, width, height);
		nightCtx.globalCompositeOperation = "destination-in";
		nightCtx.drawImage(this.maskCanvas, 0, 0, width, height);

		this.ctx.drawImage(this.nightScratchCanvas, 0, 0);
	}

	// Darkens the clouds texture on the night side to match the globe's own
	// day/night shading. `grid` is an already-computed altitude grid (passed
	// by recompute()) or null (called standalone from refreshClouds(), e.g.
	// after a fresh GIBS fetch, where it computes its own).
	recomputeClouds(grid) {
		if (this.destroyed || !this.cloudsRawImage) {
			return;
		}

		const width = this.cloudsRawImage.naturalWidth;
		const height = this.cloudsRawImage.naturalHeight;
		this.cloudsCanvas.width = width;
		this.cloudsCanvas.height = height;
		const ctx = this.cloudsCanvas.getContext("2d");
		ctx.clearRect(0, 0, width, height);
		ctx.drawImage(this.cloudsRawImage, 0, 0, width, height);

		if (this.config.dayNight.mode !== "disabled") {
			this.buildCloudShadeMask(grid || this.computeAltitudeGrid());
			ctx.globalCompositeOperation = "multiply";
			ctx.drawImage(this.cloudShadeCanvas, 0, 0, width, height);
			// "multiply" composites alpha too (Porter-Duff source-over on the
			// alpha channel), and cloudShadeCanvas is fully opaque - so the
			// line above also inflates alpha to ~1 everywhere it touches,
			// wiping out the clouds PNG's own transparent "no cloud"
			// background. Re-clip to the original per-pixel alpha shape
			// (destination-in keeps the just-darkened RGB, only rescales
			// alpha by the source's) - same masking technique drawNightOverlay
			// uses above, just applied to restore rather than to punch in.
			ctx.globalCompositeOperation = "destination-in";
			ctx.drawImage(this.cloudsRawImage, 0, 0, width, height);
			ctx.globalCompositeOperation = "source-over";
		}

		this.onCloudsImage(this.cloudsCanvas);
	}

	// Builds a multiply-darken mask: white (unchanged) on the day side,
	// fading to gray (see CLOUDS_NIGHT_DARKEN above) on the night side.
	buildCloudShadeMask(grid) {
		const ctx = this.cloudShadeCanvas.getContext("2d");
		const imageData = ctx.createImageData(MASK_WIDTH, MASK_HEIGHT);
		for (let i = 0; i < grid.length; i++) {
			const idx = i * 4;
			const shade = 255 - Math.round(nightAlpha(grid[i]) * CLOUDS_NIGHT_DARKEN);
			imageData.data[idx] = shade;
			imageData.data[idx + 1] = shade;
			imageData.data[idx + 2] = shade;
			imageData.data[idx + 3] = 255;
		}
		ctx.putImageData(imageData, 0, 0);
	}

	destroy() {
		this.destroyed = true;
		clearInterval(this.dayNightTimer);
		clearTimeout(this.cloudsTimer);
	}
}

// Standard spherical solar-altitude formula (equivalent to 90 minus the
// great-circle angular distance to the subsolar point).
function solarAltitudeDeg(lat, lng, subsolarLat, subsolarLng) {
	const toRad = Math.PI / 180;
	const sinAlt = Math.sin(lat * toRad) * Math.sin(subsolarLat * toRad)
		+ Math.cos(lat * toRad) * Math.cos(subsolarLat * toRad) * Math.cos((lng - subsolarLng) * toRad);
	return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / toRad;
}

// 0 = full day (transparent night layer) .. 255 = full night (opaque),
// smoothly blended across the twilight band.
function nightAlpha(altitudeDeg) {
	if (altitudeDeg >= TWILIGHT_DEG) {
		return 0;
	}
	if (altitudeDeg <= -TWILIGHT_DEG) {
		return 255;
	}
	return Math.round(((TWILIGHT_DEG - altitudeDeg) / (2 * TWILIGHT_DEG)) * 255);
}
