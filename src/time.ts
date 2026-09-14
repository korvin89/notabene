/** ISO-8601 with the local offset: `2026-09-13T20:15:31+03:00` (ARCHITECTURE.md §3.2). */
export function localIsoTimestamp(date: Date = new Date()): string {
	const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
		+ `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		+ `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
}
