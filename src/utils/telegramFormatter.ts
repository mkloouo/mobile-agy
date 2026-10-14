import path from 'path';

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
 * Shorten a file path for compact display (e.g. /Users/foo/bar/src/ui/money.ts -> src/ui/money.ts)
 */
export function shortenPath(filePath?: string, workspacePath?: string): string {
    if (!filePath) return '';
    if (workspacePath && filePath.startsWith(workspacePath)) {
        const rel = path.relative(workspacePath, filePath);
        if (rel && !rel.startsWith('..')) return rel;
    }
    const parts = filePath.split(/[/\\]+/).filter(Boolean);
    if (parts.length > 2) {
        return parts.slice(-2).join('/');
    }
    return path.basename(filePath);
}

/**
 * Describe a tool action in human-friendly terms (e.g. "Editing index.ts", "Reading money.ts")
 */
export function describeToolAction(
    toolName: string,
    params: any,
    workspacePath?: string,
    state: 'active' | 'done' = 'active'
): string {
    const isDone = state === 'done';

    if (toolName === 'view_file') {
        const file = shortenPath(params?.AbsolutePath, workspacePath);
        return isDone
            ? `Read <code>${escapeHtml(file || 'file')}</code>`
            : `Reading <code>${escapeHtml(file || 'file')}</code>`;
    }

    if (toolName === 'replace_file_content' || toolName === 'write_to_file') {
        const file = shortenPath(params?.TargetFile, workspacePath);
        return isDone
            ? `Edited <code>${escapeHtml(file || 'file')}</code>`
            : `Editing <code>${escapeHtml(file || 'file')}</code>`;
    }

    if (toolName === 'run_command') {
        let cmd = params?.CommandLine?.trim() || '';
        if (cmd.length > 40) {
            cmd = cmd.slice(0, 37) + '...';
        }
        return isDone
            ? `Ran <code>${escapeHtml(cmd || 'command')}</code>`
            : `Running <code>${escapeHtml(cmd || 'command')}</code>`;
    }

    if (toolName === 'invoke_subagent') {
        const agent = params?.Subagents?.[0]?.Role || params?.Subagents?.[0]?.TypeName || 'subagent';
        return isDone
            ? `Subagent <i>${escapeHtml(agent)}</i> done`
            : `Subagent <i>${escapeHtml(agent)}</i>`;
    }

    if (toolName === 'search_web') {
        let q = params?.query?.trim() || '';
        if (q.length > 35) {
            q = q.slice(0, 32) + '...';
        }
        return isDone
            ? `Searched web for <i>${escapeHtml(q)}</i>`
            : `Searching web: <i>${escapeHtml(q)}</i>`;
    }

    if (toolName === 'read_url_content') {
        return isDone ? 'Read web page' : 'Reading web page';
    }

    if (toolName.startsWith('mcp_') || toolName === 'call_mcp_tool') {
        const name = params?.ToolName || toolName.replace(/^mcp_/, '');
        return isDone
            ? `Called <code>${escapeHtml(name)}</code>`
            : `Calling <code>${escapeHtml(name)}</code>`;
    }

    if (params?.toolAction) {
        return escapeHtml(params.toolAction);
    }

    const clean = toolName.replace(/_/g, ' ');
    return isDone
        ? `Finished ${escapeHtml(clean)}`
        : `Executing ${escapeHtml(clean)}`;
}


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
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const escaped = escapeHtml(headerMatch[2]);
            result.push(`<b>${formatMarkdownLine(escaped)}</b>`);
        } else {
            const escaped = escapeHtml(line);
            result.push(formatMarkdownLine(escaped));
        }
    }

    return result.join('\n');
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

/**
 * Format relative time string from a date string (e.g. "in 23m", "in 3h 10m", "in 6d")
 */
function formatRelativeTime(dateStr: string): string {
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
 * Humanize Antigravity account quota output into a structured mobile card.
 */
export function formatAccountQuota(rawOutput: string): string {
    const lines = rawOutput
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.toLowerCase().startsWith('quota'));

    interface QuotaItem {
        model: string;
        type: string;
        pct: number;
        reset: string;
    }

    const items: QuotaItem[] = [];

    for (const line of lines) {
        const match = line.match(/^(.*?)\s+(Weekly|Five Hour)\s+Limit Remaining\s+([0-9]+)%\s+(.*)$/i);
        if (match) {
            items.push({
                model: match[1].trim(),
                type: match[2].trim(),
                pct: parseInt(match[3], 10),
                reset: match[4].trim(),
            });
        }
    }

    if (items.length === 0) {
        return `📊 <b>Antigravity Account Quota</b>\n\n<pre><code>${escapeHtml(rawOutput.trim())}</code></pre>`;
    }

    // Group items by model family
    const groups = new Map<string, QuotaItem[]>();
    for (const item of items) {
        if (!groups.has(item.model)) groups.set(item.model, []);
        groups.get(item.model)!.push(item);
    }

    let result = '📊 <b>Antigravity Account Quota</b>\n';

    for (const [model, modelItems] of groups.entries()) {
        const icon = model.toLowerCase().includes('gemini') ? '✨' : '🧠';
        result += `\n<b>${icon} ${escapeHtml(model)}</b>\n`;

        // Sort: 5-Hour first, then Weekly
        modelItems.sort((a, b) => (a.type.toLowerCase().includes('five') ? -1 : 1));

        for (const item of modelItems) {
            const badge = item.pct > 50 ? '🟢' : item.pct > 20 ? '🟡' : '🔴';
            const warn = item.pct <= 10 ? ' ⚠️' : '';
            const rel = formatRelativeTime(item.reset);
            const timeDesc = rel ? ` (resets ${rel})` : '';
            const typeLabel = item.type.toLowerCase().includes('five') ? '5-Hour Window' : 'Weekly Quota';

            result += `• <b>${typeLabel}:</b> ${badge} <b>${item.pct}%</b> remaining${warn}\n`;
            result += `  ↳ <i>${escapeHtml(item.reset)}${timeDesc}</i>\n`;
        }
    }

    return result.trim();
}

