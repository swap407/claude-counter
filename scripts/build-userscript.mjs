// Builds userscript/claude-counter.user.js from the extension sources, so features are written
// once in src/. Usage:
//   node scripts/build-userscript.mjs          write the userscript
//   node scripts/build-userscript.mjs --check  exit 1 if the userscript is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const OUT = 'userscript/claude-counter.user.js';

const REPO = 'https://github.com/swap407/claude-counter';
const RAW = 'https://raw.githubusercontent.com/swap407/claude-counter/main/userscript/claude-counter.user.js';
// Loaded by the userscript manager instead of the bundled src/vendor copy
const TOKENIZER_URL = 'https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js';
const VENDOR = 'src/vendor/o200k_base.js';

const manifest = JSON.parse(read('manifest.json'));
const version = `${manifest.version}-userscript`;
const contentScripts = manifest.content_scripts[0].js.filter((p) => p !== VENDOR);
const mainScript = contentScripts.at(-1);

const header = `// ==UserScript==
// @name         ${manifest.name}
// @namespace    ${REPO}
// @version      ${version}
// @description  Shows token count, cache timer, and usage bars on claude.ai.
// @homepageURL  ${REPO}
// @updateURL    ${RAW}
// @downloadURL  ${RAW}
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// @require      ${TOKENIZER_URL}
// ==/UserScript==

// GENERATED FILE - do not edit. Built from src/ by scripts/build-userscript.mjs
// (run \`npm run build\`). Edit the sources in src/ instead.
`;

const section = (path, body) => `\n// ---- ${path} ${'-'.repeat(Math.max(0, 76 - path.length))}\n${body.trimEnd()}\n`;

const styles = `(() => {
	'use strict';

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = ${JSON.stringify(read(manifest.content_scripts[0].css[0]))};

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	if (document.head) injectStyles();
	else document.addEventListener('DOMContentLoaded', injectStyles, { once: true });
})();`;

let out = header;
out += section('version', `(globalThis.ClaudeCounter = globalThis.ClaudeCounter || {}).VERSION = ${JSON.stringify(version)};`);
// The page-world bridge runs inline: a userscript with @grant none already runs in the page.
out += section('src/injected/bridge.js', read('src/injected/bridge.js'));
for (const path of contentScripts) {
	if (path === mainScript) out += section('styles (src/styles.css)', styles);
	out += section(path, read(path));
}

const final = out.replace(/\n/g, '\r\n');

if (process.argv.includes('--check')) {
	let current = '';
	try {
		current = readFileSync(join(root, OUT), 'utf8');
	} catch {
		// missing counts as out of date
	}
	if (current.replace(/\r\n/g, '\n') !== final.replace(/\r\n/g, '\n')) {
		console.error(`${OUT} is out of date. Run: npm run build`);
		process.exit(1);
	}
	console.log(`${OUT} is up to date.`);
} else {
	writeFileSync(join(root, OUT), final);
	console.log(`Wrote ${OUT} (${version}, ${contentScripts.length + 1} modules).`);
}
