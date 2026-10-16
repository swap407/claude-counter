(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// Browser notifications for usage thresholds, window resets, unused quota before a reset and
	// prompt-cache expiry. Uses the standard Notification API so the extension and the
	// userscript share one code path.
	const LOG_KEY = `${CC.CONST.STORAGE_PREFIX}notified`;
	const THRESHOLDS = [75, 90];
	const UNUSED_LEAD_MS = { session: 30 * 60 * 1000, weekly: 24 * 60 * 60 * 1000 };
	const UNUSED_MAX_PCT = 50;
	const CACHE_WARN_MS = 60 * 1000;

	function readLog() {
		try {
			const raw = localStorage.getItem(LOG_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	// key -> time fired. Keys include the window's reset time, so each window alerts once,
	// across reloads and tabs.
	let log = readLog();

	function alreadySent(key) {
		log = readLog();
		return !!log[key];
	}

	function markSent(key) {
		log = readLog();
		log[key] = Date.now();
		const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
		for (const k of Object.keys(log)) {
			if (log[k] < cutoff) delete log[k];
		}
		try {
			localStorage.setItem(LOG_KEY, JSON.stringify(log));
		} catch {
			// ignore
		}
	}

	function canNotify() {
		return typeof Notification !== 'undefined' && Notification.permission === 'granted';
	}

	function send(key, title, body) {
		if (alreadySent(key)) return;
		markSent(key);
		if (!canNotify()) return;
		try {
			const n = new Notification(title, { body, tag: `claude-counter-${key}` });
			n.onclick = () => {
				window.focus();
				n.close();
			};
		} catch {
			// some browsers only allow notifications from a service worker
		}
	}

	async function requestPermission() {
		if (typeof Notification === 'undefined') return 'unsupported';
		if (Notification.permission !== 'default') return Notification.permission;
		try {
			return await Notification.requestPermission();
		} catch {
			return 'denied';
		}
	}

	// Previous percentage per window, so thresholds fire on crossing rather than on page load
	const lastPct = new Map();

	function onUsage(groups) {
		const s = CC.settings;
		for (const g of groups) {
			if (typeof g.pct !== 'number' || !g.resetMs) continue;
			const prev = lastPct.get(g.key);
			lastPct.set(g.key, g.pct);
			if (!s.get('notifyThresholds') || prev === undefined) continue;
			for (const t of THRESHOLDS) {
				if (prev < t && g.pct >= t) {
					send(
						`${g.key}:${g.resetMs}:t${t}`,
						`Claude ${g.label} usage at ${Math.round(g.pct)}%`,
						`Resets ${CC.format.formatResetFull(g.resetMs)} (in ${CC.format.formatResetCountdown(g.resetMs)}).`
					);
				}
			}
		}
	}

	function onTick({ groups, cachedUntilMs }) {
		const s = CC.settings;
		const now = Date.now();

		for (const g of groups) {
			if (!g.resetMs) continue;
			const kind = g.key === 'session' ? 'session' : 'weekly';

			if (s.get('notifyReset') && now >= g.resetMs && now - g.resetMs < 10 * 60 * 1000) {
				send(`${g.key}:${g.resetMs}:reset`, `Claude ${g.label} limit has reset`, 'Your usage for this window is back to 0%.');
			}

			const lead = UNUSED_LEAD_MS[kind];
			if (
				s.get('notifyUnusedBeforeReset') &&
				typeof g.pct === 'number' &&
				g.pct < UNUSED_MAX_PCT &&
				g.resetMs > now &&
				g.resetMs - now <= lead
			) {
				send(
					`${g.key}:${g.resetMs}:unused`,
					`Claude ${g.label} resets in ${CC.format.formatResetCountdown(g.resetMs)}`,
					`You've used ${Math.round(g.pct)}%. The unused ${Math.round(100 - g.pct)}% will not carry over.`
				);
			}
		}

		if (
			s.get('notifyCacheExpiry') &&
			cachedUntilMs &&
			cachedUntilMs > now &&
			cachedUntilMs - now <= CACHE_WARN_MS &&
			document.hidden
		) {
			send(
				`cache:${cachedUntilMs}`,
				'Claude prompt cache expires in under a minute',
				'Reply now to keep this conversation cached (cheaper against your limits).'
			);
		}
	}

	CC.alerts = { onUsage, onTick, requestPermission, canNotify };
})();
