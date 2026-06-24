// client.js — shared auto-init ambience client.
//
// Any consumer page can opt in by dropping:
//
//   <canvas data-ambience></canvas>
//   <script src="https://ambience.romaine.life/sim.js"></script>
//   <script src="https://ambience.romaine.life/client.js"></script>
//
// and get a rain (or future effect) overlay plus live entropy contribution
// to the shared atmosphere. client.js loads the Go/WASM runtime itself; no
// per-consumer JS required.
//
// Configuration, via attributes on the <canvas>:
//   data-ambience-url="https://ambience.romaine.life"   — stream/server override
//   data-ambience-wasm-url / -wasm-exec-url / -runtime-url — load the runtime
//     from a vendored, version-pinned copy instead of the stream origin. Lets a
//     consumer bundle its own (effect-scoped) WASM while subscribing to a world.
//   data-ambience-grid-w="320" / data-ambience-grid-h="180" — sim grid size
//   data-ambience-transparent="false"  — paint solid bg (default: true)
//   data-ambience-entropy="off"        — disable keystroke entropy upload
//   data-ambience-delay-ticks="300"    — render this many authority ticks behind authority
//   data-ambience-initial-fade-ms="1200" — fade in after the first authority snapshot
//   data-ambience-initial-fade-color="#050505" — startup cover color
//
// Effect agnostic: the server's snapshot broadcasts the effect type; this
// file looks it up in AmbienceSim.effects[type]. Adding a new effect means
// registering a Go-backed constructor through wasm_runtime.js — no change
// needed here.

(function () {
	'use strict';

	function createPlaybackClock(opts) {
		opts = opts || {};
		const now = opts.now || (() => performance.now());
		let tickMs = Math.max(1, opts.tickMs || 100);
		let delayTicks = Math.max(0, opts.delayTicks || 0);
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

		function configure(next) {
			if (!next) return;
			if (Number.isFinite(next.tickMs) && next.tickMs > 0) tickMs = Math.max(1, next.tickMs);
			if (Number.isFinite(next.delayTicks) && next.delayTicks >= 0) delayTicks = Math.max(0, Math.round(next.delayTicks));
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
			if (drift > 1) return Math.min(maxCatchupSteps, 2);
			return 1;
		}

		function debugState(currentTick, queueInfo) {
			const current = Number.isFinite(currentTick) ? currentTick : 0;
			const authorityTick = estimatedAuthorityTick(current);
			const playbackTick = targetPlaybackTick(current);
			const queuedCommands = typeof queueInfo === 'number'
				? queueInfo
				: (queueInfo && Number.isFinite(queueInfo.queuedCommands) ? queueInfo.queuedCommands : 0);
			const nextQueuedCommandTick = queueInfo && Number.isFinite(queueInfo.nextQueuedCommandTick)
				? queueInfo.nextQueuedCommandTick
				: null;
			const maxQueuedCommandTick = queueInfo && Number.isFinite(queueInfo.maxQueuedCommandTick)
				? queueInfo.maxQueuedCommandTick
				: null;
			const bufferedAheadTicks = maxQueuedCommandTick === null
				? 0
				: Math.max(0, maxQueuedCommandTick - playbackTick);
			return {
				authorityTick,
				playbackTick,
				simTick: current,
				driftTicks: playbackTick - current,
				delayTicks,
				bufferedAheadTicks,
				tickMs,
				queuedCommands,
				nextQueuedCommandTick,
				maxQueuedCommandTick,
				haveAuthoritySample,
			};
		}

		return { noteAuthorityTick, configure, estimatedAuthorityTick, targetPlaybackTick, stepsFor, debugState };
	}

	window.AmbienceClientClock = window.AmbienceClientClock || { createPlaybackClock };

	function loadScript(src) {
		return new Promise((resolve, reject) => {
			const el = document.createElement('script');
			el.src = src;
			el.async = true;
			el.onload = resolve;
			el.onerror = () => reject(new Error('failed to load ' + src));
			document.head.appendChild(el);
		});
	}

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
	const trimSlashes = (s) => s.replace(/\/+$/, '');
	// Asset URLs default to SERVER (load the runtime from the same origin as the
	// stream). A vendoring consumer overrides them so the WASM/runtime load from
	// its OWN bundled, version-pinned copy while the stream still points at the
	// world. This is what lets the chess menu ship a vendored rain-only WASM yet
	// subscribe to ambience's /chess world.
	const WASM_URL =
		canvas.dataset.ambienceWasmUrl || trimSlashes(SERVER) + '/ambience.wasm';
	const WASM_EXEC_URL =
		canvas.dataset.ambienceWasmExecUrl || trimSlashes(SERVER) + '/wasm_exec.js';
	const RUNTIME_URL =
		canvas.dataset.ambienceRuntimeUrl || trimSlashes(SERVER) + '/wasm_runtime.js';
	const GRID_W = parseInt(canvas.dataset.ambienceGridW || '320', 10);
	const GRID_H = parseInt(canvas.dataset.ambienceGridH || '180', 10);
	const TRANSPARENT = canvas.dataset.ambienceTransparent !== 'false';
	const ENTROPY_ENABLED = canvas.dataset.ambienceEntropy !== 'off';
	const TICK_MS = 1000 / 60;
	const HAS_DELAY_ATTR = canvas.dataset.ambienceDelayTicks != null;
	const PLAYBACK_DELAY_TICKS = Math.max(0, parseInt(canvas.dataset.ambienceDelayTicks || '300', 10) || 0);
	const INITIAL_FADE_MS = Math.max(0, parseInt(canvas.dataset.ambienceInitialFadeMs || '1200', 10) || 0);
	const MAX_CATCHUP_STEPS = 5;
	const SOFT_CATCHUP_DRIFT = 20;
	const HARD_CATCHUP_DRIFT = 100;

	const ctx = canvas.getContext('2d');
	if (canvas.style) canvas.style.imageRendering = canvas.style.imageRendering || 'pixelated';
	ctx.imageSmoothingEnabled = false;
	let initialFadeCover = null;

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
	let lastError = null;
	// Capability handshake: on the first snapshot we verify this client's
	// runtime supports every effect the world advertises in servedEffects. If
	// one is missing, the client was not built for this world — fail loudly
	// (log + refuse to render) instead of silently mis-rendering.
	let handshakeChecked = false;
	let handshakeOK = true;
	const sceneState = {
		currentName: null,
		nextName: null,
		sceneRemaining: null,
		durationTicks: null,
		startedAtTick: null,
	};
	const pendingCommands = [];
	const clock = createPlaybackClock({
		tickMs: TICK_MS,
		delayTicks: PLAYBACK_DELAY_TICKS,
		softCatchupDrift: SOFT_CATCHUP_DRIFT,
		hardCatchupDrift: HARD_CATCHUP_DRIFT,
		maxCatchupSteps: MAX_CATCHUP_STEPS,
	});

	function makeInitialFadeCover() {
		if (INITIAL_FADE_MS <= 0) return null;
		const cover = document.createElement('div');
		const canvasStyle = getComputedStyle(canvas);
		const bodyStyle = getComputedStyle(document.body);
		const color =
			canvas.dataset.ambienceInitialFadeColor ||
			bodyStyle.backgroundColor ||
			'#000';
		cover.setAttribute('aria-hidden', 'true');
		cover.style.position = 'fixed';
		cover.style.inset = '0';
		cover.style.pointerEvents = 'none';
		cover.style.background = color;
		cover.style.opacity = '1';
		cover.style.zIndex = canvasStyle.zIndex === 'auto' ? 'auto' : canvasStyle.zIndex;
		cover.style.willChange = 'opacity';
		canvas.insertAdjacentElement('afterend', cover);
		return cover;
	}

	initialFadeCover = makeInitialFadeCover();

	function revealInitialScene() {
		if (initialFadeStarted) return;
		initialFadeStarted = true;
		if (!initialFadeCover || INITIAL_FADE_MS <= 0) {
			if (initialFadeCover) initialFadeCover.remove();
			initialFadeCover = null;
			return;
		}
		const cover = initialFadeCover;
		if (cover.animate) {
			const fade = cover.animate(
				[{ opacity: 1 }, { opacity: 0 }],
				{ duration: INITIAL_FADE_MS, easing: 'ease', fill: 'both' },
			);
			fade.finished
				.then(() => { cover.remove(); })
				.catch(() => { cover.remove(); });
			initialFadeCover = null;
			return;
		}
		cover.style.transition = `opacity ${INITIAL_FADE_MS}ms ease`;
		cover.offsetWidth;
		cover.style.opacity = '0';
		setTimeout(() => { cover.remove(); }, INITIAL_FADE_MS + 50);
		initialFadeCover = null;
	}

	function getSimTick(s) {
		if (!s) return 0;
		if (s.isTransition && s.incoming) return getSimTick(s.incoming);
		return Number.isFinite(s.tick) ? s.tick : 0;
	}

	function getSimDebug(s) {
		if (!s) return null;
		if (s.isTransition && s.incoming) return getSimDebug(s.incoming);
		if (typeof s.getDebugState === 'function') return s.getDebugState();
		return null;
	}

	function updateSceneFromSnapshot(data) {
		if (!data) return;
		if (data.currentScene) {
			sceneState.currentName = data.currentScene.name || sceneState.currentName;
			sceneState.durationTicks = Number.isFinite(data.currentScene.durationTicks)
				? data.currentScene.durationTicks
				: sceneState.durationTicks;
			sceneState.startedAtTick = Number.isFinite(data.currentScene.startedAtTick)
				? data.currentScene.startedAtTick
				: sceneState.startedAtTick;
		}
		if (data.nextScene) sceneState.nextName = data.nextScene.name || sceneState.nextName;
		if (Number.isFinite(data.sceneRemaining)) sceneState.sceneRemaining = data.sceneRemaining;
	}

	function applySceneData(data) {
		if (!data) return;
		sceneState.currentName = data.name || data.currentName || sceneState.currentName;
		sceneState.nextName = data.nextName || sceneState.nextName;
		sceneState.durationTicks = Number.isFinite(data.durationTicks) ? data.durationTicks : sceneState.durationTicks;
		sceneState.startedAtTick = Number.isFinite(data.startedAtTick) ? data.startedAtTick : sceneState.startedAtTick;
		if (Number.isFinite(data.sceneRemaining)) sceneState.sceneRemaining = data.sceneRemaining;
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

	function commandQueueTelemetry() {
		let nextQueuedCommandTick = null;
		let maxQueuedCommandTick = null;
		for (const item of pendingCommands) {
			const tick = Number.isFinite(item.cmd.tick) ? item.cmd.tick : null;
			if (tick === null) continue;
			if (nextQueuedCommandTick === null || tick < nextQueuedCommandTick) nextQueuedCommandTick = tick;
			if (maxQueuedCommandTick === null || tick > maxQueuedCommandTick) maxQueuedCommandTick = tick;
		}
		return {
			queuedCommands: pendingCommands.length,
			nextQueuedCommandTick,
			maxQueuedCommandTick,
		};
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

	// runHandshake verifies the client supports every effect the world may
	// broadcast. Returns false (and logs) when an advertised effect is missing
	// from this build. An older authority that advertises nothing passes.
	function runHandshake(served) {
		if (!Array.isArray(served) || served.length === 0) return true;
		const missing = served.filter((name) => !AmbienceSim.effects[name]);
		if (missing.length === 0) return true;
		lastError = `client missing world effects: ${missing.join(', ')}`;
		console.error(
			'[ambience] handshake failed — this client was not built to render ' +
			`effect(s) [${missing.join(', ')}] served by ${SERVER}. Update the ` +
			'ambience client to a version that includes them.',
		);
		return false;
	}

	function applyCommandNow(cmd, data) {
		switch (cmd.kind) {
			case 'snapshot': {
				if (!handshakeChecked) {
					handshakeChecked = true;
					handshakeOK = runHandshake(data && data.servedEffects);
				}
				if (!handshakeOK) break;
				const newType = (data && data.type) || 'rain';
				const ctor = AmbienceSim.effects[newType];
				if (!ctor) {
					lastError = `unknown effect type: ${newType}`;
					console.warn('ambience-client: unknown effect type', newType);
					break;
				}
				lastError = null;
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
				updateSceneFromSnapshot(data);
				ready = true;
				if (Number.isFinite(data && data.tick)) {
					for (let i = pendingCommands.length - 1; i >= 0; i--) {
						const queuedTick = Number.isFinite(pendingCommands[i].cmd.tick) ? pendingCommands[i].cmd.tick : data.tick;
						if (queuedTick <= data.tick) pendingCommands.splice(i, 1);
					}
				}
				break;
			}
			case 'config':
				if (!sim) break;
				try { sim.setConfig(data); } catch (err) { console.error('bad config', err); }
				break;
			case 'trigger':
				if (sim && sim.triggerEvent) sim.triggerEvent(cmd.event);
				break;
			case 'scene':
			case 'metric':
				applySceneData(data);
				break;
		}
	}

	window.AmbienceClient = {
		getDebugState: () => Object.assign(
			{
				effectType,
				ready,
				initialFadeStarted,
				scene: Object.assign({}, sceneState),
				sim: getSimDebug(sim),
				lastError,
			},
			clock.debugState(getSimTick(sim), commandQueueTelemetry()),
		),
	};

	async function start() {
		if (!AmbienceSim.wasm) {
			await loadScript(RUNTIME_URL);
		}
		if (!AmbienceSim.wasm || !AmbienceSim.wasm.ready) {
			throw new Error('ambience-client: Go WASM runtime missing');
		}
		await AmbienceSim.wasm.ready({
			wasmExecURL: WASM_EXEC_URL,
			wasmURL: WASM_URL,
		});

		// Patch the subscribe snapshot handler so we can detect effect-type
		// changes. The shared subscribe() swaps config on the existing sim; a
		// type switch crossfades the outgoing effect into the incoming one.
		const es = new EventSource(SERVER.replace(/\/+$/, '') + '/events');
		es.addEventListener('message', (e) => {
			let cmd;
			try { cmd = JSON.parse(e.data); } catch (_) { return; }
			const data = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
			if (cmd.kind === 'clock' && data) {
				clock.configure({
					tickMs: Number(data.tickRateMs),
					delayTicks: HAS_DELAY_ATTR ? undefined : Number(data.suggestedDelayTicks),
				});
				clock.noteAuthorityTick(Number.isFinite(data.tick) ? data.tick : cmd.tick);
			} else {
				clock.noteAuthorityTick(cmd.tick);
			}
			switch (cmd.kind) {
				case 'snapshot':
					applyCommandNow(cmd, data);
					break;
				case 'metric':
				case 'scene':
					applyCommandNow(cmd, data);
					break;
				case 'clock':
					break;
				case 'config':
				case 'trigger':
					queueCommand(cmd, data);
					break;
			}
		});

		// Step and render on the authority cadence. rAF stays out of the
		// simulation clock so background-tab throttling cannot silently change
		// the replica's tick math.
		setInterval(() => {
			if (ready) stepTowardAuthorityClock();
			// Unwrap a finished crossfade so we drop the outgoing sim and stop
			// paying its render cost.
			if (!sim) return;
			if (sim.isTransition && sim.done()) {
				if (sim.outgoing && typeof sim.outgoing.destroy === 'function') sim.outgoing.destroy();
				sim = sim.incoming;
			}
			sim.render(ctx, canvas.width, canvas.height, { transparent: TRANSPARENT });
			if (initialFadePending) {
				initialFadePending = false;
				revealInitialScene();
			}
		}, Math.max(1, Math.round(TICK_MS)));
	}

	function startEntropy() {
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

	start()
		.then(() => {
			if (ENTROPY_ENABLED) startEntropy();
		})
		.catch((err) => {
			console.error(err);
		});
})();
