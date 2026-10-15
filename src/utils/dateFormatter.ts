/**
 * Format relative time string from a date string (e.g. "in 23m", "in 3h 10m", "in 6d")
 */
export function formatRelativeTime(dateStr: string): string {
    if (!dateStr) return '';
    // Support CEST / CET timezone tokens in date strings
    const cleaned = dateStr.replace(/\s+CEST/i, ' +02:00').replace(/\s+CET/i, ' +01:00');
    const target = new Date(cleaned);
    if (isNaN(target.getTime())) return '';

    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) return 'soon';

    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 60) return `in ${diffMin}m`;

    const diffHours = Math.floor(diffMin / 60);
    const remMin = diffMin % 60;
    if (diffHours < 24) {
        return remMin > 0 ? `in ${diffHours}h ${remMin}m` : `in ${diffHours}h`;
    }

    const diffDays = Math.round(diffHours / 24);
    return `in ${diffDays}d`;
}

/**
 * Format elapsed seconds as Xh XXm XXs (e.g. 0h 01m 20s, 1h 05m 12s)
 */
export function formatElapsedTime(elapsedSeconds: number): string {
    const totalSec = Math.max(0, Math.floor(elapsedSeconds));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Format a date or ISO/SQLite timestamp into human-readable local machine time.
 * Example: Wed, 13th of Aug, 2026 22:40
 */
export function formatHumanDate(dateInput: string | number | Date): string {
    if (!dateInput) return '';

    let d: Date;
    if (dateInput instanceof Date) {
        d = dateInput;
    } else if (typeof dateInput === 'number') {
        d = new Date(dateInput);
    } else {
        const str = String(dateInput).trim();
        // Support CEST / CET timezone tokens in date strings
        const normalized = str.replace(/\s+CEST/i, ' +02:00').replace(/\s+CET/i, ' +01:00');

        // Check if string already contains a timezone indicator (Z or +HH:MM or -HH:MM)
        const hasTimezone = normalized.endsWith('Z') || /[+-]\d{2}(:?\d{2})?$/.test(normalized);

        let parsedStr = normalized;
        if (!hasTimezone) {
            // Raw SQLite date ('YYYY-MM-DD HH:MM:SS') or raw ISO without timezone - treat as UTC
            parsedStr = normalized.includes('T') ? normalized + 'Z' : normalized.replace(' ', 'T') + 'Z';
        }

        d = new Date(parsedStr);
        if (isNaN(d.getTime())) {
            d = new Date(normalized);
        }
        if (isNaN(d.getTime())) {
            d = new Date(str);
        }
    }

    if (isNaN(d.getTime())) return String(dateInput);

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const weekday = weekdays[d.getDay()];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();

    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');

    const j = day % 10;
    const k = day % 100;
    let suffix = 'th';
    if (j === 1 && k !== 11) {
        suffix = 'st';
    } else if (j === 2 && k !== 12) {
        suffix = 'nd';
    } else if (j === 3 && k !== 13) {
        suffix = 'rd';
    }

    return `${weekday}, ${day}${suffix} of ${month}, ${year} ${hours}:${minutes}`;
}
