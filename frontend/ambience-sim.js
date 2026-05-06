// sim.js holds shared browser infrastructure only: the AmbienceSim namespace,
// pixel-grid renderer, EffectTransition crossfade wrapper, and SSE subscribe()
// helper. Active effect constructors are registered by wasm_runtime.js from the
// Go sim package compiled to WebAssembly.

'use strict';

window.AmbienceSim = window.AmbienceSim || { effects: {}, presets: {} };

(function (api) {
	function makeRNG(seed) {
		let state = seed >>> 0;
		const rng = () => {
			state = (state + 0x6D2B79F5) | 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		rng.intn = (n) => (n <= 0 ? 0 : Math.floor(rng() * n));
		return rng;
	}

	function jitterInt(rng, base, spread) {
		const f = base * (1 + spread * (rng() * 2 - 1));
		return Math.max(1, Math.round(f));
	}

	function clamp01(v) {
		return Math.max(0, Math.min(1, v));
	}

	function hslToRGB(h, s, l) {
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const hp = h / 60;
		const x = c * (1 - Math.abs((hp % 2) - 1));
		let rp = 0, gp = 0, bp = 0;
		if (hp < 1)      { rp = c; gp = x; bp = 0; }
		else if (hp < 2) { rp = x; gp = c; bp = 0; }
		else if (hp < 3) { rp = 0; gp = c; bp = x; }
		else if (hp < 4) { rp = 0; gp = x; bp = c; }
		else if (hp < 5) { rp = x; gp = 0; bp = c; }
		else             { rp = c; gp = 0; bp = x; }
		const m = l - c / 2;
		const clamp = (v) => Math.max(0, Math.min(1, v));
		return {
			r: Math.round(clamp(rp + m) * 255),
			g: Math.round(clamp(gp + m) * 255),
			b: Math.round(clamp(bp + m) * 255),
		};
	}

	function positiveMod(value, mod) {
		if (mod === 0) return 0;
		return ((value % mod) + mod) % mod;
	}

	function ensurePixelGrid(effect) {
		const w = Math.max(1, effect.w | 0);
		const h = Math.max(1, effect.h | 0);
		const need = w * h * 3;
		if (!(effect.grid instanceof Uint8ClampedArray) || effect.grid.length !== need) {
			effect.grid = new Uint8ClampedArray(need);
		}
		return effect.grid;
	}

	function paintPixel(grid, w, h, x, y, color) {
		x = Math.round(x);
		y = Math.round(y);
		if (x < 0 || y < 0 || x >= w || y >= h) return;
		const i = (y * w + x) * 3;
		grid[i] = Math.max(grid[i], color.r | 0);
		grid[i + 1] = Math.max(grid[i + 1], color.g | 0);
		grid[i + 2] = Math.max(grid[i + 2], color.b | 0);
	}

	function renderPixelGridEffect(effect, ctx, canvasW, canvasH, opts) {
		opts = opts || {};
		ctx.imageSmoothingEnabled = false;
		const grid = ensurePixelGrid(effect);
		if (opts.transparent) {
			ctx.clearRect(0, 0, canvasW, canvasH);
		} else {
			ctx.fillStyle = opts.bg || '#0a0a0a';
			ctx.fillRect(0, 0, canvasW, canvasH);
		}
		const w = Math.max(1, effect.w | 0);
		const h = Math.max(1, effect.h | 0);
		if (!effect._pixelCanvas || effect._pixelCanvas.width !== w || effect._pixelCanvas.height !== h) {
			effect._pixelCanvas = (typeof OffscreenCanvas !== 'undefined')
				? new OffscreenCanvas(w, h)
				: document.createElement('canvas');
			effect._pixelCanvas.width = w;
			effect._pixelCanvas.height = h;
			effect._pixelImage = null;
		}
		const pctx = effect._pixelCanvas.getContext('2d');
		pctx.imageSmoothingEnabled = false;
		if (!effect._pixelImage || effect._pixelImage.width !== w || effect._pixelImage.height !== h) {
			effect._pixelImage = pctx.createImageData(w, h);
		}
		const out = effect._pixelImage.data;
		for (let i = 0, j = 0; i < grid.length; i += 3, j += 4) {
			const r = grid[i], g = grid[i + 1], b = grid[i + 2];
			out[j] = r;
			out[j + 1] = g;
			out[j + 2] = b;
			out[j + 3] = (r === 0 && g === 0 && b === 0) ? 0 : 255;
		}
		pctx.clearRect(0, 0, w, h);
		pctx.putImageData(effect._pixelImage, 0, 0);
		ctx.drawImage(effect._pixelCanvas, 0, 0, canvasW, canvasH);
	}

	// EffectTransition wraps two sims (an outgoing one and an incoming one)
	// behind the same step / render / setConfig / triggerEvent / restoreSnapshot
	// surface, smoothly crossfading the visual output across `durationTicks`.
	// Both sims keep stepping during the window so neither freezes mid-fade;
	// config and trigger commands flow to the incoming sim because they
	// describe the new effect, not the one we're leaving. Callers unwrap the
	// transition once `done()` returns true to drop the outgoing sim.
	class EffectTransition {
		constructor(outgoing, incoming, opts) {
			opts = opts || {};
			this.outgoing = outgoing;
			this.incoming = incoming;
			this.duration = Math.max(1, (opts.durationTicks | 0) || 50);
			this.elapsed = 0;
			this._scratch = null;
		}
		step() {
			if (this.outgoing && typeof this.outgoing.step === 'function') this.outgoing.step();
			if (this.incoming && typeof this.incoming.step === 'function') this.incoming.step();
			this.elapsed++;
		}
		// Smoothstep so the alpha curve isn't a hard linear ramp.
		progress() {
			const t = clamp01(this.elapsed / this.duration);
			return t * t * (3 - 2 * t);
		}
		done() { return this.elapsed >= this.duration; }
		setConfig(cfg) {
			if (this.incoming && typeof this.incoming.setConfig === 'function') {
				this.incoming.setConfig(cfg);
			}
		}
		triggerEvent(name) {
			if (this.incoming && typeof this.incoming.triggerEvent === 'function') {
				this.incoming.triggerEvent(name);
			}
		}
		restoreSnapshot(snap) {
			if (this.incoming && typeof this.incoming.restoreSnapshot === 'function') {
				this.incoming.restoreSnapshot(snap);
			}
		}
		destroy() {
			if (this.outgoing && typeof this.outgoing.destroy === 'function') this.outgoing.destroy();
			if (this.incoming && typeof this.incoming.destroy === 'function') this.incoming.destroy();
			this.outgoing = null;
			this.incoming = null;
		}
		render(ctx, w, h, opts) {
			opts = opts || {};
			const t = this.progress();
			// Force the inner renders to skip painting their own backgrounds —
			// we paint the shared bg ourselves so both layers can be alpha-
			// composited on top without each one stomping the other.
			const transparentOpts = Object.assign({}, opts, { transparent: true });

			if (opts.transparent) {
				ctx.clearRect(0, 0, w, h);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, w, h);
			}

			if (!this._scratch || this._scratch.width !== w || this._scratch.height !== h) {
				this._scratch = (typeof OffscreenCanvas !== 'undefined')
					? new OffscreenCanvas(w, h)
					: document.createElement('canvas');
				this._scratch.width = w;
				this._scratch.height = h;
			}
			const sctx = this._scratch.getContext('2d');
			sctx.imageSmoothingEnabled = false;
			sctx.clearRect(0, 0, w, h);
			this.outgoing.render(sctx, w, h, transparentOpts);

			ctx.save();
			ctx.globalAlpha = t;
			this.incoming.render(ctx, w, h, transparentOpts);
			ctx.restore();

			ctx.save();
			ctx.imageSmoothingEnabled = false;
			ctx.globalAlpha = 1 - t;
			ctx.drawImage(this._scratch, 0, 0);
			ctx.restore();
		}
	}
	EffectTransition.prototype.isTransition = true;

	function subscribe(url, rain, onReady) {
		const es = new EventSource(url);
		es.addEventListener('message', (e) => {
			let cmd;
			try { cmd = JSON.parse(e.data); } catch (_) { return; }
			switch (cmd.kind) {
				case 'snapshot':
					try {
						const snap = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
						rain.restoreSnapshot(snap);
					} catch (err) { console.error('bad snapshot', err); }
					if (onReady) onReady();
					break;
				case 'config':
					try {
						const cfg = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
						rain.setConfig(cfg);
					} catch (err) { console.error('bad config', err); }
					break;
				case 'trigger':
					rain.triggerEvent(cmd.event);
					break;
			}
		});
		es.addEventListener('error', () => { /* auto-reconnect is built in */ });
		return es;
	}

	// Expose helpers on the namespace for wasm_runtime.js and compatibility
	// callers that still use the old browser helper surface.
	api._helpers = { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod, ensurePixelGrid, paintPixel, renderPixelGridEffect };
	api.subscribe = subscribe;
	api.EffectTransition = EffectTransition;

	// Back-compat: hslToRGB used to be a top-level field on the
	// AmbienceSim export object. Keep it reachable so any external caller
	// using the old name still works.
	api.hslToRGB = hslToRGB;
})(window.AmbienceSim);
