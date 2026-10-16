import fs from 'fs';

export interface DaemonArgs {
    socketPath: string;
    statePath: string;
    sessionId: string;
    workspacePath: string;
    conversationId: string;
    autoApprove: boolean;
    model?: string;
    idleTimeoutSeconds: number;
    dbPath?: string;
}

export interface DaemonState {
    sessionId: string;
    socketPath: string;
    statePath: string;
    daemonPid: number;
    agyPid: number;
    workspacePath: string;
    conversationId: string;
    model?: string;
    isBusy: boolean;
    createdAt: number;
    lastActiveAt: number;
    currentTurnId?: string;
    turnStartTime?: number;
    statusMessageId?: number;
    chatId?: number;
    threadId?: number;
    lastResult?: any;
    turnDelivered?: boolean;
    accumulatedResponse?: string;
    userPrompt?: string;
}

export function generateTurnId(): string {
    return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function parseDaemonArgs(args: string[]): DaemonArgs {
    const getArg = (flag: string): string => {
        const idx = args.indexOf(flag);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : '';
    };

    const socketPath = getArg('--socket');
    const statePath = getArg('--state');
    const sessionId = getArg('--session');
    const workspacePath = getArg('--workspace');
    const conversationId = getArg('--conv');
    const autoApprove = getArg('--autoApprove') !== 'false';
    const model = getArg('--model') || undefined;
    const idleTimeoutSeconds = parseInt(getArg('--idle') || '300', 10) || 300;
    const dbPath = getArg('--db') || undefined;

    if (!socketPath || !sessionId || !workspacePath) {
        throw new Error('Usage: sessionDaemon --socket <path> --session <id> --workspace <path>');
    }

    return {
        socketPath,
        statePath,
        sessionId,
        workspacePath,
        conversationId,
        autoApprove,
        model,
        idleTimeoutSeconds,
        dbPath,
    };
}

export function buildAgyArgs(config: {
    conversationId?: string;
    autoApprove?: boolean;
    model?: string;
}): string[] {
    const agyArgs = [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
    ];

    if (config.conversationId) {
        agyArgs.push('--conversation', config.conversationId);
    } else {
        // Isolate fresh sessions so they don't inherit old workspaces from default-cli-project
        agyArgs.push('--new-project');
    }

    if (config.autoApprove) {
        agyArgs.push('--dangerously-skip-permissions');
    }

    if (config.model) {
        agyArgs.push('--model', config.model);
    }

    return agyArgs;
}

export function writeStateFile(statePath: string | undefined, state: DaemonState): void {
    if (!statePath) return;
    try {
        const tmpPath = `${statePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tmpPath, statePath);
    } catch {}
}

export function safeUnlink(filePath?: string): void {
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
    }
}
