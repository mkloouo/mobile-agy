import { escapeHtml } from './htmlSanitizer';

export * from './htmlSanitizer';
export * from './toolDescriber';
export * from './quotaFormatter';

/**
 * Format inline Markdown syntax on an HTML-escaped string for Telegram HTML.
 */
function formatMarkdownLine(text: string): string {
    let result = text;

    // Links: [text](url)
    // 1) Web / tg links -> <a href="url">text</a>
    // 2) file:/// or local filesystem links -> <code>text</code> (since mobile Telegram cannot open file://)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
        const trimmedUrl = url.trim();
        const cleanText = linkText.replace(/^`+|`+$/g, '');
        if (/^(https?:\/\/|tg:\/\/)/i.test(trimmedUrl)) {
            return `<a href="${trimmedUrl}">${cleanText}</a>`;
        }
        return `<code>${cleanText}</code>`;
    });

    // Inline code: `code`
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__(.+?)__/g, '<b>$1</b>');

    // Italic: *text* or _text_
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
    result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

    // Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    return result;
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
        // If string does not specify timezone (like SQLite 'YYYY-MM-DD HH:MM:SS' or ISO without offset),
        // treat it as UTC so it properly converts to machine local timezone
        const utcStr = str.includes('T')
            ? (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str) ? str : str + 'Z')
            : str.replace(' ', 'T') + 'Z';
        d = new Date(utcStr);
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

/**
 * Format markdown text for Telegram HTML parse mode.
 */
export function formatForTelegram(markdown: string): string {
    if (!markdown) return '';

    const lines = markdown.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let codeBlockLang = '';
    let inBlockquote = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const isQuoteLine = /^>\s?/.test(line);

        // If in blockquote and current line is not quote, close blockquote
        if (inBlockquote && !isQuoteLine && !inCodeBlock) {
            result.push('</blockquote>');
            inBlockquote = false;
        }

        // If not in blockquote and line is quote, open blockquote
        if (!inBlockquote && isQuoteLine) {
            inBlockquote = true;
            result.push('<blockquote>');
        }

        // Strip leading quote prefix if line is quoted
        if (isQuoteLine) {
            line = line.replace(/^>\s?/, '');
        }

        const trimmed = line.trim();

        // Handle GitHub-style callouts: [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]
        const calloutMatch = trimmed.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);
        if (calloutMatch) {
            const kind = calloutMatch[1].toUpperCase();
            const emojiMap: Record<string, string> = {
                NOTE: '💡 <b>Note:</b>',
                TIP: '💡 <b>Tip:</b>',
                IMPORTANT: '⚠️ <b>Important:</b>',
                WARNING: '⚠️ <b>Warning:</b>',
                CAUTION: '🛑 <b>Caution:</b>',
            };
            result.push(emojiMap[kind] || `<b>${kind}:</b>`);
            continue;
        }

        if (trimmed.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            if (inCodeBlock) {
                codeBlockLang = trimmed.slice(3).trim();
                result.push(codeBlockLang ? `<pre><code class="language-${escapeHtml(codeBlockLang)}">` : '<pre>');
            } else {
                result.push(codeBlockLang ? '</code></pre>' : '</pre>');
                codeBlockLang = '';
            }
            continue;
        }

        if (inCodeBlock) {
            result.push(escapeHtml(line));
            continue;
        }

        // Headers: # Title -> <b>Title</b>
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const escaped = escapeHtml(headerMatch[2]);
            result.push(`<b>${formatMarkdownLine(escaped)}</b>`);
        } else {
            const escaped = escapeHtml(line);
            result.push(formatMarkdownLine(escaped));
        }
    }

    if (inCodeBlock) {
        result.push(codeBlockLang ? '</code></pre>' : '</pre>');
    }
    if (inBlockquote) {
        result.push('</blockquote>');
    }

    return result.join('\n');
}
