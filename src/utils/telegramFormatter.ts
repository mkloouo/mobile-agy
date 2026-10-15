import { escapeHtml } from './htmlSanitizer';

export * from './htmlSanitizer';
export * from './toolDescriber';
export * from './quotaFormatter';

/**
 * Format inline Markdown syntax on an HTML-escaped string for Telegram HTML.
 */
function formatMarkdownLine(text: string): string {
    let result = text;

    // 1. Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
        const trimmedUrl = url.trim();
        const cleanText = linkText.replace(/^`+|`+$/g, '');
        if (/^(https?:\/\/|tg:\/\/)/i.test(trimmedUrl)) {
            return `<a href="${trimmedUrl}">${cleanText}</a>`;
        }
        return `<code>${cleanText}</code>`;
    });

    // 2. Extract and protect inline code: `code`
    const codeBlocks: string[] = [];
    result = result.replace(/`([^`]+)`/g, (_match, codeContent) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<code>${codeContent}</code>`);
        return `\x00CODE_${idx}\x00`;
    });

    // 3. Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__(.+?)__/g, '<b>$1</b>');

    // 4. Italic: *text* or _text_
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
    result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

    // 5. Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // 6. Restore protected inline code
    result = result.replace(/\x00CODE_(\d+)\x00/g, (_match, idxStr) => {
        const idx = parseInt(idxStr, 10);
        return codeBlocks[idx] || '';
    });

    return result;
}

export * from './dateFormatter';

/**
 * Clean up intermediate agent status chatter and boilerplate polling loops from model response.
 */
export function cleanModelResponse(text: string): string {
    if (!text) return '';

    const lines = text.split('\n');
    const cleanedLines: string[] = [];
    let inCode = false;
    let lastLine = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            inCode = !inCode;
            cleanedLines.push(line);
            lastLine = trimmed;
            continue;
        }

        // Inside code blocks: never drop or deduplicate lines
        if (inCode) {
            cleanedLines.push(line);
            continue;
        }

        // Collapse consecutive identical wait/poll phrases
        const isWaitLine = /^waiting for (tests?|build|gradle|task|final assertions|command|process).*$/i.test(trimmed) ||
            /^i will wait for .*$/i.test(trimmed);

        if (isWaitLine) {
            if (trimmed === lastLine || lines.length > 5) {
                continue;
            }
        }

        cleanedLines.push(line);
        if (trimmed) {
            lastLine = trimmed;
        }
    }

    return cleanedLines.join('\n').trim();
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
                // Extract only clean language identifier without extra options/titles
                codeBlockLang = trimmed.slice(3).trim().split(/\s+/)[0] || '';
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
            const formatted = formatMarkdownLine(escaped);
            // Avoid double bold wrapping if title is already bold
            if (formatted.startsWith('<b>') && formatted.endsWith('</b>')) {
                result.push(formatted);
            } else {
                result.push(`<b>${formatted}</b>`);
            }
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
