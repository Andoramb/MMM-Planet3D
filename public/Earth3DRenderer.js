/* global Globe, EarthCompositor, Log */

// Matches three-globe's internal GLOBE_RADIUS (world units) - needed here
// so CloudsLayer can size its sphere relative to the actual globe surface.
const GLOBE_RADIUS = 100;

/*
 * Earth3DRenderer
 * Owns the globe.gl/WebGL scene for MMM-Earth3D. Kept separate from the
 * MagicMirror module file so future features (clouds, day/night, markers,
 * live data overlays) grow here without touching MM lifecycle code.
 */

// rotationSpeed config (0-100) maps onto degrees/second of manual spin.
const ROTATION_SPEED_MAX_DEG_PER_SEC = 10; // 100 -> full revolution every 36s

// camera.zoom config (0-100) maps onto pointOfView's altitude (globe radii).
const ZOOM_ALTITUDE_MIN = 0.5; // 0   -> close
const ZOOM_ALTITUDE_MAX = 5; // 100 -> far

// Live config changes ease in over this long instead of jumping.
const TRANSITION_MS = 700;

// How often to check whether another opaque layer (e.g. a sibling
// fullscreen_below module stacked on top in the DOM) is fully covering the
// globe. A plain interval instead of a per-frame check since this only needs
// to catch layout/stacking changes, not animate anything.
const OCCLUSION_CHECK_MS = 1000;

// quality presets: sphere tessellation (lower curvatureResolution = more
// polygons = smoother), antialiasing (renderer construction option, can't
// change after init), a device-pixel-ratio cap, and which resolution key
// to request from the active texture preset's `images` map.
const QUALITY_PRESETS = {
	low: { curvatureResolution: 10, antialias: false, maxPixelRatio: 1, textureRes: "2k" },
	medium: { curvatureResolution: 6, antialias: true, maxPixelRatio: 1, textureRes: "2k" },
	high: { curvatureResolution: 3, antialias: true, maxPixelRatio: 2, textureRes: "4k" },
	ultra: { curvatureResolution: 1, antialias: true, maxPixelRatio: 3, textureRes: "8k" }
};

// Eases a single number from its current value to a target over a fixed
// duration. Used for every live-tunable property so changes glide in
// smoothly instead of jumping.
class TweenedValue {
	constructor(initial) {
		this.current = initial;
		this.from = initial;
		this.to = initial;
		this.startTime = 0;
		this.duration = 0;
	}

	setTarget(value, durationMs) {
		if (value === this.to) {
			return;
		}
		this.from = this.current;
		this.to = value;
		this.startTime = performance.now();
		this.duration = durationMs;
	}

	update(now) {
		if (this.duration <= 0) {
			this.current = this.to;
			return;
		}
		const t = Math.min((now - this.startTime) / this.duration, 1);
		this.current = this.from + (this.to - this.from) * easeInOutCubic(t);
		if (t >= 1) {
			this.duration = 0;
		}
	}
}

class Earth3DRenderer {
	constructor(container, config) {
		this.container = container;
		this.config = config;
		this.globe = null;
		this.globeObject3D = null;
		this.compositor = null;
		this.cloudsLayer = null;
		this.destroyed = false;
		this.animating = false;

		const { rotate, position } = config.camera;
		this.tiltX = new TweenedValue(rotate.x);
		this.tiltY = new TweenedValue(rotate.y);
		this.tiltZ = new TweenedValue(rotate.z);
		this.posX = new TweenedValue(position.x);
		this.posY = new TweenedValue(position.y);
		this.posZ = new TweenedValue(position.z);
		this.spinRate = new TweenedValue(rotationSpeedToDegPerSec(config.rotationSpeed));
		this.spinAngle = 0;
		this.lastFrameTime = null;

		this.init();

		// container.style.width/height may be a fixed px value or "100vw"/"100vh"
		// (fullscreen_* positions) - either way globe.gl itself needs concrete
		// pixel dimensions, so track the container's actual rendered size
		// instead of trusting config.width/height, and keep it in sync as the
		// screen/window resizes.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);

		// Several MM setups stack more than one fullscreen_below module (e.g.
		// a background slideshow/wallpaper module alongside this one) with no
		// explicit z-index, so whichever loads last simply paints over the
		// others. When that happens the globe is still fully rendering every
		// frame for nothing - pause the actual WebGL draw loop (globe.gl's own
		// internal animate loop, not our tick()) while it's covered, and
		// resume as soon as it's back on top.
		this.occluded = false;
		this.occlusionInterval = setInterval(() => this.checkOcclusion(), OCCLUSION_CHECK_MS);
	}

	// Hit-tests the container's center point. This only catches occlusion by
	// an element with default pointer-events (like an <img>/<video> background
	// layer) - a sibling that sets pointer-events:none on its covering
	// element would still visually hide the globe but pass this check, since
	// elementFromPoint skips non-hit-testable elements. Good enough for the
	// common "another fullscreen_below module paints over this one" case.
	checkOcclusion() {
		if (this.destroyed || !this.globe) {
			return;
		}
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			return;
		}
		const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		const occluded = !topElement || !this.container.contains(topElement);
		if (occluded === this.occluded) {
			return;
		}
		this.occluded = occluded;
		if (occluded) {
			this.globe.pauseAnimation();
		} else {
			this.globe.resumeAnimation();
		}
	}

	// Falls back to config.width/height (then 500) only for the brief window
	// before the container has been laid out at all - once attached, the
	// measured size always wins.
	getContainerSize() {
		const rect = this.container.getBoundingClientRect();
		return {
			width: Math.round(rect.width) || this.config.width || 500,
			height: Math.round(rect.height) || this.config.height || 500
		};
	}

	handleResize() {
		if (!this.globe) {
			return;
		}
		const size = this.getContainerSize();
		this.globe.width(size.width).height(size.height);
	}

	init() {
		const quality = QUALITY_PRESETS[this.config.quality] || QUALITY_PRESETS.high;
		const textures = this.resolveTextureUrls();
		const size = this.getContainerSize();

		this.globe = new Globe(this.container, {
			rendererConfig: { antialias: quality.antialias, alpha: true }
		})
			.width(size.width)
			.height(size.height)
			.backgroundColor("rgba(0,0,0,0)")
			.bumpImageUrl(textures.bump)
			.globeCurvatureResolution(quality.curvatureResolution);
		// globeImageUrl (the color map) is set by the compositor below, once
		// it has finished layering day/night.

		this.applyAtmosphere();

		this.globe.renderer().setPixelRatio(Math.min(quality.maxPixelRatio, window.devicePixelRatio));

		const controls = this.globe.controls();
		// Spin is applied manually each frame (see tick()) around the globe's
		// own local axis, so it correctly follows any fixed tilt. OrbitControls'
		// built-in autoRotate always orbits the camera around the world's
		// vertical axis instead, which looks wrong once the globe is tilted.
		controls.autoRotate = false;
		controls.enableZoom = false;

		this.applyZoom();

		this.ensureCloudsLayer();

		if (!this.compositor) {
			this.compositor = new EarthCompositor(
				this.config,
				(dataUrl) => {
					if (this.globe) {
						this.globe.globeImageUrl(dataUrl);
					}
				},
				(image) => {
					this.pendingCloudsImage = image;
					if (this.cloudsLayer) {
						this.applyCloudsImage(image);
					}
				},
				(path) => this.assetPath(path)
			);
		}
		this.compositor.start(textures.image);

		// A freshly constructed Globe always starts animating - applyQuality()
		// rebuilds it, so re-apply whatever occlusion state was already known.
		if (this.occluded) {
			this.globe.pauseAnimation();
		}

		// The globe mesh isn't added to the scene synchronously (globe.gl
		// debounces its internal update digest), so poll until it appears.
		this.waitForGlobeObject();

		if (!this.animating) {
			this.animating = true;
			requestAnimationFrame((now) => this.tick(now));
		}
	}

	// Live-update entry points: config is shared by reference with the
	// MMM-Earth3D module instance, so callers mutate this.config first and
	// then call the matching apply*() to ease the live globe.gl scene toward it.

	applyRotationSpeed() {
		this.spinRate.setTarget(rotationSpeedToDegPerSec(this.config.rotationSpeed), TRANSITION_MS);
	}

	applyZoom() {
		this.globe.pointOfView({ altitude: this.zoomToAltitude(this.config.camera.zoom) }, TRANSITION_MS);
	}

	applyGlobeTransform() {
		const { rotate, position } = this.config.camera;
		this.tiltX.setTarget(rotate.x, TRANSITION_MS);
		this.tiltY.setTarget(rotate.y, TRANSITION_MS);
		this.tiltZ.setTarget(rotate.z, TRANSITION_MS);
		this.posX.setTarget(position.x, TRANSITION_MS);
		this.posY.setTarget(position.y, TRANSITION_MS);
		this.posZ.setTarget(position.z, TRANSITION_MS);
	}

	// Antialiasing is a WebGLRenderer construction option and can't be
	// changed on an existing context, so quality changes rebuild the globe.
	// Tween/spin state is left untouched so tilt/position/rotation continue
	// smoothly across the rebuild. This also re-picks the texture resolution
	// key (2k/4k/8k) matching the new quality tier.
	applyQuality() {
		// Destroy cloudsLayer BEFORE the globe: its mesh is a child of the
		// globe group, and globe._destructor() recursively disposes every
		// child's geometry/material/texture (see three-render-objects'
		// emptyObject/_deallocate) - detaching and disposing it here first
		// avoids a double-dispose and means we don't try to reuse
		// now-invalid GPU resources afterwards. init() builds a fresh
		// cloudsLayer and re-fetches the clouds image via the compositor.
		if (this.cloudsLayer) {
			this.cloudsLayer.destroy();
			this.cloudsLayer = null;
		}
		if (this.globe) {
			this.globe._destructor();
			this.globe = null;
		}
		this.globeObject3D = null;
		this.init();
	}

	// showAtmosphere/atmosphereColor/atmosphereAltitude are regular
	// chainable props (unlike antialiasing), so this applies live with no
	// rebuild. opacity isn't a native globe.gl concept - approximated here
	// as a visibility threshold until/unless real alpha blending is added.
	applyAtmosphere() {
		const { color, altitude, opacity } = this.config.atmosphere;
		const visible = opacity > 0;
		this.globe.showAtmosphere(visible);
		if (visible) {
			this.globe.atmosphereColor(color).atmosphereAltitude(altitude);
		}
	}

	// bumpImageUrl is a regular chainable prop, so it applies live. The
	// color map goes through the compositor instead of globeImageUrl
	// directly, since the night layer blends on top of it.
	applyTexture() {
		const textures = this.resolveTextureUrls();
		if (textures.bump) {
			this.globe.bumpImageUrl(textures.bump);
		}
		this.compositor.setDayImage(textures.image);
	}

	// Live-update entry points for the day/night and clouds layers.
	applyDayNight() {
		this.compositor.scheduleDayNight();
		this.compositor.recompute();
	}

	applyClouds() {
		if (this.cloudsLayer) {
			this.cloudsLayer.setOpacity(this.config.clouds.opacity);
			this.cloudsLayer.setVisible(this.config.clouds.enabled);
		}
		this.compositor.applyCloudsConfig();
	}

	resolveTextureUrls() {
		const texture = this.config.texture;
		if (texture.preset === "custom" && texture.imageUrl) {
			return {
				image: texture.imageUrl,
				bump: texture.bumpImageUrl || null
			};
		}

		const preset = (window.EARTH3D_PRESETS.texture || []).find((entry) => entry.id === texture.preset);
		if (!preset) {
			return { image: null, bump: null };
		}

		const quality = QUALITY_PRESETS[this.config.quality] || QUALITY_PRESETS.high;
		const images = preset.texture.images;
		const image = images[quality.textureRes] || images["4k"] || Object.values(images)[0];
		const bump = preset.texture.bumpImage;

		return {
			image: image ? this.assetPath(image) : null,
			bump: bump ? this.assetPath(bump) : null
		};
	}

	zoomToAltitude(zoom) {
		const t = clamp(zoom, 0, 100) / 100;
		return ZOOM_ALTITUDE_MIN + t * (ZOOM_ALTITUDE_MAX - ZOOM_ALTITUDE_MIN);
	}

	// CloudsLayer.mjs is an ES module (it needs a real Three.js import, unlike
	// the other classic-script assets) - loaded here via a dynamic import()
	// rather than through MM's getScripts(), since MM core's own loader only
	// recognizes a fixed set of file extensions that varies by core version
	// with no default/fallback case, so an unrecognized one (older cores
	// don't have an "mjs" case at all) silently never loads the file, with
	// no error. A native dynamic import() bypasses that entirely and works
	// the same on any MM core version. Constructing this is async either
	// way, so the rest of init() (texture, resize tracking, the tick loop -
	// none of which have anything to do with clouds) doesn't wait on it.
	ensureCloudsLayer() {
		if (this.cloudsLayer || this.cloudsLayerImporting || this.destroyed) {
			return;
		}
		this.cloudsLayerImporting = true;
		// A relative specifier here resolves against this script's own file
		// URL (not the page's, and not MM's basePath config) since dynamic
		// import() in a classic script uses the referencing script's base URL
		// - CloudsLayer.mjs sits right next to this file, so "./" is enough.
		import("./CloudsLayer.mjs")
			.then((module) => {
				this.cloudsLayerImporting = false;
				if (this.destroyed || this.cloudsLayer) {
					return;
				}
				this.cloudsLayer = new module.CloudsLayer(GLOBE_RADIUS);
				if (this.pendingCloudsImage) {
					this.applyCloudsImage(this.pendingCloudsImage);
				}
				if (this.globeObject3D) {
					this.cloudsLayer.attachTo(this.globeObject3D);
				}
			})
			.catch((err) => {
				this.cloudsLayerImporting = false;
				Log.error("MMM-Earth3D: failed to load CloudsLayer.mjs (" + err.message + ") - clouds will stay disabled");
			});
	}

	applyCloudsImage(image) {
		this.cloudsLayer.setTexture(image);
		this.cloudsLayer.setOpacity(this.config.clouds.opacity);
		this.cloudsLayer.setVisible(this.config.clouds.enabled);
		if (this.globeObject3D) {
			this.cloudsLayer.attachTo(this.globeObject3D);
		}
	}

	waitForGlobeObject() {
		if (this.destroyed) {
			return;
		}
		// The globe mesh is the sole Group-type child of the scene (skysphere
		// is a Mesh, lights have their own types) - not officially documented
		// by globe.gl, but reliable across the installed version.
		const globeObject = this.globe.scene().children.find((child) => child.type === "Group");
		if (globeObject) {
			this.globeObject3D = globeObject;
			if (this.cloudsLayer) {
				this.cloudsLayer.attachTo(globeObject);
			}
		} else {
			requestAnimationFrame(() => this.waitForGlobeObject());
		}
	}

	tick(now) {
		if (this.destroyed) {
			this.animating = false;
			return;
		}

		const deltaSeconds = this.lastFrameTime !== null ? (now - this.lastFrameTime) / 1000 : 0;
		this.lastFrameTime = now;

		this.tiltX.update(now);
		this.tiltY.update(now);
		this.tiltZ.update(now);
		this.posX.update(now);
		this.posY.update(now);
		this.posZ.update(now);
		this.spinRate.update(now);
		this.spinAngle += degToRad(this.spinRate.current) * deltaSeconds;
		if (this.cloudsLayer) {
			this.cloudsLayer.tick(now);
		}

		if (this.globeObject3D) {
			// Reset to the (tweened) fixed tilt, then apply the total
			// accumulated spin as a local-axis rotation on top of it, so the
			// spin always turns around the globe's own (tilted) polar axis.
			this.globeObject3D.rotation.set(degToRad(this.tiltX.current), degToRad(this.tiltY.current), degToRad(this.tiltZ.current));
			this.globeObject3D.rotateY(this.spinAngle);
			this.globeObject3D.position.set(this.posX.current, this.posY.current, this.posZ.current);

			// The camera and its OrbitControls target are deliberately left
			// untouched here. Earlier this followed the globe's position, but
			// OrbitControls keeps a fixed offset from its target - moving the
			// target off-axis (X/Y) forced the camera to rotate to keep facing
			// it, which is what looked like the globe "rotating" instead of
			// panning. With a static camera, moving the globe object is a
			// clean world-space translation on all three axes: X/Y pan across
			// the screen, and Z happens to align with the camera's viewing
			// direction, which is why it already looked like zoom.
		}

		requestAnimationFrame((t) => this.tick(t));
	}

	assetPath(relativePath) {
		return "modules/MMM-Earth3D/public/" + relativePath;
	}

	destroy() {
		this.destroyed = true;
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.occlusionInterval) {
			clearInterval(this.occlusionInterval);
			this.occlusionInterval = null;
		}
		if (this.compositor) {
			this.compositor.destroy();
			this.compositor = null;
		}
		if (this.cloudsLayer) {
			this.cloudsLayer.destroy();
			this.cloudsLayer = null;
		}
		if (this.globe) {
			this.globe._destructor();
			this.globe = null;
			this.globeObject3D = null;
		}
	}
}

function rotationSpeedToDegPerSec(speed) {
	return (clamp(speed, 0, 100) / 100) * ROTATION_SPEED_MAX_DEG_PER_SEC;
}

function degToRad(deg) {
	return (deg * Math.PI) / 180;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
