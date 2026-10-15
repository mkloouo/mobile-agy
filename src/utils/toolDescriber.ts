import path from 'path';
import { escapeHtml } from './htmlSanitizer';

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

    if (toolName === 'ask_question') {
        const firstQ = params?.questions?.[0]?.question || params?.question || '';
        const shortQ = firstQ.length > 30 ? firstQ.slice(0, 27) + '...' : firstQ;
        return isDone
            ? (shortQ ? `Asked: <i>${escapeHtml(shortQ)}</i>` : 'Asked question')
            : (shortQ ? `Asking: <i>${escapeHtml(shortQ)}</i>` : 'Asking question...');
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
