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
