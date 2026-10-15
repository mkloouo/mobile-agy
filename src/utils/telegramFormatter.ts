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
