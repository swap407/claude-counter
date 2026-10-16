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
