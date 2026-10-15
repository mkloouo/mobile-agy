export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Strip ANSI terminal escape sequences (colors, cursor control)
 */
export function stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Close any unclosed HTML tags and return the closed HTML and the list of open tags.
 * Ensures strictly valid LIFO tag nesting and strips orphan closing tags.
 */
export function balanceHtmlTags(html: string): { closedHtml: string; openTags: string[] } {
    const tagRegex = /<\/?([a-zA-Z0-9_-]+)(?:\s+[^>]*?)?>/g;
    const stack: { tag: string; fullOpenTag: string }[] = [];
    let match: RegExpExecArray | null;
    let result = '';
    let lastIndex = 0;

    while ((match = tagRegex.exec(html)) !== null) {
        const fullMatch = match[0];
        const tagName = match[1].toLowerCase();
        const isClosing = fullMatch.startsWith('</');
        const isSelfClosing = fullMatch.endsWith('/>') || ['br', 'hr', 'img'].includes(tagName);

        result += html.substring(lastIndex, match.index);
        lastIndex = match.index + fullMatch.length;

        if (isSelfClosing) {
            result += fullMatch;
            continue;
        }

        if (isClosing) {
            const topIdx = stack.map((s) => s.tag).lastIndexOf(tagName);
            if (topIdx !== -1) {
                // Unroll any tags opened after this tag to ensure strictly valid LIFO nesting
                for (let i = stack.length - 1; i > topIdx; i--) {
                    result += `</${stack[i].tag}>`;
                }
                result += fullMatch;
                stack.splice(topIdx);
            }
            // If tag was never opened, omit the orphan closing tag to avoid Telegram entity error
        } else {
            stack.push({ tag: tagName, fullOpenTag: fullMatch });
            result += fullMatch;
        }
    }

    result += html.substring(lastIndex);

    let closingTags = '';
    for (let i = stack.length - 1; i >= 0; i--) {
        closingTags += `</${stack[i].tag}>`;
    }

    return {
        closedHtml: result + closingTags,
        openTags: stack.map((s) => s.fullOpenTag),
    };
}

/**
 * Sanitize and validate HTML for Telegram Bot API:
 * 1. Strips any nested formatting tags (<b>, <i>, etc.) from inside <code> and <pre> blocks.
 * 2. Strips forbidden tags (<pre>, <code>) from inside <a> blocks.
 * 3. Balances all open tags so Telegram never rejects with "can't parse entities".
 */
export function sanitizeTelegramHtml(html: string): string {
    if (!html) return '';

    // First ensure tags are properly closed so regexes match multiline blocks
    const preBalanced = balanceHtmlTags(html).closedHtml;

    // Strip forbidden tags inside <pre>...</pre>
    let cleaned = preBalanced.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match) => {
        const content = match.slice(match.indexOf('>') + 1, match.lastIndexOf('</pre>'));
        const innerCleaned = content.replace(/<(?!(\/?code\b))[^>]+>/gi, '');
        const preTag = match.slice(0, match.indexOf('>') + 1);
        return `${preTag}${innerCleaned}</pre>`;
    });

    // Strip forbidden tags inside <code>...</code>
    cleaned = cleaned.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (match) => {
        const content = match.slice(match.indexOf('>') + 1, match.lastIndexOf('</code>'));
        const innerCleaned = content.replace(/<[^>]+>/g, '');
        const codeTag = match.slice(0, match.indexOf('>') + 1);
        return `${codeTag}${innerCleaned}</code>`;
    });

    // Strip forbidden tags inside <a>...</a> (Telegram disallows <pre> and <code> inside <a>)
    cleaned = cleaned.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (match) => {
        const content = match.slice(match.indexOf('>') + 1, match.lastIndexOf('</a>'));
        const innerCleaned = content.replace(/<\/?(pre|code)\b[^>]*>/gi, '');
        const aTag = match.slice(0, match.indexOf('>') + 1);
        return `${aTag}${innerCleaned}</a>`;
    });

    // Balance all unclosed tags
    return balanceHtmlTags(cleaned).closedHtml;
}

/**
 * Split a long text or HTML into chunks below Telegram's 4096 character limit,
 * properly balancing and reopening HTML tags across chunk boundaries.
 */
export function splitTelegramHtml(text: string, limit: number = 3900): string[] {
    const sanitized = sanitizeTelegramHtml(text);
    if (sanitized.length <= limit) {
        return [sanitized];
    }

    const chunks: string[] = [];
    let remaining = sanitized;

    while (remaining.length > limit) {
        let splitIndex = remaining.lastIndexOf('\n', limit);
        if (splitIndex < limit * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', limit);
        }
        if (splitIndex < limit * 0.3) {
            splitIndex = limit;
        }

        // Avoid splitting inside an HTML tag like <pre> or <code> or href="..."
        const lastLt = remaining.lastIndexOf('<', splitIndex);
        if (lastLt !== -1) {
            const nextGt = remaining.indexOf('>', lastLt);
            if (nextGt === -1 || nextGt >= splitIndex) {
                splitIndex = lastLt;
            }
        }

        // Avoid splitting inside an HTML entity like &amp;, &#39;, &quot;
        const lastAmp = remaining.lastIndexOf('&', splitIndex);
        if (lastAmp !== -1) {
            const nextSemi = remaining.indexOf(';', lastAmp);
            if (nextSemi !== -1 && nextSemi >= splitIndex && nextSemi - lastAmp <= 10 && !remaining.substring(lastAmp, nextSemi).includes(' ')) {
                splitIndex = lastAmp;
            }
        }

        if (splitIndex <= 0) {
            splitIndex = limit;
        }

        const rawChunk = remaining.substring(0, splitIndex);
        const { closedHtml, openTags } = balanceHtmlTags(rawChunk);
        chunks.push(sanitizeTelegramHtml(closedHtml));

        const nextPrefix = openTags.join('');
        const nextPart = remaining.substring(splitIndex);
        // Only strip a single leading newline at split boundary to preserve indentation
        const trimmedNextPart = nextPart.startsWith('\n') ? nextPart.slice(1) : nextPart;
        remaining = nextPrefix + trimmedNextPart;
    }

    if (remaining.length > 0) {
        const finalChunk = sanitizeTelegramHtml(remaining);
        const stripped = finalChunk.replace(/<[^>]+>/g, '').trim();
        if (stripped.length > 0) {
            chunks.push(finalChunk);
        }
    }

    return chunks.length > 0 ? chunks : [sanitized];
}
