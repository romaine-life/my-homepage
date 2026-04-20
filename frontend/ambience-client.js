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
//
// Effect agnostic: the server's snapshot broadcasts the effect type; this
// file looks it up in AmbienceSim.effects[type]. Adding a new effect means
// registering a new entry in sim.js — no change needed here.

(function () {
	'use strict';

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

	// The first snapshot tells us what effect is running. Until then we
	// default to rain so we have something to paint during the brief
	// connection window.
	let effectType = 'rain';
	let sim = new AmbienceSim.effects[effectType](GRID_W, GRID_H, {});
	let ready = false;

	// Patch the subscribe snapshot handler so we can detect effect-type
	// changes (for when more effects ship). The shared subscribe() swaps
	// config on the existing sim; a type switch requires rebuilding.
	const es = new EventSource(SERVER.replace(/\/+$/, '') + '/events');
	es.addEventListener('message', (e) => {
		let cmd;
		try { cmd = JSON.parse(e.data); } catch (_) { return; }
		const data = typeof cmd.data === 'string' ? JSON.parse(cmd.data) : cmd.data;
		switch (cmd.kind) {
			case 'snapshot': {
				const newType = (data && data.type) || 'rain';
				if (newType !== effectType) {
					const ctor = AmbienceSim.effects[newType];
					if (!ctor) {
						console.warn('ambience-client: unknown effect type', newType);
						break;
					}
					effectType = newType;
					sim = new ctor(GRID_W, GRID_H, {});
				}
				try { sim.restoreSnapshot(data); } catch (err) { console.error('bad snapshot', err); }
				ready = true;
				break;
			}
			case 'config':
				try { sim.setConfig(data); } catch (err) { console.error('bad config', err); }
				break;
			case 'trigger':
				if (sim.triggerEvent) sim.triggerEvent(cmd.event);
				break;
		}
	});

	// Combined 10 Hz tick (matches server atmosphere rate). Step + render
	// in one setInterval — rAF pauses in background tabs and we don't need
	// 60 Hz for a 10 Hz sim.
	setInterval(() => {
		if (ready) sim.step();
		sim.render(ctx, canvas.width, canvas.height, { transparent: TRANSPARENT });
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
