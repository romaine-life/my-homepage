// sim.js — JS port of ambience/sim/rain.go.
//
// Clients run their own Rain sim locally. The server broadcasts config
// changes + trigger events; clients apply those via setConfig / triggerEvent.
// Step() advances the local sim one tick; drops + splashes are rendered into
// an internal grid that render() paints to a canvas.
//
// Clients do NOT roll for discrete events — that's the server's job. Clients
// only advance timers and physics. This keeps all clients in rough agreement
// on when events happen (frame-level sync is not guaranteed in v1).
//
// This file holds shared infrastructure only: the AmbienceSim namespace,
// the helper functions used by every effect (makeRNG, jitterInt, clamp01,
// hslToRGB, positiveMod), the EffectTransition crossfade wrapper, and the
// SSE subscribe() helper. Each effect's own class lives in its own file
// under web/effects/. The server bundles sim.js with every web/effects/*.js
// file when serving GET /sim.js, so dropping a new effect file Just Works —
// no shared registry to edit.

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
			sctx.clearRect(0, 0, w, h);
			this.outgoing.render(sctx, w, h, transparentOpts);

			ctx.save();
			ctx.globalAlpha = t;
			this.incoming.render(ctx, w, h, transparentOpts);
			ctx.restore();

			ctx.save();
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

	// Expose helpers on the namespace so per-effect files can pull them out
	// of api._helpers at the top of their own IIFE. positiveMod is included
	// because Burning-Trees and several procedural effects use it.
	api._helpers = { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod };
	api.subscribe = subscribe;
	api.EffectTransition = EffectTransition;

	// Back-compat: hslToRGB used to be a top-level field on the
	// AmbienceSim export object. Keep it reachable so any external caller
	// using the old name still works.
	api.hslToRGB = hslToRGB;
})(window.AmbienceSim);
// ===== effects/aurora.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 70,
		intro_glow: 0.18,
		ending_dur: 80,
		ending_linger: 20,
		ending_glow: 0.05,
		intensity: 0.56,
		speed: 0.11,
		drift: 0.08,
		bands: 3,
		thickness: 9,
		wave_amp: 6,
		wave_freq: 0.16,
		curtain_len: 15,
		hue: 138,
		hue_sp: 26,
		sat: 0.72,
		lmin: 0.2,
		lmax: 0.74,
		brighten_p: 0,
		shift_p: 0,
		fade_p: 0,
		brighten_dur: 42,
		brighten_mult: 1.45,
		shift_dur: 64,
		shift_amt: 1.1,
		fade_dur: 58,
		fade_mult: 0.6,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_glow = clamp01(c.intro_glow);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_glow = clamp01(c.ending_glow);
		if (c.intensity <= 0) c.intensity = DEFAULTS.intensity;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.bands < 1) c.bands = DEFAULTS.bands;
		if (c.thickness <= 0) c.thickness = DEFAULTS.thickness;
		if (c.wave_amp <= 0) c.wave_amp = DEFAULTS.wave_amp;
		if (c.wave_freq <= 0) c.wave_freq = DEFAULTS.wave_freq;
		if (c.curtain_len <= 0) c.curtain_len = DEFAULTS.curtain_len;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.brighten_dur <= 0) c.brighten_dur = DEFAULTS.brighten_dur;
		if (c.brighten_mult <= 0) c.brighten_mult = DEFAULTS.brighten_mult;
		if (c.shift_dur <= 0) c.shift_dur = DEFAULTS.shift_dur;
		if (c.shift_amt <= 0) c.shift_amt = DEFAULTS.shift_amt;
		if (c.fade_dur <= 0) c.fade_dur = DEFAULTS.fade_dur;
		if (c.fade_mult <= 0) c.fade_mult = DEFAULTS.fade_mult;
		return c;
	}

	class Aurora {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 53);
			switch (name) {
				case 'brighten':
					this.timers.brighten = jitterInt(rng, this.cfg.brighten_dur, 0.3);
					this.values.brighten_gain = this.cfg.brighten_mult * (0.85 + rng() * 0.35);
					return true;
				case 'shift':
					this.timers.shift = jitterInt(rng, this.cfg.shift_dur, 0.3);
					this.values.shift_push = (rng() < 0.5 ? -1 : 1) * this.cfg.shift_amt * (0.55 + rng() * 0.55);
					this.values.shift_seed = rng() * Math.PI * 2;
					return true;
				case 'fade':
					this.timers.fade = jitterInt(rng, this.cfg.fade_dur, 0.3);
					return true;
				case 'intro':
					this.timers.brighten = 0;
					this.timers.shift = 0;
					this.timers.fade = 0;
					this.timers.ending = 0;
					this.values.brighten_gain = 0;
					this.values.shift_push = 0;
					this.values.shift_seed = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.brighten = 0;
					this.timers.shift = 0;
					this.timers.fade = 0;
					this.values.brighten_gain = 0;
					this.values.shift_push = 0;
					this.values.shift_seed = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.brighten || this.timers.brighten <= 0) this.values.brighten_gain = 0;
			if (!this.timers.shift || this.timers.shift <= 0) {
				this.values.shift_push = 0;
				this.values.shift_seed = 0;
			}
		}

		_intensityLevel() {
			let level = this.cfg.intensity;
			if (this.timers.brighten > 0) level *= this.values.brighten_gain || this.cfg.brighten_mult;
			if (this.timers.fade > 0) level *= this.cfg.fade_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_glow + (1 - this.cfg.intro_glow) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_glow) * progress;
			}
			return Math.max(0.02, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#02060f');
				sky.addColorStop(0.52, '#07101c');
				sky.addColorStop(1, '#0a1220');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const groundRow = Math.floor(this.h * 0.82);
			const intensity = this._intensityLevel();
			const bands = Math.max(1, Math.round(this.cfg.bands));
			const shiftPush = this.values.shift_push || 0;
			const shiftSeed = this.values.shift_seed || 0;

			const horizonGlow = ctx.createLinearGradient(0, canvasH * 0.5, 0, canvasH);
			horizonGlow.addColorStop(0, 'rgba(36, 84, 92, 0)');
			horizonGlow.addColorStop(1, `rgba(48, 168, 140, ${clamp01(0.18 + intensity * 0.16)})`);
			ctx.fillStyle = horizonGlow;
			ctx.fillRect(0, canvasH * 0.48, canvasW, canvasH * 0.52);

			const baseGround = hslToRGB(212, 0.2, 0.04);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, groundRow - 1, this.w, this.h - groundRow + 1, `rgb(${baseGround.r},${baseGround.g},${baseGround.b})`, 1);

			const starCount = Math.max(12, Math.round(this.w * 0.18));
			for (let i = 0; i < starCount; i++) {
				const col = Math.floor(this._hash(19000 + i) * this.w);
				const row = Math.floor(this._hash(19100 + i) * Math.max(1, groundRow - 10));
				const twinkle = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(this.tick * (0.018 + this._hash(19200 + i) * 0.02) + i), 2);
				const alpha = clamp01((0.14 + twinkle * 0.22) * (1 - Math.min(0.65, intensity * 0.55)));
				const color = hslToRGB(205 + this._hash(19300 + i) * 18, 0.18, 0.72 + this._hash(19400 + i) * 0.2);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
			}

			const ridgePoints = [];
			const ridgeSegments = 7;
			const ridgeColor = hslToRGB(210, 0.24, 0.055);
			for (let i = 0; i <= ridgeSegments; i++) {
				ridgePoints.push(groundRow - 4 - Math.floor(this._hash(19500 + i) * 6) - Math.floor((0.5 + 0.5 * Math.sin(i * 1.3 + this._hash(19600 + i) * 4)) * 4));
			}
			const ridgeCoords = [];
			for (let x = 0; x < this.w; x++) {
				const pos = (x / Math.max(1, this.w - 1)) * ridgeSegments;
				const idx = Math.min(ridgeSegments - 1, Math.floor(pos));
				const frac = pos - idx;
				const eased = frac * frac * (3 - 2 * frac);
				const ridge = Math.round(ridgePoints[idx] + (ridgePoints[idx + 1] - ridgePoints[idx]) * eased + Math.sin(x * 0.08 + shiftSeed) * 0.8);
				ridgeCoords.push({ x, ridge });
			}
			ctx.fillStyle = `rgb(${ridgeColor.r},${ridgeColor.g},${ridgeColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (const point of ridgeCoords) {
				ctx.lineTo(Math.floor(point.x * sx), Math.floor(point.ridge * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const treeCount = 12;
			for (let i = 0; i < treeCount; i++) {
				const center = Math.floor((i + 0.5) * this.w / treeCount + (this._hash(19900 + i) - 0.5) * 5);
				const trunkH = 1 + Math.floor(this._hash(20000 + i) * 2);
				const crownH = 5 + Math.floor(this._hash(20100 + i) * 5);
				const half = 1 + Math.floor(this._hash(20200 + i) * 2);
				const baseY = groundRow - 1 - Math.floor(this._hash(20300 + i) * 4);
				const treeColor = hslToRGB(210 + this._hash(20400 + i) * 10, 0.22, 0.045 + this._hash(20500 + i) * 0.02);
				for (let row = 0; row < crownH; row++) {
					const width = Math.max(1, half - Math.floor(row / 2));
					const y = baseY - crownH + row;
					for (let dx = -width; dx <= width; dx++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, center + dx, y, 1, 1, `rgb(${treeColor.r},${treeColor.g},${treeColor.b})`, 1);
					}
				}
				for (let row = 0; row < trunkH; row++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, center, baseY - row, 1, 1, `rgb(${treeColor.r},${treeColor.g},${treeColor.b})`, 1);
				}
			}

			for (let band = 0; band < bands; band++) {
				const bandRatio = bands === 1 ? 0.5 : band / (bands - 1);
				const phase = this.tick * this.cfg.speed * (0.18 + bandRatio * 0.12) + band * 1.6 + shiftSeed;
				const amp = this.cfg.wave_amp * (0.8 + bandRatio * 0.35);
				const freq = this.cfg.wave_freq * (0.82 + bandRatio * 0.26);
				const thickness = this.cfg.thickness * (0.8 + bandRatio * 0.28);
				const curtain = this.cfg.curtain_len * (0.8 + bandRatio * 0.22);
				const baseY = this.h * (0.16 + bandRatio * 0.08) + Math.sin(this.tick * 0.01 + band * 0.8) * 1.1;
				const hueBase = ((this.cfg.hue + (bandRatio - 0.5) * this.cfg.hue_sp * 1.15 + shiftPush * 5) % 360 + 360) % 360;

				for (let x = 0; x < this.w; x++) {
					const nx = x / Math.max(1, this.w - 1);
					const arch = Math.sin(nx * Math.PI * (1.08 + bandRatio * 0.24) + band * 0.75);
					const wave = Math.sin(x * freq + phase + this.tick * this.cfg.drift * 0.04);
					const subWave = Math.sin(x * freq * 0.47 - phase * 0.62 + band * 2.1);
					const center = baseY + arch * amp * 0.72 + wave * amp * 0.52 + subWave * amp * 0.22 + shiftPush * Math.sin(x * 0.07 + phase) * 1.05;
					const startY = Math.max(0, Math.floor(center - thickness * 1.15));
					const endY = Math.min(groundRow - 2, Math.ceil(center + curtain));
					for (let y = startY; y <= endY; y++) {
						const dy = y - center;
						const core = Math.exp(-(dy * dy) / Math.max(1, thickness * thickness * 1.4));
						const tail = y >= center ? Math.exp(-(y - center) / Math.max(1, curtain)) : 0;
						const shimmer = 0.76 + 0.24 * Math.sin(this.tick * 0.03 + x * 0.1 + band * 1.7);
						const strength = (core * 0.9 + tail * 0.7) * intensity * shimmer * (0.58 + 0.42 * Math.max(0.2, arch));
						if (strength < 0.025) continue;
						const hue = ((hueBase + Math.sin(y * 0.18 + x * 0.06 + phase) * this.cfg.hue_sp * 0.32 + band * 6) % 360 + 360) % 360;
						const sat = clamp01(this.cfg.sat * (0.84 + core * 0.28));
						const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * Math.min(1, 0.24 + strength));
						const color = hslToRGB(hue, sat, light);
						const alpha = clamp01(strength * (0.34 + core * 0.46));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
						if (core > 0.62 && y < groundRow - 3) {
							const accent = hslToRGB((hue + 12) % 360, clamp01(sat * 0.9), clamp01(light * 1.08));
							this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1, 1, `rgb(${accent.r},${accent.g},${accent.b})`, alpha * 0.45);
						}
					}
				}
			}
		}
	}

	api.presets['aurora'] = [
		{
			key: 'green-veil',
			label: 'green veil',
			config: {
				intensity: 0.54,
				speed: 0.1,
				drift: 0.06,
				bands: 3,
				thickness: 9,
				wave_amp: 5.5,
				wave_freq: 0.15,
				curtain_len: 14,
				hue: 134,
				hue_sp: 18,
				sat: 0.7,
				lmin: 0.2,
				lmax: 0.72,
				shift_p: 0.0007,
			},
		},
		{
			key: 'cold-ribbons',
			label: 'cold ribbons',
			config: {
				intensity: 0.48,
				speed: 0.12,
				drift: 0.1,
				bands: 4,
				thickness: 7.5,
				wave_amp: 6.5,
				wave_freq: 0.18,
				curtain_len: 13,
				hue: 164,
				hue_sp: 34,
				sat: 0.66,
				lmin: 0.18,
				lmax: 0.76,
				shift_p: 0.0011,
				fade_p: 0.0005,
			},
		},
		{
			key: 'quiet-sky',
			label: 'quiet sky',
			config: {
				intensity: 0.34,
				speed: 0.07,
				drift: 0.03,
				bands: 2,
				thickness: 8.5,
				wave_amp: 4.5,
				wave_freq: 0.12,
				curtain_len: 11,
				hue: 142,
				hue_sp: 14,
				sat: 0.58,
				lmin: 0.16,
				lmax: 0.64,
				fade_p: 0.0008,
			},
		},
		{
			key: 'bright-aurora',
			label: 'bright aurora',
			config: {
				intensity: 0.72,
				speed: 0.14,
				drift: 0.12,
				bands: 4,
				thickness: 10,
				wave_amp: 7.2,
				wave_freq: 0.19,
				curtain_len: 18,
				hue: 136,
				hue_sp: 30,
				sat: 0.78,
				lmin: 0.22,
				lmax: 0.82,
				brighten_p: 0.0012,
				brighten_mult: 1.7,
				shift_p: 0.001,
			},
		},
	];
	api.effects['aurora'] = Aurora;
})(window.AmbienceSim);
// ===== effects/autumn_leaves.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 55,
		intro_density: 0.12,
		ending_dur: 60,
		ending_linger: 18,
		ending_density: 0.04,
		density: 0.24,
		speed: 0.44,
		drift: 0.18,
		sway: 0.86,
		layers: 2,
		size: 1.2,
		hue: 28,
		hue_sp: 24,
		sat: 0.62,
		lmin: 0.38,
		lmax: 0.78,
		gust_p: 0,
		lull_p: 0,
		swirl_p: 0,
		gust_dur: 48,
		gust_mult: 1.9,
		lull_dur: 72,
		lull_mult: 0.35,
		swirl_dur: 52,
		swirl_pull: 1.15,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_density = clamp01(c.intro_density);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_density = clamp01(c.ending_density);
		if (c.density <= 0) c.density = DEFAULTS.density;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.layers < 1) c.layers = DEFAULTS.layers;
		if (c.size <= 0) c.size = DEFAULTS.size;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.gust_dur <= 0) c.gust_dur = DEFAULTS.gust_dur;
		if (c.gust_mult <= 0) c.gust_mult = DEFAULTS.gust_mult;
		if (c.lull_dur <= 0) c.lull_dur = DEFAULTS.lull_dur;
		if (c.lull_mult <= 0) c.lull_mult = DEFAULTS.lull_mult;
		if (c.swirl_dur <= 0) c.swirl_dur = DEFAULTS.swirl_dur;
		if (c.swirl_pull <= 0) c.swirl_pull = DEFAULTS.swirl_pull;
		return c;
	}

	class AutumnLeaves {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 29);
			switch (name) {
				case 'gust':
					this.timers.gust = jitterInt(rng, this.cfg.gust_dur, 0.3);
					this.values.gust_push = (rng() < 0.5 ? -1 : 1) * this.cfg.gust_mult * (0.5 + rng() * 0.7);
					return true;
				case 'lull':
					this.timers.lull = jitterInt(rng, this.cfg.lull_dur, 0.3);
					return true;
				case 'swirl':
					this.timers.swirl = jitterInt(rng, this.cfg.swirl_dur, 0.3);
					this.values.swirl_spin = (rng() < 0.5 ? -1 : 1) * this.cfg.swirl_pull * (0.65 + rng() * 0.45);
					this.values.swirl_row = Math.max(8, this.h / 3) + rng() * Math.max(1, this.h / 2);
					this.values.swirl_col = rng() * this.w;
					return true;
				case 'intro':
					this.timers.gust = 0;
					this.timers.lull = 0;
					this.timers.swirl = 0;
					this.timers.ending = 0;
					this.values.gust_push = 0;
					this.values.swirl_spin = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.gust = 0;
					this.timers.lull = 0;
					this.timers.swirl = 0;
					this.values.gust_push = 0;
					this.values.swirl_spin = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.gust || this.timers.gust <= 0) this.values.gust_push = 0;
			if (!this.timers.swirl || this.timers.swirl <= 0) this.values.swirl_spin = 0;
		}

		_densityLevel() {
			let level = this.cfg.density;
			if (this.timers.gust > 0) level *= 1.22;
			if (this.timers.lull > 0) level *= this.cfg.lull_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_density + (1 - this.cfg.intro_density) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_density) * progress;
			}
			return Math.max(0.015, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#20170f');
				sky.addColorStop(0.52, '#58422b');
				sky.addColorStop(1, '#7c6042');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const groundRow = Math.floor(this.h * 0.82);

			for (let y = groundRow; y < this.h; y++) {
				const ratio = (y - groundRow) / Math.max(1, this.h - groundRow);
				const ground = hslToRGB(38, 0.35, 0.1 + ratio * 0.16);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${ground.r},${ground.g},${ground.b})`, 1);
			}

			for (let x = 0; x < this.w; x++) {
				const canopyDepth = 4 + Math.floor(this._hash(6100 + x) * 6);
				const shade = hslToRGB(24 + this._hash(6200 + x) * 18, 0.45, 0.14 + this._hash(6300 + x) * 0.08);
				for (let y = 0; y < canopyDepth; y++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1, 1, `rgb(${shade.r},${shade.g},${shade.b})`, 0.75);
				}
			}

			const density = this._densityLevel();
			const layers = Math.max(1, Math.round(this.cfg.layers));
			for (let layer = 0; layer < layers; layer++) {
				const layerRatio = layers === 1 ? 1 : layer / (layers - 1);
				const layerCount = Math.max(6, Math.round(this.w * density * (0.28 + layerRatio * 0.62)));
				const baseSpeed = this.cfg.speed * (0.34 + layerRatio * 0.72);
				const drift = this.cfg.drift * (0.45 + layerRatio * 0.65) + (this.values.gust_push || 0) * 0.04 * (0.5 + layerRatio * 0.7);
				const size = Math.max(1, Math.round(this.cfg.size + layerRatio * 0.8));
				for (let i = 0; i < layerCount; i++) {
					const idx = layer * 1000 + i;
					const baseX = this._hash(7000 + idx) * this.w;
					const baseY = this._hash(8000 + idx) * Math.max(1, groundRow - 2);
					const flutter = (this._hash(9000 + idx) * 2 - 1) * this.cfg.sway * (2.4 + layerRatio * 2.8);
					let row = positiveMod(baseY + this.tick * baseSpeed * (0.7 + this._hash(10000 + idx) * 0.55), Math.max(1, groundRow - 2));
					let col = positiveMod(baseX + this.tick * drift + Math.sin(this.tick * 0.04 + idx * 0.23) * flutter, this.w);
					if (this.timers.swirl > 0) {
						const sr = this.values.swirl_row || this.h * 0.55;
						const sc = this.values.swirl_col || this.w * 0.5;
						const angle = Math.atan2(row - sr, col - sc) + (this.values.swirl_spin || 0) * 0.015;
						const radius = Math.hypot(col - sc, row - sr);
						col = positiveMod(sc + Math.cos(angle) * radius, this.w);
						row = Math.max(0, Math.min(groundRow - 2, sr + Math.sin(angle) * radius * 0.94));
					}
					const hue = ((this.cfg.hue + (this._hash(11000 + idx) * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.3 + this._hash(12000 + idx) * 0.7));
					const alpha = clamp01(0.4 + layerRatio * 0.45);
					const color = hslToRGB(hue, this.cfg.sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col), Math.round(row), size, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
					if ((idx + this.tick) % 3 === 0) {
						const accent = hslToRGB((hue + 12) % 360, clamp01(this.cfg.sat * 0.85), clamp01(light * 1.08));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col) + (this._hash(13000 + idx) < 0.5 ? 1 : 0), Math.round(row), 1, size > 1 ? 1 : 0.8, `rgb(${accent.r},${accent.g},${accent.b})`, alpha * 0.8);
					}
				}
			}
		}
	}

	api.presets['autumn-leaves'] = [
		{
			key: 'few-leaves',
			label: 'few leaves',
			config: {
				density: 0.14,
				speed: 0.36,
				drift: 0.12,
				sway: 0.7,
				layers: 1,
				size: 1,
				hue: 24,
				hue_sp: 18,
				sat: 0.58,
				lmin: 0.36,
				lmax: 0.7,
				lull_p: 0.0014,
			},
		},
		{
			key: 'gentle-fall',
			label: 'gentle fall',
			config: {
				density: 0.24,
				speed: 0.44,
				drift: 0.18,
				sway: 0.86,
				layers: 2,
				size: 1.2,
				hue: 28,
				hue_sp: 24,
				sat: 0.62,
				lmin: 0.38,
				lmax: 0.78,
				gust_p: 0.0008,
			},
		},
		{
			key: 'windy-autumn',
			label: 'windy autumn',
			config: {
				density: 0.3,
				speed: 0.5,
				drift: 0.26,
				sway: 1.05,
				layers: 2,
				size: 1.4,
				hue: 22,
				hue_sp: 28,
				sat: 0.68,
				lmin: 0.36,
				lmax: 0.8,
				gust_p: 0.0016,
				gust_mult: 2.35,
			},
		},
		{
			key: 'swirl-study',
			label: 'swirl study',
			config: {
				density: 0.28,
				speed: 0.42,
				drift: 0.12,
				sway: 1.15,
				layers: 2,
				size: 1.4,
				hue: 30,
				hue_sp: 34,
				sat: 0.7,
				lmin: 0.4,
				lmax: 0.84,
				swirl_p: 0.0015,
				swirl_dur: 68,
				swirl_pull: 1.55,
			},
		},
	];
	api.effects['autumn-leaves'] = AutumnLeaves;
})(window.AmbienceSim);
// ===== effects/beach.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 55,
		intro_tide: 0.18,
		ending_dur: 65,
		ending_linger: 18,
		ending_wet: 0.1,
		shoreline: 0.58,
		tide_amp: 6,
		wave_amp: 2.4,
		wave_freq: 0.18,
		speed: 0.1,
		slope: 0.16,
		foam: 0.36,
		shimmer: 0.22,
		hue: 198,
		hue_sp: 16,
		sat: 0.5,
		lmin: 0.28,
		lmax: 0.82,
		high_tide_p: 0,
		low_tide_p: 0,
		foam_burst_p: 0,
		high_tide_dur: 60,
		high_tide_push: 1.4,
		low_tide_dur: 58,
		low_tide_pull: 1.2,
		foam_burst_dur: 34,
		foam_burst_mult: 1.9,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_tide = clamp01(c.intro_tide);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_wet = clamp01(c.ending_wet);
		if (c.shoreline <= 0) c.shoreline = DEFAULTS.shoreline;
		if (c.tide_amp <= 0) c.tide_amp = DEFAULTS.tide_amp;
		if (c.wave_amp <= 0) c.wave_amp = DEFAULTS.wave_amp;
		if (c.wave_freq <= 0) c.wave_freq = DEFAULTS.wave_freq;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.foam <= 0) c.foam = DEFAULTS.foam;
		if (c.shimmer <= 0) c.shimmer = DEFAULTS.shimmer;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.high_tide_dur <= 0) c.high_tide_dur = DEFAULTS.high_tide_dur;
		if (c.high_tide_push <= 0) c.high_tide_push = DEFAULTS.high_tide_push;
		if (c.low_tide_dur <= 0) c.low_tide_dur = DEFAULTS.low_tide_dur;
		if (c.low_tide_pull <= 0) c.low_tide_pull = DEFAULTS.low_tide_pull;
		if (c.foam_burst_dur <= 0) c.foam_burst_dur = DEFAULTS.foam_burst_dur;
		if (c.foam_burst_mult <= 0) c.foam_burst_mult = DEFAULTS.foam_burst_mult;
		return c;
	}

	class Beach {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 61);
			switch (name) {
				case 'high-tide':
					this.timers['high-tide'] = jitterInt(rng, this.cfg.high_tide_dur, 0.3);
					this.timers['low-tide'] = 0;
					this.values.tide_bias = this.cfg.high_tide_push * (0.65 + rng() * 0.55);
					return true;
				case 'low-tide':
					this.timers['low-tide'] = jitterInt(rng, this.cfg.low_tide_dur, 0.3);
					this.timers['high-tide'] = 0;
					this.values.tide_bias = -this.cfg.low_tide_pull * (0.65 + rng() * 0.55);
					return true;
				case 'foam-burst':
					this.timers['foam-burst'] = jitterInt(rng, this.cfg.foam_burst_dur, 0.3);
					this.values.foam_gain = this.cfg.foam_burst_mult * (0.85 + rng() * 0.35);
					return true;
				case 'intro':
					this.timers['high-tide'] = 0;
					this.timers['low-tide'] = 0;
					this.timers['foam-burst'] = 0;
					this.timers.ending = 0;
					this.values.tide_bias = 0;
					this.values.foam_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers['high-tide'] = 0;
					this.timers['low-tide'] = 0;
					this.timers['foam-burst'] = 0;
					this.values.tide_bias = 0;
					this.values.foam_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if ((!this.timers['high-tide'] || this.timers['high-tide'] <= 0) && (!this.timers['low-tide'] || this.timers['low-tide'] <= 0)) {
				this.values.tide_bias = 0;
			}
			if (!this.timers['foam-burst'] || this.timers['foam-burst'] <= 0) {
				this.values.foam_gain = 1;
			}
		}

		_tideLevel() {
			let level = 1;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_tide + (1 - this.cfg.intro_tide) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_wet) * progress;
			}
			return Math.max(0.05, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#f4b17a');
				sky.addColorStop(0.38, '#f8d6a9');
				sky.addColorStop(0.68, '#cfe3e6');
				sky.addColorStop(1, '#8bb4c4');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const horizon = Math.max(8, Math.floor(this.h * 0.34));
			const tideLevel = this._tideLevel();
			const tideBias = this.values.tide_bias || 0;
			const foamGain = this.values.foam_gain || 1;
			const tidePhase = this.tick * this.cfg.speed * 0.08;
			const baseShore = this.h * this.cfg.shoreline + Math.sin(tidePhase) * this.cfg.tide_amp * tideLevel * 0.34 + tideBias * 1.6;

			const sunX = canvasW * (0.16 + this._hash(24000) * 0.18);
			const sunY = canvasH * (0.18 + this._hash(24001) * 0.08);
			const sunR = Math.max(22, Math.min(canvasW, canvasH) * 0.085);
			const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2.8);
			sun.addColorStop(0, 'rgba(255, 239, 187, 0.38)');
			sun.addColorStop(0.34, 'rgba(255, 224, 168, 0.2)');
			sun.addColorStop(1, 'rgba(255, 224, 168, 0)');
			ctx.fillStyle = sun;
			ctx.fillRect(0, 0, canvasW, canvasH);

			const haze = ctx.createLinearGradient(0, canvasH * 0.18, 0, canvasH * 0.6);
			haze.addColorStop(0, 'rgba(255, 246, 224, 0)');
			haze.addColorStop(1, 'rgba(255, 246, 224, 0.14)');
			ctx.fillStyle = haze;
			ctx.fillRect(0, canvasH * 0.16, canvasW, canvasH * 0.44);

			const waterTop = hslToRGB((this.cfg.hue - 12 + 360) % 360, clamp01(this.cfg.sat * 0.72), clamp01(this.cfg.lmax * 0.74));
			const waterMid = hslToRGB(this.cfg.hue, this.cfg.sat, clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.44));
			const waterDeep = hslToRGB((this.cfg.hue + 6) % 360, clamp01(this.cfg.sat * 1.06), clamp01(this.cfg.lmin * 0.8));
			const waterGrad = ctx.createLinearGradient(0, Math.floor(horizon * sy), 0, canvasH);
			waterGrad.addColorStop(0, `rgb(${waterTop.r},${waterTop.g},${waterTop.b})`);
			waterGrad.addColorStop(0.46, `rgb(${waterMid.r},${waterMid.g},${waterMid.b})`);
			waterGrad.addColorStop(1, `rgb(${waterDeep.r},${waterDeep.g},${waterDeep.b})`);
			ctx.fillStyle = waterGrad;
			ctx.fillRect(0, Math.floor(horizon * sy), canvasW, canvasH - Math.floor(horizon * sy));

			const horizonGlow = ctx.createLinearGradient(0, Math.floor((horizon - 1) * sy), 0, Math.floor((horizon + 4) * sy));
			horizonGlow.addColorStop(0, 'rgba(255, 247, 221, 0.35)');
			horizonGlow.addColorStop(1, 'rgba(255, 247, 221, 0)');
			ctx.fillStyle = horizonGlow;
			ctx.fillRect(0, Math.floor((horizon - 1) * sy), canvasW, Math.ceil(7 * sy));

			for (let band = 0; band < 3; band++) {
				const y = Math.floor((horizon + 2 + band * 3 + Math.sin(tidePhase * 1.8 + band) * 1.2) * sy);
				ctx.fillStyle = `rgba(${waterTop.r},${waterTop.g},${waterTop.b},${0.08 + band * 0.03})`;
				ctx.fillRect(0, y, canvasW, Math.max(1, Math.ceil(sy)));
			}

			const shoreRows = new Array(this.w);
			for (let x = 0; x < this.w; x++) {
				const nx = x / Math.max(1, this.w - 1);
				const slopeOffset = (nx - 0.5) * this.cfg.slope * this.h * 0.34;
				const wave = Math.sin(x * this.cfg.wave_freq + tidePhase * 2.2);
				const backwash = Math.sin(x * this.cfg.wave_freq * 0.46 - tidePhase * 1.6 + 0.8);
				const chop = Math.sin(x * this.cfg.wave_freq * 1.85 + tidePhase * 3.1 + this._hash(24100 + x) * 3);
				const shore = baseShore + slopeOffset + wave * this.cfg.wave_amp * (0.14 + tideLevel * 0.1) + backwash * this.cfg.wave_amp * 0.08 + chop * this.cfg.wave_amp * 0.03;
				shoreRows[x] = Math.max(horizon + 3, Math.min(this.h - 4, shore));
			}
			for (let pass = 0; pass < 2; pass++) {
				for (let x = 1; x < this.w - 1; x++) {
					shoreRows[x] = (shoreRows[x - 1] + shoreRows[x] * 2 + shoreRows[x + 1]) / 4;
				}
			}

			const sandTop = hslToRGB(39, 0.54, 0.8);
			const sandMid = hslToRGB(36, 0.48, 0.68);
			const sandLow = hslToRGB(33, 0.42, 0.54);
			const drawSandPath = () => {
				ctx.beginPath();
				ctx.moveTo(0, canvasH);
				for (let x = 0; x < this.w; x++) {
					ctx.lineTo(Math.floor(x * sx), Math.floor(shoreRows[x] * sy));
				}
				ctx.lineTo(canvasW, canvasH);
				ctx.closePath();
			};
			drawSandPath();
			const sandGrad = ctx.createLinearGradient(0, Math.floor(horizon * sy), 0, canvasH);
			sandGrad.addColorStop(0, `rgb(${sandTop.r},${sandTop.g},${sandTop.b})`);
			sandGrad.addColorStop(0.55, `rgb(${sandMid.r},${sandMid.g},${sandMid.b})`);
			sandGrad.addColorStop(1, `rgb(${sandLow.r},${sandLow.g},${sandLow.b})`);
			ctx.fillStyle = sandGrad;
			ctx.fill();

			const duneColor = hslToRGB(31, 0.32, 0.42);
			const dunePoints = [];
			for (let i = 0; i <= 6; i++) {
				dunePoints.push(Math.floor(this.h * 0.74) + Math.floor(this._hash(24200 + i) * 5) + Math.floor(Math.sin(i * 1.08 + this._hash(24300 + i) * 2) * 2));
			}
			ctx.fillStyle = `rgba(${duneColor.r},${duneColor.g},${duneColor.b},0.16)`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (let x = 0; x < this.w; x++) {
				const pos = (x / Math.max(1, this.w - 1)) * 6;
				const idx = Math.min(5, Math.floor(pos));
				const frac = pos - idx;
				const eased = frac * frac * (3 - 2 * frac);
				const y = dunePoints[idx] + (dunePoints[idx + 1] - dunePoints[idx]) * eased;
				ctx.lineTo(Math.floor(x * sx), Math.floor(y * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const wetColor = hslToRGB(34, 0.34, 0.34 + clamp01(0.22 + tideLevel * 0.36) * 0.12);
			const foamColor = hslToRGB((this.cfg.hue - 8 + 360) % 360, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmax * 1.02));
			const shimmerColor = hslToRGB((this.cfg.hue - 12 + 360) % 360, clamp01(this.cfg.sat * 0.5), clamp01(this.cfg.lmax * 0.96));
			const shimmerLevel = clamp01(this.cfg.shimmer * (0.6 + tideLevel * 0.5));

			for (let x = 0; x < this.w; x++) {
				const shore = shoreRows[x];
				const surfRow = Math.round(shore);
				const wetBand = Math.max(2, Math.round(2 + tideLevel * 3 + Math.max(0, foamGain - 1) * 1.4));
				const foamBand = Math.max(1, Math.round(1 + this.cfg.foam * 2.8 + Math.max(0, foamGain - 1) * 1.4));

				for (let row = surfRow; row < Math.min(this.h, surfRow + wetBand); row++) {
					const fade = 1 - (row - shore) / Math.max(1, wetBand);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row, 1, 1, `rgb(${wetColor.r},${wetColor.g},${wetColor.b})`, clamp01(0.14 + fade * 0.32));
				}

				for (let i = 0; i < foamBand; i++) {
					const row = surfRow - i;
					const pulse = 0.55 + 0.45 * Math.sin(this.tick * 0.05 + x * 0.18 + i * 0.9);
					const alpha = clamp01((0.12 + this.cfg.foam * 0.42) * foamGain * (0.5 + 0.5 * pulse));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row, 1, 1, `rgb(${foamColor.r},${foamColor.g},${foamColor.b})`, alpha);
				}

				if ((x + this.tick) % 2 === 0) {
					const depth = 0.18 + this._hash(24400 + x) * 0.56;
					const row = Math.max(horizon + 1, Math.floor(horizon + (shore - horizon) * depth));
					const width = 1 + Math.floor(this._hash(24500 + x) * 3);
					const blink = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(this.tick * 0.03 + x * 0.12), 2);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row, width, 1, `rgb(${shimmerColor.r},${shimmerColor.g},${shimmerColor.b})`, clamp01((0.08 + shimmerLevel * 0.34) * blink));
				}

				if ((x + Math.floor(this.tick / 3)) % 7 === 0) {
					const pebbleRow = Math.min(this.h - 2, surfRow + wetBand + 1 + Math.floor(this._hash(24600 + x) * 8));
					const pebble = hslToRGB(34 + this._hash(24700 + x) * 10, 0.2, 0.4 + this._hash(24800 + x) * 0.12);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, pebbleRow, 1, 1, `rgb(${pebble.r},${pebble.g},${pebble.b})`, 0.22);
				}
			}
		}
	}

	api.presets['beach'] = [
		{
			key: 'still-shore',
			label: 'still shore',
			config: {
				shoreline: 0.56,
				tide_amp: 3.2,
				wave_amp: 1.3,
				wave_freq: 0.14,
				speed: 0.05,
				slope: 0.08,
				foam: 0.24,
				shimmer: 0.18,
				hue: 196,
				hue_sp: 10,
				sat: 0.42,
				lmin: 0.26,
				lmax: 0.78,
			},
		},
		{
			key: 'gentle-tide',
			label: 'gentle tide',
			config: {
				shoreline: 0.58,
				tide_amp: 6,
				wave_amp: 2.4,
				wave_freq: 0.18,
				speed: 0.1,
				slope: 0.16,
				foam: 0.36,
				shimmer: 0.22,
				hue: 198,
				hue_sp: 16,
				sat: 0.5,
				lmin: 0.28,
				lmax: 0.82,
				high_tide_p: 0.0008,
				low_tide_p: 0.0006,
			},
		},
		{
			key: 'foamy-edge',
			label: 'foamy edge',
			config: {
				shoreline: 0.6,
				tide_amp: 7.4,
				wave_amp: 3.1,
				wave_freq: 0.21,
				speed: 0.12,
				slope: 0.2,
				foam: 0.5,
				shimmer: 0.18,
				hue: 194,
				hue_sp: 18,
				sat: 0.54,
				lmin: 0.3,
				lmax: 0.84,
				high_tide_p: 0.0012,
				foam_burst_p: 0.0013,
				foam_burst_mult: 2.2,
			},
		},
		{
			key: 'wide-beach',
			label: 'wide beach',
			config: {
				shoreline: 0.52,
				tide_amp: 4.8,
				wave_amp: 1.8,
				wave_freq: 0.12,
				speed: 0.08,
				slope: -0.1,
				foam: 0.3,
				shimmer: 0.28,
				hue: 202,
				hue_sp: 14,
				sat: 0.44,
				lmin: 0.24,
				lmax: 0.78,
				low_tide_p: 0.0011,
			},
		},
	];
	api.effects['beach'] = Beach;
})(window.AmbienceSim);
// ===== effects/burning_trees.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	// BurningTrees — slow ambient row of trees that ignite, burn, and resolve
	// into ash. Mirrors sim/burning_trees.go: same tree state machine
	// (alive → igniting → burning → ashing → ash) and lifecycle so authority
	// and browser stay in sync on which tree is currently on fire even though
	// inner flame turbulence renders independently per client.
	const BURNING_TREES_DEFAULTS = {
		intro_dur: 60, intro_growth: 0.18,
		ending_dur: 80, ending_linger: 30, ending_ash: 0.35,
		tree_count: 9, tree_width: 7, tree_min_h: 8, tree_max_h: 16,
		baseline: 0.86, canopy: 0.62,
		ignite_dur: 30, burn_dur: 220, ash_dur: 80, spread_p: 0.012,
		flame_h: 9, flicker: 0.7, ember_rate: 0.32, glow: 0.45, smoke: 0.45,
		canopy_hue: 118, flame_hue: 22, hue_sp: 14, sat: 0.62, lmin: 0.18, lmax: 0.82,
		ignite_p: 0, flare_p: 0, lull_p: 0,
		flare_dur: 36, flare_mult: 1.7, lull_dur: 60, lull_mult: 0.55,
	};

	const BTREE_STATE_ALIVE = 0;
	const BTREE_STATE_IGNITING = 1;
	const BTREE_STATE_BURNING = 2;
	const BTREE_STATE_ASHING = 3;
	const BTREE_STATE_ASH = 4;

	function applyBurningTreesDefaults(cfg) {
		const c = Object.assign({}, BURNING_TREES_DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = BURNING_TREES_DEFAULTS.intro_dur;
		c.intro_growth = clamp01(c.intro_growth);
		if (c.ending_dur <= 0) c.ending_dur = BURNING_TREES_DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_ash = clamp01(c.ending_ash);
		if (c.tree_count <= 0) c.tree_count = BURNING_TREES_DEFAULTS.tree_count;
		if (c.tree_count > 24) c.tree_count = 24;
		if (c.tree_width <= 0) c.tree_width = BURNING_TREES_DEFAULTS.tree_width;
		if (c.tree_min_h <= 0) c.tree_min_h = BURNING_TREES_DEFAULTS.tree_min_h;
		if (c.tree_max_h <= 0) c.tree_max_h = BURNING_TREES_DEFAULTS.tree_max_h;
		if (c.tree_max_h < c.tree_min_h) [c.tree_min_h, c.tree_max_h] = [c.tree_max_h, c.tree_min_h];
		if (c.baseline <= 0) c.baseline = BURNING_TREES_DEFAULTS.baseline;
		if (c.canopy <= 0) c.canopy = BURNING_TREES_DEFAULTS.canopy;
		if (c.ignite_dur <= 0) c.ignite_dur = BURNING_TREES_DEFAULTS.ignite_dur;
		if (c.burn_dur <= 0) c.burn_dur = BURNING_TREES_DEFAULTS.burn_dur;
		if (c.ash_dur <= 0) c.ash_dur = BURNING_TREES_DEFAULTS.ash_dur;
		if (c.spread_p < 0) c.spread_p = 0;
		if (c.flame_h <= 0) c.flame_h = BURNING_TREES_DEFAULTS.flame_h;
		if (c.flicker <= 0) c.flicker = BURNING_TREES_DEFAULTS.flicker;
		if (c.ember_rate < 0) c.ember_rate = 0;
		if (c.glow <= 0) c.glow = BURNING_TREES_DEFAULTS.glow;
		if (c.smoke < 0) c.smoke = 0;
		if (c.canopy_hue === 0) c.canopy_hue = BURNING_TREES_DEFAULTS.canopy_hue;
		if (c.flame_hue < 0) c.flame_hue = BURNING_TREES_DEFAULTS.flame_hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = BURNING_TREES_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = BURNING_TREES_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = BURNING_TREES_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.ignite_p < 0) c.ignite_p = 0;
		if (c.flare_p < 0) c.flare_p = 0;
		if (c.lull_p < 0) c.lull_p = 0;
		if (c.flare_dur <= 0) c.flare_dur = BURNING_TREES_DEFAULTS.flare_dur;
		if (c.flare_mult <= 0) c.flare_mult = BURNING_TREES_DEFAULTS.flare_mult;
		if (c.lull_dur <= 0) c.lull_dur = BURNING_TREES_DEFAULTS.lull_dur;
		if (c.lull_mult <= 0) c.lull_mult = BURNING_TREES_DEFAULTS.lull_mult;
		return c;
	}

	class BurningTrees {
		constructor(w, h, cfg, seed) {
			this.kind = 'burning-trees';
			this.w = w;
			this.h = h;
			this.cfg = applyBurningTreesDefaults(cfg);
			this.seed = Number(seed || Date.now());
			this.rng = makeRNG(this.seed);
			this.tick = 0;
			this.states = new Uint8Array(this.cfg.tree_count);
			this.phaseLeft = new Int32Array(this.cfg.tree_count);
			this.phaseTotal = new Int32Array(this.cfg.tree_count);
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.flareTicks = 0;
			this.flareGain = 1;
			this.lullTicks = 0;
		}

		setConfig(cfg) {
			const next = applyBurningTreesDefaults(Object.assign({}, this.cfg, cfg));
			if (next.tree_count !== this.states.length) {
				this.states = new Uint8Array(next.tree_count);
				this.phaseLeft = new Int32Array(next.tree_count);
				this.phaseTotal = new Int32Array(next.tree_count);
			}
			this.cfg = next;
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || 0;
			const states = state.States || state.states;
			if (states) {
				let bytes;
				if (typeof states === 'string') {
					const bin = atob(states);
					bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
				} else {
					bytes = Uint8Array.from(states);
				}
				if (bytes.length !== this.states.length) {
					this.states = new Uint8Array(bytes.length);
					this.phaseLeft = new Int32Array(bytes.length);
					this.phaseTotal = new Int32Array(bytes.length);
				}
				this.states.set(bytes);
			}
			const phaseLeft = state.phaseLeft || state.PhaseLeft;
			if (Array.isArray(phaseLeft) && phaseLeft.length === this.phaseLeft.length) {
				for (let i = 0; i < phaseLeft.length; i++) this.phaseLeft[i] = phaseLeft[i] | 0;
			}
			const phaseTotal = state.phaseTotal || state.PhaseTotal;
			if (Array.isArray(phaseTotal) && phaseTotal.length === this.phaseTotal.length) {
				for (let i = 0; i < phaseTotal.length; i++) this.phaseTotal[i] = phaseTotal[i] | 0;
			}
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			this.flareTicks = state.flareTicks || 0;
			this.flareGain = state.flareGain || 1;
			this.lullTicks = state.lullTicks || 0;
			if (typeof snap.seed === 'number') {
				this.seed = snap.seed;
				this.rng = makeRNG(snap.seed);
			}
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		triggerEvent(name) {
			switch (name) {
				case 'ignite': {
					const idx = this._pickHealthy();
					if (idx >= 0) this._ignite(idx);
					return true;
				}
				case 'flare':
					this.flareTicks = jitterInt(this.rng, this.cfg.flare_dur, 0.3);
					this.flareGain = Math.max(1, this.cfg.flare_mult * (0.85 + this.rng() * 0.3));
					return true;
				case 'lull':
					this.lullTicks = jitterInt(this.rng, this.cfg.lull_dur, 0.3);
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.endingTicks > 0) {
				this.endingTicks--;
				if (this.endingTicks === 0) this._startIntro();
			} else if (this.introTicks > 0) {
				this.introTicks--;
			}
			if (this.flareTicks > 0) {
				this.flareTicks--;
				if (this.flareTicks === 0) this.flareGain = 1;
			}
			if (this.lullTicks > 0) this.lullTicks--;
			this._advanceTrees();
			// Spread/spawn rolls happen on the authority only — clients don't
			// fire those, they just replay the resulting trigger commands.
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				const burnSky = this._anyBurning();
				if (burnSky) {
					sky.addColorStop(0, '#0a0712');
					sky.addColorStop(0.55, '#1a0f10');
					sky.addColorStop(1, '#150705');
				} else {
					sky.addColorStop(0, '#0d1a18');
					sky.addColorStop(0.55, '#152724');
					sky.addColorStop(1, '#1d2419');
				}
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const baseRow = Math.max(8, Math.min(this.h - 2, Math.floor(this.h * this.cfg.baseline)));

			// Soil — flat ground band beneath the trees.
			for (let y = baseRow; y < this.h; y++) {
				const ratio = (y - baseRow) / Math.max(1, this.h - baseRow);
				const dirt = hslToRGB((this.cfg.canopy_hue + 12) % 360, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmin * (0.4 + ratio * 0.6)));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${dirt.r},${dirt.g},${dirt.b})`, 1);
			}

			const introProgress = this._introProgress();
			const endingProgress = this._endingProgress();
			const ashLinger = this._ashLingerLevel();
			const intensity = this._intensityLevel();

			// Per-tree paint pass — the tree row is the meat of the effect.
			const n = this.states.length || 1;
			const rowHalf = Math.max(1, this.cfg.tree_width * 0.5);
			const rowSpan = this.w / n;
			for (let i = 0; i < n; i++) {
				const cx = Math.floor(rowSpan * (i + 0.5));
				const treeRng = this._treeNoise(i);
				const heightFrac = 0.5 + 0.5 * treeRng[0];
				const fullH = Math.max(2, Math.round(this.cfg.tree_min_h + (this.cfg.tree_max_h - this.cfg.tree_min_h) * heightFrac));
				let stateH = fullH;
				if (this.introTicks > 0) {
					const grow = this.cfg.intro_growth + (1 - this.cfg.intro_growth) * introProgress;
					stateH = Math.max(2, Math.round(fullH * grow));
				}
				const halfW = Math.max(1, Math.round(rowHalf + treeRng[1] * 1.5));
				const state = this.states[i];
				const burnEnv = this._burnEnvelope(i);
				this._paintTree(ctx, sx, sy, ceilSx, ceilSy, cx, baseRow, stateH, halfW, i, treeRng, state, burnEnv, ashLinger, intensity, endingProgress);
			}

			// Vignette + warm wash if anything is on fire.
			if (this._anyActiveFlame()) {
				const center = canvasW * 0.5;
				const vignY = Math.floor(baseRow * sy);
				const radius = Math.max(canvasW, canvasH) * 0.55;
				const wash = ctx.createRadialGradient(center, vignY, radius * 0.2, center, vignY, radius);
				const tint = hslToRGB(this.cfg.flame_hue, clamp01(this.cfg.sat * 0.6), clamp01(this.cfg.lmax * 0.7));
				wash.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},${0.06 + intensity * 0.05})`);
				wash.addColorStop(1, 'rgba(0,0,0,0)');
				ctx.fillStyle = wash;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
		}

		// _paintTree draws one tree at column cx with stump on baseRow. Trees
		// blend through the burn lifecycle so a tree halfway through burning
		// still has a visible (but sparser, charring) canopy with flame inside.
		_paintTree(ctx, sx, sy, ceilSx, ceilSy, cx, baseRow, stateH, halfW, i, treeRng, state, burnEnv, ashLinger, intensity, endingProgress) {
			const trunkH = Math.max(2, Math.round(stateH * 0.32));
			const canopyH = Math.max(2, stateH - trunkH);
			const burning = state === BTREE_STATE_IGNITING || state === BTREE_STATE_BURNING || state === BTREE_STATE_ASHING;
			const canopyAlive = state === BTREE_STATE_ALIVE;
			const charProgress = this._charProgress(state, burnEnv);

			// Trunk.
			const trunkBase = hslToRGB((this.cfg.canopy_hue + 28) % 360, clamp01(this.cfg.sat * 0.28), clamp01(this.cfg.lmin * 0.95 - charProgress * 0.06));
			const trunkChar = hslToRGB(20, 0.18, clamp01(0.04 + (1 - charProgress) * 0.08));
			for (let y = 0; y < trunkH; y++) {
				const row = baseRow - 1 - y;
				if (row < 0) break;
				const trunkOffset = Math.round((treeRng[2] - 0.5) * 1.6 * y / Math.max(1, trunkH));
				for (let dx = -1; dx <= 1; dx++) {
					const col = cx + dx + trunkOffset;
					const c = charProgress >= 0.5 ? trunkChar : trunkBase;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${c.r},${c.g},${c.b})`, 1);
				}
			}

			// Canopy or charred silhouette. Cone-ish silhouette with hashed leaf cells.
			const canopyTop = baseRow - trunkH - canopyH;
			const canopyAlpha = canopyAlive ? 1 : (state === BTREE_STATE_IGNITING ? 0.95 : (state === BTREE_STATE_BURNING ? 0.75 - burnEnv * 0.4 : (state === BTREE_STATE_ASHING ? 0.4 * (1 - burnEnv) : ashLinger)));
			if (canopyAlpha > 0.02) {
				const baseHueJitter = (treeRng[3] - 0.5) * this.cfg.hue_sp;
				const canopyHue = ((this.cfg.canopy_hue + baseHueJitter) % 360 + 360) % 360;
				const charHue = 20 + (treeRng[4] - 0.5) * 10;
				const canopyLight = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.42 + treeRng[5] * 0.22));
				const charLight = clamp01(0.08 + (1 - charProgress) * 0.06);
				for (let y = 0; y < canopyH; y++) {
					const row = canopyTop + y;
					const yFrac = y / Math.max(1, canopyH - 1);
					const widthShape = Math.max(1, Math.round(halfW * (0.35 + 0.65 * yFrac)));
					for (let dx = -widthShape; dx <= widthShape; dx++) {
						const col = cx + dx;
						const filled = this._canopyHash(i, dx, y, this.cfg.canopy);
						if (!filled) continue;
						let r, g, b, alpha;
						if (charProgress > 0.85 || state === BTREE_STATE_ASH) {
							const c = hslToRGB(charHue, 0.18, charLight);
							r = c.r; g = c.g; b = c.b; alpha = canopyAlpha * 0.8;
						} else if (charProgress > 0.05) {
							const blend = clamp01(charProgress * 1.05);
							const fresh = hslToRGB(canopyHue, this.cfg.sat, canopyLight * (1 - blend * 0.4));
							const charred = hslToRGB(charHue, 0.16, charLight + 0.06);
							r = Math.round(fresh.r * (1 - blend) + charred.r * blend);
							g = Math.round(fresh.g * (1 - blend) + charred.g * blend);
							b = Math.round(fresh.b * (1 - blend) + charred.b * blend);
							alpha = canopyAlpha;
						} else {
							const c = hslToRGB(canopyHue, this.cfg.sat, canopyLight);
							r = c.r; g = c.g; b = c.b; alpha = canopyAlpha;
						}
						alpha = clamp01(alpha * (0.85 + (treeRng[6] - 0.5) * 0.2));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${r},${g},${b})`, alpha);
					}
				}
			}

			// Active flame inside / above the canopy while igniting/burning/ashing.
			if (burning) {
				const flameBase = baseRow - trunkH - Math.round(canopyH * 0.4);
				this._paintFlame(ctx, sx, sy, ceilSx, ceilSy, cx, flameBase, halfW, i, burnEnv, intensity, state);
				if (this.cfg.ember_rate > 0) {
					this._paintEmbers(ctx, sx, sy, ceilSx, ceilSy, cx, flameBase, halfW, i, burnEnv, intensity, state);
				}
				if (this.cfg.glow > 0) {
					this._paintGlow(ctx, sx, sy, cx, baseRow - trunkH - Math.round(canopyH * 0.5), halfW, burnEnv, intensity, state);
				}
			}
			// Smoke trails for burning + ashing trees.
			if ((burning || (state === BTREE_STATE_ASH && ashLinger > 0.2)) && this.cfg.smoke > 0) {
				this._paintSmoke(ctx, sx, sy, ceilSx, ceilSy, cx, canopyTop, halfW, i, burnEnv, state);
			}
		}

		_paintFlame(ctx, sx, sy, ceilSx, ceilSy, cx, anchorRow, halfW, i, burnEnv, intensity, state) {
			const speed = this.tick * 0.18;
			const intensityMix = intensity * (state === BTREE_STATE_IGNITING ? 0.55 + burnEnv * 0.45 : (state === BTREE_STATE_ASHING ? 0.25 + burnEnv * 0.4 : 0.7 + burnEnv * 0.3));
			const flameH = Math.max(2, Math.round(this.cfg.flame_h * (0.5 + intensityMix * 0.7)));
			const flameW = Math.max(1, Math.round(halfW * (0.55 + intensityMix * 0.4)));
			for (let dx = -flameW; dx <= flameW; dx++) {
				const nx = Math.abs(dx) / Math.max(1, flameW);
				const widthShape = Math.max(0, 1 - Math.pow(nx, 1.4));
				if (widthShape <= 0.05) continue;
				const pulse = 0.78 + 0.22 * Math.sin(speed * 1.4 + dx * 0.6 + this._hash(8000 + i * 41 + dx) * 6);
				const colH = Math.max(1, Math.round(flameH * widthShape * pulse));
				for (let y = 0; y < colH; y++) {
					const lift = y / Math.max(1, colH);
					const taper = 1 - lift;
					const sway = Math.sin(speed * 1.9 + dx * 0.3 + y * 0.22 + this._hash(8200 + i * 53 + y) * 6) * this.cfg.flicker * taper * 0.6;
					const col = Math.round(cx + dx + sway);
					const row = Math.round(anchorRow - y);
					if (row < 0) break;
					const hueWiggle = (this._hash(8400 + i * 19 + y * 7 + dx) - 0.5) * this.cfg.hue_sp * 0.4;
					const hue = ((this.cfg.flame_hue - lift * this.cfg.hue_sp * 0.4 + hueWiggle) % 360 + 360) % 360;
					const sat = clamp01(this.cfg.sat * (0.85 + taper * 0.18));
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.22 + taper * 0.78));
					const alpha = clamp01((0.18 + taper * 0.55) * (0.4 + widthShape * 0.6) * intensityMix);
					const color = hslToRGB(hue, sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
					if (widthShape > 0.4 && lift < 0.55 && (dx + y) % 2 === 0) {
						const core = hslToRGB((this.cfg.flame_hue + 8) % 360, clamp01(this.cfg.sat * 0.7), clamp01(this.cfg.lmax * (0.7 + taper * 0.25)));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${core.r},${core.g},${core.b})`, alpha * 0.55);
					}
				}
			}
		}

		_paintEmbers(ctx, sx, sy, ceilSx, ceilSy, cx, anchorRow, halfW, i, burnEnv, intensity, state) {
			const intensityMix = intensity * (state === BTREE_STATE_BURNING ? 1 : 0.55);
			const count = Math.max(1, Math.round(this.cfg.ember_rate * 6 * intensityMix));
			const maxRise = Math.max(6, Math.round(this.cfg.flame_h * 1.6 + 6));
			for (let k = 0; k < count; k++) {
				const cycle = maxRise + 6 + Math.floor(this._hash(9000 + i * 23 + k) * 12);
				const phase = positiveMod(this.tick * 0.3 * (0.7 + this._hash(9100 + i * 17 + k) * 0.6) + this._hash(9200 + i * 13 + k) * cycle, cycle);
				if (phase > maxRise) continue;
				const fade = 1 - phase / Math.max(1, maxRise);
				const drift = (this._hash(9300 + i * 11 + k) * 2 - 1) * (1.4 + phase * 0.06);
				const col = Math.round(cx + drift);
				const row = Math.round(anchorRow - 1 - phase);
				if (row < 0) continue;
				const hue = ((this.cfg.flame_hue + (this._hash(9400 + i * 7 + k) - 0.5) * 14) + 360) % 360;
				const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.55 + fade * 0.4));
				const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.85), light);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${color.r},${color.g},${color.b})`, clamp01((0.18 + fade * 0.6) * intensityMix));
			}
		}

		_paintGlow(ctx, sx, sy, cx, anchorRow, halfW, burnEnv, intensity, state) {
			const stage = state === BTREE_STATE_BURNING ? 1 : (state === BTREE_STATE_IGNITING ? 0.55 : 0.35);
			const strength = clamp01(this.cfg.glow * stage * intensity * (0.6 + burnEnv * 0.45));
			if (strength < 0.05) return;
			const glowX = cx * sx;
			const glowY = anchorRow * sy;
			const radius = Math.max(20, halfW * sx * (4 + strength * 6));
			const grad = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
			const core = hslToRGB((this.cfg.flame_hue + 6) % 360, clamp01(this.cfg.sat), clamp01(this.cfg.lmax * 0.85));
			const outer = hslToRGB((this.cfg.flame_hue - 4 + 360) % 360, clamp01(this.cfg.sat * 0.7), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.5));
			grad.addColorStop(0, `rgba(${core.r},${core.g},${core.b},${0.32 + strength * 0.28})`);
			grad.addColorStop(0.5, `rgba(${outer.r},${outer.g},${outer.b},${0.14 + strength * 0.18})`);
			grad.addColorStop(1, `rgba(${outer.r},${outer.g},${outer.b},0)`);
			ctx.fillStyle = grad;
			ctx.fillRect(glowX - radius, glowY - radius, radius * 2, radius * 2);
		}

		_paintSmoke(ctx, sx, sy, ceilSx, ceilSy, cx, canopyTop, halfW, i, burnEnv, state) {
			const stage = state === BTREE_STATE_BURNING ? 1 : (state === BTREE_STATE_IGNITING ? 0.55 : (state === BTREE_STATE_ASHING ? 0.85 : 0.45));
			const strength = clamp01(this.cfg.smoke * stage);
			if (strength < 0.05) return;
			const maxRise = Math.max(6, Math.round(canopyTop * 0.7));
			const puffCount = Math.max(2, Math.round(3 + strength * 6));
			for (let k = 0; k < puffCount; k++) {
				const cycle = maxRise + 8 + Math.floor(this._hash(10000 + i * 31 + k) * 18);
				const phase = positiveMod(this.tick * 0.12 * (0.7 + this._hash(10100 + i * 27 + k) * 0.5) + this._hash(10200 + i * 19 + k) * cycle, cycle);
				if (phase > maxRise) continue;
				const fade = 1 - phase / Math.max(1, maxRise);
				const drift = Math.sin(this.tick * 0.04 + i + k) * (1.5 + phase * 0.1) + (this._hash(10300 + i * 13 + k) - 0.5) * halfW * 0.6;
				const col = Math.round(cx + drift);
				const row = Math.round(canopyTop - 1 - phase);
				if (row < 0) continue;
				const tint = hslToRGB((this.cfg.flame_hue + 14) % 360, clamp01(this.cfg.sat * 0.18), clamp01(0.18 + fade * 0.4));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${tint.r},${tint.g},${tint.b})`, clamp01(0.12 + fade * 0.45 * strength));
			}
		}

		_pickHealthy() {
			const list = [];
			for (let i = 0; i < this.states.length; i++) {
				if (this.states[i] === BTREE_STATE_ALIVE) list.push(i);
			}
			if (list.length === 0) return -1;
			return list[Math.floor(this.rng() * list.length)];
		}

		_ignite(idx) {
			if (idx < 0 || idx >= this.states.length) return;
			if (this.states[idx] !== BTREE_STATE_ALIVE) return;
			const dur = jitterInt(this.rng, this.cfg.ignite_dur, 0.25);
			this.states[idx] = BTREE_STATE_IGNITING;
			this.phaseLeft[idx] = dur;
			this.phaseTotal[idx] = dur;
		}

		_advanceTrees() {
			for (let i = 0; i < this.states.length; i++) {
				if (this.states[i] === BTREE_STATE_ALIVE) continue;
				if (this.phaseLeft[i] > 0) this.phaseLeft[i]--;
				if (this.phaseLeft[i] > 0) continue;
				switch (this.states[i]) {
					case BTREE_STATE_IGNITING: {
						const dur = jitterInt(this.rng, this.cfg.burn_dur, 0.2);
						this.states[i] = BTREE_STATE_BURNING;
						this.phaseLeft[i] = dur;
						this.phaseTotal[i] = dur;
						break;
					}
					case BTREE_STATE_BURNING: {
						const dur = jitterInt(this.rng, this.cfg.ash_dur, 0.25);
						this.states[i] = BTREE_STATE_ASHING;
						this.phaseLeft[i] = dur;
						this.phaseTotal[i] = dur;
						break;
					}
					case BTREE_STATE_ASHING:
						this.states[i] = BTREE_STATE_ASH;
						this.phaseLeft[i] = 0;
						this.phaseTotal[i] = 0;
						break;
				}
			}
		}

		_startIntro() {
			this.states.fill(BTREE_STATE_ALIVE);
			this.phaseLeft.fill(0);
			this.phaseTotal.fill(0);
			this.flareTicks = 0;
			this.flareGain = 1;
			this.lullTicks = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.introTotal = Math.max(1, this.cfg.intro_dur);
			this.introTicks = this.introTotal;
		}

		_startEnding() {
			this.flareTicks = 0;
			this.flareGain = 1;
			this.lullTicks = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingFade = Math.max(1, this.cfg.ending_dur);
			this.endingTotal = Math.max(1, this.endingFade + Math.max(0, this.cfg.ending_linger));
			this.endingTicks = this.endingTotal;
		}

		_introProgress() {
			if (this.introTicks <= 0 || this.introTotal <= 0) return 1;
			const elapsed = this.introTotal - this.introTicks;
			return clamp01(elapsed / Math.max(1, this.introTotal - 1));
		}

		_endingProgress() {
			if (this.endingTicks <= 0 || this.endingTotal <= 0) return 0;
			const elapsed = this.endingTotal - this.endingTicks;
			return clamp01(elapsed / Math.max(1, this.endingTotal - 1));
		}

		_ashLingerLevel() {
			if (this.endingTicks <= 0) return 1;
			return clamp01(this.cfg.ending_ash + (1 - this.cfg.ending_ash) * (1 - this._endingProgress()));
		}

		_intensityLevel() {
			let level = 1;
			if (this.flareTicks > 0) level *= this.flareGain || this.cfg.flare_mult;
			if (this.lullTicks > 0) level *= this.cfg.lull_mult;
			if (this.endingTicks > 0) level *= 1 - this._endingProgress() * 0.85;
			if (this.introTicks > 0) level *= 0.4 + 0.6 * this._introProgress();
			return Math.max(0.05, level);
		}

		_burnEnvelope(idx) {
			if (this.phaseTotal[idx] <= 0) return 0;
			const progress = clamp01((this.phaseTotal[idx] - this.phaseLeft[idx]) / Math.max(1, this.phaseTotal[idx] - 1));
			switch (this.states[idx]) {
				case BTREE_STATE_IGNITING:
					return progress;
				case BTREE_STATE_BURNING:
					return Math.sin(progress * Math.PI) * 0.5 + 0.6;
				case BTREE_STATE_ASHING:
					return 0.6 * (1 - progress);
				default:
					return 0;
			}
		}

		_charProgress(state, burnEnv) {
			switch (state) {
				case BTREE_STATE_ALIVE: return 0;
				case BTREE_STATE_IGNITING: return Math.min(0.45, burnEnv * 0.45);
				case BTREE_STATE_BURNING: return clamp01(0.45 + burnEnv * 0.35);
				case BTREE_STATE_ASHING: return clamp01(0.8 + (1 - burnEnv) * 0.2);
				case BTREE_STATE_ASH: return 1;
				default: return 0;
			}
		}

		_canopyHash(treeIdx, dx, y, density) {
			const v = this._hash((treeIdx + 1) * 1009 + dx * 71 + y * 13);
			return v < density;
		}

		_anyBurning() {
			for (let i = 0; i < this.states.length; i++) {
				if (this.states[i] === BTREE_STATE_BURNING || this.states[i] === BTREE_STATE_IGNITING) return true;
			}
			return false;
		}

		_anyActiveFlame() {
			for (let i = 0; i < this.states.length; i++) {
				const s = this.states[i];
				if (s === BTREE_STATE_BURNING || s === BTREE_STATE_IGNITING || s === BTREE_STATE_ASHING) return true;
			}
			return false;
		}

		_treeNoise(idx) {
			return [
				this._hash(7000 + idx * 31),
				this._hash(7100 + idx * 31),
				this._hash(7200 + idx * 31),
				this._hash(7300 + idx * 31),
				this._hash(7400 + idx * 31),
				this._hash(7500 + idx * 31),
				this._hash(7600 + idx * 31),
			];
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}
	}

	api.presets['burning-trees'] = [
		{
			key: 'single-ignition',
			label: 'single ignition',
			config: {
				tree_count: 8,
				tree_width: 7,
				tree_min_h: 8,
				tree_max_h: 14,
				baseline: 0.86,
				canopy: 0.62,
				ignite_dur: 28,
				burn_dur: 240,
				ash_dur: 90,
				spread_p: 0,
				flame_h: 8,
				flicker: 0.62,
				ember_rate: 0.22,
				glow: 0.42,
				smoke: 0.38,
				canopy_hue: 122,
				flame_hue: 22,
				hue_sp: 12,
				sat: 0.6,
				lmin: 0.18,
				lmax: 0.8,
				ignite_p: 0.0008,
				flare_p: 0.0006,
			},
		},
		{
			key: 'slow-spread',
			label: 'slow spread',
			config: {
				tree_count: 10,
				tree_width: 7,
				tree_min_h: 9,
				tree_max_h: 16,
				baseline: 0.86,
				canopy: 0.62,
				ignite_dur: 32,
				burn_dur: 220,
				ash_dur: 80,
				spread_p: 0.012,
				flame_h: 9,
				flicker: 0.7,
				ember_rate: 0.32,
				glow: 0.45,
				smoke: 0.45,
				canopy_hue: 118,
				flame_hue: 22,
				hue_sp: 14,
				sat: 0.62,
				lmin: 0.18,
				lmax: 0.82,
				ignite_p: 0.001,
				flare_p: 0.0008,
				lull_p: 0.0008,
			},
		},
		{
			key: 'smoldering-line',
			label: 'smoldering line',
			config: {
				tree_count: 12,
				tree_width: 6.5,
				tree_min_h: 7,
				tree_max_h: 13,
				baseline: 0.84,
				canopy: 0.5,
				ignite_dur: 40,
				burn_dur: 320,
				ash_dur: 140,
				spread_p: 0.006,
				flame_h: 6,
				flicker: 0.5,
				ember_rate: 0.42,
				glow: 0.35,
				smoke: 0.7,
				canopy_hue: 110,
				flame_hue: 18,
				hue_sp: 18,
				sat: 0.55,
				lmin: 0.16,
				lmax: 0.7,
				ignite_p: 0.0006,
				lull_p: 0.001,
				ending_ash: 0.55,
			},
		},
		{
			key: 'active-burn',
			label: 'active burn',
			config: {
				tree_count: 12,
				tree_width: 7,
				tree_min_h: 10,
				tree_max_h: 18,
				baseline: 0.86,
				canopy: 0.7,
				ignite_dur: 22,
				burn_dur: 180,
				ash_dur: 60,
				spread_p: 0.028,
				flame_h: 12,
				flicker: 0.95,
				ember_rate: 0.55,
				glow: 0.7,
				smoke: 0.5,
				canopy_hue: 116,
				flame_hue: 18,
				hue_sp: 22,
				sat: 0.78,
				lmin: 0.2,
				lmax: 0.92,
				ignite_p: 0.002,
				flare_p: 0.0018,
				flare_mult: 2.1,
			},
		},
	];
	api.effects['burning-trees'] = BurningTrees;
})(window.AmbienceSim);
// ===== effects/campfire.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 45,
		intro_glow: 0.14,
		ending_dur: 60,
		ending_linger: 24,
		ending_glow: 0.08,
		flame_height: 14,
		flame_width: 10,
		flame_speed: 0.12,
		flicker: 0.72,
		ember_rate: 0.26,
		ember_speed: 0.62,
		glow: 0.54,
		hue: 24,
		hue_sp: 18,
		sat: 0.82,
		lmin: 0.32,
		lmax: 0.94,
		crackle_p: 0,
		lull_p: 0,
		crackle_dur: 36,
		crackle_mult: 1.85,
		lull_dur: 68,
		lull_mult: 0.55,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_glow = clamp01(c.intro_glow);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_glow = clamp01(c.ending_glow);
		if (c.flame_height <= 0) c.flame_height = DEFAULTS.flame_height;
		if (c.flame_width <= 0) c.flame_width = DEFAULTS.flame_width;
		if (c.flame_speed <= 0) c.flame_speed = DEFAULTS.flame_speed;
		if (c.flicker <= 0) c.flicker = DEFAULTS.flicker;
		if (c.ember_rate <= 0) c.ember_rate = DEFAULTS.ember_rate;
		if (c.ember_speed <= 0) c.ember_speed = DEFAULTS.ember_speed;
		if (c.glow <= 0) c.glow = DEFAULTS.glow;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.crackle_dur <= 0) c.crackle_dur = DEFAULTS.crackle_dur;
		if (c.crackle_mult <= 0) c.crackle_mult = DEFAULTS.crackle_mult;
		if (c.lull_dur <= 0) c.lull_dur = DEFAULTS.lull_dur;
		if (c.lull_mult <= 0) c.lull_mult = DEFAULTS.lull_mult;
		return c;
	}

	class Campfire {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 67);
			switch (name) {
				case 'crackle':
					this.timers.crackle = jitterInt(rng, this.cfg.crackle_dur, 0.3);
					this.values.crackle_gain = this.cfg.crackle_mult * (0.75 + rng() * 0.5);
					return true;
				case 'lull':
					this.timers.lull = jitterInt(rng, this.cfg.lull_dur, 0.3);
					return true;
				case 'intro':
					this.timers.crackle = 0;
					this.timers.lull = 0;
					this.timers.ending = 0;
					this.values.crackle_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.crackle = 0;
					this.timers.lull = 0;
					this.values.crackle_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.crackle || this.timers.crackle <= 0) this.values.crackle_gain = 1;
		}

		_flameLevel() {
			let level = 1;
			if (this.timers.crackle > 0) level *= this.values.crackle_gain || this.cfg.crackle_mult;
			if (this.timers.lull > 0) level *= this.cfg.lull_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_glow + (1 - this.cfg.intro_glow) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_glow) * progress;
			}
			return Math.max(0.05, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#08111a');
				sky.addColorStop(0.62, '#0f1520');
				sky.addColorStop(1, '#16110c');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const groundRow = Math.floor(this.h * 0.84);
			const centerX = Math.floor(this.w * 0.5);
			const flameLevel = this._flameLevel();
			const crackleGain = this.values.crackle_gain || 1;
			const halfW = Math.max(2, Math.round(this.cfg.flame_width * 0.5));
			const flameH = Math.max(4, this.cfg.flame_height * (0.52 + flameLevel * 0.38));
			const speed = this.tick * this.cfg.flame_speed * 1.7;

			for (let y = groundRow; y < this.h; y++) {
				const ratio = (y - groundRow) / Math.max(1, this.h - groundRow);
				const ground = hslToRGB(18, 0.24, 0.08 + ratio * 0.12);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${ground.r},${ground.g},${ground.b})`, 1);
			}

			const glowStrength = clamp01(this.cfg.glow * (0.6 + flameLevel * 0.45));
			const glowX = centerX * sx;
			const glowY = groundRow * sy;
			const glowR = Math.max(28, Math.min(canvasW, canvasH) * (0.08 + glowStrength * 0.12));
			const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowR);
			glow.addColorStop(0, `rgba(255, 178, 82, ${0.24 + glowStrength * 0.22})`);
			glow.addColorStop(0.42, `rgba(255, 120, 44, ${0.12 + glowStrength * 0.12})`);
			glow.addColorStop(1, 'rgba(255, 120, 44, 0)');
			ctx.fillStyle = glow;
			ctx.fillRect(glowX - glowR, glowY - glowR, glowR * 2, glowR * 2);

			const vignette = ctx.createRadialGradient(glowX, glowY, glowR * 0.35, glowX, glowY, glowR * 2.4);
			vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
			vignette.addColorStop(1, 'rgba(0, 0, 0, 0.26)');
			ctx.fillStyle = vignette;
			ctx.fillRect(0, 0, canvasW, canvasH);

			const logColor = hslToRGB(20, 0.46, 0.22);
			const logHighlight = hslToRGB(24, 0.44, 0.32);
			const logHalf = halfW + 2;
			for (let dx = -logHalf; dx <= logHalf; dx++) {
				const rowA = groundRow + 1 + Math.round(dx * 0.12);
				const rowB = groundRow + 1 - Math.round(dx * 0.1);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, rowA, 1, 1, `rgb(${logColor.r},${logColor.g},${logColor.b})`, 1);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, rowB, 1, 1, `rgb(${logColor.r},${logColor.g},${logColor.b})`, 0.82);
				if ((dx + logHalf) % 3 === 0) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, rowA, 1, 1, `rgb(${logHighlight.r},${logHighlight.g},${logHighlight.b})`, 0.34);
				}
			}

			for (let dx = -halfW; dx <= halfW; dx++) {
				const coalHeat = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(speed * 1.8 + dx * 0.8), 2);
				const coal = hslToRGB((this.cfg.hue - 4 + 360) % 360, clamp01(this.cfg.sat * 0.88), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.22 + coalHeat * 0.45)));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, groundRow, 1, 1, `rgb(${coal.r},${coal.g},${coal.b})`, 0.28 + coalHeat * 0.42);
			}

			for (let x = -halfW; x <= halfW; x++) {
				const nx = Math.abs(x) / Math.max(1, halfW);
				const widthShape = Math.max(0, 1 - Math.pow(nx, 1.32));
				if (widthShape <= 0.04) continue;
				const pulse = 0.8 + 0.2 * Math.sin(speed * 1.3 + x * 0.7 + this._hash(26000 + x + halfW) * 5);
				const columnH = Math.max(2, Math.round(flameH * widthShape * pulse));
				for (let y = 0; y < columnH; y++) {
					const lift = y / Math.max(1, columnH);
					const taper = 1 - lift;
					const sway = Math.sin(speed * 2.1 + x * 0.35 + y * 0.24 + this._hash(26100 + y * 31 + x + 400) * 6) * this.cfg.flicker * taper * 0.72;
					const col = Math.round(centerX + x + sway);
					const row = Math.round(groundRow - 1 - y);
					const hue = ((this.cfg.hue - lift * this.cfg.hue_sp * 0.34 + (this._hash(26200 + x * 17 + y + 700) * 2 - 1) * this.cfg.hue_sp * 0.08) % 360 + 360) % 360;
					const sat = clamp01(this.cfg.sat * (0.88 + taper * 0.16));
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.18 + taper * 0.8));
					const alpha = clamp01((0.12 + taper * 0.56) * (0.36 + widthShape * 0.64) * (0.72 + flameLevel * 0.18));
					const color = hslToRGB(hue, sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
					if (widthShape > 0.35 && lift < 0.6 && (x + y) % 2 === 0) {
						const core = hslToRGB((this.cfg.hue + 8) % 360, clamp01(this.cfg.sat * 0.74), clamp01(this.cfg.lmax * (0.72 + taper * 0.24)));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${core.r},${core.g},${core.b})`, alpha * 0.52);
					}
				}
			}

			const emberCount = Math.max(4, Math.round(this.cfg.flame_width * (0.8 + this.cfg.ember_rate * 3.8) * (this.timers.crackle > 0 ? 0.92 + crackleGain * 0.3 : 1)));
			const maxRise = Math.max(10, Math.round(this.cfg.flame_height * 2.1 + this.cfg.ember_speed * 12));
			for (let i = 0; i < emberCount; i++) {
				const cycle = maxRise + 8 + Math.floor(this._hash(27000 + i) * 12);
				const progress = positiveMod(this.tick * this.cfg.ember_speed * (0.7 + this._hash(27100 + i) * 0.7) + this._hash(27200 + i) * cycle, cycle);
				if (progress > maxRise) continue;
				const rise = progress;
				const fade = 1 - rise / Math.max(1, maxRise);
				const drift = (this._hash(27300 + i) * 2 - 1) * (1.2 + rise * 0.08) + Math.sin(speed + i * 0.7) * 0.6;
				const col = Math.round(centerX + drift);
				const row = Math.round(groundRow - 2 - rise);
				if (row < 1) continue;
				const size = fade > 0.72 && this.timers.crackle > 0 && this._hash(27400 + i) > 0.5 ? 2 : 1;
				const hue = ((this.cfg.hue - 6 + this._hash(27500 + i) * 10) % 360 + 360) % 360;
				const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.42 + fade * 0.5));
				const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.8), light);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, size, 1, `rgb(${color.r},${color.g},${color.b})`, clamp01((0.16 + fade * 0.68) * (0.78 + Math.max(0, crackleGain - 1) * 0.16)));
			}
		}
	}

	api.presets['campfire'] = [
		{
			key: 'small-fire',
			label: 'small fire',
			config: {
				flame_height: 9,
				flame_width: 7,
				flame_speed: 0.1,
				flicker: 0.56,
				ember_rate: 0.18,
				ember_speed: 0.52,
				glow: 0.4,
				hue: 22,
				hue_sp: 12,
				sat: 0.76,
				lmin: 0.28,
				lmax: 0.88,
			},
		},
		{
			key: 'steady-campfire',
			label: 'steady campfire',
			config: {
				flame_height: 14,
				flame_width: 10,
				flame_speed: 0.12,
				flicker: 0.72,
				ember_rate: 0.26,
				ember_speed: 0.62,
				glow: 0.54,
				hue: 24,
				hue_sp: 18,
				sat: 0.82,
				lmin: 0.32,
				lmax: 0.94,
				crackle_p: 0.0008,
			},
		},
		{
			key: 'crackling-fire',
			label: 'crackling fire',
			config: {
				flame_height: 16,
				flame_width: 11,
				flame_speed: 0.15,
				flicker: 0.92,
				ember_rate: 0.34,
				ember_speed: 0.78,
				glow: 0.62,
				hue: 21,
				hue_sp: 22,
				sat: 0.88,
				lmin: 0.34,
				lmax: 0.96,
				crackle_p: 0.0015,
				crackle_mult: 2.15,
				crackle_dur: 48,
			},
		},
		{
			key: 'late-embers',
			label: 'late embers',
			config: {
				intro_glow: 0.1,
				ending_glow: 0.14,
				flame_height: 8,
				flame_width: 8,
				flame_speed: 0.08,
				flicker: 0.42,
				ember_rate: 0.3,
				ember_speed: 0.48,
				glow: 0.34,
				hue: 18,
				hue_sp: 14,
				sat: 0.68,
				lmin: 0.24,
				lmax: 0.8,
				lull_p: 0.0014,
				lull_mult: 0.42,
			},
		},
	];
	api.effects['campfire'] = Campfire;
})(window.AmbienceSim);
// ===== effects/dust.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB } = api._helpers;

	const DUST_DEFAULTS = {
		intro_dur: 60,
		intro_haze: 0.12,
		intro_push: 1.5,
		ending_dur: 60,
		ending_linger: 20,
		ending_residue: 0.08,
		drift: 0.45,
		wander: 0.35,
		spawn: 4,
		burst: 2,
		max: 56,
		trail: 3,
		fade: 0.72,
		hue: 32,
		hue_sp: 10,
		sat: 0.35,
		lmin: 0.32,
		lmax: 0.72,
		layers: 2,
		lbal: 0.45,
		gust_p: 0,
		calm_p: 0,
		gust_dur: 50,
		gust_mult: 1.8,
		gust_front: 18,
		calm_dur: 65,
		calm_mult: 0.4,
	};

	function applyDustDefaults(cfg) {
		const c = Object.assign({}, DUST_DEFAULTS, cfg || {});
		if (c.intro_dur === 0 && c.intro_haze === 0 && c.intro_push === 0) {
			c.intro_dur = DUST_DEFAULTS.intro_dur;
			c.intro_haze = DUST_DEFAULTS.intro_haze;
			c.intro_push = DUST_DEFAULTS.intro_push;
		} else {
			if (c.intro_dur <= 0) c.intro_dur = DUST_DEFAULTS.intro_dur;
			if (c.intro_haze < 0) c.intro_haze = 0;
			if (c.intro_push <= 0) c.intro_push = DUST_DEFAULTS.intro_push;
		}
		c.intro_haze = clamp01(c.intro_haze);
		if (c.ending_dur === 0 && c.ending_linger === 0 && c.ending_residue === 0) {
			c.ending_dur = DUST_DEFAULTS.ending_dur;
			c.ending_linger = DUST_DEFAULTS.ending_linger;
			c.ending_residue = DUST_DEFAULTS.ending_residue;
		} else {
			if (c.ending_dur <= 0) c.ending_dur = DUST_DEFAULTS.ending_dur;
			if (c.ending_linger < 0) c.ending_linger = 0;
			if (c.ending_residue < 0) c.ending_residue = 0;
		}
		c.ending_residue = clamp01(c.ending_residue);
		if (c.drift === 0) c.drift = DUST_DEFAULTS.drift;
		if (c.wander <= 0) c.wander = DUST_DEFAULTS.wander;
		if (c.spawn <= 0) c.spawn = DUST_DEFAULTS.spawn;
		if (c.burst <= 0) c.burst = DUST_DEFAULTS.burst;
		if (c.max <= 0) c.max = DUST_DEFAULTS.max;
		if (c.trail <= 0) c.trail = DUST_DEFAULTS.trail;
		if (c.fade <= 0) c.fade = DUST_DEFAULTS.fade;
		if (c.hue === 0) c.hue = DUST_DEFAULTS.hue;
		if (c.hue_sp <= 0) c.hue_sp = DUST_DEFAULTS.hue_sp;
		if (c.sat <= 0) c.sat = DUST_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DUST_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DUST_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.layers <= 0) c.layers = DUST_DEFAULTS.layers;
		if (c.lbal <= 0) c.lbal = DUST_DEFAULTS.lbal;
		if (c.gust_dur <= 0) c.gust_dur = DUST_DEFAULTS.gust_dur;
		if (c.gust_mult <= 0) c.gust_mult = DUST_DEFAULTS.gust_mult;
		if (c.gust_front <= 0) c.gust_front = DUST_DEFAULTS.gust_front;
		if (c.calm_dur <= 0) c.calm_dur = DUST_DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DUST_DEFAULTS.calm_mult;
		return c;
	}

	class Dust {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applyDustDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.motes = [];
			this.gustTicks = 0;
			this.calmTicks = 0;
			this.gustCenter = h * 0.5;
			this.gustPush = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
		}

		setConfig(cfg) {
			const prev = this.cfg;
			const next = applyDustDefaults(Object.assign({}, this.cfg, cfg));
			if (prev && next.drift !== prev.drift) {
				const delta = next.drift - prev.drift;
				for (const mote of this.motes) {
					mote.vCol += delta * (mote.background ? 0.72 : 1);
				}
			}
			this.cfg = next;
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.gustTicks = state.gustTicks || 0;
			this.calmTicks = state.calmTicks || 0;
			if (typeof state.gustCenter === 'number') this.gustCenter = state.gustCenter;
			if (typeof state.gustPush === 'number') this.gustPush = state.gustPush;
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}
			this.motes = Array.isArray(state.motes) ? state.motes.map(m => ({
				row: m.row,
				col: m.col,
				vRow: m.vRow,
				vCol: m.vCol,
				life: m.life,
				maxLife: m.maxLife,
				trail: m.trail,
				color: m.color,
				background: !!m.background,
			})) : [];
		}

		triggerEvent(name) {
			switch (name) {
				case 'gust':
					this._startGust(this.cfg.gust_mult);
					return true;
				case 'calm':
					this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.gustTicks > 0) this.gustTicks--;
			else this.gustPush = 0;
			if (this.calmTicks > 0) this.calmTicks--;
			const introActive = this.introTicks > 0;
			const endingActive = this.endingTicks > 0;

			if (!introActive && !endingActive) {
				if (this.gustTicks === 0 && this.rng() < this.cfg.gust_p) {
					this._startGust(this.cfg.gust_mult);
				}
				if (this.calmTicks === 0 && this.rng() < this.cfg.calm_p) {
					this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
				}
			}

			this.grid.fill(0);
			this._paintHaze();
			this._spawnStep();
			this._stepMotes();
			this._paintMotes();

			if (introActive) this.introTicks = Math.max(0, this.introTicks - 1);
			if (endingActive) this.endingTicks = Math.max(0, this.endingTicks - 1);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		_startGust(mult) {
			this.gustTicks = jitterInt(this.rng, this.cfg.gust_dur, 0.3);
			this.gustCenter = this.h > 1 ? this.rng() * (this.h - 1) : 0;
			let dir = this.cfg.drift;
			if (Math.abs(dir) < 0.05) {
				dir = this.rng() < 0.5 ? -0.35 : 0.35;
			}
			const sign = dir < 0 ? -1 : 1;
			this.gustPush = sign * Math.max(0.18, Math.abs(dir)) * mult * (0.7 + this.rng() * 0.6);
		}

		_startIntro() {
			this.calmTicks = 0;
			this.gustTicks = 0;
			this.gustPush = 0;
			this.motes = [];
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.introTotal = this.cfg.intro_dur > 0 ? this.cfg.intro_dur : DUST_DEFAULTS.intro_dur;
			this.introTicks = this.introTotal;
			this._startGust(Math.max(0.2, this.cfg.intro_push));
		}

		_startEnding() {
			this.introTicks = 0;
			this.introTotal = 0;
			this.calmTicks = 0;
			this.gustTicks = 0;
			this.gustPush = 0;
			this.endingFade = this.cfg.ending_dur > 0 ? this.cfg.ending_dur : DUST_DEFAULTS.ending_dur;
			const linger = Math.max(0, this.cfg.ending_linger);
			this.endingTotal = Math.max(1, this.endingFade + linger);
			this.endingTicks = this.endingTotal;
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / (total - 1));
		}

		_densityLevel() {
			let level = 1.0;
			if (this.gustTicks > 0) level *= 1.25;
			if (this.calmTicks > 0) level *= this.cfg.calm_mult;
			if (this.introTicks > 0) {
				const progress = this._phaseProgress(this.introTotal, this.introTicks);
				level *= this.cfg.intro_haze + (1 - this.cfg.intro_haze) * progress;
			}
			if (this.endingTicks > 0) {
				const progress = this._phaseProgress(this.endingTotal, this.endingTicks);
				level *= 1 - (1 - this.cfg.ending_residue) * progress;
			}
			return Math.max(0.05, level);
		}

		_gustInfluence(row) {
			if (this.gustTicks <= 0) return 0;
			const half = Math.max(2, this.cfg.gust_front * 0.5);
			const dist = Math.abs(row - this.gustCenter);
			if (dist >= half) return 0;
			return 1 - dist / half;
		}

		_spawnStep() {
			if (this.motes.length >= this.cfg.max) return;
			const level = this._densityLevel();
			let spawnEvery = Math.round(this.cfg.spawn / Math.max(0.15, level));
			if (spawnEvery < 1) spawnEvery = 1;
			let attempts = 1;
			if (level > 1) {
				attempts += Math.floor(level);
				if (this.rng() < (level - Math.floor(level))) attempts++;
			}
			for (let i = 0; i < attempts && this.motes.length < this.cfg.max; i++) {
				if (this.rng.intn(spawnEvery) !== 0) continue;
				let burst = 1;
				if (this.cfg.burst > 1) burst = 1 + this.rng.intn(this.cfg.burst);
				if (this.gustTicks > 0 && this.rng() < 0.35) burst++;
				for (let j = 0; j < burst && this.motes.length < this.cfg.max; j++) {
					this._spawnMote();
				}
			}
		}

		_spawnRow() {
			if (this.h <= 1) return 0;
			if (this.gustTicks > 0) {
				const half = Math.max(2, this.cfg.gust_front * 0.5);
				return Math.max(0, Math.min(this.h - 1, this.gustCenter + (this.rng() * 2 - 1) * half * 0.9));
			}
			const center = this.h * 0.58 + Math.sin(this.tick * 0.017) * this.h * 0.08;
			const spread = Math.max(3, this.h * 0.28);
			return Math.max(0, Math.min(this.h - 1, center + (this.rng() * 2 - 1) * spread));
		}

		_spawnMote() {
			const isBG = this.cfg.layers >= 2 && this.rng() < this.cfg.lbal;
			const row = this._spawnRow();
			const gustInfluence = this._gustInfluence(row);
			let drift = this.cfg.drift;
			if (isBG) drift *= 0.72;
			let vCol = drift * (0.7 + this.rng() * 0.6) + this.gustPush * gustInfluence * (0.45 + this.rng() * 0.25);
			vCol += (this.rng() * 2 - 1) * this.cfg.wander * 0.05;
			let vRow = (this.rng() * 2 - 1) * (0.03 + this.cfg.wander * 0.12);
			if (isBG) vRow *= 0.7;
			let trail = this.cfg.trail;
			if (isBG) trail = Math.max(1, trail - 1);
			const hue = ((this.cfg.hue + (this.rng() * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
			let light = this.cfg.lmin + this.rng() * (this.cfg.lmax - this.cfg.lmin);
			if (isBG) light *= 0.78;
			const color = hslToRGB(hue, this.cfg.sat, light);
			const speed = Math.abs(vCol) + 0.15;
			let lifeBase = Math.round(Math.max(24, this.w) / Math.max(0.12, speed));
			lifeBase = Math.max(18, Math.min(260, lifeBase));
			const life = jitterInt(this.rng, lifeBase, 0.3);
			const edgePad = trail + 2;
			let col = this.rng() * Math.max(1, this.w - 1);
			if (vCol > 0.08) col = -edgePad + this.rng() * edgePad;
			else if (vCol < -0.08) col = (this.w - 1) + this.rng() * edgePad;
			this.motes.push({
				row,
				col,
				vRow,
				vCol,
				life,
				maxLife: life,
				trail,
				color,
				background: isBG,
			});
		}

		_stepMotes() {
			if (!this.motes.length) return;
			const alive = [];
			for (const mote of this.motes) {
				let wander = this.cfg.wander * 0.018;
				if (mote.background) wander *= 0.75;
				mote.vCol += (this.rng() * 2 - 1) * wander;
				mote.vRow += (this.rng() * 2 - 1) * wander * 0.8;
				let target = this.cfg.drift;
				if (mote.background) target *= 0.72;
				if (this.calmTicks > 0) target *= 0.88;
				if (this.gustTicks > 0) {
					const influence = this._gustInfluence(mote.row);
					target += this.gustPush * (0.55 + 0.45 * influence);
					mote.vRow += (this.rng() * 2 - 1) * influence * this.cfg.wander * 0.03;
				}
				mote.vCol += (target - mote.vCol) * 0.18;
				mote.vRow = Math.max(-0.28, Math.min(0.28, mote.vRow));
				let maxCol = Math.max(0.18, Math.abs(target) * 2.4 + 0.15);
				if (mote.background) maxCol *= 0.8;
				mote.vCol = Math.max(-maxCol, Math.min(maxCol, mote.vCol));
				mote.col += mote.vCol;
				mote.row += mote.vRow;
				while (mote.row < 0) mote.row += Math.max(1, this.h);
				while (mote.row >= this.h) mote.row -= Math.max(1, this.h);
				mote.life--;
				if (mote.life > 0 && mote.col >= -mote.trail - 2 && mote.col < this.w + mote.trail + 2) {
					alive.push(mote);
				}
			}
			this.motes = alive;
		}

		_paintHaze() {
			const level = this._densityLevel();
			if (level <= 0 || this.w <= 0 || this.h <= 0) return;
			const center = this.h * 0.58 + Math.sin(this.tick * 0.013) * this.h * 0.04;
			const spread = Math.max(4, this.h * 0.24);
			for (let y = 0; y < this.h; y++) {
				const rowInfluence = 1 - Math.abs(y - center) / spread;
				if (rowInfluence <= 0) continue;
				const gustRow = this._gustInfluence(y);
				for (let x = 0; x < this.w; x++) {
					const wave = 0.5 + 0.5 * Math.sin(x * 0.09 + y * 0.17 + this.tick * 0.04);
					let strength = rowInfluence * level * (0.02 + 0.05 * wave);
					if (gustRow > 0) {
						const sweep = 0.6 + 0.4 * Math.sin(x * 0.12 - this.tick * 0.06);
						strength += gustRow * 0.04 * sweep;
					}
					if (strength < 0.028) continue;
					const hue = ((this.cfg.hue - 6 + Math.sin(x * 0.03) * this.cfg.hue_sp * 0.2) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin * (0.18 + 0.6 * strength));
					const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.35), light);
					this._paintMax(y, x, color);
				}
			}
		}

		_paintMotes() {
			for (const mote of this.motes) {
				const lifeFade = clamp01(mote.life / Math.max(1, mote.maxLife));
				if (lifeFade <= 0) continue;
				const tail = Math.max(1, mote.trail);
				for (let i = 0; i < tail; i++) {
					const row = mote.row - i * mote.vRow * 0.75;
					const col = mote.col - i * mote.vCol * 0.75;
					const bright = Math.pow(this.cfg.fade, i) * (0.35 + 0.65 * lifeFade) * (mote.background ? 0.78 : 1);
					this._paintMax(Math.round(row), Math.round(col), {
						r: Math.floor(mote.color.r * bright),
						g: Math.floor(mote.color.g * bright),
						b: Math.floor(mote.color.b * bright),
					});
				}
			}
		}

		_paintMax(row, col, color) {
			if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
			if (color.r === 0 && color.g === 0 && color.b === 0) return;
			const i = (row * this.w + col) * 3;
			if (color.r > this.grid[i]) this.grid[i] = color.r;
			if (color.g > this.grid[i + 1]) this.grid[i + 1] = color.g;
			if (color.b > this.grid[i + 2]) this.grid[i + 2] = color.b;
		}
	}

	api.presets['dust'] = [
		{
			key: 'lazy-dust',
			label: 'lazy dust',
			config: {
				drift: 0.28,
				wander: 0.22,
				spawn: 5,
				burst: 1,
				max: 42,
				trail: 2,
				fade: 0.68,
				hue: 28,
				hue_sp: 8,
				sat: 0.28,
				lmin: 0.28,
				lmax: 0.62,
				gust_p: 0.0006,
				calm_p: 0.0008,
				gust_front: 14,
				calm_mult: 0.35,
			},
		},
		{
			key: 'cross-breeze',
			label: 'cross breeze',
			config: {
				drift: 0.58,
				wander: 0.3,
				spawn: 4,
				burst: 2,
				max: 60,
				trail: 3,
				fade: 0.74,
				hue: 34,
				hue_sp: 10,
				sat: 0.36,
				lmin: 0.32,
				lmax: 0.72,
				gust_p: 0.0012,
				calm_p: 0.0004,
				gust_mult: 1.7,
				gust_front: 20,
			},
		},
		{
			key: 'dry-gusts',
			label: 'dry gusts',
			config: {
				intro_push: 2.1,
				drift: 0.78,
				wander: 0.42,
				spawn: 3,
				burst: 2,
				max: 72,
				trail: 4,
				fade: 0.76,
				hue: 26,
				hue_sp: 12,
				sat: 0.42,
				lmin: 0.34,
				lmax: 0.76,
				gust_p: 0.0018,
				gust_dur: 65,
				gust_mult: 2.25,
				gust_front: 24,
				calm_p: 0.0002,
			},
		},
		{
			key: 'dust-storm-edge',
			label: 'dust storm edge',
			config: {
				intro_haze: 0.22,
				ending_residue: 0.16,
				drift: 1.05,
				wander: 0.55,
				spawn: 2,
				burst: 3,
				max: 92,
				trail: 5,
				fade: 0.8,
				hue: 22,
				hue_sp: 16,
				sat: 0.48,
				lmin: 0.36,
				lmax: 0.8,
				gust_p: 0.002,
				gust_dur: 80,
				gust_mult: 2.8,
				gust_front: 30,
				calm_p: 0.0001,
			},
		},
	];
	api.effects['dust'] = Dust;
})(window.AmbienceSim);
// ===== effects/fireflies.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, hslToRGB } = api._helpers;

	const FIREFLIES_DEFAULTS = {
		drift: 0.18,
		wander: 0.4,
		spawn: 3,
		max: 44,
		hue: 72,
		hue_sp: 18,
		sat: 0.55,
		lmin: 0.45,
		lmax: 0.9,
		layers: 2,
		lbal: 0.45,
		blink_burst_p: 0,
		cluster_shift_p: 0,
		calm_p: 0,
		blink_burst_dur: 55,
		blink_burst_mult: 1.6,
		cluster_shift_dur: 75,
		cluster_pull: 0.65,
		calm_dur: 60,
	};

	function applyFirefliesDefaults(cfg) {
		const c = Object.assign({}, FIREFLIES_DEFAULTS, cfg || {});
		if (c.drift <= 0) c.drift = FIREFLIES_DEFAULTS.drift;
		if (c.wander <= 0) c.wander = FIREFLIES_DEFAULTS.wander;
		if (c.spawn <= 0) c.spawn = FIREFLIES_DEFAULTS.spawn;
		if (c.max <= 0) c.max = FIREFLIES_DEFAULTS.max;
		if (c.sat <= 0) c.sat = FIREFLIES_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = FIREFLIES_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = FIREFLIES_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.layers <= 0) c.layers = FIREFLIES_DEFAULTS.layers;
		if (c.lbal <= 0) c.lbal = FIREFLIES_DEFAULTS.lbal;
		if (c.blink_burst_dur <= 0) c.blink_burst_dur = FIREFLIES_DEFAULTS.blink_burst_dur;
		if (c.blink_burst_mult <= 0) c.blink_burst_mult = FIREFLIES_DEFAULTS.blink_burst_mult;
		if (c.cluster_shift_dur <= 0) c.cluster_shift_dur = FIREFLIES_DEFAULTS.cluster_shift_dur;
		if (c.cluster_pull <= 0) c.cluster_pull = FIREFLIES_DEFAULTS.cluster_pull;
		if (c.calm_dur <= 0) c.calm_dur = FIREFLIES_DEFAULTS.calm_dur;
		return c;
	}

	class Fireflies {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applyFirefliesDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.fireflies = [];
			this.blinkBurstTicks = 0;
			this.calmTicks = 0;
			this.clusterShiftTicks = 0;
			this.clusterRow = h * 0.5;
			this.clusterCol = w * 0.5;
		}

		setConfig(cfg) {
			this.cfg = applyFirefliesDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.blinkBurstTicks = state.blinkBurstTicks || state.blinkBurstLeft || 0;
			this.calmTicks = state.calmTicks || state.calmLeft || 0;
			this.clusterShiftTicks = state.clusterShiftTicks || state.clusterShiftLeft || 0;
			if (typeof state.clusterRow === 'number') this.clusterRow = state.clusterRow;
			if (typeof state.clusterCol === 'number') this.clusterCol = state.clusterCol;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}
			if (Array.isArray(state.fireflies)) {
				this.fireflies = state.fireflies.map(ff => ({
					row: ff.row,
					col: ff.col,
					vRow: ff.vRow,
					vCol: ff.vCol,
					color: ff.color,
					phase: ff.phase,
					blinkRate: ff.blinkRate,
					background: !!ff.background,
				}));
			}
		}

		triggerEvent(name) {
			const c = this.cfg;
			switch (name) {
				case 'blink-burst':
					this.blinkBurstTicks = jitterInt(this.rng, c.blink_burst_dur, 0.3);
					return true;
				case 'cluster-shift':
					this.clusterShiftTicks = jitterInt(this.rng, c.cluster_shift_dur, 0.3);
					this.clusterRow = this.rng() * this.h;
					this.clusterCol = this.rng() * this.w;
					return true;
				case 'calm':
					this.calmTicks = jitterInt(this.rng, c.calm_dur, 0.3);
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.blinkBurstTicks > 0) this.blinkBurstTicks--;
			if (this.calmTicks > 0) this.calmTicks--;
			if (this.clusterShiftTicks > 0) this.clusterShiftTicks--;

			this.grid.fill(0);

			let spawnEvery = this.cfg.spawn;
			if (this.calmTicks > 0) spawnEvery *= 2;
			if (spawnEvery < 1) spawnEvery = 1;
			if (this.fireflies.length < this.cfg.max && this.rng.intn(spawnEvery) === 0) {
				this._spawnFirefly();
			}

			for (const ff of this.fireflies) {
				this._stepFirefly(ff);
				this._paintFirefly(ff);
			}
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		_stepFirefly(ff) {
			const wander = this.cfg.wander * 0.02;
			ff.vCol += (this.rng() * 2 - 1) * wander;
			ff.vRow += (this.rng() * 2 - 1) * wander * 0.7;
			let maxSpeed = this.cfg.drift * 2.2;
			if (ff.background) maxSpeed *= 0.7;
			ff.vCol = Math.max(-maxSpeed, Math.min(maxSpeed, ff.vCol));
			ff.vRow = Math.max(-maxSpeed, Math.min(maxSpeed, ff.vRow));
			if (this.clusterShiftTicks > 0 && this.cfg.cluster_pull > 0) {
				ff.vCol += (this.clusterCol - ff.col) * this.cfg.cluster_pull * 0.0008;
				ff.vRow += (this.clusterRow - ff.row) * this.cfg.cluster_pull * 0.0005;
			}
			ff.col += ff.vCol;
			ff.row += ff.vRow;
			while (ff.col < 0) ff.col += this.w;
			while (ff.col >= this.w) ff.col -= this.w;
			while (ff.row < 0) ff.row += this.h;
			while (ff.row >= this.h) ff.row -= this.h;
			ff.phase += ff.blinkRate;
		}

		_paintFirefly(ff) {
			const gr = Math.round(ff.row);
			const gc = Math.round(ff.col);
			if (gr < 0 || gr >= this.h || gc < 0 || gc >= this.w) return;
			const base = (Math.sin(ff.phase) + 1) * 0.5;
			let glow = 0.15 + 0.85 * base * base;
			if (this.blinkBurstTicks > 0) glow *= this.cfg.blink_burst_mult;
			if (this.calmTicks > 0) glow *= 0.7;
			if (ff.background) glow *= 0.75;
			glow = Math.max(0, Math.min(1, glow));
			this._setPixel(gr, gc,
				Math.floor(ff.color.r * glow),
				Math.floor(ff.color.g * glow),
				Math.floor(ff.color.b * glow));
		}

		_setPixel(gr, gc, r, g, b) {
			if (gr < 0 || gr >= this.h || gc < 0 || gc >= this.w) return;
			const i = (gr * this.w + gc) * 3;
			this.grid[i] = r;
			this.grid[i + 1] = g;
			this.grid[i + 2] = b;
		}

		_spawnFirefly() {
			const c = this.cfg;
			const isBG = c.layers >= 2 && this.rng() < c.lbal;
			let speed = c.drift * (0.55 + this.rng() * 0.9);
			if (isBG) speed *= 0.6;
			const hue = ((c.hue + (this.rng() * 2 - 1) * c.hue_sp) % 360 + 360) % 360;
			let lightness = c.lmin + this.rng() * (c.lmax - c.lmin);
			if (isBG) lightness *= 0.82;
			const color = hslToRGB(hue, c.sat, lightness);
			this.fireflies.push({
				row: this.rng() * this.h,
				col: this.rng() * this.w,
				vRow: (this.rng() * 2 - 1) * speed * 0.5,
				vCol: (this.rng() * 2 - 1) * speed,
				color: color,
				phase: this.rng() * 2 * Math.PI,
				blinkRate: 0.04 + this.rng() * 0.07,
				background: isBG,
			});
		}
	}

	api.effects['fireflies'] = Fireflies;
})(window.AmbienceSim);
// ===== effects/lighthouse.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 50,
		intro_beam: 0.16,
		ending_dur: 65,
		ending_linger: 18,
		ending_beam: 0.08,
		sweep_speed: 0.08,
		beam_width: 0.22,
		beam_softness: 0.42,
		tower_height: 22,
		tower_width: 6.5,
		horizon: 0.74,
		haze: 0.14,
		glow: 0.22,
		hue: 214,
		hue_sp: 18,
		sat: 0.34,
		lmin: 0.12,
		lmax: 0.84,
		bright_pass_p: 0,
		fog_thicken_p: 0,
		calm_p: 0,
		bright_pass_dur: 42,
		bright_pass_mult: 1.75,
		fog_thicken_dur: 72,
		fog_thicken_mult: 1.85,
		calm_dur: 64,
		calm_mult: 0.55,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_beam = clamp01(c.intro_beam);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_beam = clamp01(c.ending_beam);
		if (c.sweep_speed <= 0) c.sweep_speed = DEFAULTS.sweep_speed;
		if (c.beam_width <= 0) c.beam_width = DEFAULTS.beam_width;
		if (c.beam_softness <= 0) c.beam_softness = DEFAULTS.beam_softness;
		if (c.tower_height <= 0) c.tower_height = DEFAULTS.tower_height;
		if (c.tower_width <= 0) c.tower_width = DEFAULTS.tower_width;
		if (c.horizon <= 0) c.horizon = DEFAULTS.horizon;
		if (c.haze <= 0) c.haze = DEFAULTS.haze;
		if (c.glow <= 0) c.glow = DEFAULTS.glow;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.bright_pass_dur <= 0) c.bright_pass_dur = DEFAULTS.bright_pass_dur;
		if (c.bright_pass_mult <= 0) c.bright_pass_mult = DEFAULTS.bright_pass_mult;
		if (c.fog_thicken_dur <= 0) c.fog_thicken_dur = DEFAULTS.fog_thicken_dur;
		if (c.fog_thicken_mult <= 0) c.fog_thicken_mult = DEFAULTS.fog_thicken_mult;
		if (c.calm_dur <= 0) c.calm_dur = DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DEFAULTS.calm_mult;
		return c;
	}

	class Lighthouse {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 79);
			switch (name) {
				case 'bright-pass':
					this.timers['bright-pass'] = jitterInt(rng, this.cfg.bright_pass_dur, 0.3);
					this.values.bright_gain = this.cfg.bright_pass_mult * (0.8 + rng() * 0.4);
					return true;
				case 'fog-thicken':
					this.timers['fog-thicken'] = jitterInt(rng, this.cfg.fog_thicken_dur, 0.3);
					this.timers.calm = 0;
					this.values.fog_gain = this.cfg.fog_thicken_mult * (0.8 + rng() * 0.45);
					return true;
				case 'calm':
					this.timers.calm = jitterInt(rng, this.cfg.calm_dur, 0.3);
					this.timers['fog-thicken'] = 0;
					this.values.fog_gain = 1;
					return true;
				case 'intro':
					this.timers['bright-pass'] = 0;
					this.timers['fog-thicken'] = 0;
					this.timers.calm = 0;
					this.timers.ending = 0;
					this.values.bright_gain = 1;
					this.values.fog_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers['bright-pass'] = 0;
					this.timers['fog-thicken'] = 0;
					this.timers.calm = 0;
					this.values.bright_gain = 1;
					this.values.fog_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers['bright-pass'] || this.timers['bright-pass'] <= 0) this.values.bright_gain = 1;
			if (!this.timers['fog-thicken'] || this.timers['fog-thicken'] <= 0) this.values.fog_gain = 1;
		}

		_beamLevel() {
			let level = 1;
			if (this.timers['bright-pass'] > 0) level *= this.values.bright_gain || this.cfg.bright_pass_mult;
			if (this.timers.calm > 0) level *= this.cfg.calm_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_beam + (1 - this.cfg.intro_beam) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_beam) * progress;
			}
			return Math.max(0.05, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const skyTop = hslToRGB((this.cfg.hue + 358) % 360, clamp01(this.cfg.sat * 0.5), clamp01(this.cfg.lmin * 0.92));
				const skyMid = hslToRGB(this.cfg.hue, this.cfg.sat, clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.18));
				const skyLow = hslToRGB((this.cfg.hue - this.cfg.hue_sp * 0.6 + 360) % 360, clamp01(this.cfg.sat * 0.82), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.46));
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, `rgb(${skyTop.r},${skyTop.g},${skyTop.b})`);
				sky.addColorStop(0.62, `rgb(${skyMid.r},${skyMid.g},${skyMid.b})`);
				sky.addColorStop(1, `rgb(${skyLow.r},${skyLow.g},${skyLow.b})`);
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const horizon = Math.max(8, Math.min(this.h - 10, Math.floor(this.h * this.cfg.horizon)));
			const towerX = Math.floor(this.w * 0.18);
			const towerH = Math.max(10, Math.round(this.cfg.tower_height));
			const towerW = Math.max(3, Math.round(this.cfg.tower_width));
			const beamLevel = this._beamLevel();
			const fogLevel = clamp01(this.cfg.haze * (this.timers['fog-thicken'] > 0 ? this.values.fog_gain || this.cfg.fog_thicken_mult : 1) * (this.timers.calm > 0 ? 0.82 : 1));
			const beamAngle = -0.26 + Math.sin(this.tick * this.cfg.sweep_speed * 0.06) * 0.78;
			const beamWidth = this.cfg.beam_width * (1 + fogLevel * 0.9);
			const beamSoftness = clamp01(this.cfg.beam_softness * (1 + fogLevel * 0.35));

			const seaTop = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.55), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.12));
			const seaLow = hslToRGB((this.cfg.hue + 8) % 360, clamp01(this.cfg.sat * 0.42), clamp01(this.cfg.lmin * 0.8));
			const sea = ctx.createLinearGradient(0, Math.floor(horizon * sy), 0, canvasH);
			sea.addColorStop(0, `rgb(${seaTop.r},${seaTop.g},${seaTop.b})`);
			sea.addColorStop(1, `rgb(${seaLow.r},${seaLow.g},${seaLow.b})`);
			ctx.fillStyle = sea;
			ctx.fillRect(0, Math.floor(horizon * sy), canvasW, canvasH - Math.floor(horizon * sy));

			const coastRows = new Array(this.w);
			for (let x = 0; x < this.w; x++) {
				const bluff = Math.exp(-Math.pow((x - towerX) / 18, 2)) * 7.5;
				const swell = Math.sin(x * 0.032 + 0.5) * 1.3 + Math.sin(x * 0.013 + 2.1) * 1.1;
				coastRows[x] = Math.round(horizon + swell - bluff);
			}
			const coastColor = hslToRGB((this.cfg.hue + 214) % 360, clamp01(this.cfg.sat * 0.12), 0.08);
			ctx.fillStyle = `rgb(${coastColor.r},${coastColor.g},${coastColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (let x = 0; x < this.w; x++) {
				ctx.lineTo(Math.floor(x * sx), Math.floor(coastRows[x] * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const oceanLine = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.35), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.3));
			for (let x = 0; x < this.w; x += 2) {
				if ((x + this.tick) % 5 !== 0) continue;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, horizon + 1 + Math.round(Math.sin(x * 0.07 + this.tick * 0.02)), 2, 1, `rgb(${oceanLine.r},${oceanLine.g},${oceanLine.b})`, 0.18);
			}

			const towerBase = coastRows[Math.max(0, Math.min(this.w - 1, towerX))];
			const lampY = towerBase - towerH + 2;
			const towerColor = hslToRGB((this.cfg.hue + 212) % 360, clamp01(this.cfg.sat * 0.08), 0.1);
			for (let y = lampY; y <= towerBase; y++) {
				const ratio = (y - lampY) / Math.max(1, towerBase - lampY);
				const half = Math.max(1, Math.round((towerW * (0.32 + ratio * 0.68)) * 0.5));
				for (let dx = -half; dx <= half; dx++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, towerX + dx, y, 1, 1, `rgb(${towerColor.r},${towerColor.g},${towerColor.b})`, 1);
				}
			}
			for (let dx = -Math.max(2, Math.round(towerW * 0.6)); dx <= Math.max(2, Math.round(towerW * 0.6)); dx++) {
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, towerX + dx, lampY - 1 + Math.round(Math.abs(dx) * 0.15), 1, 1, `rgb(${towerColor.r},${towerColor.g},${towerColor.b})`, 1);
			}

			const lampGlow = hslToRGB(48, 0.68, clamp01(0.42 + this.cfg.glow * 0.34));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, towerX, lampY, 1, 1, `rgb(${lampGlow.r},${lampGlow.g},${lampGlow.b})`, clamp01(0.3 + this.cfg.glow * 0.7));

			const glowX = towerX * sx;
			const glowY = lampY * sy;
			const glowR = Math.max(18, Math.min(canvasW, canvasH) * (0.04 + this.cfg.glow * 0.05));
			const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowR);
			glow.addColorStop(0, `rgba(255, 236, 184, ${0.16 + this.cfg.glow * 0.22})`);
			glow.addColorStop(1, 'rgba(255, 236, 184, 0)');
			ctx.fillStyle = glow;
			ctx.fillRect(glowX - glowR, glowY - glowR, glowR * 2, glowR * 2);

			const beamHue = (this.cfg.hue - 18 + 360) % 360;
			const beamBase = hslToRGB(beamHue, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmax * 0.98));
			const beamCore = hslToRGB(44, 0.42, clamp01(this.cfg.lmax * 1.02));
			const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
			for (let y = 0; y <= horizon + 5; y++) {
				for (let x = towerX + 1; x < this.w; x++) {
					const dx = x - towerX;
					const dy = y - lampY;
					if (dx <= 0) continue;
					const dist = Math.hypot(dx, dy);
					if (dist < 2) continue;
					const ang = Math.atan2(dy, dx);
					const diff = angleDiff(ang, beamAngle);
					if (diff > beamWidth) continue;
					const cone = 1 - diff / beamWidth;
					const edge = Math.pow(cone, Math.max(0.6, 1.8 - beamSoftness));
					const falloff = Math.pow(clamp01(1 - dist / (this.w * 0.92)), 0.72);
					const strength = edge * falloff * beamLevel;
					if (strength < 0.02) continue;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1, 1, `rgb(${beamBase.r},${beamBase.g},${beamBase.b})`, clamp01(strength * (0.12 + fogLevel * 0.08)));
					if (diff < beamWidth * 0.34 && strength > 0.08) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1, 1, `rgb(${beamCore.r},${beamCore.g},${beamCore.b})`, clamp01(strength * 0.16));
					}
				}
			}

			const fog = ctx.createLinearGradient(0, Math.floor((horizon - 7) * sy), 0, Math.floor((horizon + 9) * sy));
			fog.addColorStop(0, `rgba(201, 214, 226, ${0.02 + fogLevel * 0.08})`);
			fog.addColorStop(1, 'rgba(201, 214, 226, 0)');
			ctx.fillStyle = fog;
			ctx.fillRect(0, Math.floor((horizon - 8) * sy), canvasW, Math.ceil(18 * sy));
		}
	}

	api.presets['lighthouse'] = [
		{
			key: 'clear-night',
			label: 'clear night',
			config: {
				sweep_speed: 0.07,
				beam_width: 0.18,
				beam_softness: 0.32,
				tower_height: 22,
				tower_width: 6,
				horizon: 0.74,
				haze: 0.08,
				glow: 0.2,
				hue: 216,
				hue_sp: 14,
				sat: 0.3,
				lmin: 0.1,
				lmax: 0.8,
			},
		},
		{
			key: 'steady-sweep',
			label: 'steady sweep',
			config: {
				sweep_speed: 0.08,
				beam_width: 0.22,
				beam_softness: 0.42,
				tower_height: 22,
				tower_width: 6.5,
				horizon: 0.74,
				haze: 0.14,
				glow: 0.22,
				hue: 214,
				hue_sp: 18,
				sat: 0.34,
				lmin: 0.12,
				lmax: 0.84,
				bright_pass_p: 0.0007,
			},
		},
		{
			key: 'foggy-coast',
			label: 'foggy coast',
			config: {
				sweep_speed: 0.06,
				beam_width: 0.28,
				beam_softness: 0.62,
				tower_height: 23,
				tower_width: 7,
				horizon: 0.76,
				haze: 0.24,
				glow: 0.18,
				hue: 210,
				hue_sp: 12,
				sat: 0.24,
				lmin: 0.1,
				lmax: 0.72,
				fog_thicken_p: 0.0012,
				fog_thicken_mult: 2.2,
			},
		},
		{
			key: 'bright-beacon',
			label: 'bright beacon',
			config: {
				sweep_speed: 0.1,
				beam_width: 0.24,
				beam_softness: 0.36,
				tower_height: 21,
				tower_width: 6,
				horizon: 0.72,
				haze: 0.12,
				glow: 0.3,
				hue: 218,
				hue_sp: 20,
				sat: 0.36,
				lmin: 0.12,
				lmax: 0.9,
				bright_pass_p: 0.0014,
				bright_pass_mult: 2.1,
				calm_p: 0.0009,
			},
		},
	];
	api.effects['lighthouse'] = Lighthouse;
})(window.AmbienceSim);
// ===== effects/mysterious_man.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 70,
		intro_glow: 0.10,
		ending_dur: 85,
		ending_linger: 24,
		ending_glow: 0.06,
		figure_x: 0.5,
		figure_height: 30,
		figure_width: 11,
		silhouette: 0.92,
		hat: 1,
		shoulder: 1,
		ember_x: 0.56,
		ember_y: 0.62,
		ember_brightness: 0.86,
		ember_pulse: 0.34,
		smoke_density: 0.42,
		smoke_rise: 0.46,
		smoke_drift: 0.18,
		smoke_softness: 0.62,
		hue: 22,
		hue_sp: 10,
		sat: 0.72,
		lmin: 0.06,
		lmax: 0.86,
		inhale_p: 0,
		exhale_p: 0,
		ash_fall_p: 0,
		lighter_flick_p: 0,
		inhale_dur: 32,
		inhale_mult: 1.85,
		exhale_dur: 60,
		exhale_plume: 1.4,
		ash_fall_dur: 28,
		ash_fall_mult: 1.3,
		lighter_flick_dur: 20,
		lighter_flick_mult: 2.4,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_glow = clamp01(c.intro_glow);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_glow = clamp01(c.ending_glow);
		if (c.figure_x <= 0) c.figure_x = DEFAULTS.figure_x;
		if (c.figure_height <= 0) c.figure_height = DEFAULTS.figure_height;
		if (c.figure_width <= 0) c.figure_width = DEFAULTS.figure_width;
		c.silhouette = clamp01(c.silhouette);
		if (c.silhouette <= 0) c.silhouette = DEFAULTS.silhouette;
		c.hat = clamp01(c.hat);
		c.shoulder = clamp01(c.shoulder);
		if (c.ember_x <= 0) c.ember_x = DEFAULTS.ember_x;
		if (c.ember_y <= 0) c.ember_y = DEFAULTS.ember_y;
		if (c.ember_brightness <= 0) c.ember_brightness = DEFAULTS.ember_brightness;
		if (c.ember_pulse < 0) c.ember_pulse = 0;
		if (c.smoke_density < 0) c.smoke_density = 0;
		if (c.smoke_rise <= 0) c.smoke_rise = DEFAULTS.smoke_rise;
		if (c.smoke_softness <= 0) c.smoke_softness = DEFAULTS.smoke_softness;
		if (c.hue < 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin < 0) c.lmin = 0;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.inhale_dur <= 0) c.inhale_dur = DEFAULTS.inhale_dur;
		if (c.inhale_mult <= 0) c.inhale_mult = DEFAULTS.inhale_mult;
		if (c.exhale_dur <= 0) c.exhale_dur = DEFAULTS.exhale_dur;
		if (c.exhale_plume <= 0) c.exhale_plume = DEFAULTS.exhale_plume;
		if (c.ash_fall_dur <= 0) c.ash_fall_dur = DEFAULTS.ash_fall_dur;
		if (c.ash_fall_mult <= 0) c.ash_fall_mult = DEFAULTS.ash_fall_mult;
		if (c.lighter_flick_dur <= 0) c.lighter_flick_dur = DEFAULTS.lighter_flick_dur;
		if (c.lighter_flick_mult <= 0) c.lighter_flick_mult = DEFAULTS.lighter_flick_mult;
		return c;
	}

	class MysteriousMan {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 109);
			switch (name) {
				case 'inhale':
					this.timers.inhale = jitterInt(rng, this.cfg.inhale_dur, 0.25);
					this.values.inhale_gain = this.cfg.inhale_mult * (0.8 + rng() * 0.4);
					return true;
				case 'exhale':
					this.timers.exhale = jitterInt(rng, this.cfg.exhale_dur, 0.25);
					this.values.exhale_gain = this.cfg.exhale_plume * (0.85 + rng() * 0.35);
					this.values.exhale_seed = rng() * 1024;
					return true;
				case 'ash-fall':
					this.timers['ash-fall'] = jitterInt(rng, this.cfg.ash_fall_dur, 0.3);
					this.values.ash_gain = this.cfg.ash_fall_mult * (0.85 + rng() * 0.3);
					this.values.ash_seed = rng() * 1024;
					return true;
				case 'lighter-flick':
					this.timers['lighter-flick'] = jitterInt(rng, this.cfg.lighter_flick_dur, 0.25);
					this.values.flick_gain = this.cfg.lighter_flick_mult * (0.85 + rng() * 0.3);
					return true;
				case 'intro':
					this.timers.inhale = 0;
					this.timers.exhale = 0;
					this.timers['ash-fall'] = 0;
					this.timers['lighter-flick'] = 0;
					this.timers.ending = 0;
					this.values.inhale_gain = 1;
					this.values.exhale_gain = 1;
					this.values.ash_gain = 1;
					this.values.flick_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.inhale = 0;
					this.timers.exhale = 0;
					this.timers['ash-fall'] = 0;
					this.timers['lighter-flick'] = 0;
					this.values.inhale_gain = 1;
					this.values.exhale_gain = 1;
					this.values.ash_gain = 1;
					this.values.flick_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.inhale || this.timers.inhale <= 0) this.values.inhale_gain = 1;
			if (!this.timers.exhale || this.timers.exhale <= 0) this.values.exhale_gain = 1;
			if (!this.timers['ash-fall'] || this.timers['ash-fall'] <= 0) this.values.ash_gain = 1;
			if (!this.timers['lighter-flick'] || this.timers['lighter-flick'] <= 0) this.values.flick_gain = 1;
		}

		_emberLevel() {
			let level = 1;
			if (this.timers.inhale > 0) level *= this.values.inhale_gain || this.cfg.inhale_mult;
			if (this.timers['lighter-flick'] > 0) level *= this.values.flick_gain || this.cfg.lighter_flick_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_glow + (1 - this.cfg.intro_glow) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_glow) * progress;
			}
			return Math.max(0.0, level);
		}

		_revealLevel() {
			let level = 1;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				// silhouette stays dark until the ember is established, then resolves
				level *= Math.pow(progress, 1.6);
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - progress * 0.92;
			}
			return clamp01(level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				// near-darkness with a faint warmth toward the ember side
				const tintHue = this.cfg.hue;
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				const top = hslToRGB((tintHue + 220) % 360, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmin + 0.02));
				const mid = hslToRGB((tintHue + 240) % 360, clamp01(this.cfg.sat * 0.22), clamp01(this.cfg.lmin + 0.04));
				const low = hslToRGB((tintHue + 6) % 360, clamp01(this.cfg.sat * 0.32), clamp01(this.cfg.lmin + 0.06));
				sky.addColorStop(0, `rgb(${top.r},${top.g},${top.b})`);
				sky.addColorStop(0.62, `rgb(${mid.r},${mid.g},${mid.b})`);
				sky.addColorStop(1, `rgb(${low.r},${low.g},${low.b})`);
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);

			const figureCenterX = Math.floor(this.w * this.cfg.figure_x);
			const figH = Math.max(12, Math.round(this.cfg.figure_height));
			const figW = Math.max(4, Math.round(this.cfg.figure_width));
			const halfBody = Math.max(2, Math.round(figW * 0.5));
			const groundRow = Math.min(this.h - 1, Math.floor(this.h * 0.94));
			const headRadius = Math.max(2, Math.round(figW * 0.32));
			const headTop = Math.max(2, groundRow - figH);
			const headCenterY = headTop + headRadius;
			const shoulderRow = headCenterY + headRadius + 1;
			const torsoTop = shoulderRow;
			const reveal = this._revealLevel();
			const ember = this._emberLevel();
			const emberX = Math.floor(this.w * this.cfg.ember_x);
			const emberY = Math.floor(this.h * this.cfg.ember_y);
			const breathPhase = Math.sin(this.tick * 0.05);
			const emberPulse = clamp01(this.cfg.ember_brightness * (1 + breathPhase * this.cfg.ember_pulse * 0.45) * ember);

			// soft ember halo cast around the cigarette
			const haloR = Math.max(20, Math.min(canvasW, canvasH) * (0.05 + emberPulse * 0.09));
			const haloX = emberX * sx;
			const haloY = emberY * sy;
			const haloHue = (this.cfg.hue + 4) % 360;
			const haloCore = hslToRGB(haloHue, clamp01(this.cfg.sat * 0.95), clamp01(this.cfg.lmax * 0.9));
			const haloMid = hslToRGB((this.cfg.hue + 350) % 360, clamp01(this.cfg.sat * 0.7), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.4));
			const haloGrad = ctx.createRadialGradient(haloX, haloY, 0, haloX, haloY, haloR);
			haloGrad.addColorStop(0, `rgba(${haloCore.r},${haloCore.g},${haloCore.b},${0.32 + emberPulse * 0.4})`);
			haloGrad.addColorStop(0.5, `rgba(${haloMid.r},${haloMid.g},${haloMid.b},${0.12 + emberPulse * 0.18})`);
			haloGrad.addColorStop(1, `rgba(${haloMid.r},${haloMid.g},${haloMid.b},0)`);
			ctx.fillStyle = haloGrad;
			ctx.fillRect(haloX - haloR, haloY - haloR, haloR * 2, haloR * 2);

			// silhouette body (only renders once the intro reveal has progressed)
			const silAlpha = clamp01(this.cfg.silhouette * reveal);
			if (silAlpha > 0.02) {
				const silColor = hslToRGB((this.cfg.hue + 220) % 360, clamp01(this.cfg.sat * 0.1), clamp01(this.cfg.lmin * 0.4));
				const silStr = `rgb(${silColor.r},${silColor.g},${silColor.b})`;

				// torso: a slightly tapered column from shoulders to ground
				for (let y = torsoTop; y <= groundRow; y++) {
					const t = (y - torsoTop) / Math.max(1, groundRow - torsoTop);
					const half = Math.max(2, Math.round(halfBody * (0.78 + t * 0.34)));
					for (let dx = -half; dx <= half; dx++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + dx, y, 1, 1, silStr, silAlpha);
					}
				}

				// shoulder bulge so the figure reads as a coated person
				if (this.cfg.shoulder > 0.05) {
					const shoulderHalf = halfBody + Math.max(1, Math.round(this.cfg.shoulder * 2));
					for (let dx = -shoulderHalf; dx <= shoulderHalf; dx++) {
						const nx = Math.abs(dx) / Math.max(1, shoulderHalf);
						const fall = Math.pow(1 - nx, 1.6);
						const top = shoulderRow - Math.round(this.cfg.shoulder * 1.4 * fall);
						for (let y = top; y < shoulderRow + 2; y++) {
							this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + dx, y, 1, 1, silStr, silAlpha);
						}
					}
				}

				// head: a roundish cap above the shoulders
				for (let dy = -headRadius; dy <= headRadius; dy++) {
					const span = Math.round(Math.sqrt(Math.max(0, headRadius * headRadius - dy * dy)));
					if (span <= 0) continue;
					for (let dx = -span; dx <= span; dx++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + dx, headCenterY + dy, 1, 1, silStr, silAlpha);
					}
				}

				// hat brim/crown (optional, helps the noir read)
				if (this.cfg.hat > 0.05) {
					const brimHalf = headRadius + Math.max(1, Math.round(this.cfg.hat * 2));
					const brimY = Math.max(0, headCenterY - headRadius);
					const crownH = Math.max(1, Math.round(this.cfg.hat * 2));
					// brim
					for (let dx = -brimHalf; dx <= brimHalf; dx++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + dx, brimY, 1, 1, silStr, silAlpha);
					}
					// crown
					for (let dy = 1; dy <= crownH; dy++) {
						const crownHalf = Math.max(1, headRadius - Math.round(dy * 0.4));
						for (let dx = -crownHalf; dx <= crownHalf; dx++) {
							this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + dx, brimY - dy, 1, 1, silStr, silAlpha);
						}
					}
				}

				// faint warm rim-light on the side facing the ember
				const rimDir = emberX >= figureCenterX ? 1 : -1;
				const rimColor = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.6), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.32));
				for (let y = torsoTop; y <= groundRow; y++) {
					const dist = Math.hypot((figureCenterX + halfBody * rimDir) - emberX, y - emberY);
					const fall = Math.exp(-dist / Math.max(4, figH * 0.6));
					const a = clamp01(fall * (0.18 + emberPulse * 0.32));
					if (a < 0.02) continue;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, figureCenterX + halfBody * rimDir, y, 1, 1, `rgb(${rimColor.r},${rimColor.g},${rimColor.b})`, a);
				}
			}

			// faint cigarette stem from the figure's mouth area to the ember
			const mouthX = figureCenterX + Math.round(headRadius * 0.6) * (emberX >= figureCenterX ? 1 : -1);
			const mouthY = headCenterY + Math.max(1, Math.round(headRadius * 0.5));
			if (silAlpha > 0.05 && Math.abs(emberX - mouthX) > 0) {
				const stemColor = hslToRGB(0, 0, 0.55);
				const steps = Math.max(1, Math.abs(emberX - mouthX));
				const dx = emberX > mouthX ? 1 : -1;
				for (let i = 1; i < steps; i++) {
					const cx = mouthX + dx * i;
					const t = i / Math.max(1, steps);
					const cy = Math.round(mouthY + (emberY - mouthY) * t);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, cx, cy, 1, 1, `rgb(${stemColor.r},${stemColor.g},${stemColor.b})`, clamp01(0.22 * silAlpha));
				}
			}

			// ember itself: a tiny bright pixel + a bloom point
			const emberHueShift = (this.cfg.hue + 6) % 360;
			const emberCore = hslToRGB(emberHueShift, clamp01(this.cfg.sat * 0.95), clamp01(this.cfg.lmax * (0.86 + emberPulse * 0.14)));
			const emberRim = hslToRGB((this.cfg.hue + 350) % 360, clamp01(this.cfg.sat), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.7));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, emberX, emberY, 1, 1, `rgb(${emberCore.r},${emberCore.g},${emberCore.b})`, clamp01(0.6 + emberPulse * 0.4));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, emberX - 1, emberY, 1, 1, `rgb(${emberRim.r},${emberRim.g},${emberRim.b})`, clamp01(0.32 + emberPulse * 0.32));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, emberX + 1, emberY, 1, 1, `rgb(${emberRim.r},${emberRim.g},${emberRim.b})`, clamp01(0.28 + emberPulse * 0.32));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, emberX, emberY + 1, 1, 1, `rgb(${emberRim.r},${emberRim.g},${emberRim.b})`, clamp01(0.22 + emberPulse * 0.28));

			// drifting smoke puffs above the ember
			const smokeColor = hslToRGB((this.cfg.hue + 220) % 360, 0.06, clamp01(0.62 + this.cfg.lmin * 0.4));
			const exhaleActive = this.timers.exhale > 0;
			const exhaleGain = this.values.exhale_gain || this.cfg.exhale_plume;
			const inhaleActive = this.timers.inhale > 0;
			const baseDensity = this.cfg.smoke_density * reveal;
			const puffCount = Math.max(2, Math.round(baseDensity * 22 * (exhaleActive ? exhaleGain : 1)));
			const maxRise = Math.max(8, Math.round(this.h * 0.42 + this.cfg.smoke_rise * 14));
			for (let i = 0; i < puffCount; i++) {
				const cycle = maxRise + 12 + Math.floor(this._hash(28000 + i) * 16);
				const speed = this.cfg.smoke_rise * (0.5 + this._hash(28100 + i) * 0.9);
				let progress = positiveMod(this.tick * speed + this._hash(28200 + i) * cycle, cycle);
				if (progress > maxRise) continue;
				if (inhaleActive && progress < 4) continue; // inhale briefly compresses the rise
				const rise = progress;
				const fade = 1 - rise / Math.max(1, maxRise);
				const drift = (this._hash(28300 + i) * 2 - 1) * 0.6 + this.cfg.smoke_drift * (0.3 + rise * 0.06) + Math.sin(this.tick * 0.03 + i * 0.7) * 0.4;
				const col = Math.round(emberX + drift + (i % 3 - 1) * 0.5);
				const row = Math.round(emberY - 1 - rise);
				if (row < 1 || row >= this.h) continue;
				const size = fade > 0.6 ? 2 : 1;
				const softness = clamp01(this.cfg.smoke_softness);
				const alpha = clamp01((0.08 + fade * 0.42) * (0.6 + softness * 0.5) * (exhaleActive ? exhaleGain * 0.6 : 1) * reveal);
				if (alpha < 0.02) continue;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, size, size, `rgb(${smokeColor.r},${smokeColor.g},${smokeColor.b})`, alpha);
				if (size === 2) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col + 1, row, 1, 1, `rgb(${smokeColor.r},${smokeColor.g},${smokeColor.b})`, alpha * 0.7);
				}
			}

			// ash fleck breaking off
			if (this.timers['ash-fall'] > 0) {
				const ashSeed = this.values.ash_seed || 0;
				const totalDur = Math.max(1, Math.round(this.cfg.ash_fall_dur));
				const elapsed = totalDur - this.timers['ash-fall'];
				const t = clamp01(elapsed / totalDur);
				const ashCol = Math.round(emberX + Math.sin(ashSeed * 6.28 + t * 0.6) * 1.4);
				const ashRow = Math.round(emberY + 1 + t * (this.h - emberY - 4) * 0.6);
				if (ashRow < this.h - 1) {
					const ashColor = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.85), clamp01(this.cfg.lmax * (0.65 + (1 - t) * 0.3)));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, ashCol, ashRow, 1, 1, `rgb(${ashColor.r},${ashColor.g},${ashColor.b})`, clamp01((0.6 + (this.values.ash_gain || 1) * 0.2) * (1 - t * 0.7)));
				}
			}

			// vignette darkens the edges so the silhouette read stays
			const vignette = ctx.createRadialGradient(canvasW * 0.5, canvasH * 0.5, Math.min(canvasW, canvasH) * 0.4, canvasW * 0.5, canvasH * 0.5, Math.max(canvasW, canvasH) * 0.85);
			vignette.addColorStop(0, 'rgba(0,0,0,0)');
			vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
			ctx.fillStyle = vignette;
			ctx.fillRect(0, 0, canvasW, canvasH);
		}
	}

	api.presets['mysterious-man'] = [
		{
			key: 'noir-stillness',
			label: 'noir stillness',
			config: {
				figure_x: 0.5,
				figure_height: 30,
				figure_width: 11,
				silhouette: 0.94,
				hat: 1,
				shoulder: 1,
				ember_x: 0.56,
				ember_y: 0.62,
				ember_brightness: 0.78,
				ember_pulse: 0.28,
				smoke_density: 0.38,
				smoke_rise: 0.42,
				smoke_drift: 0.14,
				smoke_softness: 0.66,
				hue: 22,
				hue_sp: 10,
				sat: 0.7,
				lmin: 0.06,
				lmax: 0.84,
				exhale_p: 0.0009,
				ash_fall_p: 0.0006,
			},
		},
		{
			key: 'deep-inhale',
			label: 'deep inhale',
			config: {
				figure_x: 0.48,
				figure_height: 32,
				figure_width: 12,
				silhouette: 0.92,
				hat: 0.7,
				shoulder: 1,
				ember_x: 0.55,
				ember_y: 0.6,
				ember_brightness: 1.0,
				ember_pulse: 0.5,
				smoke_density: 0.5,
				smoke_rise: 0.5,
				smoke_drift: 0.22,
				smoke_softness: 0.58,
				hue: 18,
				hue_sp: 14,
				sat: 0.82,
				lmin: 0.05,
				lmax: 0.92,
				inhale_p: 0.0026,
				inhale_dur: 36,
				inhale_mult: 2.1,
				exhale_p: 0.0018,
				exhale_dur: 64,
				exhale_plume: 1.6,
			},
		},
		{
			key: 'cold-alley',
			label: 'cold alley',
			config: {
				figure_x: 0.42,
				figure_height: 30,
				figure_width: 10,
				silhouette: 0.96,
				hat: 1,
				shoulder: 1,
				ember_x: 0.49,
				ember_y: 0.6,
				ember_brightness: 0.74,
				ember_pulse: 0.24,
				smoke_density: 0.6,
				smoke_rise: 0.34,
				smoke_drift: -0.12,
				smoke_softness: 0.78,
				hue: 14,
				hue_sp: 8,
				sat: 0.58,
				lmin: 0.08,
				lmax: 0.78,
				exhale_p: 0.0012,
				exhale_dur: 70,
				exhale_plume: 1.55,
				ash_fall_p: 0.0008,
			},
		},
		{
			key: 'ember-watch',
			label: 'ember watch',
			config: {
				intro_glow: 0.04,
				ending_glow: 0.04,
				figure_x: 0.5,
				figure_height: 28,
				figure_width: 11,
				silhouette: 0.97,
				hat: 1,
				shoulder: 0.9,
				ember_x: 0.57,
				ember_y: 0.6,
				ember_brightness: 0.92,
				ember_pulse: 0.46,
				smoke_density: 0.32,
				smoke_rise: 0.4,
				smoke_drift: 0.08,
				smoke_softness: 0.7,
				hue: 26,
				hue_sp: 16,
				sat: 0.8,
				lmin: 0.04,
				lmax: 0.9,
				inhale_p: 0.0014,
				exhale_p: 0.0009,
				ash_fall_p: 0.0008,
				lighter_flick_p: 0.0004,
				lighter_flick_mult: 2.6,
			},
		},
	];
	api.effects['mysterious-man'] = MysteriousMan;
})(window.AmbienceSim);
// ===== effects/rain.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, hslToRGB } = api._helpers;

	const DEFAULTS = {
		wind: 0,
		wind_jit: 0,
		speed: 1.0,
		speed_jit: 0,
		intro_style: 0,
		intro_dur: 60,
		intro_sparse: 8,
		intro_open: 0.08,
		intro_seed: 4,
		ending_style: 0,
		ending_dur: 60,
		ending_linger: 20,
		ending_splashes: 3,
		streak: 5,
		fade: 0.88,
		spawn: 5,
		burst: 1,
		hue: 210,
		hue_sp: 0,
		sat: 0.6,
		lmin: 0.55,
		lmax: 0.85,
		layers: 1,
		lbal: 0.4,
		hue_drift: 0,
		wind_drift: 0,
		downpour_p: 0,
		calm_p: 0,
		gust_p: 0,
		splash_p: 0,
		downpour_dur: 60,
		downpour_mult: 4,
		calm_dur: 50,
		gust_dur: 30,
		gust_str: 1.5,
		splash_size: 4,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		if (c.intro_sparse < 1) c.intro_sparse = DEFAULTS.intro_sparse;
		if (c.intro_open <= 0) c.intro_open = DEFAULTS.intro_open;
		if (c.intro_open > 1) c.intro_open = 1;
		if (c.intro_seed < 0) c.intro_seed = 0;
		if (c.intro_seed === 0) c.intro_seed = DEFAULTS.intro_seed;
		if (c.ending_style === 0 && c.ending_dur === 0 && c.ending_linger === 0 && c.ending_splashes === 0) {
			c.ending_dur = DEFAULTS.ending_dur;
			c.ending_linger = DEFAULTS.ending_linger;
			c.ending_splashes = DEFAULTS.ending_splashes;
		} else {
			if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
			if (c.ending_linger < 0) c.ending_linger = 0;
			if (c.ending_splashes < 0) c.ending_splashes = 0;
		}
		if (c.spawn <= 0) c.spawn = DEFAULTS.spawn;
		if (c.burst <= 0) c.burst = DEFAULTS.burst;
		if (c.streak <= 0) c.streak = DEFAULTS.streak;
		if (c.fade <= 0) c.fade = DEFAULTS.fade;
		if (c.layers <= 0) c.layers = 1;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		return c;
	}

	class Rain {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applyDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;

			// Flat pixel buffer: w*h*3 bytes (RGB). 0,0,0 = empty.
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.drops = [];
			this.splashes = [];

			// Event-timer state
			this.downpourTicks = 0;
			this.downpourMult = 0;
			this.calmTicks = 0;
			this.gustTicks = 0;
			this.gustWind = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.endingSplashLeft = 0;
			this.endingSplashTotal = 0;
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		// Apply an atmosphere-authoritative initial state (from /snapshot).
		// The outer envelope is effect-agnostic; Rain-specific replica state
		// lives under snapshot.state.
		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.downpourTicks = state.downpourTicks || state.downpourLeft || 0;
			this.downpourMult = state.downpourMult || 0;
			this.calmTicks = state.calmTicks || state.calmLeft || 0;
			this.gustTicks = state.gustTicks || state.gustLeft || 0;
			this.gustWind = state.gustWind || 0;
			this.introTicks = state.introTicks || state.introLeft || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || state.endingLeft || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			this.endingSplashLeft = state.endingSplashLeft || 0;
			this.endingSplashTotal = state.endingSplashTotal || 0;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			// Adopt the server's grid dims so drops transfer 1:1. The
			// canvas render() scales whatever resolution we have to fit,
			// so shifting from the local default (e.g. 200×100) to the
			// server's (e.g. 160×80) is imperceptible.
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}
			if (Array.isArray(state.drops)) {
				this.drops = state.drops.map(d => ({
					row: d.row,
					col: d.col,
					color: d.color,
					vRow: d.vRow,
					vCol: d.vCol,
					streakLen: d.streakLen,
				}));
			}
			if (Array.isArray(state.splashes)) {
				this.splashes = state.splashes.map(s => ({
					row: s.row,
					col: s.col,
					age: s.age,
					maxAge: s.maxAge,
					maxRadius: s.maxRadius,
					color: s.color,
				}));
			}
		}

		// Trigger a discrete event — same semantics as server's TriggerEvent.
		// Clients only invoke this in response to server commands.
		triggerEvent(name) {
			const c = this.cfg;
			switch (name) {
				case 'downpour':
					this.downpourTicks = jitterInt(this.rng, c.downpour_dur, 0.3);
					this.downpourMult = c.downpour_mult;
					return true;
				case 'calm':
					this.calmTicks = jitterInt(this.rng, c.calm_dur, 0.3);
					return true;
				case 'gust':
					this.gustTicks = jitterInt(this.rng, c.gust_dur, 0.3);
					{
						const sign = this.rng() < 0.5 ? -1 : 1;
						this.gustWind = sign * c.gust_str * (0.7 + this.rng() * 0.6);
					}
					return true;
				case 'splash':
					this._spawnSplash();
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;

			// 1. Decrement event timers (we don't roll for new events — server does).
			if (this.downpourTicks > 0) this.downpourTicks--;
			if (this.calmTicks > 0) this.calmTicks--;
			if (this.gustTicks > 0) this.gustTicks--;
			else this.gustWind = 0;

			// 2. Clear grid.
			this.grid.fill(0);

			// 3. Paint splashes.
			this._paintSplashes();

			// 4. Spawn drops. While an intro is active it owns the start pattern.
			if (this.introTicks > 0) {
				this._stepIntro();
			} else if (this.endingTicks > 0) {
				this._stepEnding();
			} else {
				let spawnEvery = this.cfg.spawn;
				if (this.downpourTicks > 0 && this.downpourMult > 1) {
					spawnEvery = Math.max(1, Math.floor(spawnEvery / this.downpourMult));
				}
				if (this.calmTicks === 0 && this.rng.intn(spawnEvery) === 0) {
					let burst = 1;
					if (this.cfg.burst > 1) burst = 1 + this.rng.intn(this.cfg.burst);
					for (let i = 0; i < burst; i++) this._spawnDrop();
				}
			}

			// 5. Advance + paint + cull drops.
			const alive = [];
			for (const d of this.drops) {
				d.row += d.vRow;
				d.col += d.vCol;
				this._paintDrop(d);
				const tailRow = d.row - (d.streakLen - 1) * d.vRow;
				if (tailRow < this.h && d.row > -d.streakLen) alive.push(d);
			}
			this.drops = alive;

			// 6. Age splashes.
			const sAlive = [];
			for (const s of this.splashes) {
				s.age++;
				if (s.age < s.maxAge) sAlive.push(s);
			}
			this.splashes = sAlive;
		}

		// Paint the grid onto a canvas context, scaled to fill (canvasW, canvasH).
		// opts: { transparent: true } — clear canvas to transparent instead of
		//        filling with the default dark background. Use when rendering
		//        as an overlay layer on top of other content.
		//       { bg: '#RRGGBB' } — use a custom background color.
		//        Defaults to '#0a0a0a' when neither transparent nor bg is set.
		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		// --- internals ---

		_currentHue() {
			let hue = this.cfg.hue;
			if (this.cfg.hue_drift > 0) {
				hue += this.cfg.hue_drift * Math.sin(this.tick * 0.02);
			}
			return ((hue % 360) + 360) % 360;
		}

		_currentWind() {
			let w = this.cfg.wind;
			if (this.cfg.wind_drift > 0) {
				w += this.cfg.wind_drift * Math.sin(this.tick * 0.013 + 1.7);
			}
			w += this.gustWind;
			return w;
		}

		_introStyle() {
			const style = this.cfg.intro_style | 0;
			if (style < 0 || style > 3) return 0;
			return style;
		}

		_introProgress() {
			return this._phaseProgress(this.introTotal, this.introTicks);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return Math.max(0, Math.min(1, elapsed / (total - 1)));
		}

		_introRange(progress) {
			const style = this._introStyle();
			if (style === 0) return [0, this.w];
			let open = this.cfg.intro_open;
			if (!(open > 0)) open = DEFAULTS.intro_open;
			open = Math.max(0, Math.min(1, open));
			let width = (open + (1 - open) * Math.max(0, Math.min(1, progress))) * this.w;
			if (width < 1) width = 1;
			switch (style) {
				case 1:
					return [0, Math.min(this.w, width)];
				case 2: {
					const center = this.w / 2;
					const half = width / 2;
					return [Math.max(0, center - half), Math.min(this.w, center + half)];
				}
				case 3:
					return [Math.max(0, this.w - width), this.w];
				default:
					return [0, this.w];
			}
		}

		_endingStyle() {
			const style = this.cfg.ending_style | 0;
			if (style < 0 || style > 3) return 0;
			return style;
		}

		_endingRange(progress) {
			const style = this._endingStyle();
			if (style === 0) return [0, this.w];
			let width = (1 - Math.max(0, Math.min(1, progress))) * this.w;
			if (width < 1) width = 1;
			switch (style) {
				case 1:
					return [0, Math.min(this.w, width)];
				case 2: {
					const center = this.w / 2;
					const half = width / 2;
					return [Math.max(0, center - half), Math.min(this.w, center + half)];
				}
				case 3:
					return [Math.max(0, this.w - width), this.w];
				default:
					return [0, this.w];
			}
		}

		_setPixel(gr, gc, r, g, b) {
			if (gr < 0 || gr >= this.h || gc < 0 || gc >= this.w) return;
			const i = (gr * this.w + gc) * 3;
			this.grid[i] = r;
			this.grid[i + 1] = g;
			this.grid[i + 2] = b;
		}

		_spawnDropAt(colValue) {
			const c = this.cfg;
			const isBG = c.layers >= 2 && this.rng() < c.lbal;

			const sJit = (this.rng() * 2 - 1) * c.speed_jit;
			const wJit = (this.rng() * 2 - 1) * c.wind_jit;
			let effSpeed = c.speed * (1 + sJit);
			let effWind = this._currentWind() + wJit * c.wind;
			if (effSpeed < 0.1) effSpeed = 0.1;
			if (isBG) effSpeed *= 0.6;

			const hJit = (this.rng() * 2 - 1) * c.hue_sp;
			const hue = ((this._currentHue() + hJit) % 360 + 360) % 360;
			const t = this.rng();
			let lightness = c.lmin + t * (c.lmax - c.lmin);
			if (isBG) lightness *= 0.65;
			const col = hslToRGB(hue, c.sat, lightness);

			let streak = c.streak;
			if (isBG) streak = Math.max(2, Math.floor(streak / 2));

			this.drops.push({
				row: 0,
				col: Math.max(0, Math.min(this.w - 1, colValue)),
				color: col,
				vRow: effSpeed,
				vCol: effWind * effSpeed,
				streakLen: streak,
			});
		}

		_spawnDrop() {
			this._spawnDropAt(this.rng() * this.w);
		}

		_spawnIntroDrop(progress) {
			const [minCol, maxCol] = this._introRange(progress);
			let col = minCol;
			if (maxCol > minCol) col += this.rng() * (maxCol - minCol);
			this._spawnDropAt(col);
		}

		_spawnEndingDrop(progress) {
			const [minCol, maxCol] = this._endingRange(progress);
			let col = minCol;
			if (maxCol > minCol) col += this.rng() * (maxCol - minCol);
			this._spawnDropAt(col);
		}

		_startIntro() {
			this.downpourTicks = 0;
			this.downpourMult = 0;
			this.calmTicks = 0;
			this.gustTicks = 0;
			this.gustWind = 0;
			this.drops = [];
			this.splashes = [];
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.endingSplashLeft = 0;
			this.endingSplashTotal = 0;
			this.introTotal = Math.max(1, this.cfg.intro_dur | 0);
			this.introTicks = this.introTotal;
			for (let i = 0; i < this.cfg.intro_seed; i++) {
				this._spawnIntroDrop(0);
			}
		}

		_stepIntro() {
			const progress = this._introProgress();
			const sparse = Math.max(1, this.cfg.intro_sparse);
			const factor = 1 + (sparse - 1) * (1 - progress);
			const effectiveSpawn = Math.max(1, Math.round(this.cfg.spawn * factor));
			if (this.rng.intn(effectiveSpawn) === 0) {
				let burst = 1;
				if (this.cfg.burst > 1) burst = 1 + this.rng.intn(this.cfg.burst);
				for (let i = 0; i < burst; i++) this._spawnIntroDrop(progress);
			}
			this.introTicks--;
		}

		_startEnding() {
			this.introTicks = 0;
			this.introTotal = 0;
			this.downpourTicks = 0;
			this.downpourMult = 0;
			this.calmTicks = 0;
			this.gustTicks = 0;
			this.gustWind = 0;
			this.endingFade = Math.max(1, this.cfg.ending_dur | 0);
			const linger = Math.max(0, this.cfg.ending_linger | 0);
			this.endingTotal = this.endingFade + linger;
			this.endingTicks = this.endingTotal;
			this.endingSplashTotal = Math.max(0, this.cfg.ending_splashes | 0);
			this.endingSplashLeft = this.endingSplashTotal;
		}

		_stepEnding() {
			const totalProgress = this._phaseProgress(this.endingTotal, this.endingTicks);
			if (this.endingSplashLeft > 0 && this.endingSplashTotal > 0) {
				const targetDone = Math.floor(Math.pow(totalProgress, 1.8) * this.endingSplashTotal);
				let done = this.endingSplashTotal - this.endingSplashLeft;
				while (done < targetDone && this.endingSplashLeft > 0) {
					this._spawnSplash();
					this.endingSplashLeft--;
					done++;
				}
			}

			const elapsed = this.endingTotal - this.endingTicks;
			if (elapsed < this.endingFade) {
				const fadeProgress = Math.max(0, Math.min(1, elapsed / Math.max(1, this.endingFade - 1)));
				const factor = 1 + 18 * fadeProgress * fadeProgress;
				const effectiveSpawn = Math.max(1, Math.round(this.cfg.spawn * factor));
				if (this.rng.intn(effectiveSpawn) === 0) {
					this._spawnEndingDrop(fadeProgress);
				}
			}

			this.endingTicks--;
			if (this.endingTicks < 0) this.endingTicks = 0;
		}

		_paintDrop(d) {
			for (let i = 0; i < d.streakLen; i++) {
				const row = d.row - i * d.vRow;
				const col = d.col - i * d.vCol;
				const gr = Math.floor(row);
				const gc = Math.round(col);
				if (gr < 0 || gr >= this.h || gc < 0 || gc >= this.w) continue;
				const brightness = Math.pow(this.cfg.fade, i);
				this._setPixel(gr, gc,
					Math.floor(d.color.r * brightness),
					Math.floor(d.color.g * brightness),
					Math.floor(d.color.b * brightness));
			}
		}

		_spawnSplash() {
			const c = this.cfg;
			if (c.splash_size <= 0) return;
			const radius = jitterInt(this.rng, c.splash_size, 0.3);
			const hJit = (this.rng() * 2 - 1) * c.hue_sp;
			const hue = ((this._currentHue() + hJit) % 360 + 360) % 360;
			const col = hslToRGB(hue, c.sat, c.lmax);
			this.splashes.push({
				row: this.rng.intn(this.h),
				col: this.rng.intn(this.w),
				age: 0,
				maxAge: radius * 2,
				maxRadius: radius,
				color: col,
			});
		}

		_paintSplashes() {
			for (const s of this.splashes) {
				const t = s.age / s.maxAge;
				const radius = t * s.maxRadius;
				const alpha = 1 - t;
				const rr = Math.floor(s.color.r * alpha);
				const gg = Math.floor(s.color.g * alpha);
				const bb = Math.floor(s.color.b * alpha);
				let steps = Math.floor(2 * Math.PI * radius);
				if (steps < 8) steps = 8;
				for (let i = 0; i < steps; i++) {
					const theta = (2 * Math.PI * i) / steps;
					const gc = s.col + Math.round(radius * Math.cos(theta));
					const gr = s.row + Math.round(radius * Math.sin(theta));
					this._setPixel(gr, gc, rr, gg, bb);
				}
			}
		}
	}

	api.effects['rain'] = Rain;
})(window.AmbienceSim);
// ===== effects/rowboat.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 50,
		intro_drift: 0.18,
		ending_dur: 65,
		ending_linger: 18,
		ending_ripple: 0.08,
		waterline: 0.58,
		drift_speed: 0.08,
		bob_amp: 1.2,
		wave_amp: 1.6,
		wave_freq: 0.16,
		ripple: 0.24,
		reflection: 0.22,
		boat_len: 14,
		boat_height: 3.5,
		hue: 206,
		hue_sp: 16,
		sat: 0.36,
		lmin: 0.16,
		lmax: 0.82,
		wake_p: 0,
		drift_p: 0,
		calm_p: 0,
		wake_dur: 40,
		wake_mult: 1.85,
		drift_dur: 58,
		drift_push: 1.3,
		calm_dur: 72,
		calm_mult: 0.5,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_drift = clamp01(c.intro_drift);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_ripple = clamp01(c.ending_ripple);
		if (c.waterline <= 0) c.waterline = DEFAULTS.waterline;
		if (c.drift_speed <= 0) c.drift_speed = DEFAULTS.drift_speed;
		if (c.bob_amp <= 0) c.bob_amp = DEFAULTS.bob_amp;
		if (c.wave_amp <= 0) c.wave_amp = DEFAULTS.wave_amp;
		if (c.wave_freq <= 0) c.wave_freq = DEFAULTS.wave_freq;
		if (c.ripple <= 0) c.ripple = DEFAULTS.ripple;
		if (c.reflection <= 0) c.reflection = DEFAULTS.reflection;
		if (c.boat_len <= 0) c.boat_len = DEFAULTS.boat_len;
		if (c.boat_height <= 0) c.boat_height = DEFAULTS.boat_height;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.wake_dur <= 0) c.wake_dur = DEFAULTS.wake_dur;
		if (c.wake_mult <= 0) c.wake_mult = DEFAULTS.wake_mult;
		if (c.drift_dur <= 0) c.drift_dur = DEFAULTS.drift_dur;
		if (c.drift_push <= 0) c.drift_push = DEFAULTS.drift_push;
		if (c.calm_dur <= 0) c.calm_dur = DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DEFAULTS.calm_mult;
		return c;
	}

	class Rowboat {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 83);
			switch (name) {
				case 'wake':
					this.timers.wake = jitterInt(rng, this.cfg.wake_dur, 0.3);
					this.values.wake_gain = this.cfg.wake_mult * (0.8 + rng() * 0.45);
					return true;
				case 'drift':
					this.timers.drift = jitterInt(rng, this.cfg.drift_dur, 0.3);
					this.values.drift_push = (rng() < 0.5 ? -1 : 1) * this.cfg.drift_push * (0.65 + rng() * 0.55);
					return true;
				case 'calm':
					this.timers.calm = jitterInt(rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'intro':
					this.timers.wake = 0;
					this.timers.drift = 0;
					this.timers.calm = 0;
					this.timers.ending = 0;
					this.values.wake_gain = 1;
					this.values.drift_push = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.wake = 0;
					this.timers.drift = 0;
					this.timers.calm = 0;
					this.values.wake_gain = 1;
					this.values.drift_push = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.wake || this.timers.wake <= 0) this.values.wake_gain = 1;
			if (!this.timers.drift || this.timers.drift <= 0) this.values.drift_push = 0;
		}

		_rippleLevel() {
			let level = 1;
			if (this.timers.wake > 0) level *= this.values.wake_gain || this.cfg.wake_mult;
			if (this.timers.calm > 0) level *= this.cfg.calm_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_drift + (1 - this.cfg.intro_drift) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_ripple) * progress;
			}
			if (this.timers.drift > 0) {
				level *= 1 + Math.abs(this.values.drift_push || this.cfg.drift_push) * 0.22;
			}
			return Math.max(0.04, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const skyTop = hslToRGB((this.cfg.hue - 12 + 360) % 360, clamp01(this.cfg.sat * 0.45), clamp01(this.cfg.lmin + 0.02));
				const skyMid = hslToRGB((this.cfg.hue - this.cfg.hue_sp * 0.22 + 360) % 360, clamp01(this.cfg.sat * 0.58), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.34));
				const skyLow = hslToRGB((this.cfg.hue + this.cfg.hue_sp * 0.18) % 360, clamp01(this.cfg.sat * 0.72), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.62));
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, `rgb(${skyTop.r},${skyTop.g},${skyTop.b})`);
				sky.addColorStop(0.58, `rgb(${skyMid.r},${skyMid.g},${skyMid.b})`);
				sky.addColorStop(1, `rgb(${skyLow.r},${skyLow.g},${skyLow.b})`);
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const waterline = Math.max(12, Math.min(this.h - 10, Math.floor(this.h * this.cfg.waterline)));
			const motion = this._rippleLevel();
			const driftPush = this.values.drift_push || 0;
			const phase = this.tick * this.cfg.drift_speed * 0.08;

			const glowX = canvasW * 0.74;
			const glowY = canvasH * 0.24;
			const glowR = Math.max(20, Math.min(canvasW, canvasH) * 0.09);
			const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowR * 2.8);
			glow.addColorStop(0, 'rgba(255, 223, 174, 0.22)');
			glow.addColorStop(1, 'rgba(255, 223, 174, 0)');
			ctx.fillStyle = glow;
			ctx.fillRect(0, 0, canvasW, canvasH);

			const ridgeBase = waterline - Math.max(5, Math.round(this.h * 0.12));
			const shorelineY = Math.max(ridgeBase + 2, waterline - Math.max(2, Math.round(this.h * 0.04)));
			const ridgePoints = [];
			const ridgeSegments = 7;
			for (let i = 0; i <= ridgeSegments; i++) {
				const ridgeWave = Math.sin(i * 0.9 + this._hash(25100 + i) * 2.4) * 2.8;
				ridgePoints.push(Math.round(ridgeBase - Math.abs(ridgeWave) - this._hash(25200 + i) * 3));
			}
			const ridgeColor = hslToRGB((this.cfg.hue + 54) % 360, clamp01(this.cfg.sat * 0.24), clamp01(this.cfg.lmin * 0.7));
			ctx.fillStyle = `rgb(${ridgeColor.r},${ridgeColor.g},${ridgeColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, Math.floor(shorelineY * sy));
			for (let x = 0; x < this.w; x++) {
				const pos = (x / Math.max(1, this.w - 1)) * ridgeSegments;
				const idx = Math.min(ridgeSegments - 1, Math.floor(pos));
				const frac = pos - idx;
				const eased = frac * frac * (3 - 2 * frac);
				const ridgeY = ridgePoints[idx] + (ridgePoints[idx + 1] - ridgePoints[idx]) * eased;
				ctx.lineTo(Math.floor(x * sx), Math.floor(ridgeY * sy));
			}
			ctx.lineTo(canvasW, Math.floor(shorelineY * sy));
			ctx.closePath();
			ctx.fill();

			const treelineColor = hslToRGB((this.cfg.hue + 72) % 360, clamp01(this.cfg.sat * 0.2), clamp01(this.cfg.lmin * 0.52));
			for (let i = 0; i < 11; i++) {
				const col = Math.floor((i + 0.4) * this.w / 11 + (this._hash(25300 + i) - 0.5) * 6);
				const top = Math.round(ridgeBase - 1 - this._hash(25400 + i) * 4);
				const height = 2 + Math.floor(this._hash(25500 + i) * 3);
				for (let row = 0; row < height; row++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, top + row, 1, 1, `rgb(${treelineColor.r},${treelineColor.g},${treelineColor.b})`, 0.92);
				}
			}

			for (let y = waterline; y < this.h; y++) {
				const depth = (y - waterline) / Math.max(1, this.h - waterline);
				const hue = ((this.cfg.hue + depth * this.cfg.hue_sp * 0.22) % 360 + 360) % 360;
				const sat = clamp01(this.cfg.sat * (0.8 - depth * 0.22));
				const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.36 - depth * 0.18));
				const color = hslToRGB(hue, sat, light);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${color.r},${color.g},${color.b})`, 1);
			}

			const mist = ctx.createLinearGradient(0, Math.floor((shorelineY - 3) * sy), 0, Math.floor((waterline + 8) * sy));
			mist.addColorStop(0, 'rgba(255, 240, 220, 0.14)');
			mist.addColorStop(1, 'rgba(255, 240, 220, 0)');
			ctx.fillStyle = mist;
			ctx.fillRect(0, Math.floor((shorelineY - 3) * sy), canvasW, Math.ceil((waterline - shorelineY + 11) * sy));

			const surfaceColor = hslToRGB((this.cfg.hue - 6 + 360) % 360, clamp01(this.cfg.sat * 0.34), clamp01(this.cfg.lmax * 0.92));
			for (let x = 0; x < this.w; x++) {
				const wave = Math.sin(x * this.cfg.wave_freq + phase) * this.cfg.wave_amp;
				const subWave = Math.sin(x * this.cfg.wave_freq * 0.42 - phase * 1.7) * this.cfg.wave_amp * 0.36;
				const row = waterline + Math.round((wave + subWave) * motion * 0.22);
				const twinkle = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(this.tick * 0.03 + x * 0.11), 2);
				const alpha = clamp01((0.05 + this.cfg.reflection * 0.16) * twinkle);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row, 1, 1, `rgb(${surfaceColor.r},${surfaceColor.g},${surfaceColor.b})`, alpha);
				if ((x + this.tick) % 6 === 0) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row + 2, 1, 1, `rgb(${surfaceColor.r},${surfaceColor.g},${surfaceColor.b})`, alpha * 0.45);
				}
			}

			const boatLen = Math.max(7, Math.round(this.cfg.boat_len));
			const boatHeight = Math.max(2, Math.round(this.cfg.boat_height));
			const boatX = Math.max(Math.floor(boatLen * 0.6), Math.min(this.w - Math.ceil(boatLen * 0.6), Math.round(this.w * 0.34 + Math.sin(phase * 1.6 + 0.8) * (2.4 + motion * 1.6) + driftPush * 1.8)));
			const bob = Math.sin(phase * 2.4 + 0.6) * this.cfg.bob_amp * motion * 0.52 + Math.sin(phase * 0.95 + 1.3) * 0.35;
			const hullBaseY = waterline - Math.round(bob * 0.55);
			const tilt = Math.sin(phase * 1.9 + 0.4) * motion * 0.9 + driftPush * 0.2;
			const hullColor = hslToRGB(24, 0.34, 0.22);
			const railColor = hslToRGB(31, 0.26, 0.36);
			const seatColor = hslToRGB(28, 0.18, 0.16);
			const hullRows = [];

			for (let row = 0; row < boatHeight; row++) {
				const t = boatHeight === 1 ? 0.5 : row / (boatHeight - 1);
				const arch = 1 - Math.abs(t * 2 - 1);
				const width = Math.max(4, Math.round(boatLen * (0.54 + arch * 0.42)));
				const y = hullBaseY - (boatHeight - 1 - row);
				const offset = Math.round((t - 0.5) * tilt * 1.8);
				const startX = Math.round(boatX - width / 2 + offset);
				hullRows.push({ startX, width, y });
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, startX, y, width, 1, `rgb(${hullColor.r},${hullColor.g},${hullColor.b})`, clamp01(0.78 + t * 0.2));
			}

			const topHull = hullRows[0];
			if (topHull && topHull.width > 3) {
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, topHull.startX + 1, topHull.y, topHull.width - 2, 1, `rgb(${railColor.r},${railColor.g},${railColor.b})`, 0.72);
			}
			const seatWidth = Math.max(2, Math.round(boatLen * 0.22));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(boatX - seatWidth / 2), hullBaseY - Math.max(1, Math.floor(boatHeight / 2)), seatWidth, 1, `rgb(${seatColor.r},${seatColor.g},${seatColor.b})`, 0.82);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(boatX - boatLen * 0.46), hullBaseY - 1, 1, 1, `rgb(${railColor.r},${railColor.g},${railColor.b})`, 0.82);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(boatX + boatLen * 0.44), hullBaseY - 1, 1, 1, `rgb(${railColor.r},${railColor.g},${railColor.b})`, 0.82);

			const shadowColor = hslToRGB((this.cfg.hue + 10) % 360, clamp01(this.cfg.sat * 0.28), clamp01(this.cfg.lmin * 0.9));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(boatX - boatLen * 0.5), waterline, boatLen, 1, `rgb(${shadowColor.r},${shadowColor.g},${shadowColor.b})`, 0.26);

			const reflectionColor = hslToRGB((this.cfg.hue + 8) % 360, clamp01(this.cfg.sat * 0.28), clamp01(this.cfg.lmax * 0.58));
			const reflectionLevel = clamp01(this.cfg.reflection * (0.3 + motion * 0.22));
			for (let i = 0; i < hullRows.length; i++) {
				const row = hullRows[i];
				const distance = hullBaseY - row.y + 1;
				const wobble = Math.round(Math.sin(this.tick * 0.08 + i * 0.8 + row.startX * 0.03) * (0.5 + motion * 0.45));
				const reflY = hullBaseY + distance + Math.round(Math.sin(row.startX * this.cfg.wave_freq + phase) * motion * 0.35);
				const reflWidth = Math.max(2, row.width - 1 - Math.floor(distance / 2));
				const alpha = clamp01(reflectionLevel * (0.4 - distance * 0.045));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, row.startX + wobble, reflY, reflWidth, 1, `rgb(${reflectionColor.r},${reflectionColor.g},${reflectionColor.b})`, alpha);
			}

			const rippleColor = hslToRGB((this.cfg.hue - 10 + 360) % 360, clamp01(this.cfg.sat * 0.32), clamp01(this.cfg.lmax * 0.98));
			const wakeGain = this.timers.wake > 0 ? (this.values.wake_gain || this.cfg.wake_mult) : 1;
			const rippleBands = 4 + Math.round(this.cfg.ripple * 7);
			for (let band = 0; band < rippleBands; band++) {
				const centerX = Math.round(boatX + boatLen * 0.18 + band * (1.2 + wakeGain * 0.28));
				const half = Math.max(3, Math.round(boatLen * (0.24 + band * 0.14 + wakeGain * 0.03)));
				const centerY = waterline + Math.round(0.8 + band * 0.75 + Math.abs(Math.sin(phase * 4.2 + band * 0.9)) * 1.1);
				for (let dx = -half; dx <= half; dx++) {
					if ((dx + band + this.tick) % 2 !== 0) continue;
					const edge = 1 - Math.abs(dx) / Math.max(1, half);
					const waveY = centerY + Math.round(Math.sin(dx * 0.22 + this.tick * 0.08 + band * 0.7) * 0.7);
					const alpha = clamp01((0.08 + this.cfg.ripple * 0.24 * motion) * Math.pow(edge, 0.45));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, waveY, 1, 1, `rgb(${rippleColor.r},${rippleColor.g},${rippleColor.b})`, alpha);
				}
			}

			for (let band = 0; band < 3; band++) {
				const half = Math.max(2, Math.round(boatLen * (0.16 + band * 0.08)));
				const centerX = Math.round(boatX - boatLen * 0.2 - band * 1.2);
				const centerY = waterline + Math.round(band * 0.85 + Math.abs(Math.sin(phase * 3.6 + band)) * 0.9);
				for (let dx = -half; dx <= half; dx++) {
					if ((dx + band) % 2 !== 0) continue;
					const edge = 1 - Math.abs(dx) / Math.max(1, half);
					const alpha = clamp01((0.03 + this.cfg.ripple * 0.12 * motion) * Math.pow(edge, 0.65));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, centerY + Math.round(Math.sin(dx * 0.3 + this.tick * 0.06) * 0.5), 1, 1, `rgb(${rippleColor.r},${rippleColor.g},${rippleColor.b})`, alpha);
				}
			}
		}
	}

	api.presets['rowboat'] = [
		{
			key: 'still-lake',
			label: 'still lake',
			config: {
				intro_drift: 0.12,
				ending_ripple: 0.12,
				waterline: 0.57,
				drift_speed: 0.05,
				bob_amp: 0.7,
				wave_amp: 0.9,
				wave_freq: 0.12,
				ripple: 0.12,
				reflection: 0.28,
				boat_len: 13,
				boat_height: 3.5,
				hue: 202,
				hue_sp: 10,
				sat: 0.26,
				lmin: 0.16,
				lmax: 0.74,
				calm_p: 0.0011,
			},
		},
		{
			key: 'gentle-drift',
			label: 'gentle drift',
			config: {
				waterline: 0.58,
				drift_speed: 0.08,
				bob_amp: 1.2,
				wave_amp: 1.6,
				wave_freq: 0.16,
				ripple: 0.24,
				reflection: 0.22,
				boat_len: 14,
				boat_height: 3.5,
				hue: 206,
				hue_sp: 16,
				sat: 0.36,
				lmin: 0.16,
				lmax: 0.82,
				drift_p: 0.0009,
			},
		},
		{
			key: 'evening-ripples',
			label: 'evening ripples',
			config: {
				waterline: 0.6,
				drift_speed: 0.1,
				bob_amp: 1.4,
				wave_amp: 1.9,
				wave_freq: 0.18,
				ripple: 0.34,
				reflection: 0.24,
				boat_len: 14.5,
				boat_height: 4,
				hue: 212,
				hue_sp: 18,
				sat: 0.4,
				lmin: 0.18,
				lmax: 0.86,
				wake_p: 0.001,
			},
		},
		{
			key: 'wind-touched-water',
			label: 'wind-touched water',
			config: {
				waterline: 0.56,
				drift_speed: 0.12,
				bob_amp: 1.8,
				wave_amp: 2.5,
				wave_freq: 0.2,
				ripple: 0.42,
				reflection: 0.18,
				boat_len: 15,
				boat_height: 4,
				hue: 198,
				hue_sp: 20,
				sat: 0.46,
				lmin: 0.18,
				lmax: 0.8,
				wake_p: 0.0012,
				wake_mult: 2.1,
				drift_p: 0.0014,
				drift_push: 1.55,
			},
		},
	];
	api.effects['rowboat'] = Rowboat;
})(window.AmbienceSim);
// ===== effects/sand.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB } = api._helpers;

	const SAND_DEFAULTS = {
		intro_dur: 70,
		intro_trickle: 0.18,
		intro_pile: 0.05,
		ending_dur: 70,
		ending_linger: 40,
		ending_residue: 0.4,
		pipe_x: 0.5,
		pipe_y: 0.16,
		pipe_width: 6,
		stream_spread: 1.4,
		container_y: 0.62,
		container_span: 0.42,
		container_depth: 16,
		wall_thick: 1,
		emit_rate: 1.6,
		gravity: 0.085,
		drag: 0.04,
		spread: 0.06,
		splatter_p: 0.18,
		grain_max: 96,
		repose: 1.6,
		settle: 6,
		hue: 38,
		hue_sp: 12,
		sat: 0.6,
		lmin: 0.36,
		lmax: 0.78,
		pipe_hue: 22,
		pipe_light: 0.32,
		surge_p: 0,
		calm_p: 0,
		surge_dur: 60,
		surge_mult: 1.9,
		calm_dur: 70,
		calm_mult: 0.35,
	};

	function applySandDefaults(cfg) {
		const c = Object.assign({}, SAND_DEFAULTS, cfg || {});
		if (c.intro_dur === 0 && c.intro_trickle === 0 && c.intro_pile === 0) {
			c.intro_dur = SAND_DEFAULTS.intro_dur;
			c.intro_trickle = SAND_DEFAULTS.intro_trickle;
			c.intro_pile = SAND_DEFAULTS.intro_pile;
		} else {
			if (c.intro_dur <= 0) c.intro_dur = SAND_DEFAULTS.intro_dur;
			if (c.intro_trickle <= 0) c.intro_trickle = SAND_DEFAULTS.intro_trickle;
			if (c.intro_pile < 0) c.intro_pile = 0;
		}
		c.intro_trickle = clamp01(c.intro_trickle);
		c.intro_pile = clamp01(c.intro_pile);
		if (c.ending_dur === 0 && c.ending_linger === 0 && c.ending_residue === 0) {
			c.ending_dur = SAND_DEFAULTS.ending_dur;
			c.ending_linger = SAND_DEFAULTS.ending_linger;
			c.ending_residue = SAND_DEFAULTS.ending_residue;
		} else {
			if (c.ending_dur <= 0) c.ending_dur = SAND_DEFAULTS.ending_dur;
			if (c.ending_linger < 0) c.ending_linger = 0;
			if (c.ending_residue < 0) c.ending_residue = 0;
		}
		c.ending_residue = clamp01(c.ending_residue);
		if (c.pipe_x <= 0) c.pipe_x = SAND_DEFAULTS.pipe_x;
		c.pipe_x = clamp01(c.pipe_x);
		if (c.pipe_y <= 0) c.pipe_y = SAND_DEFAULTS.pipe_y;
		c.pipe_y = clamp01(c.pipe_y);
		if (c.pipe_width <= 0) c.pipe_width = SAND_DEFAULTS.pipe_width;
		if (c.stream_spread <= 0) c.stream_spread = SAND_DEFAULTS.stream_spread;
		if (c.container_y <= 0) c.container_y = SAND_DEFAULTS.container_y;
		c.container_y = clamp01(c.container_y);
		if (c.container_span <= 0) c.container_span = SAND_DEFAULTS.container_span;
		c.container_span = clamp01(c.container_span);
		if (c.container_depth <= 0) c.container_depth = SAND_DEFAULTS.container_depth;
		if (c.wall_thick <= 0) c.wall_thick = SAND_DEFAULTS.wall_thick;
		if (c.emit_rate <= 0) c.emit_rate = SAND_DEFAULTS.emit_rate;
		if (c.gravity <= 0) c.gravity = SAND_DEFAULTS.gravity;
		if (c.drag < 0) c.drag = 0;
		if (c.spread < 0) c.spread = 0;
		if (c.splatter_p < 0) c.splatter_p = 0;
		if (c.grain_max <= 0) c.grain_max = SAND_DEFAULTS.grain_max;
		if (c.repose <= 0) c.repose = SAND_DEFAULTS.repose;
		if (c.settle <= 0) c.settle = SAND_DEFAULTS.settle;
		if (c.hue_sp <= 0) c.hue_sp = SAND_DEFAULTS.hue_sp;
		if (c.sat <= 0) c.sat = SAND_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = SAND_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = SAND_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.pipe_light <= 0) c.pipe_light = SAND_DEFAULTS.pipe_light;
		c.pipe_light = clamp01(c.pipe_light);
		if (c.surge_dur <= 0) c.surge_dur = SAND_DEFAULTS.surge_dur;
		if (c.surge_mult <= 0) c.surge_mult = SAND_DEFAULTS.surge_mult;
		if (c.calm_dur <= 0) c.calm_dur = SAND_DEFAULTS.calm_dur;
		if (c.calm_mult < 0) c.calm_mult = 0;
		return c;
	}

	class Sand {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applySandDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.grains = [];
			this.surgeTicks = 0;
			this.calmTicks = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.pile = [];
			this.pileLeft = 0;
			this._resetPile();
		}

		setConfig(cfg) {
			const prev = this.cfg;
			this.cfg = applySandDefaults(Object.assign({}, this.cfg, cfg));
			if (prev.container_y !== this.cfg.container_y ||
				prev.container_span !== this.cfg.container_span ||
				prev.container_depth !== this.cfg.container_depth ||
				prev.pipe_x !== this.cfg.pipe_x ||
				prev.pipe_width !== this.cfg.pipe_width) {
				this._resetPile();
			}
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.surgeTicks = state.surgeTicks || 0;
			this.calmTicks = state.calmTicks || 0;
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
				this._resetPile();
			}
			this.grains = Array.isArray(state.grains) ? state.grains.map(g => ({
				row: g.row, col: g.col, vRow: g.vRow, vCol: g.vCol,
				life: g.life, maxLife: g.maxLife, color: g.color, bright: g.bright,
			})) : [];
			if (Array.isArray(state.pile) && state.pile.length > 0) {
				this.pile = state.pile.slice();
				this.pileLeft = state.pileLeft || 0;
			} else {
				this._resetPile();
			}
		}

		triggerEvent(name) {
			switch (name) {
				case 'surge':
					this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
					return true;
				case 'calm':
					this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.surgeTicks > 0) this.surgeTicks--;
			if (this.calmTicks > 0) this.calmTicks--;
			if (this.introTicks > 0) this.introTicks--;
			if (this.endingTicks > 0) this.endingTicks--;

			if (this.surgeTicks === 0 && this.rng() < this.cfg.surge_p) {
				this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
			}
			if (this.calmTicks === 0 && this.rng() < this.cfg.calm_p) {
				this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
			}

			this._spawnGrains();
			this._stepGrains();
			this._settlePile();
			this._applyEndingDrain();

			this.grid.fill(0);
			this._paintContainer();
			this._paintPile();
			this._paintPipe();
			this._paintGrains();
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / (total - 1));
		}

		_flowLevel() {
			let flow = 1.0;
			if (this.surgeTicks > 0) flow *= this.cfg.surge_mult;
			if (this.calmTicks > 0) flow *= this.cfg.calm_mult;
			if (this.introTicks > 0) {
				const progress = this._phaseProgress(this.introTotal, this.introTicks);
				flow *= this.cfg.intro_trickle + (1 - this.cfg.intro_trickle) * progress;
			}
			if (this.endingTicks > 0) {
				const elapsed = this.endingTotal - this.endingTicks;
				if (elapsed < this.endingFade) {
					const fade = clamp01(elapsed / Math.max(1, this.endingFade - 1));
					flow *= 1 - 0.94 * fade;
				} else {
					flow *= 0.0;
				}
			}
			if (flow < 0) flow = 0;
			return flow;
		}

		_startIntro() {
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.introTotal = this.cfg.intro_dur > 0 ? this.cfg.intro_dur : SAND_DEFAULTS.intro_dur;
			this.introTicks = this.introTotal;
			this.grains = [];
			this._resetPile();
			if (this.cfg.intro_pile > 0) this._seedPile(this.cfg.intro_pile);
		}

		_startEnding() {
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingFade = this.cfg.ending_dur > 0 ? this.cfg.ending_dur : SAND_DEFAULTS.ending_dur;
			const linger = Math.max(0, this.cfg.ending_linger);
			this.endingTotal = Math.max(1, this.endingFade + linger);
			this.endingTicks = this.endingTotal;
		}

		_pipeGeometry() {
			const width = Math.max(3, this.cfg.pipe_width);
			let half = Math.round(width * 0.5);
			if (half < 2) half = 2;
			const center = Math.round(this.cfg.pipe_x * (this.w - 1));
			let left = center - half;
			let right = center + half;
			if (left < 1) left = 1;
			if (right >= this.w - 1) right = this.w - 2;
			if (right < left) right = left;
			let lip = Math.round(this.cfg.pipe_y * (this.h - 1));
			if (lip < 2) lip = 2;
			if (lip > this.h - 8) lip = this.h - 8;
			return { lip, left, right, center };
		}

		_containerGeometry() {
			let brim = Math.round(this.cfg.container_y * (this.h - 1));
			if (brim < 8) brim = 8;
			if (brim > this.h - 4) brim = this.h - 4;
			let depth = Math.round(this.cfg.container_depth);
			if (depth < 3) depth = 3;
			if (depth > this.h - brim - 1) depth = this.h - brim - 1;
			if (depth < 2) depth = 2;
			const bottom = brim + depth;
			let half = Math.round(this.cfg.container_span * this.w * 0.5);
			if (half < 4) half = 4;
			const pipe = this._pipeGeometry();
			const center = pipe.center > 0 ? pipe.center : Math.round(this.w / 2);
			let left = center - half;
			let right = center + half;
			if (left < 1) left = 1;
			if (right >= this.w - 1) right = this.w - 2;
			return { brim, bottom, left, right };
		}

		_wallThick() {
			let w = Math.round(this.cfg.wall_thick);
			if (w < 1) w = 1;
			if (w > 4) w = 4;
			return w;
		}

		_resetPile() {
			const c = this._containerGeometry();
			const cols = Math.max(1, c.right - c.left + 1);
			this.pile = new Array(cols).fill(0);
			this.pileLeft = c.left;
		}

		_seedPile(fillFraction) {
			const c = this._containerGeometry();
			const depth = c.bottom - c.brim;
			if (depth <= 0) return;
			const level = clamp01(fillFraction) * depth;
			const cols = Math.max(1, c.right - c.left + 1);
			if (this.pile.length !== cols || this.pileLeft !== c.left) {
				this.pile = new Array(cols).fill(0);
				this.pileLeft = c.left;
			}
			for (let i = 0; i < cols; i++) {
				const dist = Math.abs(i - (cols - 1) * 0.5);
				const falloff = Math.max(0, 1 - dist / (cols * 0.5 + 0.001));
				this.pile[i] = level * (0.7 + 0.3 * falloff);
			}
		}

		_spawnGrains() {
			const flow = this._flowLevel();
			if (flow <= 0.001) return;
			if (this.grains.length >= this.cfg.grain_max) return;
			const rate = this.cfg.emit_rate * flow;
			if (rate <= 0) return;
			let count = Math.floor(rate);
			const frac = rate - count;
			if (this.rng() < frac) count++;
			if (count <= 0) return;
			const pipe = this._pipeGeometry();
			for (let i = 0; i < count && this.grains.length < this.cfg.grain_max; i++) {
				this._spawnOneGrain(pipe.lip, pipe.center);
			}
		}

		_spawnOneGrain(lipRow, pipeCenter) {
			const col = pipeCenter + (this.rng() * 2 - 1) * Math.max(0.4, this.cfg.stream_spread * 0.5);
			const row = lipRow + 1;
			const vCol = (this.rng() * 2 - 1) * 0.18 * this.cfg.stream_spread;
			const vRow = 0.35 + this.rng() * 0.25;
			const hue = ((this.cfg.hue + (this.rng() * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
			const light = this.cfg.lmin + this.rng() * (this.cfg.lmax - this.cfg.lmin);
			const color = hslToRGB(hue, this.cfg.sat, light);
			const bright = 0.75 + this.rng() * 0.25;
			const maxLife = jitterInt(this.rng, Math.max(40, this.h * 2), 0.25);
			this.grains.push({ row, col, vRow, vCol, life: maxLife, maxLife, color, bright });
		}

		_stepGrains() {
			if (!this.grains.length) {
				if (this.cfg.splatter_p > 0 && this._flowLevel() > 0.05 && this.rng() < this.cfg.splatter_p * 0.15) {
					this._spawnSplatter();
				}
				return;
			}
			const alive = [];
			const gravity = this.cfg.gravity;
			const drag = this.cfg.drag;
			const jitter = this.cfg.spread * 0.18;
			const c = this._containerGeometry();
			const wallTop = c.bottom;
			for (const g of this.grains) {
				g.vRow += gravity;
				if (drag > 0) g.vCol *= 1 - drag * 0.4;
				if (jitter > 0) g.vCol += (this.rng() * 2 - 1) * jitter;
				g.row += g.vRow;
				g.col += g.vCol;
				g.life--;

				const gridCol = Math.round(g.col);
				if (gridCol >= c.left && gridCol <= c.right) {
					const idx = gridCol - this.pileLeft;
					if (idx >= 0 && idx < this.pile.length) {
						const surfaceRow = wallTop - this.pile[idx];
						if (g.row >= surfaceRow) {
							this._depositGrain(idx);
							continue;
						}
					}
					if (gridCol === c.left - 1 || gridCol === c.right + 1) {
						g.vCol = Math.abs(g.vCol);
						if (gridCol === c.right + 1) g.vCol = -g.vCol;
					}
				}

				if (g.life <= 0 || g.row >= this.h + 2) continue;
				alive.push(g);
			}
			this.grains = alive;

			if (this.cfg.splatter_p > 0 && this._flowLevel() > 0.05 && this.grains.length < this.cfg.grain_max) {
				if (this.rng() < this.cfg.splatter_p * 0.15) this._spawnSplatter();
			}
		}

		_depositGrain(idx) {
			if (idx < 0 || idx >= this.pile.length) return;
			this.pile[idx] += 1.0;
			const c = this._containerGeometry();
			const maxH = (c.bottom - c.brim) + 2;
			if (this.pile[idx] > maxH) this.pile[idx] = maxH;
		}

		_settlePile() {
			if (this.pile.length <= 1) return;
			const repose = Math.max(0.5, this.cfg.repose);
			const passes = Math.max(1, this.cfg.settle);
			for (let p = 0; p < passes; p++) {
				let moved = false;
				if ((p + this.tick) % 2 === 0) {
					for (let i = 0; i < this.pile.length - 1; i++) {
						if (this._tryFlow(i, i + 1, repose)) moved = true;
					}
					for (let i = this.pile.length - 1; i > 0; i--) {
						if (this._tryFlow(i, i - 1, repose)) moved = true;
					}
				} else {
					for (let i = this.pile.length - 1; i > 0; i--) {
						if (this._tryFlow(i, i - 1, repose)) moved = true;
					}
					for (let i = 0; i < this.pile.length - 1; i++) {
						if (this._tryFlow(i, i + 1, repose)) moved = true;
					}
				}
				if (!moved) break;
			}
		}

		_tryFlow(src, dst, repose) {
			if (src < 0 || src >= this.pile.length || dst < 0 || dst >= this.pile.length) return false;
			const delta = this.pile[src] - this.pile[dst];
			if (delta <= repose) return false;
			const move = (delta - repose) * 0.5;
			if (move < 0.05) return false;
			this.pile[src] -= move;
			this.pile[dst] += move;
			return true;
		}

		_applyEndingDrain() {
			if (this.endingTicks <= 0) return;
			const progress = this._phaseProgress(this.endingTotal, this.endingTicks);
			const target = clamp01(this.cfg.ending_residue);
			for (let i = 0; i < this.pile.length; i++) {
				this.pile[i] = this.pile[i] * (1 - 0.04 * progress) + target * this.pile[i] * 0.04 * progress;
			}
		}

		_spawnSplatter() {
			if (this.grains.length >= this.cfg.grain_max) return;
			const c = this._containerGeometry();
			if (c.right <= c.left) return;
			const pipe = this._pipeGeometry();
			const idx = pipe.center - this.pileLeft;
			if (idx < 0 || idx >= this.pile.length) return;
			const row = c.bottom - this.pile[idx];
			const col = pipe.center + (this.rng() * 2 - 1) * this.cfg.stream_spread * 1.4;
			const vRow = -(0.35 + this.rng() * 0.3);
			const vCol = (this.rng() * 2 - 1) * 0.55;
			const hue = ((this.cfg.hue + (this.rng() * 2 - 1) * this.cfg.hue_sp * 0.7) % 360 + 360) % 360;
			const light = clamp01(this.cfg.lmax * (0.85 + this.rng() * 0.15));
			const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.85), light);
			const maxLife = jitterInt(this.rng, 22, 0.3);
			this.grains.push({ row, col, vRow, vCol, life: maxLife, maxLife, color, bright: 0.95 });
		}

		_paintContainer() {
			const { brim, bottom, left, right } = this._containerGeometry();
			const wall = this._wallThick();
			const wallHue = ((this.cfg.pipe_hue % 360) + 360) % 360;
			const wallC = hslToRGB(wallHue, 0.4, this.cfg.pipe_light);
			const wallC2 = hslToRGB(wallHue, 0.32, clamp01(this.cfg.pipe_light * 0.7));
			for (let y = bottom; y < bottom + wall && y < this.h; y++) {
				for (let x = left - wall; x <= right + wall && x < this.w; x++) {
					if (x < 0) continue;
					this._paintMax(y, x, y > bottom ? wallC2 : wallC);
				}
			}
			for (let y = brim; y <= bottom; y++) {
				for (let w = 0; w < wall; w++) {
					this._paintMax(y, left - 1 - w, wallC);
					this._paintMax(y, right + 1 + w, wallC);
				}
			}
			if (brim - 1 >= 0) {
				const highlight = hslToRGB(wallHue, 0.3, clamp01(this.cfg.pipe_light * 1.4));
				for (let w = 0; w < wall; w++) {
					this._paintMax(brim - 1, left - 1 - w, highlight);
					this._paintMax(brim - 1, right + 1 + w, highlight);
				}
			}
		}

		_paintPile() {
			if (!this.pile.length) return;
			const { bottom, left, right } = this._containerGeometry();
			if (right <= left) return;
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (let i = 0; i < this.pile.length; i++) {
				const col = this.pileLeft + i;
				if (col < left || col > right) continue;
				const h = this.pile[i];
				if (h <= 0) continue;
				let topRow = bottom - Math.round(h);
				if (topRow < 0) topRow = 0;
				for (let y = topRow; y <= bottom; y++) {
					const depth = bottom - y;
					const frac = h > 0 ? depth / h : 0;
					const ridge = 1 - clamp01(frac);
					const grain = 0.5 + 0.5 * Math.sin(col * 0.81 + depth * 0.37);
					const localHue = ((hue + (grain - 0.5) * this.cfg.hue_sp * 0.6) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) *
						(0.25 + 0.55 * ridge + 0.18 * grain));
					const color = hslToRGB(localHue, clamp01(this.cfg.sat * 0.92), light);
					this._paintMax(y, col, color);
				}
			}
		}

		_paintPipe() {
			const pipe = this._pipeGeometry();
			const wallHue = ((this.cfg.pipe_hue % 360) + 360) % 360;
			const body = hslToRGB(wallHue, 0.55, this.cfg.pipe_light);
			const rim = hslToRGB(wallHue, 0.45, clamp01(this.cfg.pipe_light * 1.5));
			const shade = hslToRGB(wallHue, 0.45, clamp01(this.cfg.pipe_light * 0.65));
			for (let y = 0; y <= pipe.lip; y++) {
				for (let x = pipe.left; x <= pipe.right; x++) {
					this._paintMax(y, x, (x === pipe.left || x === pipe.right) ? shade : body);
				}
			}
			for (let x = pipe.left - 1; x <= pipe.right + 1; x++) {
				if (x < 0 || x >= this.w) continue;
				this._paintMax(pipe.lip, x, rim);
			}
		}

		_paintGrains() {
			for (const g of this.grains) {
				const fade = clamp01(g.life / Math.max(1, g.maxLife));
				if (fade <= 0) continue;
				const row = Math.round(g.row);
				const col = Math.round(g.col);
				const bright = g.bright * (0.5 + 0.5 * fade);
				this._paintMax(row, col, {
					r: Math.floor(g.color.r * bright),
					g: Math.floor(g.color.g * bright),
					b: Math.floor(g.color.b * bright),
				});
			}
		}

		_paintMax(row, col, color) {
			if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
			if (color.r === 0 && color.g === 0 && color.b === 0) return;
			const i = (row * this.w + col) * 3;
			if (color.r > this.grid[i]) this.grid[i] = color.r;
			if (color.g > this.grid[i + 1]) this.grid[i + 1] = color.g;
			if (color.b > this.grid[i + 2]) this.grid[i + 2] = color.b;
		}
	}

	api.presets['sand'] = [
		{
			key: 'small-trickle',
			label: 'small trickle',
			config: {
				intro_trickle: 0.15,
				intro_pile: 0.02,
				ending_residue: 0.7,
				pipe_x: 0.5,
				pipe_width: 5,
				stream_spread: 0.8,
				container_y: 0.66,
				container_span: 0.34,
				container_depth: 14,
				emit_rate: 0.5,
				gravity: 0.075,
				drag: 0.04,
				spread: 0.04,
				splatter_p: 0.08,
				grain_max: 48,
				repose: 1.4,
				settle: 4,
				hue: 42,
				hue_sp: 8,
				sat: 0.55,
				lmin: 0.38,
				lmax: 0.78,
				pipe_hue: 24,
				pipe_light: 0.32,
				calm_p: 0.0008,
				calm_mult: 0.3,
			},
		},
		{
			key: 'steady-pour',
			label: 'steady pour',
			config: {
				intro_trickle: 0.22,
				intro_pile: 0.08,
				ending_residue: 0.5,
				pipe_x: 0.5,
				pipe_width: 6,
				stream_spread: 1.4,
				container_y: 0.62,
				container_span: 0.42,
				container_depth: 16,
				emit_rate: 1.6,
				gravity: 0.085,
				drag: 0.04,
				spread: 0.06,
				splatter_p: 0.18,
				grain_max: 96,
				repose: 1.6,
				settle: 6,
				hue: 38,
				hue_sp: 12,
				sat: 0.6,
				lmin: 0.36,
				lmax: 0.78,
				pipe_hue: 22,
				pipe_light: 0.32,
				surge_p: 0.0006,
				surge_mult: 1.7,
			},
		},
		{
			key: 'heavy-fill',
			label: 'heavy fill',
			config: {
				intro_trickle: 0.3,
				intro_pile: 0.18,
				ending_residue: 0.55,
				pipe_x: 0.5,
				pipe_width: 8,
				stream_spread: 2.2,
				container_y: 0.58,
				container_span: 0.5,
				container_depth: 20,
				emit_rate: 3.2,
				gravity: 0.1,
				drag: 0.05,
				spread: 0.1,
				splatter_p: 0.32,
				grain_max: 180,
				repose: 1.8,
				settle: 8,
				hue: 34,
				hue_sp: 14,
				sat: 0.65,
				lmin: 0.34,
				lmax: 0.82,
				pipe_hue: 20,
				pipe_light: 0.34,
				surge_p: 0.0014,
				surge_mult: 2.1,
				surge_dur: 80,
			},
		},
		{
			key: 'overflow-study',
			label: 'overflow study',
			config: {
				intro_trickle: 0.3,
				intro_pile: 0.55,
				ending_residue: 0.6,
				pipe_x: 0.5,
				pipe_width: 6,
				stream_spread: 1.6,
				container_y: 0.7,
				container_span: 0.34,
				container_depth: 10,
				wall_thick: 1,
				emit_rate: 2.4,
				gravity: 0.09,
				drag: 0.04,
				spread: 0.08,
				splatter_p: 0.4,
				grain_max: 140,
				repose: 1.2,
				settle: 8,
				hue: 36,
				hue_sp: 16,
				sat: 0.62,
				lmin: 0.36,
				lmax: 0.84,
				pipe_hue: 22,
				pipe_light: 0.34,
				surge_p: 0.0009,
				surge_mult: 1.8,
			},
		},
	];
	api.effects['sand'] = Sand;
})(window.AmbienceSim);
// ===== effects/snow.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 60,
		intro_density: 0.16,
		ending_dur: 70,
		ending_linger: 22,
		ending_density: 0.08,
		density: 0.32,
		speed: 0.48,
		drift: 0.08,
		sway: 0.42,
		layers: 3,
		size: 1,
		hue: 210,
		hue_sp: 12,
		sat: 0.16,
		lmin: 0.74,
		lmax: 0.98,
		gust_p: 0,
		calm_p: 0,
		gust_dur: 55,
		gust_mult: 1.85,
		calm_dur: 80,
		calm_mult: 0.42,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_density = clamp01(c.intro_density);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_density = clamp01(c.ending_density);
		if (c.density <= 0) c.density = DEFAULTS.density;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.layers < 1) c.layers = DEFAULTS.layers;
		if (c.size <= 0) c.size = DEFAULTS.size;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.gust_dur <= 0) c.gust_dur = DEFAULTS.gust_dur;
		if (c.gust_mult <= 0) c.gust_mult = DEFAULTS.gust_mult;
		if (c.calm_dur <= 0) c.calm_dur = DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DEFAULTS.calm_mult;
		return c;
	}

	class Snow {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 17);
			switch (name) {
				case 'gust':
					this.timers.gust = jitterInt(rng, this.cfg.gust_dur, 0.3);
					this.values.gust_push = (rng() < 0.5 ? -1 : 1) * this.cfg.gust_mult * (0.45 + rng() * 0.55);
					return true;
				case 'calm':
					this.timers.calm = jitterInt(rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'intro':
					this.timers.gust = 0;
					this.timers.calm = 0;
					this.timers.ending = 0;
					this.values.gust_push = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.gust = 0;
					this.timers.calm = 0;
					this.values.gust_push = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.gust || this.timers.gust <= 0) {
				this.values.gust_push = 0;
			}
		}

		_densityLevel() {
			let level = this.cfg.density;
			if (this.timers.gust > 0) level *= 1.28;
			if (this.timers.calm > 0) level *= this.cfg.calm_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_density + (1 - this.cfg.intro_density) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_density) * progress;
			}
			return Math.max(0.02, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#09111d');
				sky.addColorStop(0.58, '#102033');
				sky.addColorStop(1, '#17263a');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const groundRow = Math.floor(this.h * 0.8);

			const moonX = canvasW * (0.16 + this._hash(401) * 0.18);
			const moonY = canvasH * (0.14 + this._hash(402) * 0.08);
			const moonR = Math.max(12, Math.min(canvasW, canvasH) * 0.035);
			const moon = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, moonR * 2.6);
			moon.addColorStop(0, 'rgba(225, 234, 255, 0.18)');
			moon.addColorStop(1, 'rgba(225, 234, 255, 0)');
			ctx.fillStyle = moon;
			ctx.fillRect(0, 0, canvasW, canvasH);

			for (let y = groundRow; y < this.h; y++) {
				const ratio = (y - groundRow) / Math.max(1, this.h - groundRow);
				const hue = ((this.cfg.hue - 8) % 360 + 360) % 360;
				const light = clamp01(0.06 + 0.2 * ratio);
				const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.55), light);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${color.r},${color.g},${color.b})`, 1);
			}

			const treeCount = 13;
			for (let i = 0; i < treeCount; i++) {
				const center = Math.floor((i + 0.5) * this.w / treeCount + (this._hash(500 + i) - 0.5) * 6);
				const trunkH = 1 + Math.floor(this._hash(530 + i) * 2);
				const crownH = 8 + Math.floor(this._hash(560 + i) * 9);
				const maxHalf = 2 + Math.floor(this._hash(590 + i) * 4);
				const hue = ((this.cfg.hue - 26) % 360 + 360) % 360;
				const treeColor = hslToRGB(hue, clamp01(this.cfg.sat * 0.6), 0.18 + this._hash(620 + i) * 0.08);
				for (let row = 0; row < crownH; row++) {
					const width = Math.max(1, maxHalf - Math.floor(row / 2));
					const y = groundRow - crownH + row;
					for (let dx = -width; dx <= width; dx++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, center + dx, y, 1, 1, `rgb(${treeColor.r},${treeColor.g},${treeColor.b})`, 1);
					}
				}
				for (let row = 0; row < trunkH; row++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, center, groundRow + row - trunkH, 1, 1, `rgb(${treeColor.r},${treeColor.g},${treeColor.b})`, 1);
				}
			}

			const density = this._densityLevel();
			const layers = Math.max(1, Math.round(this.cfg.layers));
			for (let layer = 0; layer < layers; layer++) {
				const layerRatio = layers === 1 ? 1 : layer / (layers - 1);
				const layerCount = Math.max(8, Math.round(this.w * density * (0.35 + layerRatio * 0.8)));
				const baseSpeed = this.cfg.speed * (0.4 + layerRatio * 0.85);
				const drift = this.cfg.drift * (0.35 + layerRatio * 0.65) + (this.values.gust_push || 0) * 0.035 * (0.5 + layerRatio * 0.65);
				const size = Math.max(1, Math.round(this.cfg.size + layerRatio));
				for (let i = 0; i < layerCount; i++) {
					const idx = layer * 1000 + i;
					const baseX = this._hash(1000 + idx) * this.w;
					const baseY = this._hash(2000 + idx) * Math.max(1, groundRow - 2);
					const sway = (this._hash(3000 + idx) * 2 - 1) * this.cfg.sway * (1.4 + layerRatio * 2.4);
					const fall = baseY + this.tick * baseSpeed * (0.75 + this._hash(4000 + idx) * 0.5);
					const row = positiveMod(fall, Math.max(1, groundRow - 2));
					const col = positiveMod(baseX + this.tick * drift + Math.sin(this.tick * 0.035 + idx * 0.19) * sway, this.w);
					const hue = ((this.cfg.hue + (this._hash(5000 + idx) * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.35 + 0.55 * (0.3 + layerRatio * 0.7)));
					const alpha = clamp01(0.35 + 0.55 * (0.25 + layerRatio * 0.75));
					const color = hslToRGB(hue, this.cfg.sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col), Math.round(row), size, size, `rgb(${color.r},${color.g},${color.b})`, alpha);
				}
			}
		}
	}

	api.presets['snow'] = [
		{
			key: 'quiet-flurries',
			label: 'quiet flurries',
			config: {
				density: 0.2,
				speed: 0.38,
				drift: 0.04,
				sway: 0.35,
				layers: 2,
				size: 1,
				hue: 208,
				hue_sp: 8,
				sat: 0.12,
				lmin: 0.76,
				lmax: 0.96,
				calm_p: 0.0012,
			},
		},
		{
			key: 'pine-evening',
			label: 'pine evening',
			config: {
				density: 0.3,
				speed: 0.5,
				drift: 0.08,
				sway: 0.4,
				layers: 3,
				size: 1,
				hue: 214,
				hue_sp: 12,
				sat: 0.16,
				lmin: 0.74,
				lmax: 0.98,
				gust_p: 0.0008,
			},
		},
		{
			key: 'crosswind',
			label: 'crosswind',
			config: {
				density: 0.34,
				speed: 0.56,
				drift: 0.16,
				sway: 0.58,
				layers: 3,
				size: 1.2,
				hue: 206,
				hue_sp: 10,
				sat: 0.14,
				lmin: 0.72,
				lmax: 0.98,
				gust_p: 0.0015,
				gust_mult: 2.25,
				gust_dur: 68,
			},
		},
		{
			key: 'whiteout-edge',
			label: 'whiteout edge',
			config: {
				intro_density: 0.22,
				ending_density: 0.14,
				density: 0.52,
				speed: 0.7,
				drift: 0.12,
				sway: 0.74,
				layers: 4,
				size: 1.5,
				hue: 212,
				hue_sp: 16,
				sat: 0.18,
				lmin: 0.76,
				lmax: 1,
				gust_p: 0.0018,
				gust_mult: 2.8,
				gust_dur: 76,
				calm_p: 0.0003,
			},
		},
	];
	api.effects['snow'] = Snow;
})(window.AmbienceSim);
// ===== effects/starfield.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 50,
		intro_density: 0.08,
		ending_dur: 60,
		ending_linger: 16,
		ending_density: 0.03,
		density: 0.22,
		speed: 0.12,
		drift: 0.04,
		layers: 3,
		size: 1,
		hue: 218,
		hue_sp: 18,
		sat: 0.18,
		lmin: 0.55,
		lmax: 0.95,
		shooting_star_p: 0,
		twinkle_burst_p: 0,
		shooting_star_dur: 26,
		shooting_star_mult: 1.8,
		twinkle_burst_dur: 42,
		twinkle_burst_mult: 1.7,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_density = clamp01(c.intro_density);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_density = clamp01(c.ending_density);
		if (c.density <= 0) c.density = DEFAULTS.density;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.layers < 1) c.layers = DEFAULTS.layers;
		if (c.size <= 0) c.size = DEFAULTS.size;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.shooting_star_dur <= 0) c.shooting_star_dur = DEFAULTS.shooting_star_dur;
		if (c.shooting_star_mult <= 0) c.shooting_star_mult = DEFAULTS.shooting_star_mult;
		if (c.twinkle_burst_dur <= 0) c.twinkle_burst_dur = DEFAULTS.twinkle_burst_dur;
		if (c.twinkle_burst_mult <= 0) c.twinkle_burst_mult = DEFAULTS.twinkle_burst_mult;
		return c;
	}

	class Starfield {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 41);
			switch (name) {
				case 'shooting-star':
					this.timers['shooting-star'] = jitterInt(rng, this.cfg.shooting_star_dur, 0.3);
					this.values['shooting-star_total'] = this.timers['shooting-star'];
					this.values.shooting_dir = rng() < 0.5 ? -1 : 1;
					this.values.shooting_row = 6 + rng() * Math.max(4, this.h / 3);
					this.values.shooting_start = rng() * this.w;
					return true;
				case 'twinkle-burst':
					this.timers['twinkle-burst'] = jitterInt(rng, this.cfg.twinkle_burst_dur, 0.3);
					return true;
				case 'intro':
					this.timers.ending = 0;
					this.timers['shooting-star'] = 0;
					this.timers['twinkle-burst'] = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers['shooting-star'] = 0;
					this.timers['twinkle-burst'] = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
		}

		_densityLevel() {
			let level = this.cfg.density;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_density + (1 - this.cfg.intro_density) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_density) * progress;
			}
			return Math.max(0.02, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#050912');
				sky.addColorStop(0.6, '#090f20');
				sky.addColorStop(1, '#0b1128');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const density = this._densityLevel();
			const layers = Math.max(1, Math.round(this.cfg.layers));
			const burst = this.timers['twinkle-burst'] > 0 ? this.cfg.twinkle_burst_mult : 1;

			for (let layer = 0; layer < layers; layer++) {
				const layerRatio = layers === 1 ? 1 : layer / (layers - 1);
				const layerCount = Math.max(10, Math.round(this.w * density * (0.4 + layerRatio * 1.2)));
				const speed = this.cfg.speed * (0.18 + layerRatio * 0.82);
				const drift = this.cfg.drift * (0.25 + layerRatio * 0.9);
				const size = Math.max(1, Math.round(this.cfg.size + layerRatio));
				for (let i = 0; i < layerCount; i++) {
					const idx = layer * 1400 + i;
					const baseX = this._hash(15000 + idx) * this.w;
					const baseY = this._hash(16000 + idx) * this.h;
					const col = positiveMod(baseX + this.tick * drift * speed * 2, this.w);
					const row = baseY;
					const hue = ((this.cfg.hue + (this._hash(17000 + idx) * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
					const twinkle = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(this.tick * (0.02 + this._hash(18000 + idx) * 0.03) + idx), 2);
					const light = clamp01((this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.3 + layerRatio * 0.7)) * twinkle * burst);
					const alpha = clamp01(0.35 + 0.25 * layerRatio + 0.25 * twinkle);
					const color = hslToRGB(hue, this.cfg.sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col), Math.round(row), size, size, `rgb(${color.r},${color.g},${color.b})`, alpha);
				}
			}

			if (this.timers['shooting-star'] > 0) {
				const total = Math.max(1, this.values['shooting-star_total'] || this.cfg.shooting_star_dur);
				const progress = 1 - (this.timers['shooting-star'] / total);
				const dir = this.values.shooting_dir || 1;
				const row = this.values.shooting_row || this.h * 0.25;
				const start = this.values.shooting_start || this.w * 0.25;
				const head = positiveMod(start + dir * progress * this.w * 0.6, this.w);
				for (let i = 0; i < 7; i++) {
					const fade = 1 - i / 7;
					const x = Math.round(head - dir * i * 1.5);
					const y = Math.round(row + i * 0.6);
					const light = clamp01(this.cfg.lmax * this.cfg.shooting_star_mult * fade * 0.55);
					const color = hslToRGB(this.cfg.hue - 8, clamp01(this.cfg.sat * 0.9), light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, 1 + (i === 0 ? 1 : 0), 1, `rgb(${color.r},${color.g},${color.b})`, fade);
				}
			}
		}
	}

	api.presets['starfield'] = [
		{
			key: 'still-night',
			label: 'still night',
			config: {
				density: 0.16,
				speed: 0.08,
				drift: 0.02,
				layers: 2,
				size: 1,
				hue: 214,
				hue_sp: 12,
				sat: 0.16,
				lmin: 0.5,
				lmax: 0.9,
			},
		},
		{
			key: 'soft-parallax',
			label: 'soft parallax',
			config: {
				density: 0.22,
				speed: 0.12,
				drift: 0.04,
				layers: 3,
				size: 1,
				hue: 218,
				hue_sp: 18,
				sat: 0.18,
				lmin: 0.55,
				lmax: 0.95,
				twinkle_burst_p: 0.0006,
			},
		},
		{
			key: 'meteor-watch',
			label: 'meteor watch',
			config: {
				density: 0.24,
				speed: 0.14,
				drift: 0.06,
				layers: 3,
				size: 1.2,
				hue: 214,
				hue_sp: 22,
				sat: 0.2,
				lmin: 0.56,
				lmax: 0.96,
				shooting_star_p: 0.0012,
				shooting_star_mult: 2.4,
			},
		},
		{
			key: 'cold-deep-space',
			label: 'cold deep space',
			config: {
				density: 0.2,
				speed: 0.09,
				drift: 0.03,
				layers: 4,
				size: 1,
				hue: 226,
				hue_sp: 26,
				sat: 0.22,
				lmin: 0.52,
				lmax: 0.94,
				twinkle_burst_p: 0.0009,
				twinkle_burst_mult: 1.9,
			},
		},
	];
	api.effects['starfield'] = Starfield;
})(window.AmbienceSim);
// ===== effects/tetris.js =====
'use strict';
(function (api) {
	const { makeRNG, hslToRGB } = api._helpers;

	// Tetris — slow ambient tetromino effect. Mirrors sim/tetris.go: same
	// piece shapes, same lifecycle, and the same mulberry32 sequence RNG so
	// authority and browser agree on piece kinds/columns/rotations.
	const TETRIS_PIECES = {
		1: { hue: 0,    rotations: [
			[[0,0],[0,1],[0,2],[0,3]],
			[[0,0],[1,0],[2,0],[3,0]],
		]},
		2: { hue: -120, rotations: [
			[[0,0],[0,1],[1,0],[1,1]],
		]},
		3: { hue: 105,  rotations: [
			[[0,0],[0,1],[0,2],[1,1]],
			[[0,0],[1,0],[1,1],[2,0]],
			[[0,1],[1,0],[1,1],[1,2]],
			[[0,1],[1,0],[1,1],[2,1]],
		]},
		4: { hue: -60,  rotations: [
			[[0,1],[0,2],[1,0],[1,1]],
			[[0,0],[1,0],[1,1],[2,1]],
		]},
		5: { hue: 180,  rotations: [
			[[0,0],[0,1],[1,1],[1,2]],
			[[0,1],[1,0],[1,1],[2,0]],
		]},
		6: { hue: 45,   rotations: [
			[[0,0],[1,0],[1,1],[1,2]],
			[[0,0],[0,1],[1,0],[2,0]],
			[[0,0],[0,1],[0,2],[1,2]],
			[[0,1],[1,1],[2,0],[2,1]],
		]},
		7: { hue: -150, rotations: [
			[[0,2],[1,0],[1,1],[1,2]],
			[[0,0],[1,0],[2,0],[2,1]],
			[[0,0],[0,1],[0,2],[1,0]],
			[[0,0],[0,1],[1,1],[2,1]],
		]},
	};

	const TETRIS_DEFAULTS = {
		intro_dur: 60, intro_h: 0, intro_first: 8,
		ending_dur: 80, ending_linger: 60,
		board_w: 10, board_h: 20,
		fall_every: 14, spawn_pause: 18, lock_delay: 6,
		hue: 200, hue_sp: 0, sat: 0.55, lmin: 0.4, lmax: 0.66, ghost: 0,
		lull_p: 0, lull_dur: 80,
		fill_thresh: 0.85,
	};

	function applyTetrisDefaults(cfg) {
		const c = Object.assign({}, TETRIS_DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = TETRIS_DEFAULTS.intro_dur;
		if (c.intro_h < 0) c.intro_h = 0;
		if (c.intro_h > 0.85) c.intro_h = 0.85;
		if (c.intro_first < 0) c.intro_first = 0;
		if (c.ending_dur <= 0) c.ending_dur = TETRIS_DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		if (c.board_w < 6) c.board_w = 6;
		if (c.board_w > 24) c.board_w = 24;
		if (c.board_h < 10) c.board_h = 10;
		if (c.board_h > 32) c.board_h = 32;
		if (c.fall_every <= 0) c.fall_every = TETRIS_DEFAULTS.fall_every;
		if (c.spawn_pause <= 0) c.spawn_pause = TETRIS_DEFAULTS.spawn_pause;
		if (c.lock_delay <= 0) c.lock_delay = TETRIS_DEFAULTS.lock_delay;
		if (c.intro_first <= 0) c.intro_first = TETRIS_DEFAULTS.intro_first;
		if (c.sat <= 0) c.sat = TETRIS_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = TETRIS_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = TETRIS_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.ghost < 0) c.ghost = 0;
		if (c.ghost > 0.6) c.ghost = 0.6;
		if (c.lull_p < 0) c.lull_p = 0;
		if (c.lull_dur <= 0) c.lull_dur = TETRIS_DEFAULTS.lull_dur;
		if (c.fill_thresh <= 0) c.fill_thresh = TETRIS_DEFAULTS.fill_thresh;
		if (c.fill_thresh > 1) c.fill_thresh = 1;
		return c;
	}

	function tetrisSeqUint32(stateRef) {
		// Math.imul produces 32-bit signed multiplication, matching Go's
		// uint32 multiply when interpreted bitwise. >>> 0 keeps everything
		// in the unsigned-32 range.
		stateRef.s = (stateRef.s + 0x6D2B79F5) >>> 0;
		let z = stateRef.s;
		z = Math.imul(z ^ (z >>> 15), z | 1);
		z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
		return (z ^ (z >>> 14)) >>> 0;
	}

	function tetrisShapeExtent(kind, rot) {
		const piece = TETRIS_PIECES[kind];
		if (!piece || rot < 0 || rot >= piece.rotations.length) return [0, 0];
		let w = 0, h = 0;
		for (const [r, c] of piece.rotations[rot]) {
			if (c + 1 > w) w = c + 1;
			if (r + 1 > h) h = r + 1;
		}
		return [w, h];
	}

	function tetrisPieceHueBase(cfg, kind) {
		const piece = TETRIS_PIECES[kind];
		if (!piece) return cfg.hue;
		let h = cfg.hue + piece.hue;
		while (h < 0) h += 360;
		while (h >= 360) h -= 360;
		return h;
	}

	class Tetris {
		constructor(w, h, cfg, seed) {
			this.kind = 'tetris';
			this.w = w;
			this.h = h;
			this.cfg = applyTetrisDefaults(cfg);
			this.seed = Number(seed || Date.now());
			this.rng = makeRNG(this.seed);
			this.boardW = this.cfg.board_w;
			this.boardH = this.cfg.board_h;
			this.cells = new Uint8Array(this.boardW * this.boardH);
			this.hues = new Float32Array(this.boardW * this.boardH);
			this.tick = 0;
			this.fallTimer = 0;
			this.spawnPause = this.cfg.intro_first;
			this.lullPause = 0;
			this.pieceIndex = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.seqState = { s: (this.seed >>> 0) || 0x9e3779b9 };
			this.active = null;
			this.nextKind = 1 + (tetrisSeqUint32(this.seqState) % 7);
		}

		setConfig(cfg) {
			const next = applyTetrisDefaults(Object.assign({}, this.cfg, cfg));
			if (next.board_w !== this.boardW || next.board_h !== this.boardH) {
				this.boardW = next.board_w;
				this.boardH = next.board_h;
				this.cells = new Uint8Array(this.boardW * this.boardH);
				this.hues = new Float32Array(this.boardW * this.boardH);
				this.active = null;
				this.fallTimer = 0;
				this.spawnPause = next.intro_first;
			}
			this.cfg = next;
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || 0;
			if (state.boardW > 0 && state.boardH > 0) {
				this.boardW = state.boardW;
				this.boardH = state.boardH;
			}
			const total = this.boardW * this.boardH;
			this.cells = new Uint8Array(total);
			this.hues = new Float32Array(total);
			if (state.cells) {
				if (typeof state.cells === 'string') {
					// Go encoding/json marshals []byte as a base64 string.
					const bin = atob(state.cells);
					const n = Math.min(total, bin.length);
					for (let i = 0; i < n; i++) this.cells[i] = bin.charCodeAt(i) & 0xff;
				} else if (state.cells.length === total) {
					for (let i = 0; i < total; i++) this.cells[i] = state.cells[i] | 0;
				}
			}
			if (Array.isArray(state.hues) && state.hues.length === total) {
				for (let i = 0; i < total; i++) this.hues[i] = +state.hues[i];
			}
			this.active = state.active ? Object.assign({}, state.active) : null;
			this.nextKind = state.nextKind || (1 + (tetrisSeqUint32(this.seqState) % 7));
			this.fallTimer = state.fallTimer || 0;
			this.spawnPause = state.spawnPause || 0;
			this.lullPause = state.lullPause || 0;
			this.pieceIndex = state.pieceIndex || 0;
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			if (typeof snap.seed === 'number') {
				this.seed = snap.seed;
				this.rng = makeRNG(snap.seed);
			}
			if (typeof state.rngState === 'number' && state.rngState !== 0) {
				this.seqState.s = state.rngState >>> 0;
			}
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		triggerEvent(name) {
			switch (name) {
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
				case 'new-piece':
					this.spawnPause = 0;
					this.lullPause = 0;
					this._spawnNext();
					return true;
				case 'lull':
					this.lullPause = this.cfg.lull_dur;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.endingTicks > 0) {
				this.endingTicks--;
				if (this.endingTicks === 0) this._startIntro();
				return;
			}
			if (this.introTicks > 0) this.introTicks--;
			if (!this.active) {
				if (this.lullPause > 0) { this.lullPause--; return; }
				if (this.spawnPause > 0) { this.spawnPause--; return; }
				if (!this._spawnNext()) this._startEnding();
				return;
			}
			if (this.active.locking) {
				this.active.lockTick++;
				if (this.active.lockTick < this.cfg.lock_delay) return;
				this._lockActive();
				this.fallTimer = 0;
				this.spawnPause = this.cfg.spawn_pause;
				if (this.cfg.lull_p > 0 && this.rng() < this.cfg.lull_p) {
					this.lullPause = this.cfg.lull_dur;
				}
				if (this._fillRatio() >= this.cfg.fill_thresh) this._startEnding();
				return;
			}
			this.fallTimer++;
			if (this.fallTimer < this.cfg.fall_every) return;
			this.fallTimer = 0;
			if (this._canPlace(this.active.kind, this.active.rot, this.active.row + 1, this.active.col)) {
				this.active.row++;
				return;
			}
			this.active.locking = true;
			this.active.lockTick = 0;
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const margin = 16;
			const availW = Math.max(40, canvasW - margin * 2);
			const availH = Math.max(40, canvasH - margin * 2);
			const cellSize = Math.floor(Math.min(availW / this.boardW, availH / this.boardH));
			if (cellSize <= 0) return;
			const totalW = cellSize * this.boardW;
			const totalH = cellSize * this.boardH;
			const ox = Math.floor((canvasW - totalW) / 2);
			const oy = Math.floor((canvasH - totalH) / 2);
			// Well outline
			ctx.strokeStyle = 'rgba(255,255,255,0.08)';
			ctx.lineWidth = 1;
			ctx.strokeRect(ox - 0.5, oy - 0.5, totalW + 1, totalH + 1);
			// Settled cells
			for (let r = 0; r < this.boardH; r++) {
				for (let c = 0; c < this.boardW; c++) {
					const i = r * this.boardW + c;
					const kind = this.cells[i];
					if (!kind) continue;
					this._fillCell(ctx, ox + c * cellSize, oy + r * cellSize, cellSize,
						this.hues[i] || tetrisPieceHueBase(this.cfg, kind), 1);
				}
			}
			// Ghost (resting target) for the active piece
			if (this.active && this.cfg.ghost > 0) {
				const ghostRow = this._dropRow(this.active.kind, this.active.rot, this.active.row, this.active.col);
				const piece = TETRIS_PIECES[this.active.kind];
				if (piece && ghostRow > this.active.row) {
					for (const [dr, dc] of piece.rotations[this.active.rot]) {
						const r = ghostRow + dr;
						const c = this.active.col + dc;
						if (r < 0 || r >= this.boardH || c < 0 || c >= this.boardW) continue;
						this._fillCell(ctx, ox + c * cellSize, oy + r * cellSize, cellSize,
							this.active.hue || tetrisPieceHueBase(this.cfg, this.active.kind), this.cfg.ghost);
					}
				}
			}
			// Active piece
			if (this.active) {
				const piece = TETRIS_PIECES[this.active.kind];
				if (piece) {
					for (const [dr, dc] of piece.rotations[this.active.rot]) {
						const r = this.active.row + dr;
						const c = this.active.col + dc;
						if (r < 0 || r >= this.boardH || c < 0 || c >= this.boardW) continue;
						this._fillCell(ctx, ox + c * cellSize, oy + r * cellSize, cellSize,
							this.active.hue || tetrisPieceHueBase(this.cfg, this.active.kind), 1);
					}
				}
			}
			// Ending fade overlay
			if (this.endingTicks > 0 && this.endingTotal > 0) {
				const fadeStart = this.endingTotal - this.endingFade;
				let alpha = 0;
				if (this.endingTicks <= this.endingFade && this.endingFade > 0) {
					alpha = 0.5 * (1 - this.endingTicks / this.endingFade);
				} else if (this.endingTicks > this.endingFade) {
					// linger phase
					alpha = 0;
				}
				if (alpha > 0) {
					ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
					ctx.fillRect(ox, oy, totalW, totalH);
				}
			}
		}

		_fillCell(ctx, x, y, size, hue, alpha) {
			const baseLight = (this.cfg.lmin + this.cfg.lmax) * 0.5;
			const inner = hslToRGB(hue, this.cfg.sat, baseLight);
			const edge = hslToRGB(hue, this.cfg.sat, Math.max(0.08, this.cfg.lmin * 0.6));
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillStyle = `rgb(${edge.r},${edge.g},${edge.b})`;
			ctx.fillRect(x, y, size, size);
			const inset = Math.max(1, Math.floor(size * 0.18));
			ctx.fillStyle = `rgb(${inner.r},${inner.g},${inner.b})`;
			ctx.fillRect(x + inset, y + inset, Math.max(1, size - inset * 2), Math.max(1, size - inset * 2));
			ctx.globalAlpha = 1;
		}

		_canPlace(kind, rot, row, col) {
			const piece = TETRIS_PIECES[kind];
			if (!piece || rot < 0 || rot >= piece.rotations.length) return false;
			for (const [dr, dc] of piece.rotations[rot]) {
				const r = row + dr;
				const c = col + dc;
				if (r < 0) continue;
				if (r >= this.boardH || c < 0 || c >= this.boardW) return false;
				if (this.cells[r * this.boardW + c] !== 0) return false;
			}
			return true;
		}

		_dropRow(kind, rot, row, col) {
			let r = row;
			while (this._canPlace(kind, rot, r + 1, col)) r++;
			return r;
		}

		_spawnNext() {
			let kind = this.nextKind;
			if (!kind) kind = 1 + (tetrisSeqUint32(this.seqState) % 7);
			this.nextKind = 1 + (tetrisSeqUint32(this.seqState) % 7);
			this.pieceIndex++;
			const piece = TETRIS_PIECES[kind];
			let rot = 0;
			if (piece && piece.rotations.length > 1) {
				rot = tetrisSeqUint32(this.seqState) % piece.rotations.length;
			}
			const [bw] = tetrisShapeExtent(kind, rot);
			const maxCol = Math.max(0, this.boardW - bw);
			let col = 0;
			if (maxCol > 0) col = tetrisSeqUint32(this.seqState) % (maxCol + 1);
			if (!this._canPlace(kind, rot, 0, col)) {
				this.active = null;
				return false;
			}
			this.active = {
				kind: kind,
				rot: rot,
				row: 0,
				col: col,
				hue: tetrisPieceHueBase(this.cfg, kind),
				locking: false,
				lockTick: 0,
			};
			this.fallTimer = 0;
			return true;
		}

		_lockActive() {
			if (!this.active) return;
			const piece = TETRIS_PIECES[this.active.kind];
			if (!piece) { this.active = null; return; }
			for (const [dr, dc] of piece.rotations[this.active.rot]) {
				const r = this.active.row + dr;
				const c = this.active.col + dc;
				if (r < 0 || r >= this.boardH || c < 0 || c >= this.boardW) continue;
				const idx = r * this.boardW + c;
				this.cells[idx] = this.active.kind;
				this.hues[idx] = this.active.hue;
			}
			this.active = null;
		}

		_fillRatio() {
			if (!this.cells.length) return 0;
			let filled = 0;
			for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== 0) filled++;
			return filled / this.cells.length;
		}

		_startIntro() {
			// Clear the board locally; the authoritative debris layout (when
			// intro_h > 0) arrives via the next server snapshot. We don't
			// reproduce it here because the Go and JS RNGs intentionally
			// differ (Splitmix64 vs Mulberry32), so a local fill would drift
			// from the server's state.
			this.cells = new Uint8Array(this.boardW * this.boardH);
			this.hues = new Float32Array(this.boardW * this.boardH);
			this.active = null;
			this.spawnPause = this.cfg.intro_first;
			this.lullPause = 0;
			this.fallTimer = 0;
			this.introTotal = this.cfg.intro_dur > 0 ? this.cfg.intro_dur : TETRIS_DEFAULTS.intro_dur;
			this.introTicks = this.introTotal;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.nextKind = 1 + (tetrisSeqUint32(this.seqState) % 7);
		}

		_startEnding() {
			this.active = null;
			this.spawnPause = 0;
			this.lullPause = 0;
			this.fallTimer = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingFade = this.cfg.ending_dur > 0 ? this.cfg.ending_dur : TETRIS_DEFAULTS.ending_dur;
			const linger = Math.max(0, this.cfg.ending_linger);
			this.endingTotal = Math.max(1, this.endingFade + linger);
			this.endingTicks = this.endingTotal;
		}

	}

	api.presets['tetris'] = [
		{
			key: 'museum-pace',
			label: 'museum pace',
			config: {
				intro_dur: 80,
				intro_h: 0,
				intro_first: 12,
				ending_dur: 100,
				ending_linger: 90,
				board_w: 10,
				board_h: 20,
				fall_every: 22,
				spawn_pause: 36,
				lock_delay: 10,
				hue: 200,
				hue_sp: 4,
				sat: 0.42,
				lmin: 0.36,
				lmax: 0.62,
				ghost: 0.05,
				lull_p: 0.012,
				lull_dur: 140,
				fill_thresh: 0.92,
			},
		},
		{
			key: 'steady-build',
			label: 'steady build',
			config: {
				intro_dur: 60,
				intro_h: 0.05,
				intro_first: 8,
				ending_dur: 80,
				ending_linger: 60,
				board_w: 10,
				board_h: 20,
				fall_every: 14,
				spawn_pause: 18,
				lock_delay: 6,
				hue: 200,
				hue_sp: 0,
				sat: 0.55,
				lmin: 0.4,
				lmax: 0.66,
				ghost: 0,
				lull_p: 0.004,
				lull_dur: 80,
				fill_thresh: 0.85,
			},
		},
		{
			key: 'dense-stack',
			label: 'dense stack',
			config: {
				intro_dur: 50,
				intro_h: 0.25,
				intro_first: 4,
				ending_dur: 60,
				ending_linger: 40,
				board_w: 10,
				board_h: 22,
				fall_every: 10,
				spawn_pause: 8,
				lock_delay: 4,
				hue: 18,
				hue_sp: 8,
				sat: 0.7,
				lmin: 0.42,
				lmax: 0.74,
				ghost: 0.08,
				lull_p: 0.0,
				lull_dur: 60,
				fill_thresh: 0.94,
			},
		},
		{
			key: 'late-game',
			label: 'late game',
			config: {
				intro_dur: 40,
				intro_h: 0.55,
				intro_first: 2,
				ending_dur: 50,
				ending_linger: 30,
				board_w: 10,
				board_h: 20,
				fall_every: 8,
				spawn_pause: 4,
				lock_delay: 3,
				hue: 0,
				hue_sp: 12,
				sat: 0.78,
				lmin: 0.44,
				lmax: 0.78,
				ghost: 0.12,
				lull_p: 0.0,
				lull_dur: 60,
				fill_thresh: 0.98,
			},
		},
	];
	api.effects['tetris'] = Tetris;
})(window.AmbienceSim);
// ===== effects/train.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB } = api._helpers;

	const DEFAULTS = {
		intro_dur: 60,
		intro_glow: 0.4,
		ending_dur: 70,
		ending_linger: 24,
		ending_glow: 0.1,
		horizon: 0.7,
		track_y: 0.78,
		loco_len: 7,
		car_len: 6,
		cars: 3,
		train_height: 5,
		light_glow: 0.45,
		smoke: 0.32,
		cue_lead: 14,
		tail_linger: 12,
		hue: 220,
		hue_sp: 18,
		sat: 0.42,
		lmin: 0.1,
		lmax: 0.78,
		pass_p: 0,
		express_p: 0,
		quiet_p: 0,
		pass_dur: 160,
		express_dur: 110,
		express_speed_mult: 1.7,
		quiet_dur: 240,
		quiet_mult: 0.15,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_glow = clamp01(c.intro_glow);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_glow = clamp01(c.ending_glow);
		if (c.horizon <= 0) c.horizon = DEFAULTS.horizon;
		if (c.track_y <= 0) c.track_y = DEFAULTS.track_y;
		if (c.track_y < c.horizon) c.track_y = c.horizon + 0.04;
		if (c.loco_len <= 0) c.loco_len = DEFAULTS.loco_len;
		if (c.car_len <= 0) c.car_len = DEFAULTS.car_len;
		if (c.cars < 0) c.cars = 0;
		if (c.train_height <= 0) c.train_height = DEFAULTS.train_height;
		if (c.light_glow <= 0) c.light_glow = DEFAULTS.light_glow;
		if (c.smoke < 0) c.smoke = 0;
		if (c.cue_lead < 0) c.cue_lead = 0;
		if (c.tail_linger < 0) c.tail_linger = 0;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.pass_dur <= 0) c.pass_dur = DEFAULTS.pass_dur;
		if (c.express_dur <= 0) c.express_dur = DEFAULTS.express_dur;
		if (c.express_speed_mult <= 0) c.express_speed_mult = DEFAULTS.express_speed_mult;
		if (c.quiet_dur <= 0) c.quiet_dur = DEFAULTS.quiet_dur;
		if (c.quiet_mult < 0) c.quiet_mult = 0;
		return c;
	}

	class Train {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 71);
			switch (name) {
				case 'pass':
					this.timers.pass = jitterInt(rng, this.cfg.pass_dur, 0.18);
					this.timers.express = 0;
					this.values.pass_total = this.timers.pass;
					this.values.pass_dir = rng() < 0.5 ? -1 : 1;
					delete this.values.express_total;
					delete this.values.express_dir;
					return true;
				case 'express':
					this.timers.express = jitterInt(rng, this.cfg.express_dur, 0.18);
					this.timers.pass = 0;
					this.values.express_total = this.timers.express;
					this.values.express_dir = rng() < 0.5 ? -1 : 1;
					delete this.values.pass_total;
					delete this.values.pass_dir;
					return true;
				case 'quiet-gap':
					this.timers['quiet-gap'] = jitterInt(rng, this.cfg.quiet_dur, 0.25);
					return true;
				case 'intro':
					this.timers.pass = 0;
					this.timers.express = 0;
					this.timers['quiet-gap'] = 0;
					this.timers.ending = 0;
					delete this.values.pass_total;
					delete this.values.pass_dir;
					delete this.values.express_total;
					delete this.values.express_dir;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.pass = 0;
					this.timers.express = 0;
					this.timers['quiet-gap'] = 0;
					delete this.values.pass_total;
					delete this.values.pass_dir;
					delete this.values.express_total;
					delete this.values.express_dir;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.pass || this.timers.pass <= 0) {
				delete this.values.pass_total;
				delete this.values.pass_dir;
			}
			if (!this.timers.express || this.timers.express <= 0) {
				delete this.values.express_total;
				delete this.values.express_dir;
			}
		}

		// Returns { kind, dir, total, left, lifecycle } when a train is in
		// flight, or null when the frame is empty. lifecycle is the elapsed
		// fraction across the entire pass timer (0 = just triggered, 1 = about
		// to clear).
		_activePass() {
			if (this.timers.express > 0) {
				const total = this.values.express_total || this.cfg.express_dur;
				return { kind: 'express', dir: this.values.express_dir || 1, total, left: this.timers.express };
			}
			if (this.timers.pass > 0) {
				const total = this.values.pass_total || this.cfg.pass_dur;
				return { kind: 'pass', dir: this.values.pass_dir || 1, total, left: this.timers.pass };
			}
			return null;
		}

		// Compute how much the lifecycle phases (intro/ending) attenuate the
		// scene. Returned value is a 0..1 multiplier: 1 = full presence.
		_lifecycleLevel() {
			let level = 1;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_glow + (1 - this.cfg.intro_glow) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_glow) * progress;
			}
			return Math.max(0.04, level);
		}

		_trainGeometry() {
			const cars = Math.max(0, Math.round(this.cfg.cars));
			const locoLen = Math.max(3, Math.round(this.cfg.loco_len));
			const carLen = Math.max(2, Math.round(this.cfg.car_len));
			const gap = 1;
			const total = locoLen + cars * (carLen + gap);
			return { cars, locoLen, carLen, gap, total };
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			const cfg = this.cfg;
			const lifecycle = this._lifecycleLevel();

			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const skyTop = hslToRGB((cfg.hue + 6) % 360, clamp01(cfg.sat * 0.5), clamp01(cfg.lmin * 0.95));
				const skyMid = hslToRGB(cfg.hue, cfg.sat, clamp01(cfg.lmin + (cfg.lmax - cfg.lmin) * 0.32));
				const skyLow = hslToRGB((cfg.hue - cfg.hue_sp * 0.5 + 360) % 360, clamp01(cfg.sat * 0.78), clamp01(cfg.lmin + (cfg.lmax - cfg.lmin) * 0.6));
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, `rgb(${skyTop.r},${skyTop.g},${skyTop.b})`);
				sky.addColorStop(0.62, `rgb(${skyMid.r},${skyMid.g},${skyMid.b})`);
				sky.addColorStop(1, `rgb(${skyLow.r},${skyLow.g},${skyLow.b})`);
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const horizon = Math.max(6, Math.min(this.h - 8, Math.floor(this.h * cfg.horizon)));
			const trackY = Math.max(horizon + 2, Math.min(this.h - 4, Math.floor(this.h * cfg.track_y)));

			// Distant ridgeline a few rows above the rail line. Slow, fixed
			// silhouette so the scene reads as "long quiet stretch of land"
			// when no train is in flight.
			const ridgeColor = hslToRGB((cfg.hue + 12) % 360, clamp01(cfg.sat * 0.32), clamp01(cfg.lmin * 0.7 + 0.02));
			const ridgeRows = new Array(this.w);
			for (let x = 0; x < this.w; x++) {
				const wave = Math.sin(x * 0.07 + this._hash(101) * 6.28) * 1.6 +
					Math.sin(x * 0.024 + 2.1) * 2.6 +
					Math.sin(x * 0.012 + 4.7) * 1.1;
				ridgeRows[x] = Math.round(horizon - 1 - Math.abs(wave) * 0.7);
			}
			ctx.fillStyle = `rgb(${ridgeColor.r},${ridgeColor.g},${ridgeColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, Math.floor(horizon * sy));
			for (let x = 0; x < this.w; x++) {
				ctx.lineTo(Math.floor(x * sx), Math.floor(ridgeRows[x] * sy));
			}
			ctx.lineTo(canvasW, Math.floor(horizon * sy));
			ctx.closePath();
			ctx.fill();

			// Foreground ground from horizon downward — solid fill with gentle
			// dust shading near the track line.
			const groundTop = hslToRGB((cfg.hue + cfg.hue_sp + 360) % 360, clamp01(cfg.sat * 0.36), clamp01(cfg.lmin + 0.04));
			const groundLow = hslToRGB((cfg.hue + cfg.hue_sp * 1.4 + 360) % 360, clamp01(cfg.sat * 0.28), clamp01(cfg.lmin * 0.85));
			const ground = ctx.createLinearGradient(0, Math.floor(horizon * sy), 0, canvasH);
			ground.addColorStop(0, `rgb(${groundTop.r},${groundTop.g},${groundTop.b})`);
			ground.addColorStop(1, `rgb(${groundLow.r},${groundLow.g},${groundLow.b})`);
			ctx.fillStyle = ground;
			ctx.fillRect(0, Math.floor(horizon * sy), canvasW, canvasH - Math.floor(horizon * sy));

			// Sleeper ties: short dark dashes on the rail line. Static between
			// passes, period locked to grid so the scene reads as still.
			const tieColor = hslToRGB((cfg.hue + 20) % 360, clamp01(cfg.sat * 0.18), clamp01(cfg.lmin * 0.6));
			for (let x = 0; x < this.w; x += 4) {
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, trackY + 1, 2, 1, `rgb(${tieColor.r},${tieColor.g},${tieColor.b})`, 0.65);
			}

			// Twin rails — a single bright cell wide.
			const railColor = hslToRGB(cfg.hue, clamp01(cfg.sat * 0.22), clamp01(cfg.lmax * 0.78));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, trackY, this.w, 1, `rgb(${railColor.r},${railColor.g},${railColor.b})`, 0.78);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, trackY + 2, this.w, 1, `rgb(${railColor.r},${railColor.g},${railColor.b})`, 0.5);

			const pass = this._activePass();
			if (pass) {
				this._renderPass(ctx, sx, sy, ceilSx, ceilSy, trackY, pass, lifecycle);
			} else if (this.timers.ending > 0) {
				// Lingering ending halo after the last train cleared.
				this._renderEndingGlow(ctx, sx, sy, ceilSx, ceilSy, trackY, lifecycle);
			}

			// Subtle low-haze near the track for depth.
			const haze = ctx.createLinearGradient(0, Math.floor((trackY - 2) * sy), 0, Math.floor((trackY + 6) * sy));
			haze.addColorStop(0, 'rgba(0,0,0,0)');
			haze.addColorStop(0.4, `rgba(0,0,0,${0.06 + (1 - lifecycle) * 0.04})`);
			haze.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = haze;
			ctx.fillRect(0, Math.floor((trackY - 2) * sy), canvasW, Math.ceil(8 * sy));
		}

		_renderPass(ctx, sx, sy, ceilSx, ceilSy, trackY, pass, lifecycle) {
			const cfg = this.cfg;
			const elapsed = pass.total - pass.left;
			const cueLead = Math.max(0, Math.round(cfg.cue_lead));
			const tailLinger = Math.max(0, Math.round(cfg.tail_linger));
			const movement = Math.max(1, pass.total - cueLead - tailLinger);
			const geom = this._trainGeometry();
			const dir = pass.dir >= 0 ? 1 : -1;
			const isExpress = pass.kind === 'express';
			const intensity = lifecycle * (isExpress ? cfg.express_speed_mult : 1);
			// Span the train so its leading edge starts just off-screen on the
			// entry side and exits just past the far edge.
			let mvProgress = -1;
			if (elapsed >= cueLead && elapsed < cueLead + movement) {
				mvProgress = (elapsed - cueLead) / movement;
			}

			// Headlight cue: distant glow at the entry edge before the loco
			// arrives, plus a halo riding the engine while it's in frame.
			const cueProgress = clamp01(elapsed / Math.max(1, cueLead || 1));
			if (elapsed < cueLead) {
				this._renderCueGlow(ctx, sx, sy, trackY, dir, cueProgress, intensity, isExpress);
				return;
			}
			if (mvProgress < 0) {
				// Tail linger phase — train has fully exited; draw residual
				// dust / steam puff drifting where it left.
				const tailProgress = clamp01((elapsed - cueLead - movement) / Math.max(1, tailLinger || 1));
				this._renderTailLinger(ctx, sx, sy, ceilSx, ceilSy, trackY, dir, tailProgress, intensity, isExpress);
				return;
			}

			const span = this.w + geom.total + 4;
			const travel = -geom.total - 2 + span * mvProgress;
			const headX = dir > 0 ? travel : (this.w - 1 - travel);
			this._renderTrain(ctx, sx, sy, ceilSx, ceilSy, trackY, headX, dir, geom, intensity, isExpress);
		}

		_renderCueGlow(ctx, sx, sy, trackY, dir, progress, intensity, isExpress) {
			const cfg = this.cfg;
			const baseAlpha = clamp01((cfg.intro_glow + (1 - cfg.intro_glow) * progress) * cfg.light_glow * intensity * (isExpress ? 1.25 : 1));
			const edgeX = dir > 0 ? -2 : this.w + 2;
			const cx = (dir > 0 ? edgeX + 6 + progress * 4 : edgeX - 6 - progress * 4) * sx;
			const cy = (trackY - 1) * sy;
			const radius = Math.max(8, sx * 14);
			const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
			grad.addColorStop(0, `rgba(255, 230, 170, ${0.3 * baseAlpha})`);
			grad.addColorStop(0.45, `rgba(255, 200, 130, ${0.16 * baseAlpha})`);
			grad.addColorStop(1, 'rgba(255, 200, 130, 0)');
			ctx.fillStyle = grad;
			ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
		}

		_renderTailLinger(ctx, sx, sy, ceilSx, ceilSy, trackY, dir, progress, intensity, isExpress) {
			const cfg = this.cfg;
			const fade = (1 - progress) * intensity * (isExpress ? 1.2 : 0.9);
			if (fade <= 0.04) return;
			const exitX = dir > 0 ? this.w - 4 : 3;
			const dustColor = hslToRGB((cfg.hue + cfg.hue_sp + 360) % 360, clamp01(cfg.sat * 0.32), clamp01(cfg.lmax * 0.7));
			for (let i = 0; i < 5; i++) {
				const drift = Math.sin(this.tick * 0.18 + i * 1.1) * 1.1;
				const x = exitX - dir * (i * 1.6 + progress * 5);
				const y = trackY - 1 - i * 1.2 + drift;
				const alpha = clamp01((0.18 + cfg.smoke * 0.22) * fade * (1 - i / 6));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(x), Math.round(y), 1, 1, `rgb(${dustColor.r},${dustColor.g},${dustColor.b})`, alpha);
			}
		}

		_renderEndingGlow(ctx, sx, sy, ceilSx, ceilSy, trackY, lifecycle) {
			const cfg = this.cfg;
			const alpha = clamp01(lifecycle * cfg.ending_glow * 0.6);
			if (alpha <= 0.02) return;
			const haloColor = hslToRGB(36, 0.4, clamp01(cfg.lmax * 0.85));
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.floor(this.w * 0.5) - 4, trackY - 1, 8, 1, `rgb(${haloColor.r},${haloColor.g},${haloColor.b})`, alpha * 0.55);
		}

		_renderTrain(ctx, sx, sy, ceilSx, ceilSy, trackY, headX, dir, geom, intensity, isExpress) {
			const cfg = this.cfg;
			const trainHeight = Math.max(2, Math.round(cfg.train_height));
			const baseY = trackY - 1;
			const topY = baseY - trainHeight + 1;
			const hullColor = hslToRGB((cfg.hue + 200) % 360, clamp01(cfg.sat * 0.24), clamp01(cfg.lmin + 0.04));
			const cabColor = hslToRGB((cfg.hue + 210) % 360, clamp01(cfg.sat * 0.18), clamp01(cfg.lmin * 0.85));
			const trimColor = hslToRGB(isExpress ? 14 : 28, 0.38, clamp01(cfg.lmax * 0.6));
			const windowColor = hslToRGB(48, 0.7, clamp01(cfg.lmax * 0.95));
			const wheelColor = hslToRGB(0, 0, 0.06);

			// Locomotive: leading edge at headX, extending backward (away from
			// dir of travel) for locoLen cells.
			const locoBackEnd = dir > 0 ? headX - geom.locoLen + 1 : headX + geom.locoLen - 1;
			const locoLeftX = Math.min(headX, locoBackEnd);
			const locoRightX = Math.max(headX, locoBackEnd);

			// Body fill.
			for (let row = 0; row < trainHeight; row++) {
				const y = topY + row;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, locoLeftX, y, geom.locoLen, 1, `rgb(${hullColor.r},${hullColor.g},${hullColor.b})`, 0.96);
			}
			// Cab silhouette — taller back portion.
			const cabLen = Math.max(2, Math.round(geom.locoLen * 0.45));
			const cabX = dir > 0 ? locoLeftX : locoRightX - cabLen + 1;
			for (let row = 0; row < trainHeight; row++) {
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, cabX, topY + row, cabLen, 1, `rgb(${cabColor.r},${cabColor.g},${cabColor.b})`, 0.95);
			}
			// Cab window.
			if (trainHeight >= 3) {
				const winY = topY + 1;
				const winX = cabX + (dir > 0 ? Math.max(0, cabLen - 2) : 1);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, winX, winY, 1, 1, `rgb(${windowColor.r},${windowColor.g},${windowColor.b})`, 0.9 * intensity);
			}
			// Stripe along the body.
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, locoLeftX, baseY - 1, geom.locoLen, 1, `rgb(${trimColor.r},${trimColor.g},${trimColor.b})`, 0.7);
			// Smokestack near front.
			const stackX = dir > 0 ? locoRightX - 1 : locoLeftX + 1;
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, stackX, topY - 1, 1, 1, `rgb(${cabColor.r},${cabColor.g},${cabColor.b})`, 0.95);
			// Cowcatcher — slim wedge at the leading nose.
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, headX, baseY, 1, 1, `rgb(${trimColor.r},${trimColor.g},${trimColor.b})`, 0.85);
			// Wheels.
			for (let i = 0; i < geom.locoLen; i += 2) {
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, locoLeftX + i, baseY + 1, 1, 1, `rgb(${wheelColor.r},${wheelColor.g},${wheelColor.b})`, 0.85);
			}

			// Headlight + halo.
			const headlightX = headX;
			const headlightY = topY + Math.max(0, Math.floor(trainHeight * 0.55));
			const lightColor = hslToRGB(54, 0.78, 0.72);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, headlightX, headlightY, 1, 1, `rgb(${lightColor.r},${lightColor.g},${lightColor.b})`, clamp01(0.9 * intensity));
			const haloX = (headlightX + (dir > 0 ? 0.5 : 0.5)) * sx;
			const haloY = (headlightY + 0.5) * sy;
			const haloR = Math.max(10, sx * (10 + (isExpress ? 4 : 0)));
			const halo = ctx.createRadialGradient(haloX, haloY, 0, haloX, haloY, haloR);
			const haloAlpha = clamp01(cfg.light_glow * intensity * (isExpress ? 1.35 : 1));
			halo.addColorStop(0, `rgba(255, 232, 170, ${0.5 * haloAlpha})`);
			halo.addColorStop(0.5, `rgba(255, 210, 130, ${0.18 * haloAlpha})`);
			halo.addColorStop(1, 'rgba(255, 210, 130, 0)');
			ctx.fillStyle = halo;
			ctx.fillRect(haloX - haloR, haloY - haloR, haloR * 2, haloR * 2);

			// Smoke / steam plume drifting back from the stack.
			const smokeStrength = clamp01(cfg.smoke * intensity * (isExpress ? 1.25 : 1));
			if (smokeStrength > 0.02) {
				const smokeColor = hslToRGB(0, 0, 0.74);
				for (let i = 0; i < 6; i++) {
					const drift = Math.sin(this.tick * 0.19 + i * 0.6) * 0.7;
					const sx2 = stackX - dir * (i * 1.4 + 0.5);
					const sy2 = topY - 1 - i * 0.9 + drift;
					const alpha = clamp01(smokeStrength * (1 - i / 7) * 0.55);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(sx2), Math.round(sy2), 1, 1, `rgb(${smokeColor.r},${smokeColor.g},${smokeColor.b})`, alpha);
				}
			}

			// Trailing cars.
			const carHeight = Math.max(2, trainHeight - 1);
			for (let i = 0; i < geom.cars; i++) {
				const offset = geom.locoLen + geom.gap + i * (geom.carLen + geom.gap);
				const carRightAnchor = dir > 0 ? locoLeftX - geom.gap - i * (geom.carLen + geom.gap) : locoRightX + geom.gap + i * (geom.carLen + geom.gap);
				const carLeftX = dir > 0 ? carRightAnchor - geom.carLen + 1 : carRightAnchor;
				const carTopY = baseY - carHeight + 1;
				const carColor = i % 2 === 0 ?
					hslToRGB((cfg.hue + 196) % 360, clamp01(cfg.sat * 0.2), clamp01(cfg.lmin + 0.06)) :
					hslToRGB((cfg.hue + 188) % 360, clamp01(cfg.sat * 0.22), clamp01(cfg.lmin + 0.08));
				for (let row = 0; row < carHeight; row++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, carLeftX, carTopY + row, geom.carLen, 1, `rgb(${carColor.r},${carColor.g},${carColor.b})`, 0.95);
				}
				// Stripe.
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, carLeftX, baseY - 1, geom.carLen, 1, `rgb(${trimColor.r},${trimColor.g},${trimColor.b})`, 0.55);
				// Windows: every other cell on the upper row.
				if (carHeight >= 2) {
					for (let wx = 1; wx < geom.carLen - 1; wx += 2) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, carLeftX + wx, carTopY + Math.max(0, Math.floor(carHeight * 0.25)), 1, 1, `rgb(${windowColor.r},${windowColor.g},${windowColor.b})`, 0.7 * intensity);
					}
				}
				// Wheels.
				for (let wx = 0; wx < geom.carLen; wx += 2) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, carLeftX + wx, baseY + 1, 1, 1, `rgb(${wheelColor.r},${wheelColor.g},${wheelColor.b})`, 0.85);
				}
				// Coupling bar.
				const couplingX = dir > 0 ? carLeftX + geom.carLen : carLeftX - 1;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, couplingX, baseY, 1, 1, `rgb(${wheelColor.r},${wheelColor.g},${wheelColor.b})`, 0.7);
				void offset;
			}

			// Subtle ground glow under the headlight to sell brightness.
			const underGlow = ctx.createRadialGradient(haloX, (baseY + 2) * sy, 0, haloX, (baseY + 2) * sy, sx * 6);
			underGlow.addColorStop(0, `rgba(255, 220, 160, ${0.18 * haloAlpha})`);
			underGlow.addColorStop(1, 'rgba(255, 220, 160, 0)');
			ctx.fillStyle = underGlow;
			ctx.fillRect(haloX - sx * 6, (baseY + 2) * sy - sx * 6, sx * 12, sx * 12);
		}
	}

	api.presets['train'] = [
		{
			key: 'distant-freight',
			label: 'distant freight',
			config: {
				horizon: 0.7,
				track_y: 0.8,
				loco_len: 8,
				car_len: 6,
				cars: 4,
				train_height: 5,
				light_glow: 0.42,
				smoke: 0.5,
				cue_lead: 18,
				tail_linger: 18,
				hue: 220,
				hue_sp: 16,
				sat: 0.32,
				lmin: 0.12,
				lmax: 0.68,
				pass_p: 0.0008,
				express_p: 0.0,
				quiet_p: 0.0014,
				pass_dur: 220,
				quiet_dur: 360,
				quiet_mult: 0.1,
			},
		},
		{
			key: 'night-local',
			label: 'night local',
			config: {
				horizon: 0.66,
				track_y: 0.78,
				loco_len: 6,
				car_len: 5,
				cars: 2,
				train_height: 4.5,
				light_glow: 0.7,
				smoke: 0.18,
				cue_lead: 22,
				tail_linger: 14,
				hue: 230,
				hue_sp: 22,
				sat: 0.46,
				lmin: 0.08,
				lmax: 0.74,
				pass_p: 0.0011,
				express_p: 0.0,
				quiet_p: 0.0011,
				pass_dur: 180,
				quiet_dur: 280,
				quiet_mult: 0.18,
			},
		},
		{
			key: 'steady-passing',
			label: 'steady passing',
			config: {
				horizon: 0.7,
				track_y: 0.78,
				loco_len: 7,
				car_len: 6,
				cars: 3,
				train_height: 5,
				light_glow: 0.45,
				smoke: 0.3,
				cue_lead: 14,
				tail_linger: 12,
				hue: 218,
				hue_sp: 18,
				sat: 0.42,
				lmin: 0.1,
				lmax: 0.78,
				pass_p: 0.0018,
				express_p: 0.0,
				quiet_p: 0.0006,
				pass_dur: 160,
				quiet_dur: 200,
				quiet_mult: 0.2,
			},
		},
		{
			key: 'express-line',
			label: 'express line',
			config: {
				horizon: 0.68,
				track_y: 0.76,
				loco_len: 7,
				car_len: 7,
				cars: 4,
				train_height: 5,
				light_glow: 0.7,
				smoke: 0.18,
				cue_lead: 10,
				tail_linger: 10,
				hue: 212,
				hue_sp: 22,
				sat: 0.5,
				lmin: 0.1,
				lmax: 0.84,
				pass_p: 0.0006,
				express_p: 0.0014,
				quiet_p: 0.0007,
				pass_dur: 150,
				express_dur: 100,
				express_speed_mult: 1.85,
				quiet_dur: 220,
				quiet_mult: 0.25,
			},
		},
	];
	api.effects['train'] = Train;
})(window.AmbienceSim);
// ===== effects/underwater.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 55,
		intro_reveal: 0.14,
		ending_dur: 70,
		ending_linger: 22,
		ending_murk: 0.08,
		density: 0.28,
		rise_speed: 0.42,
		drift: 0.1,
		sway: 0.54,
		weed_height: 20,
		weed_count: 11,
		caustics: 0.3,
		depth: 0.56,
		hue: 192,
		hue_sp: 18,
		sat: 0.42,
		lmin: 0.12,
		lmax: 0.82,
		bubble_burst_p: 0,
		current_shift_p: 0,
		calm_p: 0,
		bubble_burst_dur: 38,
		bubble_burst_mult: 1.9,
		current_shift_dur: 62,
		current_shift_push: 1.2,
		calm_dur: 74,
		calm_mult: 0.55,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_reveal = clamp01(c.intro_reveal);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_murk = clamp01(c.ending_murk);
		if (c.density <= 0) c.density = DEFAULTS.density;
		if (c.rise_speed <= 0) c.rise_speed = DEFAULTS.rise_speed;
		if (c.sway <= 0) c.sway = DEFAULTS.sway;
		if (c.weed_height <= 0) c.weed_height = DEFAULTS.weed_height;
		if (c.weed_count < 1) c.weed_count = DEFAULTS.weed_count;
		if (c.caustics <= 0) c.caustics = DEFAULTS.caustics;
		if (c.depth <= 0) c.depth = DEFAULTS.depth;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.bubble_burst_dur <= 0) c.bubble_burst_dur = DEFAULTS.bubble_burst_dur;
		if (c.bubble_burst_mult <= 0) c.bubble_burst_mult = DEFAULTS.bubble_burst_mult;
		if (c.current_shift_dur <= 0) c.current_shift_dur = DEFAULTS.current_shift_dur;
		if (c.current_shift_push <= 0) c.current_shift_push = DEFAULTS.current_shift_push;
		if (c.calm_dur <= 0) c.calm_dur = DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DEFAULTS.calm_mult;
		return c;
	}

	class Underwater {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 89);
			switch (name) {
				case 'bubble-burst':
					this.timers['bubble-burst'] = jitterInt(rng, this.cfg.bubble_burst_dur, 0.3);
					this.values.bubble_gain = this.cfg.bubble_burst_mult * (0.8 + rng() * 0.45);
					return true;
				case 'current-shift':
					this.timers['current-shift'] = jitterInt(rng, this.cfg.current_shift_dur, 0.3);
					this.timers.calm = 0;
					this.values.current_push = (rng() < 0.5 ? -1 : 1) * this.cfg.current_shift_push * (0.55 + rng() * 0.55);
					return true;
				case 'calm':
					this.timers.calm = jitterInt(rng, this.cfg.calm_dur, 0.3);
					this.timers['current-shift'] = 0;
					this.values.current_push = 0;
					return true;
				case 'intro':
					this.timers['bubble-burst'] = 0;
					this.timers['current-shift'] = 0;
					this.timers.calm = 0;
					this.timers.ending = 0;
					this.values.bubble_gain = 1;
					this.values.current_push = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers['bubble-burst'] = 0;
					this.timers['current-shift'] = 0;
					this.timers.calm = 0;
					this.values.bubble_gain = 1;
					this.values.current_push = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers['bubble-burst'] || this.timers['bubble-burst'] <= 0) this.values.bubble_gain = 1;
			if (!this.timers['current-shift'] || this.timers['current-shift'] <= 0) this.values.current_push = 0;
		}

		_sceneLevel() {
			let level = 1;
			if (this.timers['bubble-burst'] > 0) level *= this.values.bubble_gain || this.cfg.bubble_burst_mult;
			if (this.timers.calm > 0) level *= this.cfg.calm_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_reveal + (1 - this.cfg.intro_reveal) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_murk) * progress;
			}
			if (this.timers['current-shift'] > 0) {
				level *= 1 + Math.abs(this.values.current_push || this.cfg.current_shift_push) * 0.18;
			}
			return Math.max(0.04, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const top = hslToRGB((this.cfg.hue - 8 + 360) % 360, clamp01(this.cfg.sat * 0.58), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.54));
				const mid = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.82), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.28));
				const deep = hslToRGB((this.cfg.hue + 10) % 360, clamp01(this.cfg.sat * 0.72), clamp01(this.cfg.lmin * (0.72 - this.cfg.depth * 0.18)));
				const water = ctx.createLinearGradient(0, 0, 0, canvasH);
				water.addColorStop(0, `rgb(${top.r},${top.g},${top.b})`);
				water.addColorStop(0.46, `rgb(${mid.r},${mid.g},${mid.b})`);
				water.addColorStop(1, `rgb(${deep.r},${deep.g},${deep.b})`);
				ctx.fillStyle = water;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const level = this._sceneLevel();
			const currentPush = this.timers['current-shift'] > 0 ? (this.values.current_push || this.cfg.current_shift_push) : 0;
			const floorBase = Math.max(Math.floor(this.h * 0.78), Math.min(this.h - 4, Math.floor(this.h * (0.84 + this.cfg.depth * 0.08))));
			const phase = this.tick * this.cfg.rise_speed * 0.04;

			const surfaceGlow = ctx.createRadialGradient(canvasW * 0.32, 0, 0, canvasW * 0.32, 0, Math.max(canvasW, canvasH) * 0.52);
			surfaceGlow.addColorStop(0, `rgba(210, 244, 238, ${clamp01(0.08 + this.cfg.caustics * 0.18 * level)})`);
			surfaceGlow.addColorStop(1, 'rgba(210, 244, 238, 0)');
			ctx.fillStyle = surfaceGlow;
			ctx.fillRect(0, 0, canvasW, canvasH);

			const beamCount = 4;
			for (let i = 0; i < beamCount; i++) {
				const sourceX = canvasW * (0.08 + i * 0.24 + this._hash(30100 + i) * 0.08);
				const spread = canvasW * (0.08 + this._hash(30200 + i) * 0.08);
				const bend = (currentPush * 12 + Math.sin(this.tick * 0.02 + i) * 10) * this.cfg.caustics;
				ctx.fillStyle = `rgba(210, 248, 242, ${clamp01(0.04 + this.cfg.caustics * 0.12 * level)})`;
				ctx.beginPath();
				ctx.moveTo(sourceX - spread * 0.2, 0);
				ctx.lineTo(sourceX + spread * 0.22, 0);
				ctx.lineTo(sourceX + spread + bend, canvasH * 0.7);
				ctx.lineTo(sourceX - spread * 0.65 + bend * 0.45, canvasH * 0.7);
				ctx.closePath();
				ctx.fill();
			}

			const causticColor = hslToRGB((this.cfg.hue - 10 + 360) % 360, clamp01(this.cfg.sat * 0.24), clamp01(this.cfg.lmax * 0.96));
			for (let band = 0; band < 5; band++) {
				const baseY = Math.floor(this.h * (0.16 + band * 0.09));
				for (let x = 0; x < this.w; x++) {
					if ((x + band) % 2 !== 0) continue;
					const wave = Math.sin(x * 0.16 + phase * (1.2 + band * 0.18) + band) + Math.sin(x * 0.07 - phase * 1.4 + band * 1.7);
					const row = baseY + Math.round(wave * this.cfg.caustics * level * 1.3);
					const alpha = clamp01((0.03 + this.cfg.caustics * 0.18 * level) * (0.82 - band * 0.12));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, row, 1, 1, `rgb(${causticColor.r},${causticColor.g},${causticColor.b})`, alpha);
				}
			}

			const particulateColor = hslToRGB((this.cfg.hue + 8) % 360, clamp01(this.cfg.sat * 0.16), clamp01(this.cfg.lmax * 0.8));
			const particulateCount = Math.max(18, Math.round(this.w * 0.14));
			for (let i = 0; i < particulateCount; i++) {
				const col = Math.floor(this._hash(30300 + i) * this.w);
				const row = Math.floor(this._hash(30400 + i) * Math.max(1, floorBase - 6));
				const blink = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(this.tick * 0.018 + i * 0.6), 2);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${particulateColor.r},${particulateColor.g},${particulateColor.b})`, clamp01((0.04 + this.cfg.depth * 0.08) * blink));
			}

			const seabedPoints = [];
			const seabedSegments = 8;
			for (let i = 0; i <= seabedSegments; i++) {
				seabedPoints.push(Math.round(floorBase - Math.abs(Math.sin(i * 0.8 + this._hash(30500 + i) * 2.4)) * 2 - this._hash(30600 + i) * 2));
			}
			const seabedColor = hslToRGB((this.cfg.hue + 36) % 360, clamp01(this.cfg.sat * 0.22), clamp01(this.cfg.lmin * 0.85));
			ctx.fillStyle = `rgb(${seabedColor.r},${seabedColor.g},${seabedColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (let x = 0; x < this.w; x++) {
				const pos = (x / Math.max(1, this.w - 1)) * seabedSegments;
				const idx = Math.min(seabedSegments - 1, Math.floor(pos));
				const frac = pos - idx;
				const eased = frac * frac * (3 - 2 * frac);
				const row = seabedPoints[idx] + (seabedPoints[idx + 1] - seabedPoints[idx]) * eased;
				ctx.lineTo(Math.floor(x * sx), Math.floor(row * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const weedColor = hslToRGB((this.cfg.hue - 36 + 360) % 360, clamp01(this.cfg.sat * 0.6), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.28));
			const weedAccent = hslToRGB((this.cfg.hue - 18 + 360) % 360, clamp01(this.cfg.sat * 0.48), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.4));
			const weedCount = Math.max(4, Math.round(this.cfg.weed_count));
			for (let i = 0; i < weedCount; i++) {
				const baseX = Math.floor((i + 0.35) * this.w / weedCount + (this._hash(30700 + i) - 0.5) * 5);
				const rootY = floorBase - 1 - Math.floor(this._hash(30800 + i) * 3);
				const fronds = 2 + Math.floor(this._hash(30900 + i) * 2);
				for (let f = 0; f < fronds; f++) {
					const height = Math.max(7, Math.round(this.cfg.weed_height * (0.58 + this._hash(31000 + i * 5 + f) * 0.5)));
					const offset = (f - (fronds - 1) / 2) * 1.2;
					const localPhase = this.tick * 0.035 * (0.8 + this._hash(31100 + i * 5 + f) * 0.4) + i * 0.7 + f * 0.4;
					for (let seg = 0; seg < height; seg++) {
						const progress = seg / Math.max(1, height - 1);
						const sway = Math.sin(localPhase + progress * 2.6) * this.cfg.sway * level * (1.1 + Math.abs(currentPush) * 0.55) + currentPush * progress * 1.4;
						const x = Math.round(baseX + offset + sway * progress * 1.2);
						const y = rootY - seg;
						const color = seg < height * 0.28 ? weedColor : weedAccent;
						const alpha = clamp01(0.3 + progress * 0.42);
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, seg < height * 0.25 ? 2 : 1, 1, `rgb(${color.r},${color.g},${color.b})`, alpha);
					}
				}
			}

			const burstGain = this.timers['bubble-burst'] > 0 ? (this.values.bubble_gain || this.cfg.bubble_burst_mult) : 1;
			const bubbleDensity = Math.max(0.04, this.cfg.density * level);
			const bubbleCount = Math.max(12, Math.round(this.w * bubbleDensity * (0.44 + Math.max(0, burstGain - 1) * 0.18)));
			const bubbleColor = hslToRGB((this.cfg.hue - 4 + 360) % 360, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmax * 0.98));
			for (let i = 0; i < bubbleCount; i++) {
				const baseX = this._hash(31200 + i) * this.w;
				const baseY = this._hash(31300 + i) * Math.max(6, floorBase - 6);
				const rise = baseY - this.tick * this.cfg.rise_speed * (0.55 + this._hash(31400 + i) * 0.7);
				const row = 1 + positiveMod(rise, Math.max(1, floorBase - 5));
				const drift = this.cfg.drift * (0.4 + this._hash(31500 + i) * 0.9) + currentPush * 0.05 * (0.45 + this._hash(31600 + i) * 0.55);
				const wobble = Math.sin(this.tick * 0.03 + i * 0.72) * this.cfg.sway * (0.6 + this._hash(31700 + i) * 0.5);
				const col = positiveMod(baseX + this.tick * drift + wobble, this.w);
				const size = this._hash(31800 + i) > 0.82 ? 2 : 1;
				const alpha = clamp01((0.22 + this._hash(31900 + i) * 0.28) * (0.8 + Math.max(0, burstGain - 1) * 0.14));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col), Math.round(row), size, size, `rgb(${bubbleColor.r},${bubbleColor.g},${bubbleColor.b})`, alpha);
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(col), Math.round(row), 1, 1, `rgb(235,248,246)`, clamp01(alpha * 0.62));
			}
		}
	}

	api.presets['underwater'] = [
		{
			key: 'quiet-shallows',
			label: 'quiet shallows',
			config: {
				intro_reveal: 0.18,
				ending_murk: 0.12,
				density: 0.18,
				rise_speed: 0.32,
				drift: 0.04,
				sway: 0.34,
				weed_height: 16,
				weed_count: 9,
				caustics: 0.44,
				depth: 0.28,
				hue: 184,
				hue_sp: 12,
				sat: 0.38,
				lmin: 0.14,
				lmax: 0.86,
				calm_p: 0.0011,
			},
		},
		{
			key: 'bubble-field',
			label: 'bubble field',
			config: {
				density: 0.42,
				rise_speed: 0.54,
				drift: 0.08,
				sway: 0.46,
				weed_height: 18,
				weed_count: 8,
				caustics: 0.26,
				depth: 0.42,
				hue: 190,
				hue_sp: 16,
				sat: 0.42,
				lmin: 0.12,
				lmax: 0.82,
				bubble_burst_p: 0.0012,
			},
		},
		{
			key: 'slow-current',
			label: 'slow current',
			config: {
				density: 0.28,
				rise_speed: 0.4,
				drift: 0.12,
				sway: 0.78,
				weed_height: 22,
				weed_count: 11,
				caustics: 0.3,
				depth: 0.56,
				hue: 192,
				hue_sp: 18,
				sat: 0.42,
				lmin: 0.12,
				lmax: 0.82,
				current_shift_p: 0.0011,
			},
		},
		{
			key: 'deep-water',
			label: 'deep water',
			config: {
				intro_reveal: 0.1,
				ending_murk: 0.16,
				density: 0.16,
				rise_speed: 0.28,
				drift: 0.05,
				sway: 0.26,
				weed_height: 13,
				weed_count: 6,
				caustics: 0.14,
				depth: 0.82,
				hue: 204,
				hue_sp: 10,
				sat: 0.3,
				lmin: 0.08,
				lmax: 0.62,
				calm_p: 0.0014,
				calm_mult: 0.42,
			},
		},
	];
	api.effects['underwater'] = Underwater;
})(window.AmbienceSim);
// ===== effects/volcano.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 55,
		intro_glow: 0.16,
		ending_dur: 70,
		ending_linger: 22,
		ending_glow: 0.10,
		horizon: 0.86,
		cone_height: 28,
		cone_width: 46,
		crater_width: 8,
		slope_jitter: 1.6,
		glow: 0.55,
		smoke: 0.32,
		smoke_height: 18,
		hue: 18,
		hue_sp: 16,
		sat: 0.78,
		lmin: 0.18,
		lmax: 0.92,
		eruption_p: 0,
		smolder_p: 0,
		flare_p: 0,
		eruption_dur: 80,
		eruption_height: 28,
		eruption_mult: 2.4,
		smolder_dur: 80,
		smolder_mult: 0.55,
		flare_dur: 24,
		flare_mult: 1.85,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_glow = clamp01(c.intro_glow);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_glow = clamp01(c.ending_glow);
		if (c.horizon <= 0) c.horizon = DEFAULTS.horizon;
		if (c.cone_height <= 0) c.cone_height = DEFAULTS.cone_height;
		if (c.cone_width <= 0) c.cone_width = DEFAULTS.cone_width;
		if (c.crater_width <= 0) c.crater_width = DEFAULTS.crater_width;
		if (c.slope_jitter < 0) c.slope_jitter = 0;
		if (c.glow <= 0) c.glow = DEFAULTS.glow;
		if (c.smoke < 0) c.smoke = 0;
		if (c.smoke_height <= 0) c.smoke_height = DEFAULTS.smoke_height;
		if (c.hue < 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.eruption_dur <= 0) c.eruption_dur = DEFAULTS.eruption_dur;
		if (c.eruption_height <= 0) c.eruption_height = DEFAULTS.eruption_height;
		if (c.eruption_mult <= 0) c.eruption_mult = DEFAULTS.eruption_mult;
		if (c.smolder_dur <= 0) c.smolder_dur = DEFAULTS.smolder_dur;
		if (c.smolder_mult <= 0) c.smolder_mult = DEFAULTS.smolder_mult;
		if (c.flare_dur <= 0) c.flare_dur = DEFAULTS.flare_dur;
		if (c.flare_mult <= 0) c.flare_mult = DEFAULTS.flare_mult;
		return c;
	}

	class Volcano {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		_paintCraterGlow(ctx, sx, sy, ceilSx, ceilSy, centerX, peakRow, craterHalf, glowStrength) {
			if (glowStrength <= 0.02) return;
			const glowHue = (this.cfg.hue + 4) % 360;
			const core = hslToRGB(glowHue, clamp01(this.cfg.sat * 0.95), clamp01(this.cfg.lmax * (0.7 + glowStrength * 0.25)));
			const outer = hslToRGB((this.cfg.hue + 350) % 360, clamp01(this.cfg.sat), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.45));
			const maxRise = Math.max(5, Math.round(4 + glowStrength * 11));
			const maxSide = Math.max(craterHalf + 3, Math.round(craterHalf + glowStrength * 16));
			const bandH = Math.max(1, Math.round(1 + glowStrength * 1.6));

			for (let band = maxRise; band >= 0; band--) {
				const lift = band / Math.max(1, maxRise);
				const width = Math.max(craterHalf + 1, Math.round(maxSide * (1 - lift * 0.62)));
				const row = peakRow - band;
				const colorMix = 1 - lift;
				const color = colorMix > 0.58 ? core : outer;
				const baseAlpha = clamp01((0.08 + glowStrength * 0.38) * (1 - lift * 0.78));
				for (let dx = -width; dx <= width; dx++) {
					const side = Math.abs(dx) / Math.max(1, width);
					const checker = (dx + band + this.tick) & 1;
					const edgeNoise = this._hash(33400 + band * 31 + dx) * 0.22;
					const alpha = clamp01(baseAlpha * (1 - side * 0.72 + edgeNoise) * (checker ? 0.72 : 1));
					if (alpha < 0.035) continue;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, row, 1, bandH, `rgb(${color.r},${color.g},${color.b})`, alpha);
				}
			}

			const floorRows = Math.max(2, Math.round(2 + glowStrength * 3));
			for (let y = 0; y < floorRows; y++) {
				const width = Math.max(craterHalf + 2, Math.round(maxSide * (0.55 - y * 0.08)));
				const row = peakRow + y;
				const alpha = clamp01((0.12 + glowStrength * 0.3) * (1 - y / Math.max(1, floorRows)));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX - width, row, width * 2 + 1, 1, `rgb(${outer.r},${outer.g},${outer.b})`, alpha);
			}
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 97);
			switch (name) {
				case 'eruption':
					this.timers.eruption = jitterInt(rng, this.cfg.eruption_dur, 0.3);
					this.timers.smolder = 0;
					this.values.eruption_gain = this.cfg.eruption_mult * (0.8 + rng() * 0.45);
					this.values.eruption_seed = rng() * 1024;
					return true;
				case 'smolder':
					this.timers.smolder = jitterInt(rng, this.cfg.smolder_dur, 0.3);
					this.timers.eruption = 0;
					this.values.eruption_gain = 1;
					return true;
				case 'flare':
					this.timers.flare = jitterInt(rng, this.cfg.flare_dur, 0.3);
					this.values.flare_gain = this.cfg.flare_mult * (0.85 + rng() * 0.3);
					return true;
				case 'intro':
					this.timers.eruption = 0;
					this.timers.smolder = 0;
					this.timers.flare = 0;
					this.timers.ending = 0;
					this.values.eruption_gain = 1;
					this.values.flare_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.eruption = 0;
					this.timers.smolder = 0;
					this.timers.flare = 0;
					this.values.eruption_gain = 1;
					this.values.flare_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.eruption || this.timers.eruption <= 0) this.values.eruption_gain = 1;
			if (!this.timers.flare || this.timers.flare <= 0) this.values.flare_gain = 1;
		}

		_pressureLevel() {
			let level = 1;
			if (this.timers.eruption > 0) level *= this.values.eruption_gain || this.cfg.eruption_mult;
			if (this.timers.smolder > 0) level *= this.cfg.smolder_mult;
			if (this.timers.flare > 0) level *= 1 + ((this.values.flare_gain || this.cfg.flare_mult) - 1) * 0.5;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_glow + (1 - this.cfg.intro_glow) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_glow) * progress;
			}
			return Math.max(0.05, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#0a0612');
				sky.addColorStop(0.55, '#15101c');
				sky.addColorStop(1, '#1f1212');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const baseRow = Math.max(8, Math.min(this.h - 4, Math.floor(this.h * this.cfg.horizon)));
			const centerX = Math.floor(this.w * 0.5);
			const pressure = this._pressureLevel();
			const eruptionActive = this.timers.eruption > 0;
			const eruptionGain = this.values.eruption_gain || 1;
			const flareActive = this.timers.flare > 0;
			const flareGain = this.values.flare_gain || 1;
			const eruptionTotal = this.timers.eruption > 0 ? Math.max(1, Math.round(this.cfg.eruption_dur)) : 0;
			const eruptionPhase = eruptionActive
				? this._phaseProgress(Math.max(eruptionTotal, this.timers.eruption), this.timers.eruption)
				: 0;
			const eruptionEnvelope = eruptionActive ? Math.sin(Math.PI * Math.min(1, eruptionPhase * 1.0)) : 0;

			const halfW = Math.max(4, Math.round(this.cfg.cone_width * 0.5));
			const coneH = Math.max(6, Math.round(this.cfg.cone_height));
			const craterHalf = Math.max(2, Math.round(this.cfg.crater_width * 0.5));
			const peakRow = baseRow - coneH;

			// silhouette colors
			const coneColor = hslToRGB((this.cfg.hue + 350) % 360, clamp01(this.cfg.sat * 0.18), clamp01(this.cfg.lmin * 0.55));
			const coneEdge = hslToRGB((this.cfg.hue + 348) % 360, clamp01(this.cfg.sat * 0.24), clamp01(this.cfg.lmin * 0.78));
			const ground = hslToRGB((this.cfg.hue + 352) % 360, clamp01(this.cfg.sat * 0.16), clamp01(this.cfg.lmin * 0.4));

			// distant horizon haze
			const hazeColor = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.6), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.18));
			const hazeStrength = clamp01(0.18 + this.cfg.glow * 0.18 + pressure * 0.08);
			const hazeGrad = ctx.createLinearGradient(0, Math.floor((baseRow - 4) * sy), 0, Math.floor((baseRow + 6) * sy));
			hazeGrad.addColorStop(0, `rgba(${hazeColor.r},${hazeColor.g},${hazeColor.b},0)`);
			hazeGrad.addColorStop(1, `rgba(${hazeColor.r},${hazeColor.g},${hazeColor.b},${hazeStrength})`);
			ctx.fillStyle = hazeGrad;
			ctx.fillRect(0, Math.floor((baseRow - 4) * sy), canvasW, Math.ceil(14 * sy));

			// flat foreground ground past the cone
			for (let y = baseRow; y < this.h; y++) {
				const ratio = (y - baseRow) / Math.max(1, this.h - baseRow);
				const groundShade = hslToRGB((this.cfg.hue + 352) % 360, clamp01(this.cfg.sat * 0.16), clamp01(this.cfg.lmin * (0.4 + ratio * 0.45)));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, 0, y, this.w, 1, `rgb(${groundShade.r},${groundShade.g},${groundShade.b})`, 1);
			}

			// cone silhouette: crater dips into the peak
			for (let dx = -halfW; dx <= halfW; dx++) {
				const nx = Math.abs(dx) / Math.max(1, halfW);
				// slight curvature on the slopes (rounded base, sharper near peak)
				const slope = Math.pow(1 - nx, 1.3);
				const jitter = (this._hash(31000 + dx) * 2 - 1) * this.cfg.slope_jitter;
				let topY = baseRow - Math.round(coneH * slope + jitter);
				// crater notch
				if (Math.abs(dx) < craterHalf) {
					const craterDepth = Math.max(1, Math.round(2 + craterHalf * 0.4 * (1 - Math.abs(dx) / Math.max(1, craterHalf))));
					topY = peakRow + craterDepth;
				}
				if (topY > baseRow) topY = baseRow;
				const col = centerX + dx;
				if (col < 0 || col >= this.w) continue;
				for (let y = topY; y <= baseRow; y++) {
					const isEdge = y === topY || y === topY + 1;
					const color = isEdge ? coneEdge : coneColor;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, y, 1, 1, `rgb(${color.r},${color.g},${color.b})`, 1);
				}
			}

			// idle crater glow + flare bloom
			const glowStrength = clamp01(this.cfg.glow * pressure * (flareActive ? flareGain : 1));
			this._paintCraterGlow(ctx, sx, sy, ceilSx, ceilSy, centerX, peakRow, craterHalf, glowStrength);

			// crater rim hot lining
			for (let dx = -craterHalf; dx <= craterHalf; dx++) {
				const t = 1 - Math.abs(dx) / Math.max(1, craterHalf);
				const lava = hslToRGB((this.cfg.hue + this._hash(31300 + dx) * this.cfg.hue_sp * 0.4) % 360, clamp01(this.cfg.sat), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.4 + t * 0.5 + glowStrength * 0.2)));
				const row = peakRow + Math.max(1, Math.round(2 + craterHalf * 0.4 * t));
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, row, 1, 1, `rgb(${lava.r},${lava.g},${lava.b})`, clamp01(0.35 + t * 0.5 + glowStrength * 0.25));
			}

			// rising smoke plume (idle + thicker during eruption)
			const smokeBase = Math.max(0, this.cfg.smoke);
			const smokeBoost = eruptionActive ? eruptionEnvelope * 0.85 : (flareActive ? 0.18 : 0);
			const smokeStrength = clamp01(smokeBase * (this.timers.smolder > 0 ? this.cfg.smolder_mult : 1) + smokeBoost);
			if (smokeStrength > 0.02) {
				const smokeMaxRise = Math.max(8, Math.round(this.cfg.smoke_height * (1 + smokeBoost * 0.6)));
				const puffCount = Math.max(4, Math.round(8 + smokeStrength * 14));
				for (let i = 0; i < puffCount; i++) {
					const cycle = smokeMaxRise + 6 + Math.floor(this._hash(31600 + i) * 12);
					const progress = positiveMod(this.tick * 0.12 * (0.7 + this._hash(31700 + i) * 0.6) + this._hash(31800 + i) * cycle, cycle);
					if (progress > smokeMaxRise) continue;
					const fade = 1 - progress / Math.max(1, smokeMaxRise);
					const drift = Math.sin(this.tick * 0.04 + i * 0.7) * (1.4 + progress * 0.12) + (this._hash(31900 + i) * 2 - 1) * 1.6;
					const col = Math.round(centerX + drift);
					const row = Math.round(peakRow - 1 - progress);
					if (row < 1) continue;
					const tint = hslToRGB((this.cfg.hue + 12 + this._hash(32000 + i) * this.cfg.hue_sp * 0.4) % 360, clamp01(this.cfg.sat * 0.32), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.36 + fade * 0.34)));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${tint.r},${tint.g},${tint.b})`, clamp01(0.18 + fade * smokeStrength * 0.7));
					if (smokeStrength > 0.4 && (i & 1) === 0) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col + Math.sign(drift || 1), row, 1, 1, `rgb(${tint.r},${tint.g},${tint.b})`, clamp01(0.1 + fade * smokeStrength * 0.4));
					}
				}
			}

			// eruption: ballistic lava sparks arcing out of the crater
			if (eruptionActive) {
				const archHeight = Math.max(6, this.cfg.eruption_height) * (0.65 + eruptionEnvelope * 0.5) * eruptionGain * 0.55;
				const sparkCount = Math.max(8, Math.round(this.cfg.crater_width * 1.6 + archHeight * 0.8));
				const seed = this.values.eruption_seed || 0;
				for (let i = 0; i < sparkCount; i++) {
					const cycle = Math.max(14, Math.round(archHeight * 1.2 + 14));
					const phase = positiveMod(this.tick * 0.4 * (0.7 + this._hash(32200 + i + seed) * 0.6) + this._hash(32300 + i + seed) * cycle, cycle);
					const t = phase / cycle;
					if (t >= 1) continue;
					const angle = (this._hash(32400 + i + seed) * 2 - 1) * Math.PI * 0.42;
					const v0 = archHeight * (0.7 + this._hash(32500 + i + seed) * 0.6);
					const dxStart = Math.sin(angle) * (1.2 + craterHalf * 0.6);
					const yArc = -v0 * Math.sin(Math.PI * t);
					const xArc = dxStart + (this._hash(32600 + i + seed) * 2 - 1) * v0 * 0.18 * t;
					const col = Math.round(centerX + xArc);
					const row = Math.round(peakRow + 1 + yArc);
					if (col < 0 || col >= this.w || row < 0 || row >= this.h) continue;
					const fade = 1 - Math.pow(t, 1.6);
					const hue = ((this.cfg.hue + (this._hash(32700 + i + seed) * 2 - 1) * this.cfg.hue_sp * 0.5) + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.55 + fade * 0.45));
					const lava = hslToRGB(hue, clamp01(this.cfg.sat), light);
					const size = fade > 0.7 ? 2 : 1;
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, size, 1, `rgb(${lava.r},${lava.g},${lava.b})`, clamp01(0.45 + fade * 0.5));
				}

				// short lava streaks running down the cone surface during peak eruption
				const streakCount = Math.max(0, Math.round((eruptionGain - 1) * 4));
				for (let s = 0; s < streakCount; s++) {
					const side = s % 2 === 0 ? -1 : 1;
					const dxStart = side * (craterHalf + 1 + this._hash(32800 + s + seed) * 2);
					const length = Math.max(2, Math.round(coneH * 0.3 * eruptionEnvelope));
					for (let r = 0; r < length; r++) {
						const col = Math.round(centerX + dxStart + side * r * 0.4);
						const row = peakRow + r;
						if (row > baseRow || col < 0 || col >= this.w) break;
						const fade = 1 - r / Math.max(1, length);
						const lava = hslToRGB((this.cfg.hue + 4) % 360, clamp01(this.cfg.sat), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.45 + fade * 0.4)));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, col, row, 1, 1, `rgb(${lava.r},${lava.g},${lava.b})`, clamp01(0.32 + fade * 0.5));
					}
				}
			}
		}
	}

	api.presets['volcano'] = [
		{
			key: 'sleeping-cone',
			label: 'sleeping cone',
			config: {
				intro_glow: 0.1,
				ending_glow: 0.06,
				horizon: 0.86,
				cone_height: 26,
				cone_width: 48,
				crater_width: 7,
				slope_jitter: 1.4,
				glow: 0.3,
				smoke: 0.16,
				smoke_height: 14,
				hue: 16,
				hue_sp: 12,
				sat: 0.6,
				lmin: 0.16,
				lmax: 0.76,
				eruption_p: 0.0001,
				smolder_p: 0.0008,
				flare_p: 0.0006,
			},
		},
		{
			key: 'smoldering-crater',
			label: 'smoldering crater',
			config: {
				horizon: 0.86,
				cone_height: 28,
				cone_width: 46,
				crater_width: 9,
				slope_jitter: 1.6,
				glow: 0.55,
				smoke: 0.42,
				smoke_height: 22,
				hue: 18,
				hue_sp: 18,
				sat: 0.78,
				lmin: 0.18,
				lmax: 0.9,
				eruption_p: 0.0004,
				flare_p: 0.0014,
				smolder_p: 0.0006,
				eruption_height: 22,
				eruption_mult: 2.1,
			},
		},
		{
			key: 'active-vent',
			label: 'active vent',
			config: {
				intro_glow: 0.22,
				horizon: 0.84,
				cone_height: 30,
				cone_width: 48,
				crater_width: 10,
				slope_jitter: 1.8,
				glow: 0.78,
				smoke: 0.48,
				smoke_height: 28,
				hue: 14,
				hue_sp: 22,
				sat: 0.88,
				lmin: 0.22,
				lmax: 0.96,
				eruption_p: 0.0014,
				eruption_dur: 96,
				eruption_height: 32,
				eruption_mult: 2.7,
				flare_p: 0.0018,
				flare_mult: 2.0,
			},
		},
		{
			key: 'ember-burst',
			label: 'ember burst',
			config: {
				intro_glow: 0.18,
				ending_glow: 0.16,
				horizon: 0.88,
				cone_height: 24,
				cone_width: 42,
				crater_width: 12,
				slope_jitter: 1.2,
				glow: 0.7,
				smoke: 0.22,
				smoke_height: 16,
				hue: 22,
				hue_sp: 26,
				sat: 0.9,
				lmin: 0.2,
				lmax: 0.98,
				eruption_p: 0.0022,
				eruption_dur: 60,
				eruption_height: 36,
				eruption_mult: 3.0,
				flare_p: 0.0024,
				flare_mult: 2.2,
				smolder_p: 0.0004,
			},
		},
	];
	api.effects['volcano'] = Volcano;
})(window.AmbienceSim);
// ===== effects/water_pipe.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB } = api._helpers;

	const WATER_PIPE_DEFAULTS = {
		intro_dur: 70,
		intro_drip: 0.12,
		intro_fill: 0.05,
		ending_dur: 70,
		ending_linger: 30,
		ending_residue: 0.18,
		pipe_x: 0.32,
		pipe_y: 0.18,
		pipe_width: 6,
		stream_width: 3,
		basin_y: 0.66,
		basin_span: 0.34,
		basin_depth: 8,
		wall_thick: 1,
		inflow: 1.0,
		drain: 0,
		overflow_speed: 0.55,
		overflow_fade: 0.045,
		splatter_p: 0.42,
		droplet_max: 36,
		ripple_every: 7,
		ripple_max: 8,
		hue: 198,
		hue_sp: 14,
		sat: 0.55,
		lmin: 0.42,
		lmax: 0.84,
		pipe_hue: 28,
		pipe_light: 0.34,
		surge_p: 0,
		dry_p: 0,
		surge_dur: 60,
		surge_mult: 1.8,
		dry_dur: 70,
		dry_mult: 0.25,
	};

	function applyWaterPipeDefaults(cfg) {
		const c = Object.assign({}, WATER_PIPE_DEFAULTS, cfg || {});
		if (c.intro_dur === 0 && c.intro_drip === 0 && c.intro_fill === 0) {
			c.intro_dur = WATER_PIPE_DEFAULTS.intro_dur;
			c.intro_drip = WATER_PIPE_DEFAULTS.intro_drip;
			c.intro_fill = WATER_PIPE_DEFAULTS.intro_fill;
		} else {
			if (c.intro_dur <= 0) c.intro_dur = WATER_PIPE_DEFAULTS.intro_dur;
			if (c.intro_drip <= 0) c.intro_drip = WATER_PIPE_DEFAULTS.intro_drip;
			if (c.intro_fill < 0) c.intro_fill = 0;
		}
		c.intro_drip = clamp01(c.intro_drip);
		c.intro_fill = clamp01(c.intro_fill);
		if (c.ending_dur === 0 && c.ending_linger === 0 && c.ending_residue === 0) {
			c.ending_dur = WATER_PIPE_DEFAULTS.ending_dur;
			c.ending_linger = WATER_PIPE_DEFAULTS.ending_linger;
			c.ending_residue = WATER_PIPE_DEFAULTS.ending_residue;
		} else {
			if (c.ending_dur <= 0) c.ending_dur = WATER_PIPE_DEFAULTS.ending_dur;
			if (c.ending_linger < 0) c.ending_linger = 0;
			if (c.ending_residue < 0) c.ending_residue = 0;
		}
		c.ending_residue = clamp01(c.ending_residue);
		if (c.pipe_x <= 0) c.pipe_x = WATER_PIPE_DEFAULTS.pipe_x;
		c.pipe_x = clamp01(c.pipe_x);
		if (c.pipe_y <= 0) c.pipe_y = WATER_PIPE_DEFAULTS.pipe_y;
		c.pipe_y = clamp01(c.pipe_y);
		if (c.pipe_width <= 0) c.pipe_width = WATER_PIPE_DEFAULTS.pipe_width;
		if (c.stream_width <= 0) c.stream_width = WATER_PIPE_DEFAULTS.stream_width;
		if (c.basin_y <= 0) c.basin_y = WATER_PIPE_DEFAULTS.basin_y;
		c.basin_y = clamp01(c.basin_y);
		if (c.basin_span <= 0) c.basin_span = WATER_PIPE_DEFAULTS.basin_span;
		c.basin_span = clamp01(c.basin_span);
		if (c.basin_depth <= 0) c.basin_depth = WATER_PIPE_DEFAULTS.basin_depth;
		if (c.wall_thick <= 0) c.wall_thick = WATER_PIPE_DEFAULTS.wall_thick;
		if (c.inflow <= 0) c.inflow = WATER_PIPE_DEFAULTS.inflow;
		if (c.drain < 0) c.drain = 0;
		if (c.overflow_speed <= 0) c.overflow_speed = WATER_PIPE_DEFAULTS.overflow_speed;
		if (c.overflow_fade <= 0) c.overflow_fade = WATER_PIPE_DEFAULTS.overflow_fade;
		if (c.splatter_p < 0) c.splatter_p = 0;
		if (c.droplet_max <= 0) c.droplet_max = WATER_PIPE_DEFAULTS.droplet_max;
		if (c.ripple_every <= 0) c.ripple_every = WATER_PIPE_DEFAULTS.ripple_every;
		if (c.ripple_max <= 0) c.ripple_max = WATER_PIPE_DEFAULTS.ripple_max;
		if (c.hue_sp <= 0) c.hue_sp = WATER_PIPE_DEFAULTS.hue_sp;
		if (c.sat <= 0) c.sat = WATER_PIPE_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = WATER_PIPE_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = WATER_PIPE_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.pipe_light <= 0) c.pipe_light = WATER_PIPE_DEFAULTS.pipe_light;
		c.pipe_light = clamp01(c.pipe_light);
		if (c.surge_dur <= 0) c.surge_dur = WATER_PIPE_DEFAULTS.surge_dur;
		if (c.surge_mult <= 0) c.surge_mult = WATER_PIPE_DEFAULTS.surge_mult;
		if (c.dry_dur <= 0) c.dry_dur = WATER_PIPE_DEFAULTS.dry_dur;
		if (c.dry_mult < 0) c.dry_mult = 0;
		return c;
	}

	class WaterPipe {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applyWaterPipeDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.droplets = [];
			this.ripples = [];
			this.runoff = [];
			this.surgeTicks = 0;
			this.dryTicks = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.rippleCooldown = 0;
			this.fill = 0;
		}

		setConfig(cfg) {
			this.cfg = applyWaterPipeDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.surgeTicks = state.surgeTicks || 0;
			this.dryTicks = state.dryTicks || 0;
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			this.rippleCooldown = state.rippleCooldown || 0;
			this.fill = state.fill || 0;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}
			this.droplets = Array.isArray(state.droplets) ? state.droplets.map(d => ({
				row: d.row, col: d.col, vRow: d.vRow, vCol: d.vCol,
				life: d.life, maxLife: d.maxLife, color: d.color,
			})) : [];
			this.ripples = Array.isArray(state.ripples) ? state.ripples.map(r => ({
				col: r.col, radius: r.radius, speed: r.speed,
				life: r.life, maxLife: r.maxLife, strength: r.strength,
			})) : [];
			this.runoff = Array.isArray(state.runoff) ? state.runoff.map(r => ({
				col: r.col, vel: r.vel, life: r.life, maxLife: r.maxLife,
				strength: r.strength, side: r.side,
			})) : [];
		}

		triggerEvent(name) {
			switch (name) {
				case 'surge':
					this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
					return true;
				case 'dry-up':
					this.dryTicks = jitterInt(this.rng, this.cfg.dry_dur, 0.3);
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.surgeTicks > 0) this.surgeTicks--;
			if (this.dryTicks > 0) this.dryTicks--;
			if (this.introTicks > 0) this.introTicks--;
			if (this.endingTicks > 0) this.endingTicks--;
			if (this.rippleCooldown > 0) this.rippleCooldown--;

			if (this.surgeTicks === 0 && this.rng() < this.cfg.surge_p) {
				this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
			}
			if (this.dryTicks === 0 && this.rng() < this.cfg.dry_p) {
				this.dryTicks = jitterInt(this.rng, this.cfg.dry_dur, 0.3);
			}

			this._updateFill();
			this._stepDroplets();
			this._stepRipples();
			this._stepRunoff();
			this._spawnRipple();
			this._spawnRunoff();
			this._spawnSplatter();

			this.grid.fill(0);
			this._paintBasin();
			this._paintPool();
			this._paintStream();
			this._paintImpact();
			this._paintRipples();
			this._paintRunoff();
			this._paintPipe();
			this._paintDroplets();
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		_startIntro() {
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.introTotal = this.cfg.intro_dur > 0 ? this.cfg.intro_dur : WATER_PIPE_DEFAULTS.intro_dur;
			this.introTicks = this.introTotal;
			this.fill = clamp01(this.cfg.intro_fill);
			this.rippleCooldown = 1;
		}

		_startEnding() {
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingFade = this.cfg.ending_dur > 0 ? this.cfg.ending_dur : WATER_PIPE_DEFAULTS.ending_dur;
			const linger = Math.max(0, this.cfg.ending_linger);
			this.endingTotal = Math.max(1, this.endingFade + linger);
			this.endingTicks = this.endingTotal;
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / (total - 1));
		}

		_flowLevel() {
			let flow = 1.0;
			if (this.surgeTicks > 0) flow *= this.cfg.surge_mult;
			if (this.dryTicks > 0) flow *= this.cfg.dry_mult;
			if (this.introTicks > 0) {
				const progress = this._phaseProgress(this.introTotal, this.introTicks);
				flow *= this.cfg.intro_drip + (1 - this.cfg.intro_drip) * progress;
			}
			if (this.endingTicks > 0) {
				const elapsed = this.endingTotal - this.endingTicks;
				if (elapsed < this.endingFade) {
					const fade = clamp01(elapsed / Math.max(1, this.endingFade - 1));
					flow *= 1 - 0.94 * fade;
				} else {
					flow *= 0.06;
				}
			}
			if (flow < 0) flow = 0;
			return flow;
		}

		_updateFill() {
			const flow = this._flowLevel();
			this.fill += this.cfg.inflow * flow * 0.012;
			this.fill -= this.cfg.drain * 0.012;
			if (this.endingTicks > 0) {
				const progress = this._phaseProgress(this.endingTotal, this.endingTicks);
				const target = this.cfg.ending_residue;
				this.fill = this.fill * (1 - 0.06 * progress) + target * 0.06 * progress;
			}
			if (this.fill < 0) this.fill = 0;
			if (this.fill > 1.6) this.fill = 1.6;
		}

		_pipeGeometry() {
			const width = Math.max(3, this.cfg.pipe_width);
			let half = Math.round(width * 0.5);
			if (half < 2) half = 2;
			const center = Math.round(this.cfg.pipe_x * (this.w - 1));
			let left = center - half;
			let right = center + half;
			if (left < 1) left = 1;
			if (right >= this.w - 1) right = this.w - 2;
			if (right < left) right = left;
			let lip = Math.round(this.cfg.pipe_y * (this.h - 1));
			if (lip < 2) lip = 2;
			if (lip > this.h - 6) lip = this.h - 6;
			return { lip, left, right, center };
		}

		_basinGeometry() {
			let brim = Math.round(this.cfg.basin_y * (this.h - 1));
			if (brim < 6) brim = 6;
			if (brim > this.h - 3) brim = this.h - 3;
			let depth = Math.round(this.cfg.basin_depth);
			if (depth < 3) depth = 3;
			if (depth > this.h - brim - 1) depth = this.h - brim - 1;
			if (depth < 2) depth = 2;
			const bottom = brim + depth;
			let half = Math.round(this.cfg.basin_span * this.w * 0.5);
			if (half < 4) half = 4;
			const pipe = this._pipeGeometry();
			const center = pipe.center > 0 ? pipe.center : Math.round(this.w / 2);
			let left = center - half;
			let right = center + half;
			if (left < 1) left = 1;
			if (right >= this.w - 1) right = this.w - 2;
			return { brim, bottom, left, right };
		}

		_wallThick() {
			let w = Math.round(this.cfg.wall_thick);
			if (w < 1) w = 1;
			if (w > 4) w = 4;
			return w;
		}

		_stepDroplets() {
			if (!this.droplets.length) return;
			const alive = [];
			const gravity = 0.085;
			for (const d of this.droplets) {
				d.vRow += gravity;
				d.row += d.vRow;
				d.col += d.vCol;
				d.life--;
				if (d.life > 0 && d.row < this.h + 1 && d.col >= -2 && d.col < this.w + 2) {
					alive.push(d);
				}
			}
			this.droplets = alive;
		}

		_stepRipples() {
			if (!this.ripples.length) return;
			const alive = [];
			for (const r of this.ripples) {
				r.radius += r.speed;
				r.life--;
				if (r.life > 0 && r.radius < this.w) alive.push(r);
			}
			this.ripples = alive;
		}

		_stepRunoff() {
			if (!this.runoff.length) return;
			const alive = [];
			for (const r of this.runoff) {
				r.col += r.vel * r.side;
				r.strength *= 1 - this.cfg.overflow_fade;
				r.life--;
				if (r.life > 0 && r.strength > 0.04 && r.col >= -1 && r.col <= this.w + 1) {
					alive.push(r);
				}
			}
			this.runoff = alive;
		}

		_spawnRipple() {
			if (this.ripples.length >= this.cfg.ripple_max || this.rippleCooldown > 0) return;
			const flow = this._flowLevel();
			if (flow < 0.1) return;
			let cadence = this.cfg.ripple_every / Math.max(0.25, flow);
			if (cadence < 1) cadence = 1;
			const pipe = this._pipeGeometry();
			const col = pipe.center + (this.rng() * 2 - 1) * 1.2;
			const life = jitterInt(this.rng, 22, 0.25);
			const speed = (0.45 + this.rng() * 0.45) * (0.85 + 0.2 * flow);
			const strength = clamp01(0.45 + 0.3 * flow + this.rng() * 0.2);
			this.ripples.push({ col, radius: 0, speed, life, maxLife: life, strength });
			this.rippleCooldown = jitterInt(this.rng, Math.round(cadence), 0.25);
		}

		_spawnRunoff() {
			const overflow = this.fill - 1.0;
			if (overflow <= 0) return;
			if (this.endingTicks > 0 && this.endingTotal - this.endingTicks >= this.endingFade) {
				if (this.rng() > 0.25) return;
			}
			const flow = this._flowLevel();
			const intensity = Math.min(1, overflow / 0.6);
			if (this.rng() > 0.55 + 0.4 * intensity) return;
			const basin = this._basinGeometry();
			for (const side of [-1, 1]) {
				const col = side > 0 ? basin.right : basin.left;
				const vel = this.cfg.overflow_speed * (0.85 + 0.4 * this.rng()) * (0.7 + 0.3 * flow);
				const life = jitterInt(this.rng, 60, 0.3);
				const strength = clamp01(0.55 + 0.45 * intensity + this.rng() * 0.15);
				this.runoff.push({ col, vel, life, maxLife: life, strength, side });
			}
		}

		_spawnSplatter() {
			const flow = this._flowLevel();
			if (flow <= 0.05) return;
			const chance = this.cfg.splatter_p * (0.5 + 0.6 * flow);
			if (this.rng() > chance) return;
			if (this.droplets.length >= this.cfg.droplet_max) return;
			const basin = this._basinGeometry();
			const pipe = this._pipeGeometry();
			const col = pipe.center + (this.rng() * 2 - 1) * this.cfg.stream_width * 0.7;
			const row = basin.brim - 1 + this.rng() * 1.5;
			const vCol = (this.rng() * 2 - 1) * (0.5 + 0.4 * flow);
			const vRow = -(0.6 + this.rng() * 0.5) * (0.7 + 0.3 * flow);
			const life = jitterInt(this.rng, 18, 0.4);
			const hue = ((this.cfg.hue + (this.rng() * 2 - 1) * this.cfg.hue_sp * 0.5) % 360 + 360) % 360;
			const light = clamp01(this.cfg.lmax * (0.85 + this.rng() * 0.15));
			const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.85), light);
			this.droplets.push({ row, col, vRow, vCol, life, maxLife: life, color });
		}

		_paintBasin() {
			const { brim, bottom, left, right } = this._basinGeometry();
			const wall = this._wallThick();
			const wallHue = ((this.cfg.pipe_hue % 360) + 360) % 360;
			const wallC = hslToRGB(wallHue, 0.45, this.cfg.pipe_light);
			const wallC2 = hslToRGB(wallHue, 0.35, clamp01(this.cfg.pipe_light * 0.7));
			for (let y = bottom; y < bottom + wall && y < this.h; y++) {
				for (let x = left - wall; x <= right + wall && x < this.w; x++) {
					if (x < 0) continue;
					this._paintMax(y, x, y > bottom ? wallC2 : wallC);
				}
			}
			for (let y = brim; y <= bottom; y++) {
				for (let w = 0; w < wall; w++) {
					this._paintMax(y, left - 1 - w, wallC);
					this._paintMax(y, right + 1 + w, wallC);
				}
			}
			if (brim - 1 >= 0) {
				for (let w = 0; w < wall; w++) {
					const highlight = hslToRGB(wallHue, 0.3, clamp01(this.cfg.pipe_light * 1.4));
					this._paintMax(brim - 1, left - 1 - w, highlight);
					this._paintMax(brim - 1, right + 1 + w, highlight);
				}
			}
		}

		_paintPool() {
			const { brim, bottom, left, right } = this._basinGeometry();
			if (right <= left || bottom <= brim) return;
			const depth = bottom - brim;
			const level = clamp01(this.fill);
			let surface = bottom - Math.round(level * depth);
			if (surface > bottom) surface = bottom;
			if (surface < brim) surface = brim;
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (let y = surface; y < bottom; y++) {
				const dist = (y - surface) / Math.max(1, bottom - surface - 1);
				const shimmer = 0.7 + 0.3 * Math.sin(y * 0.31 + this.tick * 0.08);
				const light = clamp01(this.cfg.lmin * (0.55 + 0.4 * dist) +
					(this.cfg.lmax - this.cfg.lmin) * 0.15 * shimmer);
				const color = hslToRGB(((hue - 6) % 360 + 360) % 360,
					clamp01(this.cfg.sat * 0.85), light);
				for (let x = left; x <= right; x++) {
					this._paintMax(y, x, color);
				}
			}
			if (surface >= brim && surface <= bottom) {
				const light = clamp01(this.cfg.lmax * 0.85);
				const color = hslToRGB(((hue + 2) % 360 + 360) % 360,
					clamp01(this.cfg.sat * 0.7), light);
				for (let x = left; x <= right; x++) {
					const wave = Math.sin(x * 0.42 + this.tick * 0.12) * 0.3;
					let row = surface + Math.round(wave);
					if (row < brim) row = brim;
					if (row > bottom) row = bottom;
					this._paintMax(row, x, color);
				}
			}
		}

		_paintStream() {
			const pipe = this._pipeGeometry();
			const basin = this._basinGeometry();
			const flow = this._flowLevel();
			if (flow <= 0.02) return;
			const depth = basin.bottom - basin.brim;
			const level = clamp01(this.fill);
			let surface = basin.bottom - Math.round(level * depth);
			if (surface < basin.brim + 1) surface = basin.brim + 1;
			const streamTop = pipe.lip + 1;
			const streamBottom = surface;
			if (streamBottom <= streamTop) return;
			const width = Math.max(1, this.cfg.stream_width * flow);
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (let y = streamTop; y < streamBottom; y++) {
				const progress = (y - streamTop) / Math.max(1, streamBottom - streamTop - 1);
				const sway = Math.sin(y * 0.55 - this.tick * 0.18) * 0.6 * width * 0.18;
				const rowCenter = pipe.center + sway;
				const half = Math.max(0.6, width * 0.5);
				let start = Math.floor(rowCenter - half);
				let end = Math.ceil(rowCenter + half);
				if (start < 0) start = 0;
				if (end >= this.w) end = this.w - 1;
				for (let x = start; x <= end; x++) {
					const dist = Math.abs((x + 0.5) - rowCenter) / half;
					if (dist > 1.05) continue;
					const edge = clamp01(1 - dist * dist);
					const pulse = 0.7 + 0.3 * Math.sin(progress * 9 - this.tick * 0.36 + x * 0.4);
					const intensity = edge * pulse;
					if (intensity < 0.1) continue;
					const h = ((hue + Math.sin(progress * 2 + x * 0.1) * this.cfg.hue_sp * 0.5) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) *
						(0.35 + 0.6 * intensity));
					const color = hslToRGB(h, this.cfg.sat, light);
					this._paintMax(y, x, color);
				}
			}
			for (let x = pipe.left; x <= pipe.right; x++) {
				if (Math.abs(x - pipe.center) > this.cfg.stream_width * 0.55) continue;
				const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.6),
					clamp01(this.cfg.lmax * 0.95));
				this._paintMax(pipe.lip + 1, x, color);
			}
		}

		_paintImpact() {
			const flow = this._flowLevel();
			if (flow <= 0.05) return;
			const basin = this._basinGeometry();
			const depth = basin.bottom - basin.brim;
			const level = clamp01(this.fill);
			let surface = basin.bottom - Math.round(level * depth);
			if (surface < basin.brim) surface = basin.brim;
			if (surface > basin.bottom) surface = basin.bottom;
			const pipe = this._pipeGeometry();
			const radius = Math.round(Math.max(2, this.cfg.stream_width * flow * 0.7));
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (let dx = -radius; dx <= radius; dx++) {
				const x = pipe.center + dx;
				if (x < 0 || x >= this.w) continue;
				const dist = Math.abs(dx) / (radius + 1);
				if (dist > 1) continue;
				const foam = clamp01((1 - dist * dist) * (0.65 + 0.25 * flow));
				const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) *
					(0.6 + 0.4 * foam));
				const color = hslToRGB(((hue + 10) % 360 + 360) % 360,
					clamp01(this.cfg.sat * 0.4), light);
				this._paintMax(surface, x, color);
				if (surface - 1 >= 0) this._paintMax(surface - 1, x, color);
			}
		}

		_paintRipples() {
			if (!this.ripples.length) return;
			const basin = this._basinGeometry();
			const depth = basin.bottom - basin.brim;
			const level = clamp01(this.fill);
			let surface = basin.bottom - Math.round(level * depth);
			if (surface < basin.brim) surface = basin.brim;
			if (surface > basin.bottom) surface = basin.bottom;
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (const r of this.ripples) {
				const fade = clamp01(r.life / Math.max(1, r.maxLife));
				if (fade <= 0) continue;
				for (let x = basin.left; x <= basin.right; x++) {
					const wave = Math.abs(Math.abs(x - r.col) - r.radius);
					if (wave > 0.85) continue;
					const bright = r.strength * fade * (1 - wave / 0.85);
					const light = clamp01(this.cfg.lmin * 0.85 + (this.cfg.lmax - this.cfg.lmin) *
						(0.25 + 0.6 * bright));
					const color = hslToRGB(((hue - 6) % 360 + 360) % 360,
						clamp01(this.cfg.sat * 0.7), light);
					this._paintMax(surface, x, color);
				}
			}
		}

		_paintRunoff() {
			if (!this.runoff.length) return;
			const basin = this._basinGeometry();
			const wall = this._wallThick();
			let floor = basin.bottom + wall;
			if (floor >= this.h) floor = this.h - 1;
			const hue = ((this.cfg.hue % 360) + 360) % 360;
			for (const r of this.runoff) {
				const fade = clamp01(r.life / Math.max(1, r.maxLife));
				const intensity = r.strength * fade;
				if (intensity <= 0.02) continue;
				let col = Math.round(r.col);
				if (r.side > 0 && col < basin.right) col = basin.right + 1;
				if (r.side < 0 && col > basin.left) col = basin.left - 1;
				if (col < 0 || col >= this.w) continue;
				const light = clamp01(this.cfg.lmin * 0.85 + (this.cfg.lmax - this.cfg.lmin) *
					(0.3 + 0.6 * intensity));
				const color = hslToRGB(((hue - 4) % 360 + 360) % 360,
					clamp01(this.cfg.sat * 0.75), light);
				this._paintMax(floor, col, color);
				if (floor + 1 < this.h && intensity > 0.3) {
					this._paintMax(floor + 1, col, {
						r: Math.floor(color.r * 0.75),
						g: Math.floor(color.g * 0.75),
						b: Math.floor(color.b * 0.75),
					});
				}
				const trail = Math.round(2 + 3 * intensity);
				for (let t = 1; t <= trail; t++) {
					const tcol = col - r.side * t;
					if (tcol < 0 || tcol >= this.w) continue;
					const tfade = intensity * (1 - t / (trail + 1));
					if (tfade <= 0.05) continue;
					const tlight = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) *
						(0.2 + 0.5 * tfade));
					const tc = hslToRGB(((hue - 8) % 360 + 360) % 360,
						clamp01(this.cfg.sat * 0.65), tlight);
					this._paintMax(floor, tcol, tc);
				}
			}
		}

		_paintPipe() {
			const pipe = this._pipeGeometry();
			const wallHue = ((this.cfg.pipe_hue % 360) + 360) % 360;
			const body = hslToRGB(wallHue, 0.55, this.cfg.pipe_light);
			const rim = hslToRGB(wallHue, 0.45, clamp01(this.cfg.pipe_light * 1.5));
			const shade = hslToRGB(wallHue, 0.45, clamp01(this.cfg.pipe_light * 0.65));
			for (let y = 0; y <= pipe.lip; y++) {
				for (let x = pipe.left; x <= pipe.right; x++) {
					this._paintMax(y, x, (x === pipe.left || x === pipe.right) ? shade : body);
				}
			}
			for (let x = pipe.left; x <= pipe.right; x++) {
				this._paintMax(pipe.lip, x, rim);
			}
			if (pipe.lip + 1 < this.h) {
				for (let x = pipe.left - 1; x <= pipe.right + 1; x++) {
					if (x < 0 || x >= this.w) continue;
					this._paintMax(pipe.lip, x, rim);
				}
			}
		}

		_paintDroplets() {
			for (const d of this.droplets) {
				const fade = clamp01(d.life / Math.max(1, d.maxLife));
				if (fade <= 0) continue;
				const row = Math.round(d.row);
				const col = Math.round(d.col);
				const scale = 0.3 + 0.7 * fade;
				this._paintMax(row, col, {
					r: Math.floor(d.color.r * scale),
					g: Math.floor(d.color.g * scale),
					b: Math.floor(d.color.b * scale),
				});
			}
		}

		_paintMax(row, col, color) {
			if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
			if (color.r === 0 && color.g === 0 && color.b === 0) return;
			const i = (row * this.w + col) * 3;
			if (color.r > this.grid[i]) this.grid[i] = color.r;
			if (color.g > this.grid[i + 1]) this.grid[i + 1] = color.g;
			if (color.b > this.grid[i + 2]) this.grid[i + 2] = color.b;
		}
	}

	api.presets['water-pipe'] = [
		{
			key: 'small-trickle',
			label: 'small trickle',
			config: {
				intro_drip: 0.1,
				intro_fill: 0.02,
				ending_residue: 0.1,
				pipe_width: 5,
				stream_width: 1.5,
				basin_y: 0.7,
				basin_span: 0.28,
				basin_depth: 7,
				inflow: 0.45,
				drain: 0.04,
				overflow_speed: 0.4,
				overflow_fade: 0.08,
				splatter_p: 0.18,
				droplet_max: 18,
				ripple_every: 11,
				ripple_max: 5,
				hue: 198,
				hue_sp: 10,
				sat: 0.5,
				lmin: 0.4,
				lmax: 0.82,
				pipe_hue: 24,
				pipe_light: 0.32,
				dry_p: 0.0008,
				dry_mult: 0.15,
			},
		},
		{
			key: 'steady-pool',
			label: 'steady pool',
			config: {
				intro_drip: 0.18,
				intro_fill: 0.1,
				ending_residue: 0.32,
				pipe_width: 6,
				stream_width: 3,
				basin_y: 0.66,
				basin_span: 0.36,
				basin_depth: 8,
				inflow: 1.0,
				drain: 0.6,
				overflow_speed: 0.5,
				overflow_fade: 0.06,
				splatter_p: 0.4,
				droplet_max: 36,
				ripple_every: 7,
				ripple_max: 8,
				hue: 200,
				hue_sp: 14,
				sat: 0.55,
				lmin: 0.42,
				lmax: 0.84,
				pipe_hue: 28,
				pipe_light: 0.34,
				surge_p: 0.0006,
				surge_mult: 1.6,
			},
		},
		{
			key: 'heavy-spill',
			label: 'heavy spill',
			config: {
				intro_drip: 0.22,
				intro_fill: 0.4,
				ending_residue: 0.45,
				pipe_width: 8,
				stream_width: 4.5,
				basin_y: 0.62,
				basin_span: 0.4,
				basin_depth: 6,
				wall_thick: 1,
				inflow: 1.8,
				drain: 0.05,
				overflow_speed: 0.85,
				overflow_fade: 0.035,
				splatter_p: 0.7,
				droplet_max: 64,
				ripple_every: 5,
				ripple_max: 12,
				hue: 196,
				hue_sp: 16,
				sat: 0.6,
				lmin: 0.45,
				lmax: 0.88,
				pipe_hue: 22,
				pipe_light: 0.36,
				surge_p: 0.0014,
				surge_mult: 2.0,
				surge_dur: 80,
			},
		},
		{
			key: 'edge-runoff',
			label: 'edge runoff',
			config: {
				intro_drip: 0.16,
				intro_fill: 0.6,
				ending_residue: 0.5,
				pipe_x: 0.22,
				pipe_width: 6,
				stream_width: 3.5,
				basin_y: 0.68,
				basin_span: 0.3,
				basin_depth: 5,
				wall_thick: 1,
				inflow: 1.4,
				drain: 0.02,
				overflow_speed: 1.1,
				overflow_fade: 0.025,
				splatter_p: 0.55,
				droplet_max: 48,
				ripple_every: 6,
				ripple_max: 10,
				hue: 204,
				hue_sp: 18,
				sat: 0.58,
				lmin: 0.44,
				lmax: 0.86,
				pipe_hue: 32,
				pipe_light: 0.34,
				surge_p: 0.0009,
				surge_mult: 1.7,
				dry_p: 0.0005,
				dry_mult: 0.2,
			},
		},
	];
	api.effects['water-pipe'] = WaterPipe;
})(window.AmbienceSim);
// ===== effects/waterfall.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB } = api._helpers;

	const WATERFALL_DEFAULTS = {
		intro_dur: 60,
		intro_trickle: 0.18,
		intro_mist: 0.25,
		ending_dur: 60,
		ending_linger: 24,
		ending_mist: 0.2,
		width: 7,
		wobble: 1.8,
		speed: 1.0,
		pool_y: 0.72,
		pool_span: 0.34,
		mist_spawn: 2,
		mist_max: 48,
		ripple_every: 8,
		ripple_max: 10,
		hue: 204,
		hue_sp: 12,
		sat: 0.48,
		lmin: 0.45,
		lmax: 0.82,
		surge_p: 0,
		calm_p: 0,
		mist_burst_p: 0,
		surge_dur: 55,
		surge_mult: 1.6,
		calm_dur: 70,
		calm_mult: 0.55,
		mist_burst_dur: 40,
		mist_burst_mult: 2.5,
	};

	function applyWaterfallDefaults(cfg) {
		const c = Object.assign({}, WATERFALL_DEFAULTS, cfg || {});
		if (c.intro_dur === 0 && c.intro_trickle === 0 && c.intro_mist === 0) {
			c.intro_dur = WATERFALL_DEFAULTS.intro_dur;
			c.intro_trickle = WATERFALL_DEFAULTS.intro_trickle;
			c.intro_mist = WATERFALL_DEFAULTS.intro_mist;
		} else {
			if (c.intro_dur <= 0) c.intro_dur = WATERFALL_DEFAULTS.intro_dur;
			if (c.intro_trickle <= 0) c.intro_trickle = WATERFALL_DEFAULTS.intro_trickle;
			if (c.intro_mist < 0) c.intro_mist = 0;
		}
		c.intro_trickle = clamp01(c.intro_trickle);
		c.intro_mist = clamp01(c.intro_mist);
		if (c.ending_dur === 0 && c.ending_linger === 0 && c.ending_mist === 0) {
			c.ending_dur = WATERFALL_DEFAULTS.ending_dur;
			c.ending_linger = WATERFALL_DEFAULTS.ending_linger;
			c.ending_mist = WATERFALL_DEFAULTS.ending_mist;
		} else {
			if (c.ending_dur <= 0) c.ending_dur = WATERFALL_DEFAULTS.ending_dur;
			if (c.ending_linger < 0) c.ending_linger = 0;
			if (c.ending_mist < 0) c.ending_mist = 0;
		}
		c.ending_mist = clamp01(c.ending_mist);
		if (c.width <= 0) c.width = WATERFALL_DEFAULTS.width;
		if (c.wobble < 0) c.wobble = 0;
		if (c.wobble === 0) c.wobble = WATERFALL_DEFAULTS.wobble;
		if (c.speed <= 0) c.speed = WATERFALL_DEFAULTS.speed;
		if (c.pool_y <= 0) c.pool_y = WATERFALL_DEFAULTS.pool_y;
		c.pool_y = clamp01(c.pool_y);
		if (c.pool_span <= 0) c.pool_span = WATERFALL_DEFAULTS.pool_span;
		c.pool_span = clamp01(c.pool_span);
		if (c.mist_spawn <= 0) c.mist_spawn = WATERFALL_DEFAULTS.mist_spawn;
		if (c.mist_max <= 0) c.mist_max = WATERFALL_DEFAULTS.mist_max;
		if (c.ripple_every <= 0) c.ripple_every = WATERFALL_DEFAULTS.ripple_every;
		if (c.ripple_max <= 0) c.ripple_max = WATERFALL_DEFAULTS.ripple_max;
		if (c.hue_sp <= 0) c.hue_sp = WATERFALL_DEFAULTS.hue_sp;
		if (c.sat <= 0) c.sat = WATERFALL_DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = WATERFALL_DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = WATERFALL_DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.surge_dur <= 0) c.surge_dur = WATERFALL_DEFAULTS.surge_dur;
		if (c.surge_mult <= 0) c.surge_mult = WATERFALL_DEFAULTS.surge_mult;
		if (c.calm_dur <= 0) c.calm_dur = WATERFALL_DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = WATERFALL_DEFAULTS.calm_mult;
		if (c.mist_burst_dur <= 0) c.mist_burst_dur = WATERFALL_DEFAULTS.mist_burst_dur;
		if (c.mist_burst_mult <= 0) c.mist_burst_mult = WATERFALL_DEFAULTS.mist_burst_mult;
		return c;
	}

	class Waterfall {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.cfg = applyWaterfallDefaults(cfg);
			this.rng = makeRNG(seed || Date.now());
			this.tick = 0;
			this.grid = new Uint8ClampedArray(w * h * 3);
			this.mists = [];
			this.ripples = [];
			this.surgeTicks = 0;
			this.calmTicks = 0;
			this.mistBurstTicks = 0;
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.rippleCooldown = 0;
		}

		setConfig(cfg) {
			const prev = this.cfg;
			const next = applyWaterfallDefaults(Object.assign({}, this.cfg, cfg));
			if (prev && prev.speed > 0 && next.speed !== prev.speed) {
				const ratio = next.speed / prev.speed;
				for (const mist of this.mists) {
					mist.vRow *= ratio;
					mist.vCol *= ratio;
				}
				for (const ripple of this.ripples) {
					ripple.speed *= 0.7 + 0.3 * ratio;
				}
			}
			this.cfg = next;
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.surgeTicks = state.surgeTicks || 0;
			this.calmTicks = state.calmTicks || 0;
			this.mistBurstTicks = state.mistBurstTicks || 0;
			this.introTicks = state.introTicks || 0;
			this.introTotal = state.introTotal || 0;
			this.endingTicks = state.endingTicks || 0;
			this.endingTotal = state.endingTotal || 0;
			this.endingFade = state.endingFade || 0;
			this.rippleCooldown = state.rippleCooldown || 0;
			if (typeof snap.seed === 'number') this.rng = makeRNG(snap.seed);
			if (snap.gridW > 0 && snap.gridH > 0 &&
				(snap.gridW !== this.w || snap.gridH !== this.h)) {
				this.w = snap.gridW;
				this.h = snap.gridH;
				this.grid = new Uint8ClampedArray(this.w * this.h * 3);
			}
			this.mists = Array.isArray(state.mists) ? state.mists.map(m => ({
				row: m.row,
				col: m.col,
				vRow: m.vRow,
				vCol: m.vCol,
				life: m.life,
				maxLife: m.maxLife,
				color: m.color,
			})) : [];
			this.ripples = Array.isArray(state.ripples) ? state.ripples.map(r => ({
				col: r.col,
				radius: r.radius,
				speed: r.speed,
				life: r.life,
				maxLife: r.maxLife,
				strength: r.strength,
			})) : [];
		}

		triggerEvent(name) {
			switch (name) {
				case 'surge':
					this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
					this._spawnRipple(this._flowLevel());
					return true;
				case 'calm':
					this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'mist-burst':
					this.mistBurstTicks = jitterInt(this.rng, this.cfg.mist_burst_dur, 0.3);
					this._spawnRipple(this._flowLevel());
					return true;
				case 'intro':
					this._startIntro();
					return true;
				case 'ending':
					this._startEnding();
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			if (this.surgeTicks > 0) this.surgeTicks--;
			if (this.calmTicks > 0) this.calmTicks--;
			if (this.mistBurstTicks > 0) this.mistBurstTicks--;
			if (this.introTicks > 0) this.introTicks--;
			if (this.endingTicks > 0) this.endingTicks--;
			if (this.rippleCooldown > 0) this.rippleCooldown--;

			if (this.surgeTicks === 0 && this.rng() < this.cfg.surge_p) {
				this.surgeTicks = jitterInt(this.rng, this.cfg.surge_dur, 0.3);
				this._spawnRipple(this._flowLevel());
			}
			if (this.calmTicks === 0 && this.rng() < this.cfg.calm_p) {
				this.calmTicks = jitterInt(this.rng, this.cfg.calm_dur, 0.3);
			}
			if (this.mistBurstTicks === 0 && this.rng() < this.cfg.mist_burst_p) {
				this.mistBurstTicks = jitterInt(this.rng, this.cfg.mist_burst_dur, 0.3);
				this._spawnRipple(this._flowLevel());
			}

			this._stepMists();
			this._stepRipples();
			this._stepRippleSpawner();
			this._stepMistSpawner();
			this.grid.fill(0);
			this._paintPool();
			this._paintSheet();
			this._paintImpact();
			this._paintRipples();
			this._paintMists();
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				ctx.fillStyle = opts.bg || '#0a0a0a';
				ctx.fillRect(0, 0, canvasW, canvasH);
			}
			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx), ceilSy = Math.ceil(sy);
			for (let y = 0; y < this.h; y++) {
				for (let x = 0; x < this.w; x++) {
					const i = (y * this.w + x) * 3;
					const r = this.grid[i], g = this.grid[i + 1], b = this.grid[i + 2];
					if (r === 0 && g === 0 && b === 0) continue;
					ctx.fillStyle = `rgb(${r},${g},${b})`;
					ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), ceilSx, ceilSy);
				}
			}
		}

		_startIntro() {
			this.endingTicks = 0;
			this.endingTotal = 0;
			this.endingFade = 0;
			this.introTotal = this.cfg.intro_dur > 0 ? this.cfg.intro_dur : WATERFALL_DEFAULTS.intro_dur;
			this.introTicks = this.introTotal;
			this.rippleCooldown = 1;
		}

		_startEnding() {
			this.introTicks = 0;
			this.introTotal = 0;
			this.endingFade = this.cfg.ending_dur > 0 ? this.cfg.ending_dur : WATERFALL_DEFAULTS.ending_dur;
			const linger = Math.max(0, this.cfg.ending_linger);
			this.endingTotal = Math.max(1, this.endingFade + linger);
			this.endingTicks = this.endingTotal;
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / (total - 1));
		}

		_flowLevel() {
			let flow = 1.0;
			if (this.surgeTicks > 0) flow *= this.cfg.surge_mult;
			if (this.calmTicks > 0) flow *= this.cfg.calm_mult;
			if (this.introTicks > 0) {
				const progress = this._phaseProgress(this.introTotal, this.introTicks);
				flow *= this.cfg.intro_trickle + (1 - this.cfg.intro_trickle) * progress;
			}
			if (this.endingTicks > 0) {
				const elapsed = this.endingTotal - this.endingTicks;
				if (elapsed < this.endingFade) {
					const fade = clamp01(elapsed / Math.max(1, this.endingFade - 1));
					flow *= 1 - 0.88 * fade;
				} else {
					flow *= 0.12;
				}
			}
			return Math.max(0.05, flow);
		}

		_mistLevel() {
			let level = 1.0;
			if (this.surgeTicks > 0) level *= 1.25;
			if (this.calmTicks > 0) level *= 0.65;
			if (this.mistBurstTicks > 0) level *= this.cfg.mist_burst_mult;
			if (this.introTicks > 0) {
				const progress = this._phaseProgress(this.introTotal, this.introTicks);
				level *= this.cfg.intro_mist + (1 - this.cfg.intro_mist) * progress;
			}
			if (this.endingTicks > 0) {
				const progress = this._phaseProgress(this.endingTotal, this.endingTicks);
				level *= 1 - (1 - this.cfg.ending_mist) * progress;
			}
			return Math.max(0.05, level);
		}

		_poolRow() {
			let row = Math.round(this.cfg.pool_y * (this.h - 1));
			if (row < 6) row = 6;
			if (row > this.h - 4) row = this.h - 4;
			return row;
		}

		_poolBounds() {
			const center = Math.round(this.w * 0.5);
			let half = Math.round(this.cfg.pool_span * this.w * 0.5);
			if (half < 4) half = 4;
			let left = center - half;
			let right = center + half;
			if (left < 0) left = 0;
			if (right >= this.w) right = this.w - 1;
			return [left, right];
		}

		_stepMists() {
			if (!this.mists.length) return;
			const speedScale = 0.75 + 0.4 * this.cfg.speed;
			const alive = [];
			for (const mist of this.mists) {
				mist.vCol += (this.rng() * 2 - 1) * 0.015;
				mist.vCol = Math.max(-0.4, Math.min(0.4, mist.vCol));
				mist.row += mist.vRow * speedScale;
				mist.col += mist.vCol;
				mist.vRow *= 0.99;
				mist.life--;
				if (mist.life > 0 && mist.row >= -2 && mist.row < this.h && mist.col >= -2 && mist.col < this.w + 2) {
					alive.push(mist);
				}
			}
			this.mists = alive;
		}

		_stepRipples() {
			if (!this.ripples.length) return;
			const alive = [];
			for (const ripple of this.ripples) {
				ripple.radius += ripple.speed;
				ripple.life--;
				if (ripple.life > 0 && ripple.radius < this.w) alive.push(ripple);
			}
			this.ripples = alive;
		}

		_stepRippleSpawner() {
			if (this.ripples.length >= this.cfg.ripple_max || this.rippleCooldown > 0) return;
			const flow = this._flowLevel();
			let cadence = this.cfg.ripple_every;
			if (flow > 0) cadence /= Math.max(0.25, flow);
			if (this.endingTicks > 0 && this.endingTotal - this.endingTicks >= this.endingFade) cadence *= 2;
			cadence = Math.max(1, cadence);
			this._spawnRipple(flow);
			this.rippleCooldown = jitterInt(this.rng, Math.round(cadence), 0.25);
		}

		_stepMistSpawner() {
			if (this.mists.length >= this.cfg.mist_max) return;
			const level = this._mistLevel();
			let spawnEvery = Math.round(this.cfg.mist_spawn / Math.max(0.2, level));
			if (spawnEvery < 1) spawnEvery = 1;
			let attempts = 1;
			if (level > 1) {
				attempts += Math.floor(level);
				if (this.rng() < (level - Math.floor(level))) attempts++;
			}
			if (this.endingTicks > 0 && this.endingTotal - this.endingTicks >= this.endingFade) {
				spawnEvery *= 3;
				attempts = 1;
			}
			for (let i = 0; i < attempts && this.mists.length < this.cfg.mist_max; i++) {
				if (this.rng.intn(spawnEvery) === 0) this._spawnMist(level);
			}
		}

		_spawnRipple(flow) {
			if (this.ripples.length >= this.cfg.ripple_max) return;
			const center = this.w * 0.5;
			const col = center + (this.rng() * 2 - 1) * this.cfg.width * Math.max(0.35, flow) * 0.35;
			const life = jitterInt(this.rng, 18, 0.25);
			const speed = (0.5 + this.rng() * 0.55) * (0.8 + 0.25 * Math.max(0.5, flow));
			const strength = clamp01(0.45 + this.rng() * 0.35 + (flow - 1) * 0.12);
			this.ripples.push({
				col,
				radius: 0,
				speed,
				life,
				maxLife: life,
				strength,
			});
		}

		_spawnMist(level) {
			if (this.mists.length >= this.cfg.mist_max) return;
			const center = this.w * 0.5;
			const flow = this._flowLevel();
			const surface = this._poolRow();
			const col = center + (this.rng() * 2 - 1) * this.cfg.width * Math.max(0.35, flow) * 0.6;
			const row = surface - 1 - this.rng() * 2;
			const vRow = -(0.12 + this.rng() * 0.22) * (0.8 + 0.35 * this.cfg.speed);
			const vCol = (this.rng() * 2 - 1) * (0.08 + 0.1 * Math.max(0.5, level) + this.cfg.wobble * 0.02);
			const life = jitterInt(this.rng, 22, 0.35);
			const hue = ((this.cfg.hue + (this.rng() * 2 - 1) * this.cfg.hue_sp * 0.35) % 360 + 360) % 360;
			const light = clamp01(this.cfg.lmax * (0.88 + this.rng() * 0.12));
			const color = hslToRGB(hue, clamp01(this.cfg.sat * 0.45), light);
			this.mists.push({
				row,
				col,
				vRow,
				vCol,
				life,
				maxLife: life,
				color,
			});
		}

		_paintPool() {
			const surface = this._poolRow();
			const [left, right] = this._poolBounds();
			let depth = this.h - surface;
			if (depth > 10) depth = 10;
			if (depth < 3) depth = 3;
			const center = this.w * 0.5;
			const half = Math.max(1, (right - left) / 2);
			for (let y = surface; y < this.h && y < surface + depth; y++) {
				const rowDepth = 1 - (y - surface) / depth;
				for (let x = left; x <= right; x++) {
					const edge = 1 - Math.abs(x - center) / half;
					if (edge <= 0) continue;
					const shimmer = 0.72 + 0.28 * Math.sin(x * 0.13 + y * 0.27 + this.tick * 0.07 * this.cfg.speed);
					const light = clamp01(this.cfg.lmin * 0.22 + (this.cfg.lmax - this.cfg.lmin) * 0.28 * edge * rowDepth * shimmer);
					const color = hslToRGB(((this.cfg.hue - 8) % 360 + 360) % 360, clamp01(this.cfg.sat * 0.9), light);
					this._paintMax(y, x, color);
				}
			}
		}

		_paintSheet() {
			const surface = this._poolRow();
			if (surface <= 0) return;
			const center = this.w * 0.5;
			const flow = this._flowLevel();
			const width = Math.max(1, this.cfg.width * flow);
			for (let y = 0; y < surface; y++) {
				const progress = y / Math.max(1, surface - 1);
				// Let the sheet bend drift downward so it reads as falling water.
				const rowCenter = center + Math.sin(progress * 5.1 - this.tick * 0.05 * this.cfg.speed) * this.cfg.wobble * 0.55;
				const rowWidth = width * (0.86 + 0.32 * progress);
				const half = Math.max(0.6, rowWidth * 0.5);
				let start = Math.floor(rowCenter - half - 1);
				let end = Math.ceil(rowCenter + half + 1);
				if (start < 0) start = 0;
				if (end >= this.w) end = this.w - 1;
				for (let x = start; x <= end; x++) {
					const dist = Math.abs((x + 0.5) - rowCenter) / half;
					if (dist > 1.1) continue;
					const edge = clamp01(1 - dist * dist);
					const pulse = 0.72 + 0.28 * Math.sin(progress * 11 - this.tick * 0.22 * this.cfg.speed + x * 0.35);
					const intensity = edge * pulse;
					if (intensity < 0.08) continue;
					const hue = ((this.cfg.hue + Math.sin(progress * 3 + x * 0.1) * this.cfg.hue_sp) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.3 + 0.7 * intensity));
					const color = hslToRGB(hue, this.cfg.sat, light);
					this._paintMax(y, x, color);
				}
			}
		}

		_paintImpact() {
			const surface = this._poolRow();
			const center = Math.round(this.w * 0.5);
			const flow = this._flowLevel();
			const level = this._mistLevel();
			const radius = Math.round(Math.max(2, this.cfg.width * flow * 0.6));
			for (let dx = -radius; dx <= radius; dx++) {
				const x = center + dx;
				const dist = Math.abs(dx) / (radius + 1);
				if (dist > 1) continue;
				const foam = clamp01((1 - dist * dist) * (0.65 + 0.2 * Math.max(0.5, level)));
				const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.55 + 0.45 * foam));
				const color = hslToRGB(((this.cfg.hue - 16) % 360 + 360) % 360, clamp01(this.cfg.sat * 0.25), light);
				this._paintMax(surface, x, color);
				this._paintMax(surface - 1, x, color);
				if (surface + 1 < this.h && dx % 2 === 0) {
					this._paintMax(surface + 1, x, {
						r: Math.floor(color.r * 0.8),
						g: Math.floor(color.g * 0.8),
						b: Math.floor(color.b * 0.8),
					});
				}
			}
		}

		_paintRipples() {
			if (!this.ripples.length) return;
			const surface = this._poolRow();
			const [left, right] = this._poolBounds();
			for (const ripple of this.ripples) {
				const fade = clamp01(ripple.life / Math.max(1, ripple.maxLife));
				if (fade <= 0) continue;
				for (let x = left; x <= right; x++) {
					const wave = Math.abs(Math.abs(x - ripple.col) - ripple.radius);
					if (wave > 0.8) continue;
					const bright = ripple.strength * fade * (1 - wave / 0.8);
					const light = clamp01(this.cfg.lmin * 0.85 + (this.cfg.lmax - this.cfg.lmin) * (0.25 + 0.55 * bright));
					const color = hslToRGB(((this.cfg.hue - 10) % 360 + 360) % 360, clamp01(this.cfg.sat * 0.7), light);
					this._paintMax(surface, x, color);
					if (surface + 1 < this.h && bright > 0.45) {
						this._paintMax(surface + 1, x, {
							r: Math.floor(color.r * 0.75),
							g: Math.floor(color.g * 0.75),
							b: Math.floor(color.b * 0.75),
						});
					}
				}
			}
		}

		_paintMists() {
			for (const mist of this.mists) {
				const fade = clamp01(mist.life / Math.max(1, mist.maxLife));
				if (fade <= 0) continue;
				const row = Math.round(mist.row);
				const col = Math.round(mist.col);
				const scale = 0.25 + 0.75 * fade;
				const color = {
					r: Math.floor(mist.color.r * scale),
					g: Math.floor(mist.color.g * scale),
					b: Math.floor(mist.color.b * scale),
				};
				this._paintMax(row, col, color);
				if (fade > 0.7) {
					const side = mist.vCol >= 0 ? col + 1 : col - 1;
					this._paintMax(row, side, {
						r: Math.floor(color.r * 0.65),
						g: Math.floor(color.g * 0.65),
						b: Math.floor(color.b * 0.65),
					});
				}
			}
		}

		_paintMax(row, col, color) {
			if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
			if (color.r === 0 && color.g === 0 && color.b === 0) return;
			const i = (row * this.w + col) * 3;
			if (color.r > this.grid[i]) this.grid[i] = color.r;
			if (color.g > this.grid[i + 1]) this.grid[i + 1] = color.g;
			if (color.b > this.grid[i + 2]) this.grid[i + 2] = color.b;
		}
	}

	api.presets['waterfall'] = [
		{
			key: 'thin-falls',
			label: 'thin falls',
			config: {
				intro_trickle: 0.1,
				intro_mist: 0.12,
				ending_linger: 18,
				ending_mist: 0.08,
				width: 4.5,
				wobble: 1.2,
				speed: 0.85,
				pool_span: 0.26,
				mist_spawn: 3,
				mist_max: 24,
				ripple_every: 11,
				ripple_max: 6,
				hue: 200,
				hue_sp: 10,
				sat: 0.42,
				lmin: 0.4,
				lmax: 0.78,
				calm_p: 0.001,
				calm_mult: 0.35,
				mist_burst_mult: 1.8,
			},
		},
		{
			key: 'steady-cascade',
			label: 'steady cascade',
			config: {
				width: 7.5,
				wobble: 1.6,
				speed: 1,
				pool_span: 0.36,
				mist_spawn: 2,
				mist_max: 48,
				ripple_every: 8,
				ripple_max: 10,
				hue: 204,
				hue_sp: 12,
				sat: 0.48,
				lmin: 0.45,
				lmax: 0.82,
				surge_p: 0.0008,
				calm_p: 0.0004,
				mist_burst_p: 0.0006,
			},
		},
		{
			key: 'misty-drop',
			label: 'misty drop',
			config: {
				intro_mist: 0.45,
				ending_mist: 0.45,
				width: 6.5,
				wobble: 1.4,
				speed: 0.95,
				pool_span: 0.38,
				mist_spawn: 1,
				mist_max: 72,
				ripple_every: 12,
				ripple_max: 8,
				hue: 196,
				hue_sp: 16,
				sat: 0.36,
				lmin: 0.42,
				lmax: 0.88,
				mist_burst_p: 0.0012,
				mist_burst_mult: 3.4,
			},
		},
		{
			key: 'heavy-plunge',
			label: 'heavy plunge',
			config: {
				intro_trickle: 0.22,
				intro_mist: 0.3,
				ending_dur: 75,
				ending_linger: 32,
				width: 10.5,
				wobble: 2.4,
				speed: 1.25,
				pool_span: 0.42,
				mist_spawn: 1,
				mist_max: 60,
				ripple_every: 6,
				ripple_max: 14,
				hue: 208,
				hue_sp: 14,
				sat: 0.52,
				lmin: 0.47,
				lmax: 0.86,
				surge_p: 0.0015,
				surge_mult: 2.1,
				calm_mult: 0.65,
				mist_burst_p: 0.001,
			},
		},
	];
	api.effects['waterfall'] = Waterfall;
})(window.AmbienceSim);
// ===== effects/wheat_field.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 60,
		intro_breeze: 0.16,
		ending_dur: 70,
		ending_linger: 20,
		ending_sway: 0.08,
		density: 0.48,
		speed: 0.12,
		drift: 0.16,
		sway: 0.68,
		wave_freq: 0.18,
		field_top: 0.62,
		stalk_h: 18,
		layers: 3,
		hue: 46,
		hue_sp: 18,
		sat: 0.64,
		lmin: 0.3,
		lmax: 0.76,
		gust_p: 0,
		calm_p: 0,
		gust_dur: 50,
		gust_mult: 1.85,
		calm_dur: 72,
		calm_mult: 0.4,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_breeze = clamp01(c.intro_breeze);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_sway = clamp01(c.ending_sway);
		if (c.density <= 0) c.density = DEFAULTS.density;
		if (c.speed <= 0) c.speed = DEFAULTS.speed;
		if (c.sway <= 0) c.sway = DEFAULTS.sway;
		if (c.wave_freq <= 0) c.wave_freq = DEFAULTS.wave_freq;
		if (c.field_top <= 0) c.field_top = DEFAULTS.field_top;
		if (c.stalk_h <= 0) c.stalk_h = DEFAULTS.stalk_h;
		if (c.layers < 1) c.layers = DEFAULTS.layers;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.gust_dur <= 0) c.gust_dur = DEFAULTS.gust_dur;
		if (c.gust_mult <= 0) c.gust_mult = DEFAULTS.gust_mult;
		if (c.calm_dur <= 0) c.calm_dur = DEFAULTS.calm_dur;
		if (c.calm_mult <= 0) c.calm_mult = DEFAULTS.calm_mult;
		return c;
	}

	class WheatField {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 47);
			switch (name) {
				case 'gust':
					this.timers.gust = jitterInt(rng, this.cfg.gust_dur, 0.3);
					this.values.gust_push = (rng() < 0.35 ? -1 : 1) * this.cfg.gust_mult * (0.55 + rng() * 0.55);
					return true;
				case 'calm':
					this.timers.calm = jitterInt(rng, this.cfg.calm_dur, 0.3);
					return true;
				case 'intro':
					this.timers.gust = 0;
					this.timers.calm = 0;
					this.timers.ending = 0;
					this.values.gust_push = 0;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.gust = 0;
					this.timers.calm = 0;
					this.values.gust_push = 0;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.gust || this.timers.gust <= 0) this.values.gust_push = 0;
		}

		_motionLevel() {
			let level = this.cfg.sway;
			if (this.timers.gust > 0) level *= 1 + Math.abs(this.values.gust_push || this.cfg.gust_mult) * 0.35;
			if (this.timers.calm > 0) level *= this.cfg.calm_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_breeze + (1 - this.cfg.intro_breeze) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_sway) * progress;
			}
			return Math.max(0.05, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, '#16213f');
				sky.addColorStop(0.56, '#556785');
				sky.addColorStop(1, '#d2ad66');
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const motion = this._motionLevel();
			const density = Math.max(0.08, this.cfg.density);
			const layers = Math.max(1, Math.round(this.cfg.layers));
			const gustPush = this.values.gust_push || 0;
			const fieldBase = Math.floor(this.h * this.cfg.field_top);

			const sunX = canvasW * (0.16 + this._hash(21000) * 0.18);
			const sunY = canvasH * (0.2 + this._hash(21001) * 0.06);
			const sunR = Math.max(18, Math.min(canvasW, canvasH) * 0.06);
			const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2.8);
			sun.addColorStop(0, 'rgba(255, 228, 153, 0.2)');
			sun.addColorStop(1, 'rgba(255, 228, 153, 0)');
			ctx.fillStyle = sun;
			ctx.fillRect(0, 0, canvasW, canvasH);

			const hillColor = hslToRGB(38, 0.18, 0.3);
			const hillPoints = [];
			for (let i = 0; i <= 8; i++) {
				hillPoints.push(Math.floor(this.h * 0.56) - Math.floor(this._hash(21100 + i) * 5) - Math.floor((0.5 + 0.5 * Math.sin(i * 0.9 + this._hash(21200 + i) * 3)) * 5));
			}
			ctx.fillStyle = `rgb(${hillColor.r},${hillColor.g},${hillColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (let x = 0; x < this.w; x++) {
				const pos = (x / Math.max(1, this.w - 1)) * 8;
				const idx = Math.min(7, Math.floor(pos));
				const frac = pos - idx;
				const eased = frac * frac * (3 - 2 * frac);
				const y = hillPoints[idx] + (hillPoints[idx + 1] - hillPoints[idx]) * eased;
				ctx.lineTo(Math.floor(x * sx), Math.floor(y * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const groundGrad = ctx.createLinearGradient(0, Math.floor(fieldBase * sy), 0, canvasH);
			groundGrad.addColorStop(0, '#b28d45');
			groundGrad.addColorStop(0.45, '#be9c56');
			groundGrad.addColorStop(1, '#8e6e32');
			ctx.fillStyle = groundGrad;
			ctx.fillRect(0, Math.floor(fieldBase * sy), canvasW, canvasH - Math.floor(fieldBase * sy));

			for (let layer = 0; layer < layers; layer++) {
				const layerRatio = layers === 1 ? 1 : layer / (layers - 1);
				const amp = motion * (2.4 + layerRatio * 4.8);
				const speed = this.cfg.speed * (0.4 + layerRatio * 0.65);
				const drift = this.cfg.drift * (0.25 + layerRatio * 0.75) + gustPush * 0.04 * (0.5 + layerRatio * 0.5);
				const topBase = fieldBase - this.cfg.stalk_h * (0.28 + layerRatio * 0.46);
				const tipChance = clamp01(density * (0.4 + layerRatio * 0.22));
				for (let x = 0; x < this.w;) {
					const clumpSeed = layer * 4000 + x;
					const width = Math.max(1, Math.min(4, Math.round(1 + this._hash(21700 + clumpSeed) * (1.2 + layerRatio * 2.4))));
					const sampleX = Math.min(this.w - 1, x + width * 0.5);
					const idx = layer * 2000 + sampleX;
					const wave = Math.sin(sampleX * this.cfg.wave_freq * (0.85 + layerRatio * 0.25) + this.tick * speed + layer * 1.7);
					const subWave = Math.sin(sampleX * this.cfg.wave_freq * 0.42 - this.tick * speed * 0.62 + layer * 2.3);
					const lean = wave * amp + subWave * amp * 0.32 + Math.sin(this.tick * 0.012 + sampleX * 0.05) * drift * 3.2;
					const top = Math.max(0, Math.min(this.h - 2, topBase + lean + this._hash(21300 + idx) * 2));
					const depth = Math.max(6, Math.round(this.cfg.stalk_h * (0.48 + layerRatio * 0.42)));
					const hue = ((this.cfg.hue + (this._hash(21400 + idx) * 2 - 1) * this.cfg.hue_sp) % 360 + 360) % 360;
					const light = clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * (0.18 + layerRatio * 0.6));
					const alpha = clamp01(0.34 + layerRatio * 0.24);
					const color = hslToRGB(hue, this.cfg.sat, light);
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, Math.round(top), width, depth, `rgb(${color.r},${color.g},${color.b})`, alpha);
					const shadow = hslToRGB(hue, clamp01(this.cfg.sat * 0.72), clamp01(light * 0.76));
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x, Math.round(top), width, Math.max(1, Math.round(depth * 0.28)), `rgb(${shadow.r},${shadow.g},${shadow.b})`, clamp01(alpha * 0.55));

					if (this._hash(21500 + idx) < tipChance) {
						const tipHeight = 1 + Math.floor(this._hash(21600 + idx) * (1 + layerRatio * 3));
						const tipX = Math.max(0, Math.min(this.w - 1, Math.round(x + width * 0.5 + lean * 0.18)));
						const accent = hslToRGB((hue + 4) % 360, clamp01(this.cfg.sat * 0.82), clamp01(light * 1.08));
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, tipX, Math.round(top) - tipHeight + 1, 1, tipHeight, `rgb(${accent.r},${accent.g},${accent.b})`, clamp01(alpha * 0.9));
					}
					x += width;
				}
			}
		}
	}

	api.presets['wheat-field'] = [
		{
			key: 'still-evening',
			label: 'still evening',
			config: {
				density: 0.4,
				speed: 0.07,
				drift: 0.05,
				sway: 0.34,
				wave_freq: 0.14,
				field_top: 0.64,
				stalk_h: 17,
				layers: 2,
				hue: 42,
				hue_sp: 12,
				sat: 0.56,
				lmin: 0.28,
				lmax: 0.7,
				calm_p: 0.001,
			},
		},
		{
			key: 'gentle-breeze',
			label: 'gentle breeze',
			config: {
				density: 0.48,
				speed: 0.12,
				drift: 0.14,
				sway: 0.68,
				wave_freq: 0.18,
				field_top: 0.62,
				stalk_h: 18,
				layers: 3,
				hue: 46,
				hue_sp: 18,
				sat: 0.64,
				lmin: 0.3,
				lmax: 0.76,
				gust_p: 0.0008,
			},
		},
		{
			key: 'rolling-field',
			label: 'rolling field',
			config: {
				density: 0.56,
				speed: 0.16,
				drift: 0.2,
				sway: 0.88,
				wave_freq: 0.16,
				field_top: 0.6,
				stalk_h: 20,
				layers: 3,
				hue: 48,
				hue_sp: 20,
				sat: 0.68,
				lmin: 0.3,
				lmax: 0.8,
				gust_p: 0.0012,
				gust_mult: 2.15,
			},
		},
		{
			key: 'windy-harvest',
			label: 'windy harvest',
			config: {
				density: 0.62,
				speed: 0.2,
				drift: 0.28,
				sway: 1.02,
				wave_freq: 0.21,
				field_top: 0.59,
				stalk_h: 22,
				layers: 4,
				hue: 44,
				hue_sp: 24,
				sat: 0.72,
				lmin: 0.32,
				lmax: 0.84,
				gust_p: 0.0016,
				gust_mult: 2.45,
				gust_dur: 66,
			},
		},
	];
	api.effects['wheat-field'] = WheatField;
})(window.AmbienceSim);
// ===== effects/windmill.js =====
'use strict';
(function (api) {
	const { makeRNG, jitterInt, clamp01, hslToRGB, positiveMod } = api._helpers;

	const DEFAULTS = {
		intro_dur: 45,
		intro_turn: 0.12,
		ending_dur: 60,
		ending_linger: 20,
		ending_turn: 0.05,
		turn_speed: 0.08,
		blade_len: 14,
		blade_width: 1.8,
		tower_height: 20,
		tower_width: 6,
		horizon: 0.72,
		glow: 0.18,
		hue: 28,
		hue_sp: 18,
		sat: 0.42,
		lmin: 0.18,
		lmax: 0.82,
		gust_p: 0,
		lull_p: 0,
		gust_dur: 50,
		gust_mult: 1.9,
		lull_dur: 72,
		lull_mult: 0.45,
	};

	function applyDefaults(cfg) {
		const c = Object.assign({}, DEFAULTS, cfg || {});
		if (c.intro_dur <= 0) c.intro_dur = DEFAULTS.intro_dur;
		c.intro_turn = clamp01(c.intro_turn);
		if (c.ending_dur <= 0) c.ending_dur = DEFAULTS.ending_dur;
		if (c.ending_linger < 0) c.ending_linger = 0;
		c.ending_turn = clamp01(c.ending_turn);
		if (c.turn_speed <= 0) c.turn_speed = DEFAULTS.turn_speed;
		if (c.blade_len <= 0) c.blade_len = DEFAULTS.blade_len;
		if (c.blade_width <= 0) c.blade_width = DEFAULTS.blade_width;
		if (c.tower_height <= 0) c.tower_height = DEFAULTS.tower_height;
		if (c.tower_width <= 0) c.tower_width = DEFAULTS.tower_width;
		if (c.horizon <= 0) c.horizon = DEFAULTS.horizon;
		if (c.glow <= 0) c.glow = DEFAULTS.glow;
		if (c.hue === 0) c.hue = DEFAULTS.hue;
		if (c.hue_sp < 0) c.hue_sp = 0;
		if (c.sat <= 0) c.sat = DEFAULTS.sat;
		if (c.lmin <= 0) c.lmin = DEFAULTS.lmin;
		if (c.lmax <= 0) c.lmax = DEFAULTS.lmax;
		if (c.lmax < c.lmin) [c.lmin, c.lmax] = [c.lmax, c.lmin];
		if (c.gust_dur <= 0) c.gust_dur = DEFAULTS.gust_dur;
		if (c.gust_mult <= 0) c.gust_mult = DEFAULTS.gust_mult;
		if (c.lull_dur <= 0) c.lull_dur = DEFAULTS.lull_dur;
		if (c.lull_mult <= 0) c.lull_mult = DEFAULTS.lull_mult;
		return c;
	}

	class Windmill {
		constructor(w, h, cfg, seed) {
			this.w = w;
			this.h = h;
			this.seed = Number(seed || Date.now());
			this.tick = 0;
			this.timers = {};
			this.values = {};
			this.cfg = applyDefaults(cfg);
		}

		setConfig(cfg) {
			this.cfg = applyDefaults(Object.assign({}, this.cfg, cfg));
		}

		restoreSnapshot(snap) {
			const state = snap.state || snap;
			this.setConfig(snap.config || {});
			this.tick = state.tick || snap.tick || 0;
			this.timers = Object.assign({}, state.timers || {});
			this.values = Object.assign({}, state.values || {});
			if (typeof snap.seed === 'number') this.seed = snap.seed;
			if (snap.gridW > 0 && snap.gridH > 0) {
				this.w = snap.gridW;
				this.h = snap.gridH;
			}
		}

		_eventRng(salt) {
			return makeRNG(((this.seed >>> 0) ^ (((this.tick + salt) * 2654435761) >>> 0)) >>> 0);
		}

		_hash(index) {
			const x = Math.sin((this.seed * 0.000001 + index * 12.9898) * 43758.5453);
			return x - Math.floor(x);
		}

		_phaseProgress(total, left) {
			if (left <= 1 || total <= 1) return 1;
			const elapsed = total - left;
			if (elapsed <= 0) return 0;
			return clamp01(elapsed / Math.max(1, total - 1));
		}

		_fillCell(ctx, sx, sy, ceilSx, ceilSy, x, y, w, h, color, alpha) {
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha == null ? 1 : alpha;
			ctx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.max(1, Math.ceil(w * sx || ceilSx)), Math.max(1, Math.ceil(h * sy || ceilSy)));
			ctx.globalAlpha = 1;
		}

		triggerEvent(name) {
			const rng = this._eventRng(name.length + 71);
			switch (name) {
				case 'gust':
					this.timers.gust = jitterInt(rng, this.cfg.gust_dur, 0.3);
					this.values.gust_gain = this.cfg.gust_mult * (0.75 + rng() * 0.45);
					return true;
				case 'lull':
					this.timers.lull = jitterInt(rng, this.cfg.lull_dur, 0.3);
					return true;
				case 'intro':
					this.timers.gust = 0;
					this.timers.lull = 0;
					this.timers.ending = 0;
					this.values.gust_gain = 1;
					this.timers.intro = Math.max(1, Math.round(this.cfg.intro_dur));
					this.values.intro_total = this.timers.intro;
					return true;
				case 'ending':
					this.timers.intro = 0;
					this.timers.gust = 0;
					this.timers.lull = 0;
					this.values.gust_gain = 1;
					this.timers.ending = Math.max(1, Math.round(this.cfg.ending_dur + Math.max(0, this.cfg.ending_linger)));
					this.values.ending_total = this.timers.ending;
					return true;
			}
			return false;
		}

		step() {
			this.tick++;
			for (const key of Object.keys(this.timers)) {
				if (this.timers[key] > 0) this.timers[key]--;
			}
			if (!this.timers.gust || this.timers.gust <= 0) this.values.gust_gain = 1;
		}

		_rotationLevel() {
			let level = 1;
			if (this.timers.gust > 0) level *= this.values.gust_gain || this.cfg.gust_mult;
			if (this.timers.lull > 0) level *= this.cfg.lull_mult;
			if (this.timers.intro > 0) {
				const total = this.values.intro_total || this.cfg.intro_dur;
				const progress = this._phaseProgress(total, this.timers.intro);
				level *= this.cfg.intro_turn + (1 - this.cfg.intro_turn) * progress;
			}
			if (this.timers.ending > 0) {
				const total = this.values.ending_total || (this.cfg.ending_dur + this.cfg.ending_linger);
				const progress = this._phaseProgress(total, this.timers.ending);
				level *= 1 - (1 - this.cfg.ending_turn) * progress;
			}
			return Math.max(0.03, level);
		}

		render(ctx, canvasW, canvasH, opts) {
			opts = opts || {};
			if (opts.transparent) {
				ctx.clearRect(0, 0, canvasW, canvasH);
			} else {
				const skyTop = hslToRGB((this.cfg.hue + 210) % 360, clamp01(this.cfg.sat * 0.5), clamp01(this.cfg.lmin * 0.95));
				const skyMid = hslToRGB((this.cfg.hue + 248) % 360, clamp01(this.cfg.sat * 0.42), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.32));
				const skyLow = hslToRGB(this.cfg.hue, clamp01(this.cfg.sat * 0.82), clamp01(this.cfg.lmin + (this.cfg.lmax - this.cfg.lmin) * 0.78));
				const sky = ctx.createLinearGradient(0, 0, 0, canvasH);
				sky.addColorStop(0, `rgb(${skyTop.r},${skyTop.g},${skyTop.b})`);
				sky.addColorStop(0.58, `rgb(${skyMid.r},${skyMid.g},${skyMid.b})`);
				sky.addColorStop(1, `rgb(${skyLow.r},${skyLow.g},${skyLow.b})`);
				ctx.fillStyle = sky;
				ctx.fillRect(0, 0, canvasW, canvasH);
			}

			const sx = canvasW / this.w;
			const sy = canvasH / this.h;
			const ceilSx = Math.ceil(sx);
			const ceilSy = Math.ceil(sy);
			const horizon = Math.max(8, Math.min(this.h - 8, Math.floor(this.h * this.cfg.horizon)));
			const centerX = Math.floor(this.w * 0.58);
			const rotationLevel = this._rotationLevel();
			const angle = this.tick * this.cfg.turn_speed * rotationLevel + Math.PI * 0.08;
			const towerH = Math.max(10, Math.round(this.cfg.tower_height));
			const towerW = Math.max(3, Math.round(this.cfg.tower_width));
			const bladeLen = Math.max(5, Math.round(this.cfg.blade_len));
			const bladeWidth = Math.max(1, this.cfg.blade_width);

			const horizonGlow = ctx.createLinearGradient(0, Math.floor((horizon - 3) * sy), 0, Math.floor((horizon + 7) * sy));
			horizonGlow.addColorStop(0, `rgba(255, 214, 163, ${0.04 + this.cfg.glow * 0.12})`);
			horizonGlow.addColorStop(1, 'rgba(255, 214, 163, 0)');
			ctx.fillStyle = horizonGlow;
			ctx.fillRect(0, Math.floor((horizon - 3) * sy), canvasW, Math.ceil(12 * sy));

			const hillRows = new Array(this.w);
			for (let x = 0; x < this.w; x++) {
				const broad = Math.sin(x * 0.045 + 0.4) * 1.2 + Math.sin(x * 0.012 + 1.3) * 2.1;
				const mound = Math.exp(-Math.pow((x - centerX) / 18, 2)) * 6.2 + Math.exp(-Math.pow((x - this.w * 0.18) / 24, 2)) * 2.1;
				hillRows[x] = Math.round(horizon + broad - mound);
			}

			const hillColor = hslToRGB((this.cfg.hue + 205) % 360, clamp01(this.cfg.sat * 0.16), 0.08);
			ctx.fillStyle = `rgb(${hillColor.r},${hillColor.g},${hillColor.b})`;
			ctx.beginPath();
			ctx.moveTo(0, canvasH);
			for (let x = 0; x < this.w; x++) {
				ctx.lineTo(Math.floor(x * sx), Math.floor(hillRows[x] * sy));
			}
			ctx.lineTo(canvasW, canvasH);
			ctx.closePath();
			ctx.fill();

			const baseY = hillRows[Math.max(0, Math.min(this.w - 1, centerX))];
			const hubY = baseY - towerH + 2;
			const millColor = hslToRGB((this.cfg.hue + 208) % 360, clamp01(this.cfg.sat * 0.08), 0.1);
			for (let y = hubY; y <= baseY; y++) {
				const ratio = (y - hubY) / Math.max(1, baseY - hubY);
				const half = Math.max(1, Math.round((towerW * (0.38 + ratio * 0.62)) * 0.5));
				for (let dx = -half; dx <= half; dx++) {
					this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, y, 1, 1, `rgb(${millColor.r},${millColor.g},${millColor.b})`, 1);
				}
			}

			for (let dx = -Math.max(2, Math.round(towerW * 0.42)); dx <= Math.max(2, Math.round(towerW * 0.42)); dx++) {
				const roofY = hubY - 2 + Math.abs(dx) * 0.4;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX + dx, Math.round(roofY), 1, 1, `rgb(${millColor.r},${millColor.g},${millColor.b})`, 1);
			}

			const windowGlow = hslToRGB(42, 0.72, clamp01(0.38 + this.cfg.glow * 0.5));
			const windowY = Math.round(hubY + towerH * 0.46);
			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX, windowY, 1, 2, `rgb(${windowGlow.r},${windowGlow.g},${windowGlow.b})`, clamp01(0.18 + this.cfg.glow * 0.58));

			const bladeColor = hslToRGB((this.cfg.hue + 210) % 360, clamp01(this.cfg.sat * 0.08), 0.13);
			for (let blade = 0; blade < 4; blade++) {
				const theta = angle + blade * Math.PI * 0.5;
				const px = -Math.sin(theta);
				const py = Math.cos(theta) * 0.88;
				for (let r = 1; r <= bladeLen; r++) {
					const fade = 1 - r / Math.max(1, bladeLen);
					const bx = centerX + Math.cos(theta) * r;
					const by = hubY + Math.sin(theta) * r * 0.88;
					const half = Math.max(0, Math.round(bladeWidth * fade * 0.55));
					for (let spread = -half; spread <= half; spread++) {
						this._fillCell(ctx, sx, sy, ceilSx, ceilSy, Math.round(bx + px * spread * 0.7), Math.round(by + py * spread * 0.7), 1, 1, `rgb(${bladeColor.r},${bladeColor.g},${bladeColor.b})`, 1);
					}
				}
			}

			this._fillCell(ctx, sx, sy, ceilSx, ceilSy, centerX - 1, hubY - 1, 3, 3, `rgb(${millColor.r},${millColor.g},${millColor.b})`, 1);

			const grassColor = hslToRGB((this.cfg.hue + 120) % 360, 0.16, 0.14);
			for (let x = 0; x < this.w; x += 2) {
				const top = hillRows[x];
				if ((x + this.tick) % 5 !== 0) continue;
				const sway = this.timers.gust > 0 ? (this.values.gust_gain || this.cfg.gust_mult) * 0.2 : this.timers.lull > 0 ? -this.cfg.lull_mult * 0.08 : 0.04;
				this._fillCell(ctx, sx, sy, ceilSx, ceilSy, x + Math.round(Math.sin(this.tick * 0.05 + x * 0.1) * sway), top - 1, 1, 2, `rgb(${grassColor.r},${grassColor.g},${grassColor.b})`, 0.28);
			}
		}
	}

	api.presets['windmill'] = [
		{
			key: 'still-dusk',
			label: 'still dusk',
			config: {
				intro_turn: 0.08,
				ending_turn: 0.04,
				turn_speed: 0.04,
				blade_len: 12,
				blade_width: 1.6,
				tower_height: 19,
				tower_width: 5.5,
				horizon: 0.74,
				glow: 0.22,
				hue: 26,
				hue_sp: 14,
				sat: 0.38,
				lmin: 0.16,
				lmax: 0.78,
			},
		},
		{
			key: 'steady-turning',
			label: 'steady turning',
			config: {
				turn_speed: 0.08,
				blade_len: 14,
				blade_width: 1.8,
				tower_height: 20,
				tower_width: 6,
				horizon: 0.72,
				glow: 0.18,
				hue: 28,
				hue_sp: 18,
				sat: 0.42,
				lmin: 0.18,
				lmax: 0.82,
				gust_p: 0.0006,
			},
		},
		{
			key: 'windy-hill',
			label: 'windy hill',
			config: {
				turn_speed: 0.12,
				blade_len: 15,
				blade_width: 2.1,
				tower_height: 21,
				tower_width: 6.5,
				horizon: 0.7,
				glow: 0.14,
				hue: 24,
				hue_sp: 20,
				sat: 0.4,
				lmin: 0.16,
				lmax: 0.8,
				gust_p: 0.0014,
				gust_mult: 2.2,
				gust_dur: 62,
			},
		},
		{
			key: 'silhouette-mill',
			label: 'silhouette mill',
			config: {
				turn_speed: 0.06,
				blade_len: 16,
				blade_width: 1.5,
				tower_height: 23,
				tower_width: 5,
				horizon: 0.76,
				glow: 0.1,
				hue: 222,
				hue_sp: 12,
				sat: 0.22,
				lmin: 0.12,
				lmax: 0.68,
				lull_p: 0.0012,
				lull_mult: 0.38,
			},
		},
	];
	api.effects['windmill'] = Windmill;
})(window.AmbienceSim);
