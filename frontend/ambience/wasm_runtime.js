'use strict';

window.AmbienceSim = window.AmbienceSim || { effects: {}, presets: {} };

(function (api) {
	let loadPromise = null;
	let registered = false;

	function script(src) {
		return new Promise((resolve, reject) => {
			const el = document.createElement('script');
			el.src = src;
			el.async = true;
			el.onload = resolve;
			el.onerror = () => reject(new Error('failed to load ' + src));
			document.head.appendChild(el);
		});
	}

	async function load(opts) {
		opts = opts || {};
		if (window.ambienceWasm) return window.ambienceWasm;
		if (loadPromise) return loadPromise;
		loadPromise = (async () => {
			if (!window.Go) await script(opts.wasmExecURL || '/wasm_exec.js');
			const go = new window.Go();
			const wasmURL = opts.wasmURL || '/ambience.wasm';
			let result;
			if (WebAssembly.instantiateStreaming) {
				try {
					result = await WebAssembly.instantiateStreaming(fetch(wasmURL), go.importObject);
				} catch (_) {
					const resp = await fetch(wasmURL);
					result = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
				}
			} else {
				const resp = await fetch(wasmURL);
				result = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
			}
			go.run(result.instance);
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (!window.ambienceWasm) throw new Error('ambience wasm runtime did not initialize');
			return window.ambienceWasm;
		})();
		return loadPromise;
	}

	function makeEffectClass(kind) {
		return class GoWASMEffect {
			constructor(w, h, cfg, seed) {
				if (!window.ambienceWasm) {
					throw new Error('AmbienceSim.wasm.load() must resolve before constructing ' + kind);
				}
				this.kind = kind;
				this.w = w;
				this.h = h;
				this.tick = 0;
				this.grid = new Uint8ClampedArray(w * h * 3);
				this.id = window.ambienceWasm.newRuntime(kind, w, h, String(seed || Date.now()), JSON.stringify(cfg || {}));
				if (this.id < 0) throw new Error('failed to create wasm runtime for ' + kind);
			}

			destroy() {
				if (this.id > 0 && window.ambienceWasm) window.ambienceWasm.destroy(this.id);
				this.id = 0;
			}

			setConfig(cfg) {
				window.ambienceWasm.setConfig(this.id, JSON.stringify(cfg || {}));
			}

			restoreSnapshot(snap) {
				window.ambienceWasm.restoreSnapshot(this.id, JSON.stringify(snap || {}));
				this.w = window.ambienceWasm.width(this.id) || this.w;
				this.h = window.ambienceWasm.height(this.id) || this.h;
				this.tick = window.ambienceWasm.tick(this.id) || 0;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}

			triggerEvent(name) {
				return !!window.ambienceWasm.triggerEvent(this.id, name);
			}

			step() {
				window.ambienceWasm.step(this.id);
				this.tick = window.ambienceWasm.tick(this.id) || this.tick;
			}

			render(ctx, canvasW, canvasH, opts) {
				this.grid = window.ambienceWasm.frame(this.id);
				api._helpers.renderPixelGridEffect(this, ctx, canvasW, canvasH, opts);
			}
		};
	}

	function registerAll() {
		if (!window.ambienceWasm) throw new Error('AmbienceSim.wasm.load() must resolve before registerAll()');
		const effects = Array.from(window.ambienceWasm.supportedEffects());
		for (const kind of effects) {
			api.effects[kind] = makeEffectClass(kind);
		}
		registered = true;
		return effects;
	}

	async function ready(opts) {
		await load(opts);
		if (!registered) registerAll();
		return api.wasm;
	}

	api.wasm = api.wasm || {};
	api.wasm.load = load;
	api.wasm.ready = ready;
	api.wasm.registerAll = registerAll;
	api.wasm.makeEffectClass = makeEffectClass;
})(window.AmbienceSim);
