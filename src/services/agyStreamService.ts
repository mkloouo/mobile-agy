import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger';

export interface TurnOptions {
    workspacePath: string;
    conversationId?: string;
    prompt: string;
    autoApprove?: boolean;
    model?: string;
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

interface WarmSession {
    proc: ChildProcess;
    workspacePath: string;
    currentConvId: string;
    isBusy: boolean;
    idleTimer: NodeJS.Timeout | null;
    safetyTimer: NodeJS.Timeout | null;
    accumulatedText: string;
    activeOptions?: TurnOptions;
    currentResolve?: (res: TurnResult) => void;
    currentReject?: (err: any) => void;
}

export class AgyStreamService {
    private sessions: Map<string, WarmSession> = new Map();
    private readonly idleTimeoutMs: number;

    constructor(idleTimeoutSeconds: number = 300) {
        this.idleTimeoutMs = idleTimeoutSeconds * 1000;
        logger.info(`[AgyStream] Warm process idle timeout set to ${idleTimeoutSeconds}s`);
    }

    /**
     * Stop active execution or warm process for a session
     */
    public stopSession(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        logger.info(`[AgyStream] Stopping session ${sessionId}`);

        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.safetyTimer) clearTimeout(session.safetyTimer);

        if (!session.proc.killed) {
            session.proc.kill('SIGINT');
            setTimeout(() => {
                if (!session.proc.killed) session.proc.kill('SIGKILL');
            }, 1500);
        }

        if (session.currentResolve) {
            session.currentResolve({
                status: 'STOPPED',
                response: session.accumulatedText || '<i>Task was stopped.</i>',
                durationSeconds: 0,
                conversationId: session.currentConvId,
            });
        }

        this.sessions.delete(sessionId);
        return true;
    }

    /**
     * Check if a session is currently executing a turn
     */
    public isBusy(sessionId: string): boolean {
        return this.sessions.get(sessionId)?.isBusy ?? false;
    }

    /**
     * Execute a prompt turn, reusing an existing warm process if available
     */
    public executeTurn(sessionId: string, options: TurnOptions): Promise<TurnResult> {
        return new Promise((resolve, reject) => {
            const existing = this.sessions.get(sessionId);

            // 1. If currently running a turn, reject
            if (existing && existing.isBusy) {
                return reject(new Error('A task is already running in this session. Send /stop to interrupt it first.'));
            }

            // 2. Check if we can reuse the warm session
            if (
                existing &&
                !existing.proc.killed &&
                existing.workspacePath === options.workspacePath &&
                (!options.conversationId || existing.currentConvId === options.conversationId)
            ) {
                logger.info(`[AgyStream] Reusing warm process for session ${sessionId} (Conv: ${existing.currentConvId})`);

                // Cancel idle timeout
                if (existing.idleTimer) {
                    clearTimeout(existing.idleTimer);
                    existing.idleTimer = null;
                }

                existing.isBusy = true;
                existing.accumulatedText = '';
                existing.activeOptions = options;
                existing.currentResolve = resolve;
                existing.currentReject = reject;

                // Safety timeout for this turn (10 minutes)
                existing.safetyTimer = setTimeout(() => {
                    if (existing.isBusy) {
                        logger.warn(`[AgyStream] Turn timed out for session ${sessionId}. Stopping process.`);
                        this.stopSession(sessionId);
                    }
                }, 10 * 60 * 1000);

                // Write next turn into warm process's stdin
                const inputMessage = JSON.stringify({
                    event: 'user',
                    message: {
                        content: options.prompt,
                    },
                }) + '\n';

                existing.proc.stdin?.write(inputMessage, 'utf-8');
                return;
            }

            // 3. Otherwise, kill any stale session and spawn a new warm process
            if (existing) {
                this.stopSession(sessionId);
            }

            this.spawnNewSession(sessionId, options, resolve, reject);
        });
    }

    private spawnNewSession(
        sessionId: string,
        options: TurnOptions,
        resolve: (res: TurnResult) => void,
        reject: (err: any) => void
    ): void {
        const args = [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
        ];

        if (options.conversationId) {
            args.push('--conversation', options.conversationId);
        }

        if (options.autoApprove) {
            args.push('--dangerously-skip-permissions');
        }

        if (options.model) {
            args.push('--model', options.model);
        }

        logger.info(`[AgyStream] Spawning new warm agy in "${options.workspacePath}" with args:`, args.join(' '));

        const proc = spawn('agy', args, {
            cwd: options.workspacePath,
            env: {
                ...process.env,
                PAGER: 'cat',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const session: WarmSession = {
            proc,
            workspacePath: options.workspacePath,
            currentConvId: options.conversationId || '',
            isBusy: true,
            idleTimer: null,
            safetyTimer: null,
            accumulatedText: '',
            activeOptions: options,
            currentResolve: resolve,
            currentReject: reject,
        };

        this.sessions.set(sessionId, session);

        // Turn safety timeout (10 minutes)
        session.safetyTimer = setTimeout(() => {
            if (session.isBusy) {
                logger.warn(`[AgyStream] Turn timed out for session ${sessionId}. Stopping process.`);
                this.stopSession(sessionId);
            }
        }, 10 * 60 * 1000);

        const rlOut = readline.createInterface({
            input: proc.stdout,
            crlfDelay: Infinity,
        });

        const rlErr = readline.createInterface({
            input: proc.stderr,
            crlfDelay: Infinity,
        });

        rlErr.on('line', (line) => {
            if (line.trim()) {
                logger.warn(`[AgyStream STDERR] ${line}`);
            }
        });

        rlOut.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            try {
                const event = JSON.parse(trimmed);
                this.handleEvent(session, event);
            } catch (err: any) {
                logger.debug(`[AgyStream] Non-JSON line from stdout: ${trimmed}`);
            }
        });

        proc.on('error', (err) => {
            logger.error(`[AgyStream] Process error:`, err);
            if (session.currentReject) {
                session.currentReject(err);
                session.currentReject = undefined;
            }
            this.stopSession(sessionId);
        });

        proc.on('close', (code, signal) => {
            logger.info(`[AgyStream] Process closed with code ${code}, signal ${signal}`);
            if (session.currentResolve) {
                if (signal === 'SIGINT' || signal === 'SIGTERM') {
                    session.currentResolve({
                        status: 'STOPPED',
                        response: session.accumulatedText || '<i>Task was stopped.</i>',
                        durationSeconds: 0,
                        conversationId: session.currentConvId,
                    });
                } else if (code !== 0) {
                    session.currentReject?.(new Error(`agy process exited with code ${code}`));
                } else {
                    session.currentResolve({
                        status: 'SUCCESS',
                        response: session.accumulatedText,
                        durationSeconds: 0,
                        conversationId: session.currentConvId,
                    });
                }
                session.currentResolve = undefined;
                session.currentReject = undefined;
            }
            this.sessions.delete(sessionId);
        });

        // Write first prompt to stdin
        const inputMessage = JSON.stringify({
            event: 'user',
            message: {
                content: options.prompt,
            },
        }) + '\n';

        proc.stdin.write(inputMessage, 'utf-8');
    }

    private handleEvent(session: WarmSession, event: any): void {
        switch (event.event) {
            case 'init':
                if (event.conversation_id) {
                    session.currentConvId = event.conversation_id;
                    session.activeOptions?.onInit?.(event.conversation_id);
                }
                break;

            case 'step_update': {
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

                // Arm the idle timer to disconnect process if no further replies arrive
                if (session.idleTimer) clearTimeout(session.idleTimer);
                session.idleTimer = setTimeout(() => {
                    logger.info(`[AgyStream] Idle timeout (${this.idleTimeoutMs / 1000}s) expired for session. Disconnecting warm process.`);
                    for (const [key, val] of this.sessions.entries()) {
                        if (val === session) {
                            this.stopSession(key);
                            break;
                        }
                    }
                }, this.idleTimeoutMs);

                break;
            }

            default:
                break;
        }
    }
}
