// client.js — shared auto-init ambience client.
//
// Any consumer page can opt in by dropping:
//
//   <canvas data-ambience></canvas>
//   <script src="https://ambience.romaine.life/sim.js"></script>
//   <script src="https://ambience.romaine.life/client.js"></script>
//
// and get a rain (or future effect) overlay plus live entropy contribution
// to the shared atmosphere. No per-consumer JS required.
//
// Configuration, via attributes on the <canvas>:
//   data-ambience-url="https://ambience.romaine.life"   — server override
//   data-ambience-grid-w="200" / data-ambience-grid-h="100" — sim grid size
//   data-ambience-transparent="false"  — paint solid bg (default: true)
//   data-ambience-entropy="off"        — disable keystroke entropy upload
//   data-ambience-delay-ticks="50"     — render this many 10 Hz ticks behind authority
//   data-ambience-initial-fade-ms="1200" — fade in after the first authority snapshot
//
// Effect agnostic: the server's snapshot broadcasts the effect type; this
// file looks it up in AmbienceSim.effects[type]. Adding a new effect means
// registering a new entry in sim.js — no change needed here.

(function () {
	'use strict';

	function createPlaybackClock(opts) {
		opts = opts || {};
		const now = opts.now || (() => performance.now());
		const tickMs = Math.max(1, opts.tickMs || 100);
		const delayTicks = Math.max(0, opts.delayTicks || 0);
		const softCatchupDrift = Math.max(1, opts.softCatchupDrift || 20);
		const hardCatchupDrift = Math.max(softCatchupDrift, opts.hardCatchupDrift || 100);
		const maxCatchupSteps = Math.max(1, opts.maxCatchupSteps || 5);
		let authoritySampleTick = 0;
		let authoritySampleAt = now();
		let haveAuthoritySample = false;

		function noteAuthorityTick(tick, sampleAt) {
			if (!Number.isFinite(tick)) return;
			authoritySampleTick = tick;
			authoritySampleAt = Number.isFinite(sampleAt) ? sampleAt : now();
			haveAuthoritySample = true;
		}

		function estimatedAuthorityTick(fallbackTick) {
			if (!haveAuthoritySample) return Number.isFinite(fallbackTick) ? fallbackTick : 0;
			const elapsedTicks = Math.floor((now() - authoritySampleAt) / tickMs);
			return authoritySampleTick + Math.max(0, elapsedTicks);
		}

		function targetPlaybackTick(fallbackTick) {
			return Math.max(0, estimatedAuthorityTick(fallbackTick) - delayTicks);
		}

		function stepsFor(currentTick) {
			const current = Number.isFinite(currentTick) ? currentTick : 0;
			const target = targetPlaybackTick(current);
			const drift = target - current;
			if (drift <= 0) return 0;
			if (drift > hardCatchupDrift) return maxCatchupSteps;
			if (drift > softCatchupDrift) return Math.min(maxCatchupSteps, 2);
			return 1;
		}

		function debugState(currentTick, queuedCommands) {
			const current = Number.isFinite(currentTick) ? currentTick : 0;
			const authorityTick = estimatedAuthorityTick(current);
			const playbackTick = targetPlaybackTick(current);
			return {
				authorityTick,
				playbackTick,
				simTick: current,
				driftTicks: playbackTick - current,
				delayTicks,
				tickMs,
				queuedCommands: queuedCommands || 0,
				haveAuthoritySample,
			};
		}

		return { noteAuthorityTick, estimatedAuthorityTick, targetPlaybackTick, stepsFor, debugState };
	}

	window.AmbienceClientClock = window.AmbienceClientClock || { createPlaybackClock };

	const canvas = document.querySelector('canvas[data-ambience]');
	if (!canvas) {
		console.warn('ambience-client: no <canvas data-ambience> found');
		return;
	}
	if (!window.AmbienceSim) {
		console.warn('ambience-client: AmbienceSim missing — load sim.js first');
		return;
	}

	const isLocalhost =
		location.hostname === 'localhost' || location.hostname === '127.0.0.1';
	const SERVER =
		canvas.dataset.ambienceUrl ||
		window.AMBIENCE_URL ||
		(isLocalhost ? 'http://127.0.0.1:8080' : 'https://ambience.romaine.life');
	const GRID_W = parseInt(canvas.dataset.ambienceGridW || '200', 10);
	const GRID_H = parseInt(canvas.dataset.ambienceGridH || '100', 10);
	const TRANSPARENT = canvas.dataset.ambienceTransparent !== 'false';
	const ENTROPY_ENABLED = canvas.dataset.ambienceEntropy !== 'off';
	const TICK_MS = 100;
	const PLAYBACK_DELAY_TICKS = Math.max(0, parseInt(canvas.dataset.ambienceDelayTicks || '50', 10) || 0);
	const INITIAL_FADE_MS = Math.max(0, parseInt(canvas.dataset.ambienceInitialFadeMs || '1200', 10) || 0);
	const MAX_CATCHUP_STEPS = 5;
	const SOFT_CATCHUP_DRIFT = 20;
	const HARD_CATCHUP_DRIFT = 100;

	const ctx = canvas.getContext('2d');

	// Mark body so consumer CSS can conditionally adapt (e.g. make terminal
	// backgrounds transparent only when ambience is actually running).
	document.body.classList.add('ambience-on');

	function resize() {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.floor(window.innerWidth * dpr);
		canvas.height = Math.floor(window.innerHeight * dpr);
	}
	resize();
	window.addEventListener('resize', resize);

	// The first snapshot tells us what effect is running. Until then, render
	// nothing; creating a local fallback effect makes subscribers visibly
	// diverge and can crossfade two worlds together during startup.
	let effectType = null;
	let sim = null;
	let ready = false;
	let initialFadePending = false;
	let initialFadeStarted = false;
	const pendingCommands = [];
	const clock = createPlaybackClock({
		tickMs: TICK_MS,
		delayTicks: PLAYBACK_DELAY_TICKS,
		softCatchupDrift: SOFT_CATCHUP_DRIFT,
		hardCatchupDrift: HARD_CATCHUP_DRIFT,
		maxCatchupSteps: MAX_CATCHUP_STEPS,
	});
	if (INITIAL_FADE_MS > 0) canvas.style.opacity = '0';

	function revealInitialScene() {
		if (initialFadeStarted) return;
		initialFadeStarted = true;
		if (INITIAL_FADE_MS <= 0) return;
		const opacityTransition = `opacity ${INITIAL_FADE_MS}ms ease`;
		canvas.style.transition = canvas.style.transition
			? `${canvas.style.transition}, ${opacityTransition}`
			: opacityTransition;
		requestAnimationFrame(() => { canvas.style.opacity = '1'; });
	}

	function getSimTick(s) {
		if (!s) return 0;
		if (s.isTransition && s.incoming) return getSimTick(s.incoming);
		return Number.isFinite(s.tick) ? s.tick : 0;
	}

	function stepTowardAuthorityClock() {
		const current = getSimTick(sim);
		const steps = clock.stepsFor(current);
		if (steps <= 0) {
			applyDueCommands(current);
			return;
		}
		for (let i = 0; i < steps; i++) {
			applyDueCommands(getSimTick(sim) + 1);
			sim.step();
		}
		applyDueCommands(getSimTick(sim));
	}

	function queueCommand(cmd, data) {
		pendingCommands.push({ cmd, data });
		pendingCommands.sort((a, b) => {
			const at = Number.isFinite(a.cmd.tick) ? a.cmd.tick : 0;
			const bt = Number.isFinite(b.cmd.tick) ? b.cmd.tick : 0;
			return at - bt;
		});
	}

	function applyDueCommands(playbackTick) {
		while (pendingCommands.length > 0) {
			const item = pendingCommands[0];
			const tick = Number.isFinite(item.cmd.tick) ? item.cmd.tick : playbackTick;
			if (tick > playbackTick) return;
			pendingCommands.shift();
			applyCommandNow(item.cmd, item.data);
		}
	}

	function applyCommandNow(cmd, data) {
		switch (cmd.kind) {
			case 'snapshot': {
				const newType = (data && data.type) || 'rain';
				const ctor = AmbienceSim.effects[newType];
				if (!ctor) {
					console.warn('ambience-client: unknown effect type', newType);
					break;
				}
				if (!sim) {
					sim = new ctor(GRID_W, GRID_H, {});
					try { sim.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
					effectType = newType;
					initialFadePending = true;
				} else if (newType !== effectType) {
					const incoming = new ctor(GRID_W, GRID_H, {});
					try { incoming.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
					sim = AmbienceSim.EffectTransition
						? new AmbienceSim.EffectTransition(sim, incoming)
						: incoming;
					effectType = newType;
				} else {
					try { sim.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
				}
				ready = true;
				break;
			}
			case 'config':
				if (!sim) break;
				try { sim.setConfig(data); } catch (err) { console.error('bad config', err); }
				break;
			case 'trigger':
				if (sim && sim.triggerEvent) sim.triggerEvent(cmd.event);
				break;
		}
	}

	// Patch the subscribe snapshot handler so we can detect effect-type
	// changes (for when more effects ship). The shared subscribe() swaps
	// config on the existing sim; a type switch crossfades the outgoing
	// effect into the incoming one via AmbienceSim.EffectTransition.
	const es = new EventSource(SERVER.replace(/\/+$/, '') + '/events');
	es.addEventListener('message', (e) => {
		let cmd;
		try { cmd = JSON.parse(e.data); } catch (_) { return; }
		clock.noteAuthorityTick(cmd.tick);
		const data = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
		switch (cmd.kind) {
			case 'snapshot':
				if (!ready) {
					applyCommandNow(cmd, data);
				} else {
					queueCommand(cmd, data);
				}
				break;
			case 'metric':
			case 'scene':
			case 'clock':
				break;
			case 'config':
			case 'trigger':
				queueCommand(cmd, data);
				break;
		}
	});

	window.AmbienceClient = {
		getDebugState: () => Object.assign(
			{ effectType, ready, initialFadeStarted },
			clock.debugState(getSimTick(sim), pendingCommands.length),
		),
	};

	// Combined 10 Hz tick (matches server atmosphere rate). Step + render
	// in one setInterval — rAF pauses in background tabs and we don't need
	// 60 Hz for a 10 Hz sim.
	setInterval(() => {
		if (ready) stepTowardAuthorityClock();
		// Unwrap a finished crossfade so we drop the outgoing sim and stop
		// paying its render cost.
		if (!sim) return;
		if (sim.isTransition && sim.done()) sim = sim.incoming;
		sim.render(ctx, canvas.width, canvas.height, { transparent: TRANSPARENT });
		if (initialFadePending) {
			initialFadePending = false;
			revealInitialScene();
		}
	}, 100);

	// ── Entropy ──────────────────────────────────────────────────
	// Every keystroke contributes a few bits derived from the key identity
	// and its wall-clock timing. Batched and POSTed at a throttle so typing
	// doesn't flood the server. The server folds bits into the shared
	// atmosphere's RNG — see POST /entropy.
	if (ENTROPY_ENABLED) {
		const buf = [];
		const FLUSH_INTERVAL_MS = 2000;
		const MAX_BUFFERED = 256;

		document.addEventListener('keydown', (e) => {
			// Hash: low-byte of key charCode ^ low-byte of milliseconds since
			// epoch. Cheap, plenty of variance for entropy purposes.
			const k = (e.key && e.key.charCodeAt(0)) || 0;
			const t = Date.now() & 0xff;
			buf.push((k ^ t) & 0xff);
			if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);
		}, { passive: true });

		setInterval(() => {
			if (buf.length === 0) return;
			const bytes = buf.splice(0, buf.length);
			// Fire-and-forget; keepalive=true so it completes on unload
			try {
				fetch(SERVER.replace(/\/+$/, '') + '/entropy', {
					method: 'POST',
					body: new Uint8Array(bytes),
					keepalive: true,
				}).catch(() => {});
			} catch (_) { /* swallow */ }
		}, FLUSH_INTERVAL_MS);
	}
})();
