(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// Settings live in claude.ai's localStorage, which both the extension's content script and
	// the userscript can read, so one implementation serves both.
	const KEY = `${CC.CONST.STORAGE_PREFIX}settings`;

	const DEFAULTS = Object.freeze({
		showHeader: true,
		showUsageRow: true,
		showModelLimits: true,
		compact: false,
		// 'countdown' (resets in 4h 31m) or 'clock' (resets 4:50 PM)
		resetFormat: 'countdown',
		// 0 = auto (model-based default)
		contextLimit: 0,
		notifyThresholds: false,
		notifyReset: false,
		notifyUnusedBeforeReset: false,
		notifyCacheExpiry: false
	});

	function readStored() {
		try {
			const raw = localStorage.getItem(KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	let current = { ...DEFAULTS, ...readStored() };
	const listeners = new Set();

	function notify() {
		for (const fn of listeners) {
			try {
				fn(current);
			} catch {
				// a broken listener must not block the others
			}
		}
	}

	CC.settings = {
		DEFAULTS,
		get(key) {
			return current[key];
		},
		all() {
			return { ...current };
		},
		set(patch) {
			current = { ...current, ...patch };
			try {
				localStorage.setItem(KEY, JSON.stringify(current));
			} catch {
				// storage can be unavailable (private mode); keep the in-memory value
			}
			notify();
		},
		reset() {
			current = { ...DEFAULTS };
			try {
				localStorage.removeItem(KEY);
			} catch {
				// ignore
			}
			notify();
		},
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
	};

	// Keep tabs in sync when settings change in another claude.ai tab
	window.addEventListener('storage', (e) => {
		if (e.key !== KEY) return;
		current = { ...DEFAULTS, ...readStored() };
		notify();
	});
})();
