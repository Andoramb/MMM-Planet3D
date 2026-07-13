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
 * owns *fetching* the clouds image (static/GIBS/fallback/poll), handing the
 * loaded image off via onCloudsImage() rather than drawing it itself.
 *
 * Night-side darkening for clouds is NOT baked into that texture (see
 * onCloudsNightMask() below for why) - it's a small standalone alpha mask
 * handed to CloudsLayer.mjs, which renders it as a second, non-rotating
 * sphere over the clouds.
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

const CLOUDS_NIGHT_DARKEN = 0.85;

// NASA GIBS' underlying satellite composite only updates once per day (see
// README), so polling more often than this just re-requests the same image.
const CLOUDS_POLL_MS = 24 * 60 * 60 * 1000;

class EarthCompositor {
	constructor(config, onReady, onCloudsImage, onCloudsNightMask, assetPath) {
		this.config = config;
		this.onReady = onReady;
		this.onCloudsImage = onCloudsImage;
		this.onCloudsNightMask = onCloudsNightMask;
		this.assetPath = assetPath;

		this.dayImage = null;
		this.nightImage = null;
		this.cloudsRawImage = null;
		this.serverTimeOffsetMs = 0;

		this.canvas = document.createElement("canvas");
		this.ctx = this.canvas.getContext("2d");
		this.maskCanvas = document.createElement("canvas");
		this.maskCanvas.width = MASK_WIDTH;
		this.maskCanvas.height = MASK_HEIGHT;
		this.nightScratchCanvas = document.createElement("canvas");
		this.cloudMaskCanvas = document.createElement("canvas");
		this.cloudMaskCanvas.width = MASK_WIDTH;
		this.cloudMaskCanvas.height = MASK_HEIGHT;

		this.dayNightTimer = null;
		this.cloudsTimer = null;
		this.destroyed = false;
	}

	// Set once by Earth3DRenderer as soon as it hears back from node_helper
	// (see MMM-Earth3D.js's EARTH3D_SERVER_TIME handler) - realtime dayNight
	// should reflect the clock of the machine actually running MagicMirror,
	// not whichever device's browser happens to be viewing the page.
	setServerTimeOffset(offsetMs) {
		this.serverTimeOffsetMs = offsetMs;
		this.recompute();
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
		this.onCloudsImage(this.cloudsRawImage);
		this.updateCloudNightMask(null);
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

		// Computed once and shared with updateCloudNightMask() below so
		// toggling/polling day-night doesn't run the SunCalc grid twice.
		const dayNightEnabled = this.config.dayNight.mode !== "disabled";
		const grid = dayNightEnabled ? this.computeAltitudeGrid() : null;

		if (dayNightEnabled && this.nightImage) {
			this.drawNightOverlay(width, height, grid);
		}

		this.onReady(this.canvas.toDataURL("image/jpeg", 0.85));

		this.updateCloudNightMask(grid);
	}

	// Grid of solar altitude (degrees), one entry per mask pixel - shared by
	// drawNightOverlay (globe night-lights alpha) and buildCloudNightMask
	// (clouds darkening) so both derive from the exact same terminator.
	computeAltitudeGrid() {
		const mode = this.config.dayNight.mode;
		const now = new Date(Date.now() + this.serverTimeOffsetMs);
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

	// Hands CloudsLayer.mjs a small black/transparent alpha mask (or null)
	// to render as its own separate, non-rotating shell over the clouds -
	// deliberately NOT baked as darkened pixels into the clouds texture
	// itself: CloudsLayer spins the clouds mesh independently for a parallax
	// effect, so anything baked into *its* texture drifts out of alignment
	// with the true terminator as it rotates. A separate mesh that's parented
	// alongside (not nested under) the spinning clouds mesh inherits only the
	// globe's own orientation, so it stays correctly aligned with the real
	// day/night line - realtime or custom - no matter how the clouds drift.
	updateCloudNightMask(grid) {
		if (this.destroyed || !this.cloudsRawImage) {
			return;
		}
		if (this.config.dayNight.mode === "disabled") {
			this.onCloudsNightMask(null);
			return;
		}
		this.buildCloudNightMask(grid || this.computeAltitudeGrid());
		this.onCloudsNightMask(this.cloudMaskCanvas);
	}

	// Black, alpha = nightAlpha * CLOUDS_NIGHT_DARKEN - transparent on the
	// day side, fading to a translucent black shell on the night side.
	buildCloudNightMask(grid) {
		const ctx = this.cloudMaskCanvas.getContext("2d");
		const imageData = ctx.createImageData(MASK_WIDTH, MASK_HEIGHT);
		for (let i = 0; i < grid.length; i++) {
			const idx = i * 4;
			imageData.data[idx] = 0;
			imageData.data[idx + 1] = 0;
			imageData.data[idx + 2] = 0;
			imageData.data[idx + 3] = Math.round(nightAlpha(grid[i]) * CLOUDS_NIGHT_DARKEN);
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
