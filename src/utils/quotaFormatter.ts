import { escapeHtml } from './htmlSanitizer';
import { formatHumanDate, formatRelativeTime } from './dateFormatter';
export { formatRelativeTime } from './dateFormatter';

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

            const humanReset = formatHumanDate(item.reset);
            result += `• <b>${typeLabel}:</b> ${badge} <b>${item.pct}%</b> remaining${warn}\n`;
            result += `  ↳ <i>${escapeHtml(humanReset || item.reset)}${timeDesc}</i>\n`;
        }
    }

    return result.trim();
}
