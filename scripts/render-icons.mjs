// Renders icons/icon.svg to icons/icon{16,32,48,96,128,256}.png with headless Chrome.
// Usage: node scripts/render-icons.mjs [path-to-chrome]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 96, 128, 256];
const PORT = 9334;
const chromePath =
	process.argv[2] ||
	{
		win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
		darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		linux: 'google-chrome'
	}[process.platform];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const svg = readFileSync(join(root, 'icons/icon.svg'), 'utf8');
const chrome = spawn(
	chromePath,
	['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cc-icons-'))}`, 'about:blank'],
	{ stdio: 'ignore' }
);

try {
	let targets = [];
	for (let i = 0; i < 50 && !targets.length; i++) {
		try {
			targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
		} catch {
			// not up yet
		}
		if (!targets.length) await sleep(200);
	}
	const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = new Map();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.error) console.error(`CDP error (${msg.id}): ${msg.error.message}`);
		pending.get(msg.id)?.(msg.result);
	};
	const send = (method, params = {}) =>
		new Promise((r) => {
			pending.set(++id, r);
			ws.send(JSON.stringify({ id, method, params }));
		});

	await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
	// Swap the document body for each size instead of navigating (navigation can detach the target)
	for (const size of SIZES) {
		await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
		const markup = svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `);
		await send('Runtime.evaluate', {
			expression: `document.documentElement.style.background = 'transparent'; document.body.style.cssText = 'margin:0;background:transparent'; document.body.innerHTML = ${JSON.stringify(markup)}; 1`
		});
		await sleep(150);
		const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
		writeFileSync(join(root, `icons/icon${size}.png`), Buffer.from(shot.data, 'base64'));
		console.log(`icons/icon${size}.png`);
	}
	ws.close();
} finally {
	chrome.kill();
}
