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
			handleEventStream(response, { isReply: !!url && (url.includes('/completion') || url.includes('/retry_completion')) });
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

	async function handleEventStream(response, { isReply = false } = {}) {
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
			if (isReply) post('cc:generation_idle', { transport: 'sse' });
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
