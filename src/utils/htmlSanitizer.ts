export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Strip ANSI terminal escape sequences (colors, cursor control)
 */
export function stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Close any unclosed HTML tags and return the closed HTML and the list of open tags.
 */
export function balanceHtmlTags(html: string): { closedHtml: string; openTags: string[] } {
    const tagRegex = /<\/?([a-zA-Z0-9_-]+)(?:\s+[^>]*?)?>/g;
    const stack: { tag: string; fullOpenTag: string }[] = [];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(html)) !== null) {
        const fullMatch = match[0];
        const tagName = match[1].toLowerCase();
        const isClosing = fullMatch.startsWith('</');

        if (isClosing) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tagName) {
                    stack.splice(i, 1);
                    break;
                }
            }
        } else {
            stack.push({ tag: tagName, fullOpenTag: fullMatch });
        }
    }

    let closingTags = '';
    for (let i = stack.length - 1; i >= 0; i--) {
        closingTags += `</${stack[i].tag}>`;
    }

    return {
        closedHtml: html + closingTags,
        openTags: stack.map((s) => s.fullOpenTag),
    };
}

/**
 * Split a long text or HTML into chunks below Telegram's 4096 character limit,
 * properly balancing and reopening HTML tags across chunk boundaries.
 */
export function splitTelegramHtml(text: string, limit: number = 3900): string[] {
    if (text.length <= limit) {
        return [balanceHtmlTags(text).closedHtml];
    }

    const chunks: string[] = [];
    let remaining = text;

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
        const lastGt = remaining.lastIndexOf('>', splitIndex);
        if (lastLt > lastGt) {
            splitIndex = lastLt;
        }

        if (splitIndex <= 0) {
            splitIndex = limit;
        }

        const rawChunk = remaining.substring(0, splitIndex);
        const { closedHtml, openTags } = balanceHtmlTags(rawChunk);
        chunks.push(closedHtml);

        const nextPrefix = openTags.join('');
        remaining = nextPrefix + remaining.substring(splitIndex).trim();
    }

    if (remaining.length > 0) {
        chunks.push(balanceHtmlTags(remaining).closedHtml);
    }

    return chunks;
}
