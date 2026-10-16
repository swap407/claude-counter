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
