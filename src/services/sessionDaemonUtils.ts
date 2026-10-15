export interface DaemonArgs {
    socketPath: string;
    statePath: string;
    sessionId: string;
    workspacePath: string;
    conversationId: string;
    autoApprove: boolean;
    model?: string;
    idleTimeoutSeconds: number;
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
    statusMessageId?: number;
    chatId?: number;
    threadId?: number;
    lastResult?: any;
    turnDelivered?: boolean;
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

    if (!socketPath || !sessionId || !workspacePath) {
        throw new Error('Usage: sessionDaemon --socket <path> --state <path> --session <id> --workspace <path>');
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
