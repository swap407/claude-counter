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
