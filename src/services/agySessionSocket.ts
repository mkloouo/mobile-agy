import net from 'net';
import readline from 'readline';
import { logger } from '../utils/logger';
import { SessionPaths } from './agyDaemonLauncher';
import { TurnOptions, TurnResult } from './agyStreamService';

export interface ActiveSocketSession {
    socket: net.Socket;
    socketPath: string;
    statePath: string;
    sessionId: string;
    workspacePath: string;
    currentConvId: string;
    model?: string;
    isBusy: boolean;
    activeTurnId?: string;
    accumulatedText: string;
    activeOptions?: TurnOptions;
    currentResolve?: (res: TurnResult) => void;
    currentReject?: (err: any) => void;
    safetyTimer?: NodeJS.Timeout | null;
}

export function createSocketSession(
    sessionId: string,
    paths: SessionPaths,
    socket: net.Socket,
    workspacePath: string,
    conversationId: string,
    model: string | undefined,
    onSessionClose: (sessionId: string) => void,
    onTimeout: (sessionId: string) => void
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

    const rl = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const event = JSON.parse(trimmed);
            routeDaemonEvent(session, event, onTimeout);
        } catch {
            logger.debug('[AgyStream] Non-JSON line from daemon socket:', trimmed);
        }
    });

    socket.on('close', () => {
        logger.info(`[AgyStream] Socket closed for session ${sessionId}`);
        if (session.safetyTimer) {
            clearTimeout(session.safetyTimer);
            session.safetyTimer = null;
        }
        if (session.currentResolve && session.isBusy) {
            session.currentResolve({
                status: 'STOPPED',
                response: session.accumulatedText || '⚠️ Task was stopped or process closed.',
                durationSeconds: 0,
                conversationId: session.currentConvId,
            });
        }
        onSessionClose(sessionId);
    });

    socket.on('error', (err) => {
        logger.warn(`[AgyStream] Socket error for session ${sessionId}:`, err.message);
    });

    return session;
}

export function routeDaemonEvent(
    session: ActiveSocketSession,
    event: any,
    onTimeout: (sessionId: string) => void
): void {
    switch (event.event) {
        case 'daemon_hello': {
            if (event.state?.conversationId) {
                session.currentConvId = event.state.conversationId;
            }
            if (event.currentTurnId || event.state?.currentTurnId) {
                const turnId = event.currentTurnId || event.state?.currentTurnId;
                if (!session.activeTurnId) {
                    session.activeTurnId = turnId;
                }
            }
            if (event.state?.isBusy) {
                session.isBusy = true;
                if (event.accumulatedResponse) {
                    session.accumulatedText = event.accumulatedResponse;
                } else if (Array.isArray(event.history)) {
                    session.accumulatedText = '';
                    for (const ev of event.history) {
                        if (ev.event === 'step_update') {
                            const step = ev.step_update;
                            if (step?.step_type === 'agent_response' && step.text_delta) {
                                session.accumulatedText += step.text_delta;
                            }
                        }
                    }
                }
            } else {
                session.accumulatedText = '';
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
            if (event.turnId && session.activeTurnId && event.turnId !== session.activeTurnId) {
                break;
            }
            if (session.safetyTimer) {
                clearTimeout(session.safetyTimer);
                session.safetyTimer = setTimeout(() => {
                    if (session.isBusy) {
                        logger.warn(`[AgyStream] Turn timed out (no activity for 10m) for session ${session.sessionId}. Stopping.`);
                        onTimeout(session.sessionId);
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
            if (event.turnId && session.activeTurnId && event.turnId !== session.activeTurnId) {
                logger.warn(`[AgyStream] Dropping stale result for turn ${event.turnId} (active: ${session.activeTurnId})`);
                break;
            }
            session.isBusy = false;
            session.activeTurnId = undefined;
            if (session.safetyTimer) {
                clearTimeout(session.safetyTimer);
                session.safetyTimer = null;
            }

            const resultPayload: TurnResult = {
                status: event.result?.status || 'SUCCESS',
                response: event.result?.response || session.accumulatedText,
                error: event.result?.error,
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
