import net from 'net';
import fs from 'fs';
import { logger } from '../utils/logger';
import { SessionPaths, getSessionPaths, tryConnectSocket, waitForSocket, launchDaemonProcess } from './agyDaemonLauncher';
import { scanAndRecoverSessions } from './agyRecoveryScanner';
import { ActiveSocketSession, createSocketSession } from './agySessionSocket';
import { generateTurnId } from './sessionDaemonUtils';
import { getDatabase } from '../database/db';

export { SessionPaths, getSessionPaths };

export interface TurnOptions {
    workspacePath: string;
    conversationId?: string;
    prompt: string;
    autoApprove?: boolean;
    model?: string;
    chatId?: number;
    statusMessageId?: number;
    threadId?: number;
    onInit?: (convId: string) => void;
    onDelta?: (delta: string, fullText: string) => void;
    onToolCall?: (toolName: string, params: any) => void;
    onToolDone?: (toolName: string, output: string) => void;
}

export interface TurnResult {
    status: 'SUCCESS' | 'ERROR' | 'STOPPED';
    response: string;
    error?: string;
    durationSeconds: number;
    usage?: any;
    conversationId: string;
}

export class AgyStreamService {
    private sessions: Map<string, ActiveSocketSession> = new Map();
    private readonly idleTimeoutSeconds: number;

    constructor(idleTimeoutSeconds: number = 300) {
        this.idleTimeoutSeconds = idleTimeoutSeconds;
        logger.info(`[AgyStream] Unix Domain Socket runner initialized (idle timeout: ${idleTimeoutSeconds}s)`);
    }

    /**
     * Check if a session is currently executing a turn
     */
    public isBusy(sessionId: string): boolean {
        const inMem = this.sessions.get(sessionId);
        if (inMem) return inMem.isBusy;

        const paths = getSessionPaths(sessionId);
        try {
            if (fs.existsSync(paths.statePath)) {
                const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf-8'));
                if (state.daemonPid) {
                    try {
                        process.kill(state.daemonPid, 0);
                        return !!state.isBusy;
                    } catch {
                        return false;
                    }
                }
                return !!state.isBusy;
            }
        } catch {}

        return false;
    }

    /**
     * Check if any active session is currently executing a turn
     */
    public hasBusySessions(): boolean {
        for (const session of this.sessions.values()) {
            if (session.isBusy) return true;
        }
        return false;
    }

    /**
     * Cleanly close all Unix socket connections without terminating background daemons
     */
    public disconnectAll(): void {
        for (const session of this.sessions.values()) {
            try {
                session.socket.end();
            } catch {}
        }
        this.sessions.clear();
    }

    /**
     * Stop active execution for a session (keeps warm daemon alive)
     */
    public stopSession(sessionId: string): boolean {
        const inMem = this.sessions.get(sessionId);
        logger.info(`[AgyStream] Stopping active turn for session ${sessionId}`);

        if (inMem) {
            if (inMem.safetyTimer) {
                clearTimeout(inMem.safetyTimer);
                inMem.safetyTimer = null;
            }
            try {
                if (!inMem.socket.destroyed) {
                    inMem.socket.write(JSON.stringify({ action: 'stop' }) + '\n');
                }
            } catch {}

            // Immediately settle the ongoing turn promise so caller does not hang
            if (inMem.currentResolve) {
                inMem.currentResolve({
                    status: 'STOPPED',
                    response: inMem.accumulatedText || '⚠️ Task was stopped by user.',
                    durationSeconds: 0,
                    conversationId: inMem.currentConvId,
                });
                inMem.currentResolve = undefined;
                inMem.currentReject = undefined;
            }

            inMem.isBusy = false;
            inMem.accumulatedText = '';
            inMem.socket.destroy();
            this.sessions.delete(sessionId);
            return true;
        }

        const paths = getSessionPaths(sessionId);
        if (fs.existsSync(paths.socketPath)) {
            const socket = net.createConnection(paths.socketPath, () => {
                socket.write(JSON.stringify({ action: 'stop' }) + '\n', () => socket.destroy());
            });
            socket.once('error', () => socket.destroy());
        }

        return true;
    }

    /**
     * Terminate the warm session daemon and agy process completely so that
     * the next turn launches a clean agy instance (reloading MCP configs, plugins, and env).
     */
    public async restartSession(sessionId: string): Promise<boolean> {
        const paths = getSessionPaths(sessionId);
        const inMem = this.sessions.get(sessionId);

        logger.info(`[AgyStream] Restarting session daemon for ${sessionId}`);

        let daemonPid: number | undefined;
        let agyPid: number | undefined;

        try {
            if (fs.existsSync(paths.statePath)) {
                const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf-8'));
                daemonPid = state.daemonPid;
                agyPid = state.agyPid;
            }
        } catch {}

        if (!daemonPid || !agyPid) {
            try {
                const dbSession = getDatabase().getDaemonSession(sessionId);
                daemonPid = daemonPid || dbSession?.daemonPid;
                agyPid = agyPid || dbSession?.agyPid;
            } catch {}
        }

        if (inMem) {
            if (inMem.safetyTimer) {
                clearTimeout(inMem.safetyTimer);
                inMem.safetyTimer = null;
            }
            if (inMem.currentResolve) {
                inMem.currentResolve({
                    status: 'STOPPED',
                    response: inMem.accumulatedText || '⚠️ Task was stopped.',
                    durationSeconds: 0,
                    conversationId: inMem.currentConvId,
                });
                inMem.currentResolve = undefined;
                inMem.currentReject = undefined;
            }
            try {
                inMem.socket.write(JSON.stringify({ action: 'shutdown' }) + '\n');
            } catch {}
            inMem.socket.destroy();
            this.sessions.delete(sessionId);
        }

        if (!inMem && fs.existsSync(paths.socketPath)) {
            try {
                const socket = net.createConnection(paths.socketPath, () => {
                    socket.write(JSON.stringify({ action: 'shutdown' }) + '\n', () => socket.destroy());
                });
                socket.once('error', () => { socket.destroy(); });
            } catch {}
        }

        await new Promise((r) => setTimeout(r, 100));

        if (agyPid) {
            try { process.kill(agyPid, 'SIGTERM'); } catch {}
        }
        if (daemonPid) {
            try { process.kill(daemonPid, 'SIGTERM'); } catch {}
            for (let i = 0; i < 6; i++) {
                try {
                    process.kill(daemonPid, 0);
                    await new Promise((r) => setTimeout(r, 50));
                } catch {
                    break;
                }
            }
            try { process.kill(daemonPid, 'SIGKILL'); } catch {}
        }

        try { if (fs.existsSync(paths.socketPath)) fs.unlinkSync(paths.socketPath); } catch {}
        try { if (fs.existsSync(paths.statePath)) fs.unlinkSync(paths.statePath); } catch {}
        try { getDatabase().deleteDaemonSession(sessionId); } catch {}

        return true;
    }

    /**
     * Associate Telegram message ID with this session in state file (for reconnect recovery)
     */
    public setTelegramStatus(sessionId: string, statusMessageId: number, chatId: number, threadId?: number): void {
        const inMem = this.sessions.get(sessionId);
        if (inMem && !inMem.socket.destroyed) {
            try {
                inMem.socket.write(JSON.stringify({
                    action: 'set_telegram_status',
                    statusMessageId,
                    chatId,
                    threadId,
                }) + '\n');
            } catch {}
        }
    }

    /**
     * Mark a turn as delivered to Telegram so recovery will not re-deliver it
     */
    public markTurnDelivered(sessionId: string, turnId?: string): void {
        const inMem = this.sessions.get(sessionId);
        if (inMem && !inMem.socket.destroyed) {
            try {
                inMem.socket.write(JSON.stringify({ action: 'mark_delivered', turnId }) + '\n');
            } catch {}
        }
        try {
            getDatabase().markDaemonTurnDelivered(sessionId, turnId);
        } catch {}
        const paths = getSessionPaths(sessionId);
        try {
            if (fs.existsSync(paths.statePath)) {
                const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf-8'));
                state.turnDelivered = true;
                const tmp = `${paths.statePath}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
                fs.renameSync(tmp, paths.statePath);
            }
        } catch {}
    }

    /**
     * Execute a prompt turn, connecting to or starting the persistent Unix socket daemon
     */
    public async executeTurn(sessionId: string, options: TurnOptions): Promise<TurnResult> {
        const session = await this.getOrConnectSession(sessionId, options);

        if (session.isBusy && session.currentResolve) {
            throw new Error('A task is already running in this session. Send /agy_stop to cancel it.');
        }

        const turnId = generateTurnId();

        return new Promise<TurnResult>((resolve, reject) => {
            session.isBusy = true;
            session.activeTurnId = turnId;
            session.accumulatedText = '';
            session.activeOptions = options;
            session.currentResolve = resolve;
            session.currentReject = reject;

            if (session.safetyTimer) clearTimeout(session.safetyTimer);
            session.safetyTimer = setTimeout(() => {
                if (session.isBusy) {
                    logger.warn(`[AgyStream] Turn timed out for session ${sessionId}. Stopping.`);
                    this.stopSession(sessionId);
                }
            }, 10 * 60 * 1000);

            const payload = JSON.stringify({
                action: 'user_prompt',
                turnId,
                prompt: options.prompt,
                conversationId: options.conversationId,
                chatId: options.chatId,
                statusMessageId: options.statusMessageId,
                threadId: options.threadId,
            }) + '\n';

            session.socket.write(payload, 'utf-8');
        });
    }

    private async getOrConnectSession(
        sessionId: string,
        options: TurnOptions
    ): Promise<ActiveSocketSession> {
        const paths = getSessionPaths(sessionId);

        // 1. Check in-memory active session
        const inMem = this.sessions.get(sessionId);
        if (inMem && !inMem.socket.destroyed) {
            const sameWorkspace = inMem.workspacePath === options.workspacePath;
            const sameModel = !options.model || inMem.model === options.model;
            if (sameWorkspace && sameModel) return inMem;
            await this.restartSession(sessionId);
        }

        // 2. Try connecting to existing Unix Domain Socket
        const existingSocket = await tryConnectSocket(paths.socketPath);
        if (existingSocket) {
            let daemonState: any = null;
            try {
                if (fs.existsSync(paths.statePath)) {
                    daemonState = JSON.parse(fs.readFileSync(paths.statePath, 'utf-8'));
                }
            } catch {}
            const dbSession = getDatabase().getDaemonSession(sessionId);
            const activeModel = daemonState?.model || dbSession?.model;
            const activeConvId = daemonState?.conversationId || dbSession?.conversationId || options.conversationId || '';
            const activeWorkspace = daemonState?.workspacePath || dbSession?.workspacePath || options.workspacePath;

            const sameWorkspace = activeWorkspace === options.workspacePath;
            const sameModel = !options.model || !activeModel || activeModel === options.model;

            if (sameWorkspace && sameModel) {
                logger.info(`[AgyStream] Reconnected to existing Unix socket for session ${sessionId}`);
                return this.setupSocketSession(sessionId, paths, existingSocket, options.workspacePath, activeConvId, activeModel);
            }

            existingSocket.destroy();
            await this.restartSession(sessionId);
        }

        // 3. Socket not running: launch detached sessionDaemon
        await launchDaemonProcess(sessionId, paths, options, this.idleTimeoutSeconds);

        const newSocket = await waitForSocket(paths.socketPath, 6000);
        logger.info(`[AgyStream] Connected to newly spawned Unix socket for session ${sessionId}`);
        return this.setupSocketSession(sessionId, paths, newSocket, options.workspacePath, options.conversationId || '', options.model);
    }

    private setupSocketSession(
        sessionId: string,
        paths: SessionPaths,
        socket: net.Socket,
        workspacePath: string,
        conversationId: string,
        model?: string
    ): ActiveSocketSession {
        const session = createSocketSession(
            sessionId,
            paths,
            socket,
            workspacePath,
            conversationId,
            model,
            (closedId) => this.sessions.delete(closedId),
            (timedOutId) => this.stopSession(timedOutId)
        );

        this.sessions.set(sessionId, session);
        return session;
    }

    /**
     * Recover any in-flight turns that were running across a bot restart
     */
    public async recoverActiveSessions(
        onTurnUpdate: (state: any, fullText: string, activeTool?: any, doneAction?: string) => Promise<void>,
        onTurnComplete: (state: any, result: TurnResult) => Promise<void>
    ): Promise<void> {
        return scanAndRecoverSessions(
            onTurnUpdate,
            onTurnComplete,
            (sessionId, paths, socket, workspacePath, conversationId, model) =>
                this.setupSocketSession(sessionId, paths, socket, workspacePath, conversationId, model)
        );
    }
}
