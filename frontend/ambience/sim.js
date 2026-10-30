// sim.js holds shared browser infrastructure only: the AmbienceSim namespace,
// pixel-grid renderer, EffectTransition crossfade wrapper, and SSE subscribe()
// helper. Active effect constructors are registered by wasm_runtime.js from the
// Go sim package compiled to WebAssembly.

'use strict';

window.AmbienceSim = window.AmbienceSim || { effects: {}, presets: {} };

(function (api) {
	api.presets['magic-portal'] = [
		{
			key: 'arcane-blue', label: 'arcane blue', note: 'cool bright gate',
			config: { hue: 208, sat: 0.72, lmin: 0.12, lmax: 0.86, pulse_period: 210, pulse_amp: 0.72, glow: 0.74, ember_rate: 3 },
		},
		{
			key: 'infernal-red', label: 'infernal red', note: 'hot ember surge',
			config: { hue: 8, sat: 0.82, lmin: 0.10, lmax: 0.86, pulse_period: 185, pulse_amp: 0.86, glow: 0.88, ember_rate: 5 },
		},
		{
			key: 'ancient-amber', label: 'ancient amber', note: 'slow relic pulse',
			config: { hue: 40, sat: 0.58, lmin: 0.12, lmax: 0.82, pulse_period: 245, pulse_amp: 0.64, glow: 0.64, ember_rate: 3 },
		},
		{
			key: 'dormant', label: 'dormant', note: 'dim gray relic',
			config: { hue: 218, sat: 0.10, lmin: 0.08, lmax: 0.55, pulse_period: 330, pulse_amp: 0.34, glow: 0.34, ember_rate: 1 },
		},
	];

	api.presets['paper-lanterns'] = [
		{
			key: 'spirits-eve', label: "spirit's eve", note: 'soft amber drift',
			config: { hue: 36, hue_sp: 11, sat: 0.76, lmin: 0.46, lmax: 0.78, wind: 0.18, rise: 0.076, lone_every: 95, release_gap: 420, release_min: 5, release_max: 9, size: 1.45, lbal: 0.42 },
		},
		{
			key: 'temple-festival', label: 'temple festival', note: 'brighter clustered release',
			config: { hue: 27, hue_sp: 14, sat: 0.88, lmin: 0.5, lmax: 0.86, wind: 0.34, rise: 0.092, lone_every: 70, release_gap: 300, release_min: 7, release_max: 12, size: 1.8, lbal: 0.34 },
		},
		{
			key: 'slow-drift', label: 'slow drift', note: 'wide quiet gaps',
			config: { hue: 48, hue_sp: 8, sat: 0.55, lmin: 0.36, lmax: 0.68, wind: -0.22, rise: 0.052, lone_every: 155, release_gap: 690, release_min: 4, release_max: 7, size: 1.25, lbal: 0.58 },
		},
		{
			key: 'lantern-flock', label: 'lantern flock', note: 'denser festival sky',
			config: { hue: 40, hue_sp: 18, sat: 0.72, lmin: 0.44, lmax: 0.8, wind: 0.28, rise: 0.082, lone_every: 55, release_gap: 255, release_min: 9, release_max: 15, size: 1.55, lbal: 0.5 },
		},
	];

	api.presets['rain-on-window'] = [
		{
			key: 'quiet-city', label: 'quiet city', note: 'cool sparse street glow',
			config: { glow_hue: 214, glow_sat: 0.34, glow_light: 0.28, glass_tint: 0.42, nucleation: 0.10, grow: 0.024, critical: 2.1, fall_speed: 0.42, wind: 0.08, quiet_p: 0.00012 },
		},
		{
			key: 'evening-downpour', label: 'evening downpour', note: 'warm dense pane',
			config: { glow_hue: 42, glow_sat: 0.68, glow_light: 0.48, glass_tint: 0.46, nucleation: 0.32, grow: 0.055, critical: 1.55, fall_speed: 0.76, merge: 1.22, form_p: 0.00025, fall_p: 0.00022 },
		},
		{
			key: 'neon-street', label: 'neon street', note: 'purple city reflections',
			config: { glow_hue: 288, glow_sat: 0.78, glow_light: 0.40, glass_tint: 0.58, nucleation: 0.21, grow: 0.042, critical: 1.8, fall_speed: 0.62, wind: -0.22, gust_p: 0.00014, gust_strength: 1.1 },
		},
		{
			key: 'gentle-drizzle', label: 'gentle drizzle', note: 'soft warm interior',
			config: { glow_hue: 56, glow_sat: 0.42, glow_light: 0.34, glass_tint: 0.30, nucleation: 0.13, grow: 0.026, critical: 2.25, fall_speed: 0.36, wind: 0.02, quiet_p: 0.0001 },
		},
	];

	api.presets['birds-on-a-wire'] = [
		{
			key: 'morning-wire', label: 'morning wire', note: 'cool sparse dawn',
			config: { sky_hue: 208, sky_sat: 0.34, top_light: 0.24, horizon_light: 0.62, max_birds: 8, arrival_every: 260, pair_chance: 0.12, takeoff_every: 720, flock_chance: 0.18, quiet_dur: 900 },
		},
		{
			key: 'evening-commute', label: 'evening commute', note: 'warm busier dusk',
			config: { sky_hue: 32, sky_sat: 0.62, top_light: 0.19, horizon_light: 0.62, max_birds: 16, intro_target: 7, arrival_every: 125, pair_chance: 0.34, bob_chance: 0.004, takeoff_every: 480, flock_chance: 0.28 },
		},
		{
			key: 'overcast-lull', label: 'overcast lull', note: 'grey quiet wire',
			config: { sky_hue: 220, sky_sat: 0.08, top_light: 0.26, horizon_light: 0.46, max_birds: 6, intro_target: 3, arrival_every: 420, pair_chance: 0.08, takeoff_every: 940, flock_chance: 0.12, quiet_dur: 1320, quiet_arrival: 0.06 },
		},
		{
			key: 'telephone-row', label: 'telephone row', note: 'two sagging lines',
			config: { sky_hue: 42, sky_sat: 0.48, top_light: 0.18, horizon_light: 0.58, wire_count: 2, wire_y: 0.36, wire_sag: 3.8, max_birds: 18, perch_spacing: 4.5, arrival_every: 150, pair_chance: 0.26, takeoff_every: 560 },
		},
	];

	api.presets['cottage-chimney'] = [
		{
			key: 'still-night', label: 'still night', note: 'slow vertical smoke',
			config: { wind: 0.018, wander: 0.22, puff_every: 36, puff_life: 205, plume_width: 12, window_hue: 42, window_sat: 0.78, window_light: 0.66, window_glow: 0.72 },
		},
		{
			key: 'windy-peak', label: 'windy peak', note: 'sideways plume bend',
			config: { wind: 0.13, wander: 0.48, puff_every: 26, puff_life: 170, plume_width: 22, gust_p: 0.001, gust_strength: 0.32, window_hue: 38, window_glow: 0.68 },
		},
		{
			key: 'lamplit-cabin', label: 'lamplit cabin', note: 'warm bright window',
			config: { window_hue: 36, window_sat: 0.92, window_light: 0.78, window_glow: 0.94, puff_every: 28, smoke_light: 0.48, flicker_p: 0.0005 },
		},
		{
			key: 'quiet-hearth', label: 'quiet hearth', note: 'thin sleepy emission',
			config: { puff_every: 50, puff_life: 220, puff_size: 1.8, plume_width: 10, quiet_p: 0.001, quiet_mult: 0.24, window_hue: 48, window_light: 0.56, window_glow: 0.54 },
		},
	];

	api.presets['lava-lamp'] = [
		{
			key: 'classic-red', label: 'classic red', note: 'warm slow rise',
			config: { hue: 7, hue_sp: 9, sat: 0.9, liquid_light: 0.1, blob_light: 0.64, heat_glow: 0.9, rise: 0.056, fall: 0.04, detach_every: 230, min_blobs: 3, max_blobs: 5 },
		},
		{
			key: 'cool-blue', label: 'cool blue', note: 'dim blue wax',
			config: { hue: 154, hue_sp: 12, sat: 0.74, liquid_light: 0.085, blob_light: 0.58, heat_glow: 0.68, rise: 0.05, fall: 0.036, detach_every: 270, quiet_flow_p: 0.00012 },
		},
		{
			key: 'green-goo', label: 'green goo', note: 'brighter alien blobs',
			config: { hue: 104, hue_sp: 14, sat: 0.86, liquid_light: 0.11, blob_light: 0.68, heat_glow: 0.78, rise: 0.062, fall: 0.046, merge_p: 0.0007, split_p: 0.00055 },
		},
		{
			key: 'slow-drift', label: 'slow drift', note: 'settled hypnotic flow',
			config: { hue: 18, hue_sp: 6, sat: 0.72, liquid_light: 0.075, blob_light: 0.52, heat_glow: 0.62, rise: 0.032, fall: 0.026, drift: 0.055, detach_every: 430, quiet_flow_p: 0.00016, quiet_mult: 0.18 },
		},
	];

	api.presets['spider-web'] = [
		{
			key: 'dawn-dew', label: 'dawn dew', note: 'warm first light',
			config: { palette: 0, dropletShimmer: 1.35, glintRate: 1.12, moveChance: 0.032, webSway: 0.48 },
		},
		{
			key: 'moonlit-silver', label: 'moonlit silver', note: 'cool quiet glints',
			config: { palette: 1, dropletShimmer: 0.88, glintRate: 0.58, moveChance: 0.022, webSway: 0.26 },
		},
		{
			key: 'autumn-gold', label: 'autumn gold', note: 'amber breezy beads',
			config: { palette: 2, dropletShimmer: 1.08, glintRate: 0.86, moveChance: 0.04, webSway: 0.82 },
		},
		{
			key: 'misty', label: 'misty', note: 'soft muted dew',
			config: { palette: 3, dropletShimmer: 0.58, glintRate: 0.44, moveChance: 0.018, webSway: 0.22 },
		},
	];

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

	function renderPixelGridEffect(effect, ctx, canvasW, canvasH, opts, gridOverride) {
		opts = opts || {};
		ctx.imageSmoothingEnabled = false;
		const grid = gridOverride || ensurePixelGrid(effect);
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
		// renderOverlay mirrors render() for the near/overlay plane so the
		// foreground drops crossfade between scenes alongside the back field.
		renderOverlay(ctx, w, h, opts) {
			opts = opts || {};
			const t = this.progress();
			const transparentOpts = Object.assign({}, opts, { transparent: true });
			ctx.clearRect(0, 0, w, h);
			if (typeof this.outgoing.renderOverlay !== 'function' || typeof this.incoming.renderOverlay !== 'function') {
				return;
			}
			if (!this._overlayScratch || this._overlayScratch.width !== w || this._overlayScratch.height !== h) {
				this._overlayScratch = (typeof OffscreenCanvas !== 'undefined')
					? new OffscreenCanvas(w, h)
					: document.createElement('canvas');
				this._overlayScratch.width = w;
				this._overlayScratch.height = h;
			}
			const sctx = this._overlayScratch.getContext('2d');
			sctx.imageSmoothingEnabled = false;
			sctx.clearRect(0, 0, w, h);
			this.outgoing.renderOverlay(sctx, w, h, transparentOpts);

			ctx.save();
			ctx.globalAlpha = t;
			this.incoming.renderOverlay(ctx, w, h, transparentOpts);
			ctx.restore();

			ctx.save();
			ctx.imageSmoothingEnabled = false;
			ctx.globalAlpha = 1 - t;
			ctx.drawImage(this._overlayScratch, 0, 0);
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
