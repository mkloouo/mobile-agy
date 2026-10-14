/**
 * Telegram text formatter — HTML-based formatting for Telegram messages.
 */

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

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
        let formattedLine = line;
        const headerMatch = formattedLine.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            formattedLine = `<b>${escapeHtml(headerMatch[2])}</b>`;
        } else {
            // Escape HTML
            formattedLine = escapeHtml(formattedLine);

            // Bold: **text** or __text__
            formattedLine = formattedLine.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
            formattedLine = formattedLine.replace(/__(.+?)__/g, '<b>$1</b>');

            // Italic: *text* or _text_
            formattedLine = formattedLine.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
            formattedLine = formattedLine.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

            // Inline code: `code`
            formattedLine = formattedLine.replace(/`([^`]+)`/g, '<code>$1</code>');

            // Strikethrough: ~~text~~
            formattedLine = formattedLine.replace(/~~(.+?)~~/g, '<s>$1</s>');
        }

        result.push(formattedLine);
    }

    return result.join('\n');
}

/**
 * Split a long text or HTML into chunks below Telegram's 4096 character limit.
 */
export function splitTelegramHtml(text: string, limit: number = 4000): string[] {
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > limit) {
        // Try to split at newline
        let splitIndex = remaining.lastIndexOf('\n', limit);
        if (splitIndex < limit * 0.5) {
            // If newline is too far back, split at space
            splitIndex = remaining.lastIndexOf(' ', limit);
        }
        if (splitIndex < limit * 0.3) {
            // If space is too far back, hard cut
            splitIndex = limit;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trim();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}
