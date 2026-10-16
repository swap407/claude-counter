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
		// The user may have switched chats while tokens were being counted
		if (conversationId !== currentConversationId) return;
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
