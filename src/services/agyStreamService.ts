import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawn } from 'child_process';
import { logger } from '../utils/logger';

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
    durationSeconds: number;
    usage?: any;
    conversationId: string;
}

export interface SessionPaths {
    socketPath: string;
    statePath: string;
    hash: string;
}

export function getSessionPaths(sessionId: string): SessionPaths {
    const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    return {
        socketPath: `/tmp/magy_${hash}.sock`,
        statePath: `/tmp/magy_${hash}.json`,
        hash,
    };
}

interface ActiveSocketSession {
    socket: net.Socket;
    socketPath: string;
    statePath: string;
    sessionId: string;
    workspacePath: string;
    currentConvId: string;
    model?: string;
    isBusy: boolean;
    accumulatedText: string;
    activeOptions?: TurnOptions;
    currentResolve?: (res: TurnResult) => void;
    currentReject?: (err: any) => void;
    safetyTimer?: NodeJS.Timeout | null;
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
     * Stop active execution or warm process for a session
     */
    public stopSession(sessionId: string): boolean {
        const paths = getSessionPaths(sessionId);
        const inMem = this.sessions.get(sessionId);

        logger.info(`[AgyStream] Stopping session ${sessionId}`);

        if (inMem) {
            if (inMem.safetyTimer) clearTimeout(inMem.safetyTimer);
            try {
                inMem.socket.write(JSON.stringify({ action: 'stop' }) + '\n');
            } catch {}
            inMem.socket.destroy();
            this.sessions.delete(sessionId);
        }

        // Clean up socket and state files
        try {
            if (fs.existsSync(paths.socketPath)) fs.unlinkSync(paths.socketPath);
        } catch {}
        try {
            if (fs.existsSync(paths.statePath)) fs.unlinkSync(paths.statePath);
        } catch {}

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
     * Execute a prompt turn, connecting to or starting the persistent Unix socket daemon
     */
    public async executeTurn(sessionId: string, options: TurnOptions): Promise<TurnResult> {
        const session = await this.getOrConnectSession(sessionId, options);

        if (session.isBusy && session.currentResolve) {
            throw new Error('A task is already running in this session. Send /agy_stop to cancel it.');
        }

        return new Promise<TurnResult>((resolve, reject) => {
            session.isBusy = true;
            session.accumulatedText = '';
            session.activeOptions = options;
            session.currentResolve = resolve;
            session.currentReject = reject;

            // Safety timeout (10 minutes)
            if (session.safetyTimer) clearTimeout(session.safetyTimer);
            session.safetyTimer = setTimeout(() => {
                if (session.isBusy) {
                    logger.warn(`[AgyStream] Turn timed out for session ${sessionId}. Stopping.`);
                    this.stopSession(sessionId);
                }
            }, 10 * 60 * 1000);

            // Send prompt action to daemon
            const payload = JSON.stringify({
                action: 'user_prompt',
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
            if (sameWorkspace && sameModel) {
                return inMem;
            }
            // Workspace or model changed: stop the old daemon
            this.stopSession(sessionId);
        }

        // 2. Try connecting to existing Unix Domain Socket
        const existingSocket = await this.tryConnectSocket(paths.socketPath);
        if (existingSocket) {
            let daemonState: any = null;
            try {
                if (fs.existsSync(paths.statePath)) {
                    daemonState = JSON.parse(fs.readFileSync(paths.statePath, 'utf-8'));
                }
            } catch {}

            const sameWorkspace = !daemonState || daemonState.workspacePath === options.workspacePath;
            const sameModel = !options.model || !daemonState?.model || daemonState.model === options.model;

            if (sameWorkspace && sameModel) {
                logger.info(`[AgyStream] Reconnected to existing Unix socket for session ${sessionId}`);
                return this.setupSocketSession(sessionId, paths, existingSocket, options.workspacePath, daemonState?.conversationId || options.conversationId || '', daemonState?.model || options.model);
            }

            // Workspace or model mismatch: close existing and start clean
            existingSocket.destroy();
            this.stopSession(sessionId);
        }

        // 3. Socket not running: launch detached sessionDaemon
        await this.launchDaemon(sessionId, paths, options);

        const newSocket = await this.waitForSocket(paths.socketPath, 6000);
        logger.info(`[AgyStream] Connected to newly spawned Unix socket for session ${sessionId}`);
        return this.setupSocketSession(sessionId, paths, newSocket, options.workspacePath, options.conversationId || '', options.model);
    }

    private tryConnectSocket(socketPath: string): Promise<net.Socket | null> {
        return new Promise((resolve) => {
            if (!fs.existsSync(socketPath)) return resolve(null);

            const socket = net.createConnection(socketPath, () => {
                resolve(socket);
            });

            socket.once('error', () => {
                socket.destroy();
                resolve(null);
            });
        });
    }

    private waitForSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            const check = () => {
                if (fs.existsSync(socketPath)) {
                    const socket = net.createConnection(socketPath, () => {
                        resolve(socket);
                    });

                    socket.once('error', () => {
                        socket.destroy();
                        if (Date.now() - startTime > timeoutMs) {
                            reject(new Error(`Timed out waiting for socket ${socketPath}`));
                        } else {
                            setTimeout(check, 100);
                        }
                    });
                    return;
                }

                if (Date.now() - startTime > timeoutMs) {
                    reject(new Error(`Timed out waiting for socket file ${socketPath} to appear`));
                } else {
                    setTimeout(check, 100);
                }
            };

            check();
        });
    }

    private async launchDaemon(sessionId: string, paths: SessionPaths, options: TurnOptions): Promise<void> {
        // Resolve path to sessionDaemon.js
        let daemonScript = path.resolve(__dirname, 'sessionDaemon.js');
        if (!fs.existsSync(daemonScript)) {
            daemonScript = path.resolve(__dirname, '..', '..', 'dist', 'services', 'sessionDaemon.js');
        }

        if (!fs.existsSync(daemonScript)) {
            throw new Error(`sessionDaemon.js not found at ${daemonScript}. Did you run npm run build?`);
        }

        logger.info(`[AgyStream] Spawning detached sessionDaemon for session ${sessionId}`);

        const daemonProcess = spawn(
            process.execPath,
            [
                daemonScript,
                '--socket', paths.socketPath,
                '--state', paths.statePath,
                '--session', sessionId,
                '--workspace', options.workspacePath,
                '--conv', options.conversationId || '',
                '--autoApprove', String(options.autoApprove ?? true),
                '--model', options.model || '',
                '--idle', String(this.idleTimeoutSeconds),
            ],
            {
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    PAGER: 'cat',
                },
            }
        );

        daemonProcess.unref();
    }

    private setupSocketSession(
        sessionId: string,
        paths: SessionPaths,
        socket: net.Socket,
        workspacePath: string,
        conversationId: string,
        model?: string
    ): ActiveSocketSession {
        const session: ActiveSocketSession = {
            socket,
            socketPath: paths.socketPath,
            statePath: paths.statePath,
            sessionId,
            workspacePath,
            currentConvId: conversationId,
            model,
            isBusy: false,
            accumulatedText: '',
        };

        this.sessions.set(sessionId, session);

        const rl = readline.createInterface({
            input: socket,
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            try {
                const event = JSON.parse(trimmed);
                this.handleDaemonEvent(session, event);
            } catch (err: any) {
                logger.debug('[AgyStream] Non-JSON line from daemon socket:', trimmed);
            }
        });

        socket.on('close', () => {
            logger.info(`[AgyStream] Socket closed for session ${sessionId}`);
            if (session.currentResolve && session.isBusy) {
                session.currentResolve({
                    status: 'STOPPED',
                    response: session.accumulatedText || '⚠️ Task was stopped or process closed.',
                    durationSeconds: 0,
                    conversationId: session.currentConvId,
                });
            }
            this.sessions.delete(sessionId);
        });

        socket.on('error', (err) => {
            logger.warn(`[AgyStream] Socket error for session ${sessionId}:`, err.message);
        });

        return session;
    }

    private handleDaemonEvent(session: ActiveSocketSession, event: any): void {
        switch (event.event) {
            case 'daemon_hello': {
                if (event.state?.conversationId) {
                    session.currentConvId = event.state.conversationId;
                }
                // If reconnecting to an ongoing turn, replay history
                if (event.state?.isBusy && Array.isArray(event.history)) {
                    session.isBusy = true;
                    for (const ev of event.history) {
                        if (ev.event === 'step_update') {
                            const step = ev.step_update;
                            if (step?.step_type === 'agent_response' && step.text_delta) {
                                session.accumulatedText += step.text_delta;
                            }
                        }
                    }
                }
                break;
            }

            case 'init': {
                if (event.conversation_id) {
                    session.currentConvId = event.conversation_id;
                    session.activeOptions?.onInit?.(event.conversation_id);
                }
                break;
            }

            case 'step_update': {
                // Refresh activity timer while agent is actively working
                if (session.safetyTimer) {
                    clearTimeout(session.safetyTimer);
                    session.safetyTimer = setTimeout(() => {
                        if (session.isBusy) {
                            logger.warn(`[AgyStream] Turn timed out (no activity for 10m) for session ${session.sessionId}. Stopping.`);
                            this.stopSession(session.sessionId);
                        }
                    }, 10 * 60 * 1000);
                }

                const step = event.step_update;
                if (!step) break;

                if (step.conversation_id) {
                    session.currentConvId = step.conversation_id;
                }

                if (step.step_type === 'agent_response' && step.text_delta) {
                    session.accumulatedText += step.text_delta;
                    session.activeOptions?.onDelta?.(step.text_delta, session.accumulatedText);
                } else if (step.step_type === 'tool') {
                    if (step.state === 'ACTIVE') {
                        session.activeOptions?.onToolCall?.(step.tool_name, step.tool_info?.parameters);
                    } else if (step.state === 'DONE') {
                        session.activeOptions?.onToolDone?.(step.tool_name, step.tool_info?.output);
                    }
                }
                break;
            }

            case 'result': {
                session.isBusy = false;
                if (session.safetyTimer) {
                    clearTimeout(session.safetyTimer);
                    session.safetyTimer = null;
                }

                const resultPayload: TurnResult = {
                    status: event.result?.status || 'SUCCESS',
                    response: event.result?.response || session.accumulatedText,
                    durationSeconds: event.result?.duration_seconds || 0,
                    usage: event.result?.usage,
                    conversationId: session.currentConvId || event.result?.conversation_id,
                };

                if (session.currentResolve) {
                    session.currentResolve(resultPayload);
                    session.currentResolve = undefined;
                    session.currentReject = undefined;
                }
                break;
            }

            default:
                break;
        }
    }

    /**
     * Recover any in-flight turns that were running across a bot restart
     */
    public async recoverActiveSessions(
        onTurnUpdate: (state: any, fullText: string) => Promise<void>,
        onTurnComplete: (state: any, result: TurnResult) => Promise<void>
    ): Promise<void> {
        try {
            const files = fs.readdirSync('/tmp');
            for (const file of files) {
                if (file.startsWith('magy_') && file.endsWith('.json')) {
                    const statePath = path.join('/tmp', file);
                    try {
                        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                        if (state.isBusy && state.socketPath && fs.existsSync(state.socketPath)) {
                            logger.info(`[AgyStream] Recovering in-flight session ${state.sessionId} (PID ${state.agyPid})`);

                            const socket = await this.tryConnectSocket(state.socketPath);
                            if (!socket) continue;

                            const session = this.setupSocketSession(
                                state.sessionId,
                                { socketPath: state.socketPath, statePath, hash: file.slice(5, -5) },
                                socket,
                                state.workspacePath,
                                state.conversationId
                            );

                            session.isBusy = true;
                            let lastUpdate = 0;

                            session.activeOptions = {
                                workspacePath: state.workspacePath,
                                prompt: '',
                                onDelta: (_delta, fullText) => {
                                    const now = Date.now();
                                    if (now - lastUpdate > 1500) {
                                        lastUpdate = now;
                                        onTurnUpdate(state, fullText).catch(() => {});
                                    }
                                },
                            };

                            session.currentResolve = (result) => {
                                onTurnComplete(state, result).catch((err) => {
                                    logger.error('[AgyStream] Error in turn recovery completion:', err);
                                });
                            };
                        }
                    } catch {}
                }
            }
        } catch (err: any) {
            logger.warn('[AgyStream] Failed to scan /tmp for recoverable sessions:', err.message);
        }
    }
}

