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
//   data-ambience-delay-ticks="90"     — pin how many world ticks behind the
//     authority this page plays. Omit it to use the world's suggested delay.
//   data-ambience-initial-fade-ms="1200" — fade in after the first authority snapshot
//   data-ambience-initial-fade-color="#050505" — startup cover color
//   data-ambience-intro-on-join="off" — disable the join intro. By default a
//     freshly-connected client does NOT drop into the world mid-storm: it plays
//     the effect's "intro" beat so the scene eases in (rain starts spawning from
//     a near-empty grid) instead of the full atmosphere jolting on at once. Set
//     to "off" to restore instant mid-simulation replication for this consumer.
//
// Effect agnostic: the server's snapshot broadcasts the effect type; this
// file looks it up in AmbienceSim.effects[type]. Adding a new effect means
// registering a Go-backed constructor through wasm_runtime.js — no change
// needed here.
//
// Loaded with a `data-ambience-library` attribute on its <script> tag, this file
// only defines window.AmbiencePlayback (the live monitor at / drives its own
// canvas with it) and skips the auto-init.

(function () {
	'use strict';

	// ── shared playback ─────────────────────────────────────────────────────
	// Every page shows the same world at the same moment by playing the world
	// tick a fixed delay behind the authority. Commands are stamped with the
	// world tick they happened on and arrive well before playback reaches them,
	// so each one lands on the same tick on every screen.
	//
	// Playback is stepped from the page's frames at the authority's rate. It
	// never stops to wait and never sprints: a small difference from the target
	// is absorbed by running a few percent fast or slow, which can't be seen.
	// A larger gap (a stalled or hidden tab) is closed in a single frame, by
	// simulating the missed ticks without drawing them or, beyond what is cheap
	// to simulate, by restoring a fresh snapshot.
	const PLAYBACK_DEFAULTS = {
		tickMs: 1000 / 60,
		delayTicks: 90,
		// Rate correction: full correction at this many ticks off target.
		correctionSpanTicks: 30,
		maxSlowdown: 0.05,
		maxSpeedup: 0.08,
		// Behind by more than this, catch up in one undrawn burst.
		jumpBehindTicks: 30,
		// Behind by more than this, restore a fresh snapshot first.
		resyncBehindTicks: 600,
		// Ahead by more than delay + this, the world clock went backwards
		// (authority restarted); restore a fresh snapshot.
		resyncAheadTicks: 120,
		// A frame gap longer than this is a stall, not a frame: don't turn it
		// into steps, let the gap logic close it.
		maxFrameMs: 250,
		maxStepsPerFrame: 4,
		// Authority clock samples older than this stop counting toward the
		// estimate, so a server that slows down is followed.
		sampleWindowMs: 10000,
		retrySnapshotMs: 3000,
	};

	function createPlayback(opts) {
		const o = Object.assign({}, PLAYBACK_DEFAULTS, opts || {});
		const now = o.now || (() => performance.now());
		const effects = o.effects;
		const gridW = o.gridW;
		const gridH = o.gridH;
		let tickMs = o.tickMs;
		let delayTicks = o.delayTicks;
		const pinnedDelay = o.pinnedDelayTicks != null;
		if (pinnedDelay) delayTicks = Math.max(0, o.pinnedDelayTicks);

		let sim = null;
		let effectType = null;
		let ready = false;
		let handshakeChecked = false;
		let handshakeOK = true;
		let lastError = null;
		// playTick is the world tick the replica has been stepped to.
		let playTick = 0;
		let acc = 0;
		let rate = 1;
		let lastFrameAt = null;
		let resyncInFlight = false;
		let lastResyncAttemptAt = -Infinity;
		const counters = { jumps: 0, jumpedTicks: 0, resyncs: 0, lateCommands: 0 };
		const pending = [];
		let nextSeq = 0;
		// Authority clock samples: [worldTick, receivedAt].
		const samples = [];

		function noteSample(tick, at) {
			if (!Number.isFinite(tick)) return;
			// noteSnapshotSample handles a world clock that went backwards.
			samples.push([tick, at]);
			while (samples.length > 1 && at - samples[0][1] > o.sampleWindowMs) samples.shift();
		}

		// The authority's world tick right now. A sample can only arrive late,
		// never early, so the least-delayed one in the window is the best
		// estimate.
		function authorityTick(at) {
			let best = null;
			for (const [tick, receivedAt] of samples) {
				const est = tick + (at - receivedAt) / tickMs;
				if (best === null || est > best) best = est;
			}
			return best;
		}

		// A snapshot is the authority's state when it was sent (an edge's cached
		// one trails by seconds, never minutes). One far behind the estimate means
		// the world clock went backwards (an authority restarted without its
		// saved state): forget the old clock.
		function noteSnapshotSample(tick, at) {
			const est = authorityTick(at);
			if (est !== null && tick < est - o.resyncBehindTicks) samples.length = 0;
			noteSample(tick, at);
		}

		function targetTick(at) {
			const a = authorityTick(at);
			return a === null ? null : a - delayTicks;
		}

		function worldTickOf(cmd, data) {
			if (data && Number.isFinite(data.worldTick)) return data.worldTick;
			if (cmd && Number.isFinite(cmd.tick)) return cmd.tick;
			if (data && Number.isFinite(data.tick)) return data.tick;
			return 0;
		}

		// runHandshake verifies the client supports every effect the world may
		// broadcast. Returns false (and logs) when an advertised effect is missing
		// from this build. An older authority that advertises nothing passes.
		function runHandshake(served) {
			if (!Array.isArray(served) || served.length === 0) return true;
			const missing = served.filter((name) => !effects[name]);
			if (missing.length === 0) return true;
			lastError = `client missing world effects: ${missing.join(', ')}`;
			console.error(
				'[ambience] handshake failed — this client was not built to render ' +
				`effect(s) [${missing.join(', ')}] served by ${o.server || 'this world'}. ` +
				'Update the ambience client to a version that includes them.',
			);
			return false;
		}

		// applySnapshot puts the replica at the snapshot's moment. A different
		// effect type crossfades from the outgoing replica; the same type is
		// restored in place.
		function applySnapshot(data, worldTick, seq) {
			if (!handshakeChecked) {
				handshakeChecked = true;
				handshakeOK = runHandshake(data && data.servedEffects);
			}
			if (!handshakeOK) return;
			const newType = (data && data.type) || 'rain';
			const Ctor = effects[newType];
			if (!Ctor) {
				lastError = `unknown effect type: ${newType}`;
				console.warn('ambience-client: unknown effect type', newType);
				return;
			}
			lastError = null;
			const first = !sim;
			const typeChanged = !first && newType !== effectType;
			if (first || typeChanged) {
				const incoming = new Ctor(gridW, gridH, {});
				try { incoming.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
				// A "fresh" effect (rain) is steady-state: a page that is just
				// joining starts it from its intro so it eases in instead of
				// jolting on mid-storm. "restore" effects carry history and keep
				// the snapshot as-is.
				if (first && o.introOnJoin && data && data.joinMode === 'fresh' && incoming.triggerEvent) {
					try { incoming.triggerEvent('intro'); } catch (err) { console.error('join intro failed', err); }
				}
				sim = typeChanged && o.EffectTransition ? new o.EffectTransition(sim, incoming) : incoming;
			} else {
				try { sim.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
			}
			effectType = newType;
			playTick = worldTick;
			acc = 0;
			// Commands that arrived before this snapshot and fall at or before
			// its moment are already part of its state.
			const cutoff = seq === undefined ? Infinity : seq;
			for (let i = pending.length - 1; i >= 0; i--) {
				if (pending[i].tick <= worldTick && pending[i].seq < cutoff) pending.splice(i, 1);
			}
			ready = true;
			if (o.onSnapshot) o.onSnapshot(data, { first, typeChanged });
		}

		function applyCommand(item) {
			const { cmd, data } = item;
			switch (cmd.kind) {
				case 'snapshot':
					applySnapshot(data, item.tick, item.seq);
					break;
				case 'config':
					if (!sim) break;
					try { sim.setConfig(data); } catch (err) { console.error('bad config', err); }
					break;
				case 'trigger':
					if (sim && sim.triggerEvent) sim.triggerEvent(cmd.event);
					break;
			}
			if (o.onApplied) o.onApplied(cmd, data);
		}

		function queue(item) {
			item.seq = nextSeq++;
			// Stable insert by tick: same-tick commands keep arrival order.
			let i = pending.length;
			while (i > 0 && pending[i - 1].tick > item.tick) i--;
			pending.splice(i, 0, item);
		}

		// stepOnce advances one world tick. Commands due by then apply first; a
		// snapshot due by then is that tick's state, so it replaces the step.
		function stepOnce() {
			const next = playTick + 1;
			let snapped = false;
			while (pending.length > 0 && pending[0].tick <= next) {
				const item = pending.shift();
				applyCommand(item);
				if (item.cmd.kind === 'snapshot') snapped = true;
			}
			if (!snapped) {
				sim.step();
				playTick = next;
			}
			if (sim.isTransition && sim.done()) {
				if (sim.outgoing && typeof sim.outgoing.destroy === 'function') sim.outgoing.destroy();
				sim = sim.incoming;
			}
		}

		// onCommand takes every authority command. Config, trigger and later
		// snapshots wait in the buffer for their world tick; scene and metric
		// are display metadata and pass straight through.
		function onCommand(cmd, data) {
			const at = now();
			const tick = worldTickOf(cmd, data);
			if (cmd.kind === 'clock' && data) {
				if (Number(data.tickRateMs) > 0) tickMs = Number(data.tickRateMs);
				if (!pinnedDelay && Number(data.suggestedDelayTicks) >= 0) delayTicks = Number(data.suggestedDelayTicks);
			}
			if (cmd.kind === 'snapshot') noteSnapshotSample(tick, at);
			else noteSample(tick, at);
			switch (cmd.kind) {
				case 'snapshot':
					if (!ready) {
						applySnapshot(data, tick, nextSeq++);
						// Start where the world is now, minus the delay, so the
						// page needs no warm-up.
						const target = targetTick(at);
						if (target !== null && target > playTick) catchUp(Math.floor(target), false);
					} else if (tick > playTick) {
						queue({ tick, cmd, data });
					} else {
						// A snapshot for a moment already played (a reconnect, a
						// restarted authority): take it as the new truth.
						applySnapshot(data, tick, nextSeq++);
					}
					break;
				case 'config':
				case 'trigger':
					if (ready && tick <= playTick) {
						counters.lateCommands++;
						applyCommand({ tick, cmd, data });
					} else {
						queue({ tick, cmd, data });
					}
					break;
			}
		}

		// catchUp simulates to `to` without drawing in between.
		function catchUp(to, counted) {
			const from = playTick;
			while (playTick < to) stepOnce();
			if (counted && playTick > from) {
				counters.jumps++;
				counters.jumpedTicks += playTick - from;
			}
		}

		function resync() {
			if (resyncInFlight || !o.fetchSnapshot) return;
			const at = now();
			if (at - lastResyncAttemptAt < o.retrySnapshotMs) return;
			lastResyncAttemptAt = at;
			resyncInFlight = true;
			Promise.resolve()
				.then(() => o.fetchSnapshot())
				.then((data) => {
					if (!data) return;
					counters.resyncs++;
					const tick = worldTickOf(null, data);
					noteSnapshotSample(tick, now());
					applySnapshot(data, tick);
				})
				.catch((err) => { console.warn('ambience-client: snapshot resync failed', err); })
				.finally(() => { resyncInFlight = false; });
		}

		// frame advances playback to `at` and returns how many ticks it stepped.
		function frame(at) {
			if (at === undefined) at = now();
			if (!ready || !sim) {
				lastFrameAt = at;
				return 0;
			}
			const dt = lastFrameAt === null ? 0 : at - lastFrameAt;
			lastFrameAt = at;
			const target = targetTick(at);
			if (target === null) return 0;
			const before = playTick;
			const behind = target - playTick;
			if (behind > o.resyncBehindTicks || behind < -(delayTicks + o.resyncAheadTicks)) {
				resync();
				// Keep animating while the snapshot is fetched.
				if (behind > 0) acc += Math.min(dt, o.maxFrameMs) / tickMs * (1 + o.maxSpeedup);
			} else if (behind > o.jumpBehindTicks) {
				catchUp(Math.floor(target), true);
				acc = 0;
				rate = 1;
				return playTick - before;
			} else {
				const correction = behind / o.correctionSpanTicks;
				rate = 1 + Math.max(-o.maxSlowdown, Math.min(o.maxSpeedup, correction * (correction < 0 ? o.maxSlowdown : o.maxSpeedup)));
				if (dt <= o.maxFrameMs) acc += (dt / tickMs) * rate;
			}
			let steps = Math.floor(acc);
			if (steps > o.maxStepsPerFrame) steps = o.maxStepsPerFrame;
			acc -= steps;
			if (acc > 1) acc = 1;
			for (let i = 0; i < steps && sim; i++) stepOnce();
			return playTick - before;
		}

		function debugState() {
			const at = now();
			const authority = authorityTick(at);
			const target = targetTick(at);
			let nextQueuedCommandTick = null;
			let maxQueuedCommandTick = null;
			for (const item of pending) {
				if (nextQueuedCommandTick === null || item.tick < nextQueuedCommandTick) nextQueuedCommandTick = item.tick;
				if (maxQueuedCommandTick === null || item.tick > maxQueuedCommandTick) maxQueuedCommandTick = item.tick;
			}
			return {
				authorityTick: authority === null ? null : Math.floor(authority),
				playbackTick: target === null ? null : Math.floor(target),
				simTick: playTick,
				driftTicks: target === null ? 0 : target - playTick,
				delayTicks,
				rate,
				tickMs,
				queuedCommands: pending.length,
				nextQueuedCommandTick,
				maxQueuedCommandTick,
				bufferedAheadTicks: maxQueuedCommandTick === null || target === null
					? 0
					: Math.max(0, maxQueuedCommandTick - Math.floor(target)),
				haveAuthoritySample: samples.length > 0,
				jumps: counters.jumps,
				jumpedTicks: counters.jumpedTicks,
				resyncs: counters.resyncs,
				lateCommands: counters.lateCommands,
			};
		}

		return {
			onCommand,
			frame,
			debugState,
			get sim() { return sim; },
			get effectType() { return effectType; },
			get ready() { return ready; },
			get lastError() { return lastError; },
		};
	}

	window.AmbiencePlayback = window.AmbiencePlayback || { createPlayback, defaults: PLAYBACK_DEFAULTS };

	const script = document.currentScript;
	if (script && script.hasAttribute && script.hasAttribute('data-ambience-library')) return;

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
	const GRID_W = parseInt(canvas.dataset.ambienceGridW || '640', 10);
	const GRID_H = parseInt(canvas.dataset.ambienceGridH || '360', 10);
	const TRANSPARENT = canvas.dataset.ambienceTransparent !== 'false';
	const ENTROPY_ENABLED = canvas.dataset.ambienceEntropy !== 'off';
	const PINNED_DELAY_TICKS = canvas.dataset.ambienceDelayTicks != null
		? Math.max(0, parseInt(canvas.dataset.ambienceDelayTicks, 10) || 0)
		: null;
	const INITIAL_FADE_MS = Math.max(0, parseInt(canvas.dataset.ambienceInitialFadeMs || '1200', 10) || 0);
	const INTRO_ON_JOIN = canvas.dataset.ambienceIntroOnJoin !== 'off';

	const ctx = canvas.getContext('2d');
	if (canvas.style) canvas.style.imageRendering = canvas.style.imageRendering || 'pixelated';
	ctx.imageSmoothingEnabled = false;
	// Optional second canvas the consumer stacks ABOVE its own UI. When present
	// we paint the near/overlay plane into it each tick (the drops the world
	// promotes via the effect's overlay lever) so a few drops cross in front of
	// the page. The main field is unchanged whether or not this canvas exists.
	const overlayCanvas = document.querySelector('canvas[data-ambience-overlay]');
	const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
	if (overlayCtx) {
		if (overlayCanvas.style) overlayCanvas.style.imageRendering = overlayCanvas.style.imageRendering || 'pixelated';
		overlayCtx.imageSmoothingEnabled = false;
	}
	let initialFadeCover = null;

	// Mark body so consumer CSS can conditionally adapt (e.g. make terminal
	// backgrounds transparent only when ambience is actually running).
	document.body.classList.add('ambience-on');

	let needsRender = true;
	function resize() {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.floor(window.innerWidth * dpr);
		canvas.height = Math.floor(window.innerHeight * dpr);
		if (overlayCanvas) {
			overlayCanvas.width = canvas.width;
			overlayCanvas.height = canvas.height;
		}
		needsRender = true;
	}
	resize();
	window.addEventListener('resize', resize);

	let initialFadePending = false;
	let initialFadeStarted = false;
	const sceneState = {
		currentName: null,
		nextName: null,
		sceneRemaining: null,
		durationTicks: null,
		startedAtTick: null,
	};

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

	const playback = createPlayback({
		effects: AmbienceSim.effects,
		EffectTransition: AmbienceSim.EffectTransition,
		gridW: GRID_W,
		gridH: GRID_H,
		server: SERVER,
		pinnedDelayTicks: PINNED_DELAY_TICKS,
		introOnJoin: INTRO_ON_JOIN,
		fetchSnapshot: () => fetch(trimSlashes(SERVER) + '/snapshot', { cache: 'no-store' })
			.then((r) => {
				if (!r.ok) throw new Error('snapshot ' + r.status);
				return r.json();
			}),
		onSnapshot: (data, info) => {
			updateSceneFromSnapshot(data);
			if (info.first) initialFadePending = true;
			needsRender = true;
		},
	});

	window.AmbienceClient = {
		getDebugState: () => Object.assign(
			{
				effectType: playback.effectType,
				ready: playback.ready,
				initialFadeStarted,
				scene: Object.assign({}, sceneState),
				sim: getSimDebug(playback.sim),
				lastError: playback.lastError,
			},
			playback.debugState(),
		),
	};

	function render() {
		const sim = playback.sim;
		if (!sim) return;
		sim.render(ctx, canvas.width, canvas.height, { transparent: TRANSPARENT });
		if (overlayCtx) {
			if (typeof sim.renderOverlay === 'function') {
				sim.renderOverlay(overlayCtx, overlayCanvas.width, overlayCanvas.height, { transparent: true });
			} else {
				overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
			}
		}
		if (initialFadePending) {
			initialFadePending = false;
			revealInitialScene();
		}
	}

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

		const es = new EventSource(trimSlashes(SERVER) + '/events');
		es.addEventListener('message', (e) => {
			let cmd;
			try { cmd = JSON.parse(e.data); } catch (_) { return; }
			const data = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
			if (cmd.kind === 'scene' || cmd.kind === 'metric') applySceneData(data);
			playback.onCommand(cmd, data);
		});

		// Step and draw once per display frame.
		(function loop() {
			if (playback.frame(performance.now()) > 0) needsRender = true;
			if (needsRender) {
				needsRender = false;
				render();
			}
			requestAnimationFrame(loop);
		})();
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
				fetch(trimSlashes(SERVER) + '/entropy', {
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
