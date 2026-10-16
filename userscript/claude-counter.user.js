// ==UserScript==
// @name         Claude Counter (swap407)
// @namespace    https://github.com/swap407/claude-counter
// @version      0.5.0-userscript
// @description  Shows token count, cache timer, and usage bars on claude.ai.
// @homepageURL  https://github.com/swap407/claude-counter
// @updateURL    https://raw.githubusercontent.com/swap407/claude-counter/main/userscript/claude-counter.user.js
// @downloadURL  https://raw.githubusercontent.com/swap407/claude-counter/main/userscript/claude-counter.user.js
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// @require      https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js
// ==/UserScript==

// GENERATED FILE - do not edit. Built from src/ by scripts/build-userscript.mjs
// (run `npm run build`). Edit the sources in src/ instead.

// ---- version ---------------------------------------------------------------------
(globalThis.ClaudeCounter = globalThis.ClaudeCounter || {}).VERSION = "0.5.0-userscript";

// ---- src/injected/bridge.js ------------------------------------------------------
(() => {
	'use strict';

	const CC_MARKER = 'ClaudeCounter';

	// Runs in the page: injected by the extension, or inlined in the userscript. Install once,
	// even if both are active.
	if (window.__ccBridgeInstalled) return;
	window.__ccBridgeInstalled = true;

	// Capture original fetch before anyone else can wrap it
	const originalFetch = window.fetch;

	// Wrap history methods early to detect SPA navigation (before frameworks cache them)
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	// Newer claude.ai accounts send messages over Connect RPC instead of /completion SSE:
	// PerformAction starts a turn and StreamTimeline streams the reply as protobuf frames.
	// The frames aren't parsed; the stream going quiet is treated as "reply finished".
	// e.g. /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction
	const CONNECT_PERFORM_ACTION = '.ConversationService/PerformAction';
	const CONNECT_STREAM_TIMELINE = '.ConversationService/StreamTimeline';
	const STREAM_IDLE_MS = 2500;

	window.fetch = async (...args) => {
		const url = toAbsoluteUrl(args[0]);
		const opts = args[1] || {};
		const method = String(opts.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();

		// Detect generation start (completion requests)
		if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
			post('cc:generation_start', {});
		}
		if (url && method === 'POST' && url.includes(CONNECT_PERFORM_ACTION)) {
			post('cc:generation_start', { transport: 'connect' });
		}

		const response = await originalFetch.apply(window, args);

		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('event-stream')) {
			handleEventStream(response);
		}
		if (url && url.includes(CONNECT_STREAM_TIMELINE)) {
			watchStreamActivity(response);
		}

		// Catch conversation tree fetches
		if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
			const meta = getConversationMeta(url);
			if (meta) {
				handleConversationResponse(meta, response);
			}
		}

		return response;
	};

	function post(type, payload) {
		window.postMessage({ cc: CC_MARKER, type, payload }, '*');
	}

	function postResponse(requestId, ok, payload, error) {
		window.postMessage(
			{
				cc: CC_MARKER,
				type: 'cc:response',
				requestId,
				ok,
				payload,
				error
			},
			'*'
		);
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		// /api/organizations/{orgId}/chat_conversations/{conversationId}
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			post('cc:conversation', { orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	// Post cc:generation_idle once a streamed response has received data and then gone quiet
	// (or ended), so the content script can re-fetch usage and the conversation.
	async function watchStreamActivity(response) {
		let idleTimer = null;
		let sawData = false;
		const fireIdle = () => {
			idleTimer = null;
			if (!sawData) return;
			sawData = false;
			post('cc:generation_idle', { transport: 'connect' });
		};
		try {
			const reader = response.clone().body?.getReader?.();
			if (!reader) return;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value?.byteLength) {
					sawData = true;
					clearTimeout(idleTimer);
					idleTimer = setTimeout(fireIdle, STREAM_IDLE_MS);
				}
			}
		} catch {
			// stream aborted (navigation, cancel); fall through
		}
		clearTimeout(idleTimer);
		fireIdle();
	}

	async function handleEventStream(response) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							post('cc:message_limit', json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
			post('cc:generation_idle', { transport: 'sse' });
		} catch {
			// best-effort; don't break claude.ai
		}
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;
		try {
			if (kind === 'hash') {
				const text = typeof payload?.text === 'string' ? payload.text : '';
				if (!text || !crypto?.subtle?.digest) {
					postResponse(requestId, false, null, 'Hash unavailable');
					return;
				}
				const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				const bytes = new Uint8Array(buffer);
				const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
				postResponse(requestId, true, { hash }, null);
				return;
			}

			if (kind === 'usage') {
				const orgId = payload?.orgId;
				if (!orgId) throw new Error('Missing orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				postResponse(requestId, true, json, null);
				return;
			}

			if (kind === 'conversation') {
				const orgId = payload?.orgId;
				const conversationId = payload?.conversationId;
				if (!orgId || !conversationId) throw new Error('Missing orgId/conversationId');

				const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				const res = await originalFetch(url, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				post('cc:conversation', { orgId, conversationId, data: json });
				postResponse(requestId, true, json, null);
				return;
			}

			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();

// ---- src/content/constants.js ----------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// Every claude.ai selector lives here, so a redesign only needs changes in one place.
	// `CC.diag` warns in the console when one of these stops matching.
	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_INPUT: '[data-testid="chat-input"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		CHAT_HEADER: '[data-testid="chat-header"]',
		CHAT_TITLE: '[data-testid="chat-title-split"]',
		// Either the legacy title menu or the newer split title button
		HEADER_ANCHOR: '[data-testid="chat-menu-trigger"], [data-testid="chat-title-split"]',
		// Either the model selector or the editor (the composer host is derived from the editor)
		USAGE_ANCHOR: '[data-testid="model-selector-dropdown"], [data-testid="chat-input"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		DEFAULT_CONTEXT_LIMIT_TOKENS: 200000,
		STORAGE_PREFIX: 'claudeCounter:',
		// Usage snapshots older than this are not shown after a reload
		USAGE_SNAPSHOT_MAX_AGE_MS: 6 * 60 * 60 * 1000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		AMBER_WARNING: '#d97706',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();

// ---- src/content/format.js -------------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs, { compact = false } = {}) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		const sep = compact ? '' : ' ';

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h${sep}${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d${sep}${remHours}h`;
	}

	// Within a day: "4:50 PM". Further out: "Sat 4:50 PM".
	function formatResetClock(timestampMs) {
		const date = new Date(timestampMs);
		const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (timestampMs - Date.now() < 24 * 60 * 60 * 1000) return time;
		const day = date.toLocaleDateString([], { weekday: 'short' });
		return `${day} ${time}`;
	}

	// Full date and time for tooltips: "Sat, Oct 18, 4:50 PM"
	function formatResetFull(timestampMs) {
		return new Date(timestampMs).toLocaleString([], {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function formatTokens(n) {
		if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
		if (n >= 1000) return `${Math.round(n / 1000)}k`;
		return String(n);
	}

	CC.format = { formatSeconds, formatResetCountdown, formatResetClock, formatResetFull, formatTokens };
})();

// ---- src/content/settings.js -----------------------------------------------------
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

// ---- src/content/diag.js ---------------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// When claude.ai changes its markup, say which piece can't be placed instead of failing
	// silently. Run `dispatchEvent(new Event('cc:debug'))` in the DevTools console for a report.
	const GRACE_MS = 20000;
	const status = new Map(); // name -> { ok, firstMissMs, warned }
	const startedMs = Date.now();

	function report(name, ok) {
		const s = status.get(name) || { ok: false, firstMissMs: null, warned: false };
		s.ok = ok;
		if (ok) {
			s.firstMissMs = null;
		} else if (!s.firstMissMs) {
			s.firstMissMs = Date.now();
		}
		status.set(name, s);
	}

	function check() {
		const now = Date.now();
		for (const [name, s] of status) {
			if (s.ok || s.warned || !s.firstMissMs) continue;
			if (now - s.firstMissMs < GRACE_MS || now - startedMs < GRACE_MS) continue;
			s.warned = true;
			console.warn(
				`[Claude Counter] Can't find where to place the ${name}. claude.ai may have changed its layout; ` +
					"run dispatchEvent(new Event('cc:debug')) for details."
			);
		}
	}
	setInterval(check, 5000);

	const describe = (selector) => {
		const el = document.querySelector(selector);
		if (!el) return 'missing';
		const r = el.getBoundingClientRect();
		return `found (${Math.round(r.width)}x${Math.round(r.height)})`;
	};

	window.addEventListener('cc:debug', () => {
		const lines = ['[Claude Counter] debug report'];
		lines.push(`version: ${CC.VERSION || 'unknown'} (${CC.PLATFORM || 'unknown'})`);
		for (const [key, selector] of Object.entries(CC.DOM)) {
			if (key === 'BRIDGE_SCRIPT_ID') continue;
			lines.push(`  ${key}: ${describe(selector)}  ${selector}`);
		}
		for (const [name, s] of status) lines.push(`  placed ${name}: ${s.ok ? 'yes' : 'no'}`);
		const header = document.querySelector('.cc-header');
		const row = document.querySelector('.cc-usageRow');
		lines.push(`  header in page: ${!!header}, text="${header?.textContent || ''}"`);
		lines.push(`  usage row in page: ${!!row}, hidden=${row?.classList.contains('cc-hidden')}`);
		lines.push(`  settings: ${JSON.stringify(CC.settings?.all?.() || {})}`);
		if (CC.debugState) lines.push(`  state: ${JSON.stringify(CC.debugState())}`);
		console.log(lines.join('\n'));
	});

	CC.diag = { report };
})();

// ---- src/content/alerts.js -------------------------------------------------------
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

// ---- src/content/bridge-client.js ------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	function makeRequestId() {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	class BridgeClient {
		constructor() {
			this._pending = new Map();
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				const data = event.data;
				if (!data || data.cc !== 'ClaudeCounter') return;

				if (data.type === 'cc:response') {
					const { requestId, ok, payload, error } = data;
					const pending = this._pending.get(requestId);
					if (!pending) return;
					this._pending.delete(requestId);
					clearTimeout(pending.timeoutId);
					if (ok) pending.resolve(payload);
					else pending.reject(new Error(error || 'Bridge request failed'));
					return;
				}

				// Events
				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of listeners) {
				fn(payload);
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}

		request(kind, payload, { timeoutMs = 10000 } = {}) {
			const requestId = makeRequestId();
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`Bridge request timed out (${kind})`));
				}, timeoutMs);

				this._pending.set(requestId, { resolve, reject, timeoutId });
				window.postMessage(
					{
						cc: 'ClaudeCounter',
						type: 'cc:request',
						requestId,
						kind,
						payload
					},
					'*'
				);
			});
		}

		async requestUsage(orgId) {
			return this.request('usage', { orgId }, { timeoutMs: 15000 });
		}

		async requestConversation(orgId, conversationId) {
			return this.request('conversation', { orgId, conversationId }, { timeoutMs: 20000 });
		}

		async requestHash(text) {
			return this.request('hash', { text }, { timeoutMs: 5000 });
		}
	}

	let bridgeReadyPromise = null;

	function injectBridgeOnce() {
		if (bridgeReadyPromise) return bridgeReadyPromise;

		// Userscript build: bridge.js is inlined and already running in the page.
		const runtime = getRuntime();
		if (!runtime?.getURL) {
			bridgeReadyPromise = Promise.resolve(true);
			return bridgeReadyPromise;
		}

		if (document.getElementById(CC.DOM.BRIDGE_SCRIPT_ID)) {
			return Promise.resolve(true);
		}

		bridgeReadyPromise = new Promise((resolve) => {
			const script = document.createElement('script');
			script.id = CC.DOM.BRIDGE_SCRIPT_ID;
			script.src = runtime.getURL('src/injected/bridge.js');
			script.onload = () => resolve(true);
			script.onerror = () => resolve(false);
			(document.head || document.documentElement).appendChild(script);
		});

		return bridgeReadyPromise;
	}

	CC.bridge = new BridgeClient();
	CC.injectBridgeOnce = injectBridgeOnce;
})();

// ---- src/content/tokens.js -------------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	// Countable text of one message, split by category for the breakdown tooltip.
	function messageCountableParts(message) {
		const text = [];
		const tools = [];
		const attachments = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (!s) continue;
			if (item.type === 'tool_use' || item.type === 'tool_result') tools.push(s);
			else text.push(s);
		}

		// Attachment extracted content (observable, already text).
		const files = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of files) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				attachments.push(a.extracted_content);
			}
		}

		return { text: text.join('\n'), tools: tools.join('\n'), attachments: attachments.join('\n') };
	}

	function countParts(parts) {
		return {
			text: countTokens(parts.text),
			tools: countTokens(parts.tools),
			attachments: countTokens(parts.attachments)
		};
	}

	async function hashString(str) {
		if (!CC.bridge?.requestHash) return null;
		try {
			const res = await CC.bridge.requestHash(str);
			if (res?.hash) return res.hash;
		} catch {
			// No local hashing fallback.
		}
		return null;
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	class TokenCache {
		constructor() {
			this._byMessageId = new Map(); // uuid -> { fp, counts }
		}

		// Returns { text, tools, attachments } token counts for one message.
		async getMessageTokens(messageId, parts) {
			const fp = await fingerprint(`${parts.text}\u0000${parts.tools}\u0000${parts.attachments}`);
			if (!fp) return countParts(parts);
			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) return cached.counts;

			const counts = countParts(parts);
			this._byMessageId.set(messageId, { fp, counts });
			return counts;
		}

		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}
		}
	}

	const tokenCache = new TokenCache();

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		const breakdown = { userText: 0, assistantText: 0, tools: 0, attachments: 0 };
		let lastAssistantMs = null;

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const parts = messageCountableParts(msg);
			const counts = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, parts) : countParts(parts);
			if (msg?.sender === 'assistant') breakdown.assistantText += counts.text;
			else breakdown.userText += counts.text;
			breakdown.tools += counts.tools;
			breakdown.attachments += counts.attachments;
		}
		const totalTokens = breakdown.userText + breakdown.assistantText + breakdown.tools + breakdown.attachments;
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			breakdown,
			model: typeof conversation?.model === 'string' ? conversation.model : null,
			lastAssistantMs,
			cachedUntil
		};
	}

	CC.tokens = { computeConversationMetrics };
})();

// ---- src/content/ui.js -----------------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const { formatSeconds, formatResetCountdown, formatResetClock, formatResetFull, formatTokens } = CC.format;

	const CACHE_WARN_MS = 60 * 1000;

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	// Context window used for the header bar. claude.ai doesn't expose it, so it's a setting with a
	// model-based default: 1M for long-context model ids, otherwise 200k.
	function resolveContextLimit(model) {
		const override = Number(CC.settings.get('contextLimit'));
		if (Number.isFinite(override) && override > 0) return override;
		if (model && /(\[1m\]|-1m\b|1m-context)/i.test(model)) return 1000000;
		return CC.CONST.DEFAULT_CONTEXT_LIMIT_TOKENS;
	}

	class CounterUI {
		constructor({ onUsageRefresh, onOpenSettings } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onOpenSettings = onOpenSettings || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;
			this.metrics = null;

			this.usageLine = null;
			this.usageGroups = new Map(); // key -> group elements + state
			this.lastUsage = [];
			this.usageStale = false;
			this.refreshingUsage = false;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			for (const g of this.usageGroups.values()) {
				applyBarChrome(g.bar, { fillWarn: CC.COLORS.RED_WARNING });
			}
			this._applyCacheColor();
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthGroup.className = 'cc-lengthGroup';
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly + per-model)
			this._initUsageLine();

			this._setupTooltips();
			this._setupSettingsTriggers();
			this._observeDom();
			this._observeTheme();

			CC.settings.onChange(() => this.applySettings());
			this.applySettings();
		}

		applySettings() {
			const s = CC.settings;
			this.headerContainer?.classList.toggle('cc-hidden', !s.get('showHeader'));
			this.usageLine?.classList.toggle('cc-usageRow--compact', !!s.get('compact'));
			this._renderUsage();
			if (this.metrics) this.setConversationMetrics(this.metrics);
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;
			let placementCheckQueued = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.USAGE_ANCHOR, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				// The composer can finish rendering after the first attach (which then falls back
				// to a page-level spot), so move the row once the composer host appears.
				if (!usageMissing && this.usageLine && !placementCheckQueued) {
					placementCheckQueued = true;
					requestAnimationFrame(() => {
						placementCheckQueued = false;
						const host = this._findComposerHost();
						if (host && host.nextElementSibling !== this.usageLine) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.HEADER_ANCHOR, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'text-text-400 cc-usageRow cc-hidden';

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_makeUsageGroup(key) {
			const group = document.createElement('div');
			group.className = 'cc-usageGroup';
			group.dataset.ccGroup = key;

			const text = document.createElement('span');
			text.className = 'cc-usageText';

			const bar = document.createElement('div');
			bar.className = 'cc-bar cc-bar--usage';
			const fill = document.createElement('div');
			fill.className = 'cc-bar__fill';
			const marker = document.createElement('div');
			marker.className = 'cc-bar__marker cc-hidden';
			marker.style.left = '0%';
			bar.append(fill, marker);

			group.append(text, bar);
			const tooltip = makeTooltip('');
			setupTooltip(group, tooltip, { topOffset: 8 });

			const entry = { key, group, text, bar, fill, marker, tooltip, data: null };
			this.usageGroups.set(key, entry);
			this.refreshProgressChrome();
			return entry;
		}

		_removeUsageGroup(key) {
			const entry = this.usageGroups.get(key);
			if (!entry) return;
			entry.group.remove();
			entry.tooltip.remove();
			this.usageGroups.delete(key);
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip('');
			setupTooltip(this.lengthGroup, this.lengthTooltip, { topOffset: 8 });

			setupTooltip(
				this.cachedDisplay,
				makeTooltip(
					'Messages sent while cached are significantly cheaper.\nRight-click the counter for settings (e.g. an expiry alert).'
				),
				{ topOffset: 8 }
			);
		}

		_setupSettingsTriggers() {
			const open = (e) => {
				if (!this.onOpenSettings) return;
				e.preventDefault();
				this.onOpenSettings();
			};
			this.usageLine.addEventListener('contextmenu', open);
			this.headerContainer.addEventListener('contextmenu', open);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		// Newer layout: chat-header > title wrapper > chat-title-split, followed by a flex-1
		// spacer. Place the header right after the title wrapper (a direct child of chat-header).
		// Legacy layout: after the chat menu trigger's project wrapper.
		_findHeaderAnchor() {
			const title = document.querySelector(CC.DOM.CHAT_TITLE);
			const header = title?.closest(CC.DOM.CHAT_HEADER);
			if (title && header) {
				let cur = title;
				while (cur.parentElement && cur.parentElement !== header) cur = cur.parentElement;
				if (cur.parentElement === header) return cur;
			}
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return null;
			return chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
		}

		attachHeader() {
			const anchor = this._findHeaderAnchor();
			CC.diag?.report('header', !!anchor);
			if (!anchor) return;
			this.headerContainer.classList.toggle('cc-header--titlebar', !!anchor.closest(CC.DOM.CHAT_HEADER));
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		// Newer composer: the toolbar is an absolutely positioned cluster overlaid on the
		// input, and the model selector may sit inside it (new chat) or below the card
		// (existing chat). Anchor on the editor instead: its nearest ancestor holding any
		// buttons is the card's inner container, so the row lands inside the card below it.
		_findComposerHost() {
			const editor = document.querySelector(CC.DOM.CHAT_INPUT);
			let cur = editor?.parentElement;
			for (let i = 0; cur && cur !== document.body && i < 8; i++) {
				if (cur.querySelector('button')) return cur;
				cur = cur.parentElement;
			}
			return null;
		}

		// Legacy composer: the row goes after the toolbar row that holds the model selector.
		_findLegacyToolbarRow() {
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return null;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			if (!gridContainer) return null;
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const stopAt = gridArea || gridContainer;
			let cur = modelSelector.parentElement;
			while (cur && cur !== document.body && cur !== stopAt) {
				const style = window.getComputedStyle(cur);
				if (style.display === 'flex' && style.flexDirection === 'row' && cur.querySelectorAll('button').length > 1) {
					return cur;
				}
				cur = cur.parentElement;
			}
			return null;
		}

		attachUsageLine() {
			if (!this.usageLine) return;

			const host = this._findComposerHost();
			const target = host || this._findLegacyToolbarRow();
			CC.diag?.report('usage row', !!target);
			// No page-level fallback: a misplaced row (e.g. across the whole page) is worse than
			// waiting for the composer, which the DOM observer will pick up.
			if (!target?.parentElement) return;

			this.usageLine.classList.toggle('cc-usageRow--composer', !!host);
			if (target.nextElementSibling !== this.usageLine) {
				target.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			this._applyCacheColor();
		}

		_applyCacheColor() {
			if (!this.cacheTimeSpan) return;
			if (this.pendingCache) {
				this.cacheTimeSpan.style.color = '';
				return;
			}
			const expiring = this.lastCachedUntilMs && this.lastCachedUntilMs - Date.now() <= CACHE_WARN_MS;
			this.cacheTimeSpan.style.color = expiring ? CC.COLORS.AMBER_WARNING : this.getProgressChrome().boldColor;
		}

		setConversationMetrics(metrics = {}) {
			const { totalTokens, cachedUntil, breakdown, model } = metrics;
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.metrics = null;
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}
			this.metrics = metrics;

			const limit = resolveContextLimit(model);
			const pct = Math.max(0, Math.min(100, (totalTokens / limit) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;
			this.lengthTooltip.textContent = this._lengthTooltipText({ totalTokens, breakdown, model, limit, pct });

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'cc-barWrap';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('  '), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this._applyCacheColor();
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for '), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_lengthTooltipText({ totalTokens, breakdown, model, limit, pct }) {
			const lines = [`~${totalTokens.toLocaleString()} tokens (${pct.toFixed(1)}% of ${formatTokens(limit)})`];
			if (breakdown) {
				const row = (label, n) => (n ? `  ${label}: ~${n.toLocaleString()}` : null);
				lines.push(
					...[
						row('Your messages', breakdown.userText),
						row("Claude's replies", breakdown.assistantText),
						row('Tool calls & results', breakdown.tools),
						row('Attached files', breakdown.attachments)
					].filter(Boolean)
				);
			}
			if (model) lines.push(`Model: ${model}`);
			lines.push(
				'',
				'Estimate only: uses a generic (non-Claude) tokenizer and excludes the system',
				'prompt, web search results and other hidden context. Invalid after compaction.',
				`Bar scale: ${formatTokens(limit)} tokens${CC.settings.get('contextLimit') ? ' (set in settings)' : ''}.`,
				'Right-click for settings.'
			);
			return lines.join('\n');
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '  ' : ' ';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		// groups: [{ key, label, pct, resetMs, windowMs, scoped }], session first.
		// stale: values restored from a previous page load, not yet confirmed by claude.ai.
		setUsage(groups, { stale = false } = {}) {
			this.lastUsage = Array.isArray(groups) ? groups : [];
			this.usageStale = stale;
			this._renderUsage();
		}

		_visibleUsage() {
			const showScoped = CC.settings.get('showModelLimits');
			return this.lastUsage.filter((g) => typeof g.pct === 'number' && (showScoped || !g.scoped));
		}

		_renderUsage() {
			if (!this.usageLine) return;
			const groups = this._visibleUsage();
			const visible = groups.length > 0 && CC.settings.get('showUsageRow');
			this.usageLine.classList.toggle('cc-hidden', !visible);
			this.usageLine.classList.toggle('cc-usageRow--stale', this.usageStale);

			const keep = new Set(groups.map((g) => g.key));
			for (const key of [...this.usageGroups.keys()]) {
				if (!keep.has(key)) this._removeUsageGroup(key);
			}

			for (const g of groups) {
				const entry = this.usageGroups.get(g.key) || this._makeUsageGroup(g.key);
				entry.data = g;
				// Keep DOM order equal to data order
				this.usageLine.appendChild(entry.group);

				const width = Math.max(0, Math.min(100, g.pct));
				entry.fill.style.width = `${width}%`;
				entry.fill.classList.toggle('cc-warn', width >= 90);
				entry.fill.classList.toggle('cc-full', width >= 99.5);
				this._renderUsageText(entry);
				entry.tooltip.textContent = this._usageTooltipText(g);
			}

			this._updateMarkers();
		}

		_renderUsageText(entry) {
			const g = entry.data;
			if (!g) return;
			const compact = CC.settings.get('compact');
			const pct = Math.round(g.pct * 10) / 10;
			const label = compact ? g.shortLabel || g.label : g.label;
			let reset = '';
			if (g.resetMs) {
				if (CC.settings.get('resetFormat') === 'clock') {
					reset = compact ? ` · ${formatResetClock(g.resetMs)}` : ` · resets ${formatResetClock(g.resetMs)}`;
				} else {
					const countdown = formatResetCountdown(g.resetMs, { compact });
					reset = compact ? ` · ${countdown}` : ` · resets in ${countdown}`;
				}
			}
			const text = `${label}: ${pct}%${reset}`;
			if (entry.text.textContent !== text) entry.text.textContent = text;
		}

		_usageTooltipText(g) {
			const hours = g.windowMs ? Math.round(g.windowMs / 3600000) : null;
			const windowText = hours === 5 ? '5-hour session window' : hours === 168 ? '7-day window' : 'Usage window';
			const lines = [`${g.label}: ${Math.round(g.pct * 10) / 10}% used`, windowText + (g.scoped ? ` (${g.label} only)` : '')];
			if (g.resetMs) lines.push(`Resets ${formatResetFull(g.resetMs)}`);
			if (this.usageStale) lines.push('(last known value; refreshing…)');
			lines.push('', 'The bar shows your usage; the line marks where you are in the window.', 'Click to refresh · right-click for settings.');
			return lines.join('\n');
		}

		_updateMarkers() {
			const now = Date.now();
			for (const entry of this.usageGroups.values()) {
				const g = entry.data;
				if (g?.resetMs && g.windowMs) {
					const start = g.resetMs - g.windowMs;
					const elapsed = Math.max(0, Math.min(g.windowMs, now - start));
					const pct = Math.max(0, Math.min(100, (elapsed / g.windowMs) * 100));
					entry.marker.classList.remove('cc-hidden');
					entry.marker.style.left = `${pct}%`;
				} else {
					entry.marker.classList.add('cc-hidden');
				}
			}
		}

		getUsageGroups() {
			return this.lastUsage;
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
					this._applyCacheColor();
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			for (const entry of this.usageGroups.values()) this._renderUsageText(entry);
			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI,
		resolveContextLimit
	};
})();

// ---- src/content/settings-panel.js -----------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// In-page settings dialog. Opened by right-clicking the counter, or from the extension's
	// toolbar icon. Built with plain DOM so it works the same in the extension and the userscript.
	const HOMEPAGE = 'https://github.com/swap407/claude-counter';

	const FIELDS = [
		{ section: 'Display' },
		{ key: 'showHeader', type: 'checkbox', label: 'Show token count and cache timer next to the chat title' },
		{ key: 'showUsageRow', type: 'checkbox', label: 'Show usage bars below the message box' },
		{ key: 'showModelLimits', type: 'checkbox', label: 'Show per-model weekly limits (e.g. Fable) as their own bar' },
		{ key: 'compact', type: 'checkbox', label: 'Compact labels (S 6% · 4h31m)' },
		{
			key: 'resetFormat',
			type: 'select',
			label: 'Reset time',
			options: [
				['countdown', 'Countdown (resets in 4h 31m)'],
				['clock', 'Clock time (resets 4:50 PM)']
			]
		},
		{
			key: 'contextLimit',
			type: 'select',
			label: 'Context bar scale',
			number: true,
			options: [
				[0, 'Auto (200k, or 1M for long-context models)'],
				[200000, '200k'],
				[500000, '500k'],
				[1000000, '1M']
			]
		},
		{ section: 'Notifications' },
		{ key: 'notifyThresholds', type: 'checkbox', label: 'When session or weekly usage reaches 75% and 90%', notify: true },
		{ key: 'notifyReset', type: 'checkbox', label: 'When a usage window resets', notify: true },
		{
			key: 'notifyUnusedBeforeReset',
			type: 'checkbox',
			label: 'Before a reset if under half is used (session: 30 min, weekly: 1 day)',
			notify: true
		},
		{
			key: 'notifyCacheExpiry',
			type: 'checkbox',
			label: 'When the prompt cache has under a minute left (tab in background)',
			notify: true
		}
	];

	let overlay = null;

	function close() {
		overlay?.remove();
		overlay = null;
		document.removeEventListener('keydown', onKey, true);
	}

	function onKey(e) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}

	function el(tag, props = {}, children = []) {
		const node = Object.assign(document.createElement(tag), props);
		for (const c of children) node.append(c);
		return node;
	}

	function permissionNote() {
		if (typeof Notification === 'undefined') return 'This browser does not support notifications.';
		if (Notification.permission === 'denied') {
			return 'Notifications are blocked for claude.ai. Allow them in the site settings (lock icon in the address bar).';
		}
		if (Notification.permission === 'default') return 'Turning one on will ask your browser for permission.';
		return '';
	}

	function render() {
		const settings = CC.settings.all();
		const body = el('div', { className: 'cc-settings__body' });
		const note = el('p', { className: 'cc-settings__note', textContent: permissionNote() });

		for (const f of FIELDS) {
			if (f.section) {
				body.append(el('h3', { className: 'cc-settings__section', textContent: f.section }));
				if (f.section === 'Notifications') body.append(note);
				continue;
			}

			if (f.type === 'checkbox') {
				const input = el('input', { type: 'checkbox', checked: !!settings[f.key] });
				input.addEventListener('change', async () => {
					if (input.checked && f.notify) {
						const perm = await CC.alerts.requestPermission();
						note.textContent = permissionNote();
						if (perm !== 'granted') {
							input.checked = false;
							return;
						}
					}
					CC.settings.set({ [f.key]: input.checked });
				});
				body.append(el('label', { className: 'cc-settings__row' }, [input, el('span', { textContent: f.label })]));
				continue;
			}

			if (f.type === 'select') {
				const select = el('select', { className: 'cc-settings__select' });
				for (const [value, text] of f.options) {
					select.append(el('option', { value: String(value), textContent: text, selected: settings[f.key] === value }));
				}
				select.addEventListener('change', () => {
					CC.settings.set({ [f.key]: f.number ? Number(select.value) : select.value });
				});
				body.append(
					el('label', { className: 'cc-settings__row cc-settings__row--select' }, [el('span', { textContent: f.label }), select])
				);
			}
		}

		const reset = el('button', { type: 'button', className: 'cc-settings__btn', textContent: 'Reset to defaults' });
		reset.addEventListener('click', () => {
			CC.settings.reset();
			open();
		});
		const done = el('button', { type: 'button', className: 'cc-settings__btn cc-settings__btn--primary', textContent: 'Done' });
		done.addEventListener('click', close);
		const link = el('a', { href: HOMEPAGE, target: '_blank', rel: 'noopener noreferrer', textContent: 'GitHub' });

		const header = el('div', { className: 'cc-settings__header' }, [
			el('h2', { className: 'cc-settings__title', textContent: 'Claude Counter settings' }),
			el('span', { className: 'cc-settings__version', textContent: CC.VERSION ? `v${CC.VERSION}` : '' })
		]);
		const footer = el('div', { className: 'cc-settings__footer' }, [link, el('span', { className: 'cc-settings__spacer' }), reset, done]);

		return el('div', { className: 'cc-settings', role: 'dialog', ariaModal: 'true', ariaLabel: 'Claude Counter settings' }, [
			header,
			body,
			footer
		]);
	}

	function open() {
		close();
		overlay = el('div', { className: 'cc-settingsOverlay' }, [render()]);
		overlay.dataset.mode = document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
		overlay.addEventListener('mousedown', (e) => {
			if (e.target === overlay) close();
		});
		document.body.appendChild(overlay);
		document.addEventListener('keydown', onKey, true);
		overlay.querySelector('input, select, button')?.focus();
	}

	CC.openSettings = open;
})();

// ---- styles (src/styles.css) -----------------------------------------------------
(() => {
	'use strict';

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = "/* Layout is defined here rather than with claude.ai's utility classes, which change between\n   redesigns. */\n\n/* Header: tokens + cache timer */\n.cc-header {\n\tmargin-top: 2px;\n\tfont-size: 12px;\n\tline-height: 16px;\n\tuser-select: none;\n}\n\n.cc-headerItem,\n.cc-lengthGroup,\n.cc-barWrap {\n\tdisplay: inline-flex;\n\talign-items: center;\n\twhite-space: nowrap;\n}\n\n/* Header placed in the newer title bar, between the title and the spacer */\n.cc-header--titlebar {\n\tflex-shrink: 0;\n\tmargin-top: 0;\n\tpadding-inline: 8px !important;\n}\n\n/* Usage row: session + weekly + per-model limits */\n.cc-usageRow {\n\tposition: relative;\n\tz-index: 50;\n\tdisplay: flex;\n\tflex-flow: row wrap;\n\talign-items: center;\n\tgap: 4px 12px;\n\twidth: 100%;\n\tfont-size: 11px;\n\tline-height: 16px;\n\tcursor: pointer;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n/* Values restored from the last page load, until claude.ai confirms them */\n.cc-usageRow--stale {\n\topacity: 0.7;\n}\n\n/* Row placed inside the composer card, below the overlaid toolbar */\n.cc-usageRow--composer {\n\tbox-sizing: border-box;\n\tpadding: 6px 6px 2px;\n}\n\n/* Groups share the row; when three don't fit, they wrap instead of squeezing the bars */\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tflex: 1 1 auto;\n\tmin-width: 0;\n}\n\n.cc-usageRow--compact .cc-usageGroup {\n\tgap: 6px;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--mini {\n\twidth: 60px;\n\theight: 7px;\n\t--cc-radius: 2px;\n}\n\n.cc-bar--usage {\n\theight: 10px;\n\tflex: 1 1 40px;\n\tmin-width: 40px;\n}\n\n/* Tooltips (own colors: claude.ai's utility class names change between redesigns) */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tmax-width: 420px;\n\tpadding: 6px 9px;\n\tborder-radius: 6px;\n\tfont-size: 12px;\n\tline-height: 1.45;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n\tbackground: #262624;\n\tcolor: #f5f4ef;\n\tbox-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);\n}\n\nhtml[data-mode='light'] .cc-tooltip {\n\tbackground: #ffffff;\n\tcolor: #1f1e1d;\n\tborder: 1px solid #dedcd5;\n\tbox-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Settings panel */\n.cc-settingsOverlay {\n\t--cc-panel-bg: #262624;\n\t--cc-panel-fg: #f5f4ef;\n\t--cc-panel-muted: #a3a29c;\n\t--cc-panel-border: #3e3e3a;\n\t--cc-panel-accent: #2c84db;\n\n\tposition: fixed;\n\tinset: 0;\n\tz-index: 10000;\n\tdisplay: flex;\n\talign-items: center;\n\tjustify-content: center;\n\tpadding: 16px;\n\tbackground: rgba(0, 0, 0, 0.45);\n\tfont-family: inherit;\n}\n\n.cc-settingsOverlay[data-mode='light'] {\n\t--cc-panel-bg: #ffffff;\n\t--cc-panel-fg: #1f1e1d;\n\t--cc-panel-muted: #6b6a65;\n\t--cc-panel-border: #dedcd5;\n\t--cc-panel-accent: #2c84db;\n}\n\n.cc-settings {\n\twidth: min(480px, 100%);\n\tmax-height: calc(100vh - 32px);\n\toverflow: auto;\n\tbox-sizing: border-box;\n\tpadding: 18px 20px;\n\tborder: 1px solid var(--cc-panel-border);\n\tborder-radius: 12px;\n\tbackground: var(--cc-panel-bg);\n\tcolor: var(--cc-panel-fg);\n\tfont-size: 13px;\n\tline-height: 1.45;\n\tbox-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);\n}\n\n.cc-settings__header {\n\tdisplay: flex;\n\talign-items: baseline;\n\tgap: 8px;\n\tmargin-bottom: 4px;\n}\n\n.cc-settings__title {\n\tmargin: 0;\n\tfont-size: 16px;\n\tfont-weight: 600;\n}\n\n.cc-settings__version {\n\tcolor: var(--cc-panel-muted);\n\tfont-size: 12px;\n}\n\n.cc-settings__section {\n\tmargin: 14px 0 6px;\n\tfont-size: 12px;\n\tfont-weight: 600;\n\tletter-spacing: 0.04em;\n\ttext-transform: uppercase;\n\tcolor: var(--cc-panel-muted);\n}\n\n.cc-settings__note {\n\tmargin: 0 0 6px;\n\tcolor: var(--cc-panel-muted);\n\tfont-size: 12px;\n}\n\n.cc-settings__note:empty {\n\tdisplay: none;\n}\n\n.cc-settings__row {\n\tdisplay: flex;\n\talign-items: flex-start;\n\tgap: 10px;\n\tpadding: 5px 0;\n\tcursor: pointer;\n}\n\n.cc-settings__row input[type='checkbox'] {\n\tmargin-top: 3px;\n\taccent-color: var(--cc-panel-accent);\n\tflex-shrink: 0;\n}\n\n.cc-settings__row--select {\n\talign-items: center;\n\tjustify-content: space-between;\n}\n\n.cc-settings__select {\n\tmax-width: 60%;\n\tpadding: 4px 6px;\n\tborder: 1px solid var(--cc-panel-border);\n\tborder-radius: 6px;\n\tbackground: var(--cc-panel-bg);\n\tcolor: var(--cc-panel-fg);\n\tfont: inherit;\n}\n\n.cc-settings__footer {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tmargin-top: 16px;\n}\n\n.cc-settings__footer a {\n\tcolor: var(--cc-panel-accent);\n\ttext-decoration: underline;\n}\n\n.cc-settings__spacer {\n\tflex: 1;\n}\n\n.cc-settings__btn {\n\tpadding: 6px 12px;\n\tborder: 1px solid var(--cc-panel-border);\n\tborder-radius: 8px;\n\tbackground: transparent;\n\tcolor: var(--cc-panel-fg);\n\tfont: inherit;\n\tcursor: pointer;\n}\n\n.cc-settings__btn--primary {\n\tborder-color: var(--cc-panel-accent);\n\tbackground: var(--cc-panel-accent);\n\tcolor: #ffffff;\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n";

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	if (document.head) injectStyles();
	else document.addEventListener('DOMContentLoaded', injectStyles, { once: true });
})();

// ---- src/content/main.js ---------------------------------------------------------
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	CC.PLATFORM = runtime?.getManifest ? 'extension' : 'userscript';
	if (!CC.VERSION && runtime?.getManifest) {
		try {
			CC.VERSION = runtime.getManifest().version;
		} catch {
			// ignore
		}
	}

	const HOUR_MS = 60 * 60 * 1000;
	const SESSION_WINDOW_MS = 5 * HOUR_MS;
	const WEEK_WINDOW_MS = 7 * 24 * HOUR_MS;
	const USAGE_KEY = `${CC.CONST.STORAGE_PREFIX}usage`;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	// ---- Usage parsing -------------------------------------------------------------------
	// Normalized usage is a list of groups:
	// { key, label, shortLabel, pct (0-100), resetMs, windowMs, scoped }

	const clampPct = (n) => Math.max(0, Math.min(100, n));

	function sessionGroup(pct, resetMs) {
		return { key: 'session', label: 'Session', shortLabel: 'S', pct, resetMs, windowMs: SESSION_WINDOW_MS, scoped: false };
	}

	function weeklyGroup(pct, resetMs) {
		return { key: 'weekly', label: 'Weekly', shortLabel: 'W', pct, resetMs, windowMs: WEEK_WINDOW_MS, scoped: false };
	}

	function parseResetMs(value) {
		if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
		if (typeof value === 'string') {
			const ms = Date.parse(value);
			return Number.isFinite(ms) ? ms : null;
		}
		return null;
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;
		const groups = [];

		// Newer shape: limits: [{ kind: 'session' | 'weekly_all' | 'weekly_scoped', percent, resets_at, scope }]
		if (Array.isArray(raw.limits)) {
			for (const l of raw.limits) {
				const pct = typeof l?.percent === 'number' ? l.percent : typeof l?.utilization === 'number' ? l.utilization : null;
				if (pct === null || !Number.isFinite(pct)) continue;
				const resetMs = parseResetMs(l.resets_at);
				if (l.kind === 'session') groups.push(sessionGroup(clampPct(pct), resetMs));
				else if (l.kind === 'weekly_all') groups.push(weeklyGroup(clampPct(pct), resetMs));
				else if (l.kind === 'weekly_scoped') {
					const name = l.scope?.model?.display_name || l.scope?.surface?.display_name || l.scope?.model?.id || 'Model';
					groups.push({
						key: `weekly:${name}`,
						label: name,
						shortLabel: name.slice(0, 3),
						pct: clampPct(pct),
						resetMs,
						windowMs: WEEK_WINDOW_MS,
						scoped: true
					});
				}
			}
		}

		// Legacy shape (and fallback when limits lacks an entry): five_hour / seven_day
		const legacy = (w) =>
			w && typeof w.utilization === 'number' && Number.isFinite(w.utilization)
				? { pct: clampPct(w.utilization), resetMs: parseResetMs(w.resets_at) }
				: null;
		if (!groups.some((g) => g.key === 'session')) {
			const s = legacy(raw.five_hour);
			if (s) groups.push(sessionGroup(s.pct, s.resetMs));
		}
		if (!groups.some((g) => g.key === 'weekly')) {
			const w = legacy(raw.seven_day);
			if (w) groups.push(weeklyGroup(w.pct, w.resetMs));
		}

		return groups.length ? sortGroups(groups) : null;
	}

	// SSE message_limit only carries the 5h / 7d windows (utilization 0-1, resets_at in seconds).
	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;
		const read = (w) =>
			w && typeof w.utilization === 'number' && Number.isFinite(w.utilization)
				? { pct: clampPct(w.utilization * 100), resetMs: parseResetMs(w.resets_at) }
				: null;
		const groups = [];
		const s = read(raw.windows['5h']);
		const w = read(raw.windows['7d']);
		if (s) groups.push(sessionGroup(s.pct, s.resetMs));
		if (w) groups.push(weeklyGroup(w.pct, w.resetMs));
		return groups.length ? groups : null;
	}

	function sortGroups(groups) {
		const rank = (g) => (g.key === 'session' ? 0 : g.key === 'weekly' ? 1 : 2);
		return [...groups].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
	}

	// Merge a partial update (e.g. SSE without per-model limits) into the current groups.
	function mergeGroups(current, update) {
		const byKey = new Map((current || []).map((g) => [g.key, g]));
		for (const g of update) byKey.set(g.key, g);
		return sortGroups([...byKey.values()]);
	}

	// ---- Persisted usage (survives reloads; issue #43) -------------------------------------

	function saveUsageSnapshot(groups) {
		try {
			localStorage.setItem(USAGE_KEY, JSON.stringify({ savedAt: Date.now(), groups }));
		} catch {
			// ignore
		}
	}

	function loadUsageSnapshot() {
		try {
			const raw = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null');
			if (!raw || !Array.isArray(raw.groups)) return null;
			if (Date.now() - raw.savedAt > CC.CONST.USAGE_SNAPSHOT_MAX_AGE_MS) return null;
			// A window that has reset since the snapshot no longer has a meaningful value
			const now = Date.now();
			const groups = raw.groups.filter((g) => g && typeof g.pct === 'number' && (!g.resetMs || g.resetMs > now));
			return groups.length ? groups : null;
		} catch {
			return null;
		}
	}

	// ---- State -------------------------------------------------------------------------------

	let currentConversationId = null;
	let currentOrgId = null;

	let usageGroups = null; // last snapshot
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandled = new Map(); // group key -> resetMs already refreshed for
	let idleRefreshTimer = null;
	let lastGenerationTransport = null;

	let ui = null;

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(groups, source) {
		if (!groups) return;
		const now = Date.now();
		usageGroups = source === 'sse' ? mergeGroups(usageGroups, groups) : groups;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		saveUsageSnapshot(usageGroups);
		ui.setUsage(usageGroups);
		CC.alerts.onUsage(usageGroups);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		applyUsageUpdate(parseUsageFromUsageEndpoint(raw), 'usage');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			// ignore
		}
	}

	function handleGenerationStart(payload) {
		lastGenerationTransport = payload?.transport || 'sse';
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	// A reply finished streaming. The new Connect transport carries no usage data we can read,
	// so re-fetch usage and the conversation. For SSE the message_limit event already updated
	// session/weekly; the /usage fetch also brings per-model limits up to date.
	function handleGenerationIdle(payload) {
		clearTimeout(idleRefreshTimer);
		idleRefreshTimer = setTimeout(() => {
			if (payload?.transport === 'connect' || currentConversationId) refreshConversation();
			refreshUsage();
		}, 400);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics(metrics);
	}

	function handleMessageLimit(messageLimit) {
		applyUsageUpdate(parseUsageFromMessageLimit(messageLimit), 'sse');
	}

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and the header anchor doesn't exist on home/new pages
		waitForElement(CC.DOM.USAGE_ANCHOR, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.HEADER_ANCHOR, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			ui.setConversationMetrics();
		} else {
			// Best-effort orgId from cookie.
			updateOrgIdIfNeeded(getOrgIdFromCookie());
			await refreshConversation();
		}

		// Usage is org-level, not conversation-level. Only fetch on first load or if stale.
		if (!usageGroups || Date.now() - lastUsageUpdateMs > HOUR_MS) await refreshUsage();
	}

	function watchBranchNavigation() {
		// Refresh on branch navigation - watch for the branch indicator to change
		let branchObserver = null;
		document.addEventListener('click', (e) => {
			if (!currentConversationId) return;
			const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
			if (!btn) return;

			// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
			const container = btn.closest('.inline-flex');
			const spans = container?.querySelectorAll('span') || [];
			const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
			if (!indicator) return;

			const originalText = indicator.textContent;

			// Clean up any existing observer
			if (branchObserver) branchObserver.disconnect();

			// Watch for the indicator text to change (with cleanup timeout)
			branchObserver = new MutationObserver(() => {
				if (indicator.textContent !== originalText) {
					branchObserver.disconnect();
					branchObserver = null;
					refreshConversation();
				}
			});

			branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

			// Clean up if nothing changes after 60 seconds
			setTimeout(() => {
				if (branchObserver) {
					branchObserver.disconnect();
					branchObserver = null;
				}
			}, 60000);
		});
	}

	function tick() {
		ui.tick();

		const now = Date.now();
		const groups = usageGroups || [];

		// Refresh usage when a window ends. SSE won't fire at rollover unless a message is sent.
		for (const g of groups) {
			if (g.resetMs && now >= g.resetMs && rolloverHandled.get(g.key) !== g.resetMs) {
				rolloverHandled.set(g.key, g.resetMs);
				refreshUsage();
			}
		}

		// Hourly safety refresh.
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > HOUR_MS && anyAge > HOUR_MS) {
			refreshUsage();
		}

		CC.alerts.onTick({ groups, cachedUntilMs: ui.lastCachedUntilMs });
	}

	CC.debugState = () => ({
		conversation: !!currentConversationId,
		org: !!(currentOrgId || getOrgIdFromCookie()),
		usageGroups: (usageGroups || []).map((g) => `${g.key}=${Math.round(g.pct)}%`),
		lastUsageUpdate: lastUsageUpdateMs ? new Date(lastUsageUpdateMs).toLocaleTimeString() : null,
		lastReplyTransport: lastGenerationTransport,
		tokens: ui?.metrics?.totalTokens ?? null,
		model: ui?.metrics?.model ?? null
	});

	function start() {
		ui = new CC.ui.CounterUI({
			onUsageRefresh: refreshUsage,
			onOpenSettings: () => CC.openSettings()
		});
		ui.initialize();

		const snapshot = loadUsageSnapshot();
		if (snapshot) ui.setUsage(snapshot, { stale: true });

		CC.bridge.on('cc:generation_start', handleGenerationStart);
		CC.bridge.on('cc:generation_idle', handleGenerationIdle);
		CC.bridge.on('cc:conversation', handleConversationPayload);
		CC.bridge.on('cc:message_limit', handleMessageLimit);

		// Extension toolbar icon opens the settings panel
		runtime?.onMessage?.addListener?.((msg) => {
			if (msg?.type === 'cc:open-settings') CC.openSettings();
		});

		const unobserveUrl = observeUrlChanges(handleUrlChange);
		window.addEventListener('beforeunload', unobserveUrl);
		watchBranchNavigation();

		// Initial attach + fetches
		handleUrlChange();

		// Keep countdowns + markers updated.
		setInterval(tick, 1000);
	}

	// The userscript runs at document-start, before <body> exists.
	if (document.body) start();
	else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
