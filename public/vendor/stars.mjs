// Based on tools/vendor-stars/build.mjs's bundle of @pmndrs/vanilla's Stars, hand-patched to add sizeVariation/twinkle/variation - see tools/vendor-stars/README.md before regenerating.
import * as THREE from "./three.module.min.js";
import { REVISION } from "./three.module.min.js";

const revision = parseInt(REVISION.replace(/\D+/g, ""));

class StarfieldMaterial extends THREE.ShaderMaterial {
	constructor() {
		super({
			uniforms: { time: { value: 0 }, fade: { value: 1 }, twinkle: { value: 1 }, variation: { value: 0 } },
			vertexShader: `
      uniform float time;
      uniform float twinkle;
      uniform float variation;
      attribute float size;
      attribute float phase;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 0.5);
        float pulse = 3.0;
        if (twinkle > 0.5) {
          pulse += sin(time + 100.0 + phase * variation * 6.2831853);
        }
        gl_PointSize = size * (30.0 / -mvPosition.z) * pulse;
        gl_Position = projectionMatrix * mvPosition;
      }`,
			fragmentShader: `
      uniform sampler2D pointTexture;
      uniform float fade;
      varying vec3 vColor;
      void main() {
        float opacity = 1.0;
        if (fade == 1.0) {
          float d = distance(gl_PointCoord, vec2(0.5, 0.5));
          opacity = 1.0 / (1.0 + exp(16.0 * (d - 0.25)));
        }
        gl_FragColor = vec4(vColor, opacity);

        #include <tonemapping_fragment>
        #include <${revision >= 154 ? "colorspace_fragment" : "encodings_fragment"}>
      }`
		});
	}
}

// Uniform-random point on a sphere shell at the given radius (Archimedes' theorem: cos(theta) uniform on [-1,1] avoids pole clustering).
function randomPointAtRadius(radius) {
	return new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, Math.acos(1 - Math.random() * 2), Math.random() * 2 * Math.PI));
}

export class Stars extends THREE.Points {
	constructor({ radius = 100, depth = 50, count = 5000, saturation = 0, factor = 4, fade = false, speed = 1, sizeVariation = 0.5, twinkle = true, variation = 0 } = {}) {
		super(new THREE.BufferGeometry(), new StarfieldMaterial());
		this.speed = speed;
		const material = this.material;
		material.blending = THREE.AdditiveBlending;
		material.depthWrite = false;
		material.transparent = true;
		material.vertexColors = true;
		material.needsUpdate = true;
		this.rebuildAttributes({ radius, depth, count, saturation, factor, fade, speed, sizeVariation, twinkle, variation });
	}

	// Regenerates positions/colors/sizes/phase from scratch - cheap enough to call on every live config change (a few thousand points).
	rebuildAttributes({ radius = 100, depth = 50, count = 5000, saturation = 0, factor = 4, fade = false, speed = 1, sizeVariation = 0.5, twinkle = true, variation = 0 }) {
		this.speed = speed;
		const material = this.material;
		material.uniforms.fade.value = fade ? 1 : 0;
		material.uniforms.twinkle.value = twinkle ? 1 : 0;
		material.uniforms.variation.value = variation;

		const positions = [];
		const colors = [];
		const sizes = Array.from({ length: count }, () => ((1 - sizeVariation) + sizeVariation * Math.random()) * factor);
		const phases = Array.from({ length: count }, () => Math.random() * Math.PI * 2);
		const color = new THREE.Color();
		let shellRadius = radius + depth;
		const step = depth / count;
		for (let i = 0; i < count; i++) {
			shellRadius -= step * Math.random();
			positions.push(...randomPointAtRadius(shellRadius).toArray());
			color.setHSL(i / count, saturation, 0.9);
			colors.push(color.r, color.g, color.b);
		}

		this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
		this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
		this.geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(sizes), 1));
		this.geometry.setAttribute("phase", new THREE.BufferAttribute(new Float32Array(phases), 1));
	}

	update(time) {
		this.material.uniforms.time.value = time * this.speed;
	}
}
