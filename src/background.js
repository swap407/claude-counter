'use strict';

// Toolbar icon: open the in-page settings panel on claude.ai. On any other tab (where the
// content script isn't running) open claude.ai instead.
const api = globalThis.browser || globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
	if (tab?.id == null) return;
	try {
		await api.tabs.sendMessage(tab.id, { type: 'cc:open-settings' });
	} catch {
		api.tabs.create({ url: 'https://claude.ai/new' });
	}
});
