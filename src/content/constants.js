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
