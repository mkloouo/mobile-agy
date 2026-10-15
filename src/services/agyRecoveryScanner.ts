import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { TurnResult } from './agyStreamService';
import { tryConnectSocket, getSessionPaths } from './agyDaemonLauncher';
import { getDatabase } from '../database/db';
import { DaemonSessionRecord } from '../database/daemonSessionDb';

export async function scanAndRecoverSessions(
    onTurnUpdate: (state: any, fullText: string, activeTool?: any, doneAction?: string) => Promise<void>,
    onTurnComplete: (state: any, result: TurnResult) => Promise<void>,
    setupSocketSession: (sessionId: string, paths: any, socket: any, workspacePath: string, conversationId: string, model?: string) => any
): Promise<void> {
    const processedChannelIds = new Set<string>();

    // 1. Primary source: query SQLite daemon_sessions table
    try {
        const dbSessions = getDatabase().getRecoverableDaemonSessions();
        logger.info(`[AgyStream] Found ${dbSessions.length} recoverable sessions in SQLite`);

        for (const record of dbSessions) {
            processedChannelIds.add(record.channelId);
            await recoverSessionRecord(record, onTurnUpdate, onTurnComplete, setupSocketSession);
        }
    } catch (dbErr: any) {
        logger.warn('[AgyStream] Failed to query SQLite for recoverable sessions:', dbErr.message);
    }

    // 2. Legacy fallback: scan /tmp for any unrecorded state files
    try {
        if (!fs.existsSync('/tmp')) return;
        const files = fs.readdirSync('/tmp');
        for (const file of files) {
            if (file.startsWith('magy_') && file.endsWith('.json')) {
                const statePath = path.join('/tmp', file);
                try {
                    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                    if (processedChannelIds.has(state.sessionId)) continue;

                    processedChannelIds.add(state.sessionId);
                    logger.info(`[AgyStream] Recovering legacy state file ${file} for session ${state.sessionId}`);

                    const record: DaemonSessionRecord = {
                        channelId: state.sessionId,
                        workspacePath: state.workspacePath,
                        conversationId: state.conversationId,
                        model: state.model,
                        socketPath: state.socketPath,
                        daemonPid: state.daemonPid || 0,
                        agyPid: state.agyPid || 0,
                        isBusy: Boolean(state.isBusy),
                        currentTurnId: state.currentTurnId,
                        turnStartTime: state.turnStartTime,
                        statusMessageId: state.statusMessageId,
                        chatId: state.chatId,
                        threadId: state.threadId,
                        accumulatedResponse: state.accumulatedResponse || '',
                        turnDelivered: Boolean(state.turnDelivered),
                        lastStatus: state.lastResult?.status,
                        lastDurationSeconds: state.lastResult?.duration_seconds || 0,
                        createdAt: state.createdAt || Date.now(),
                        updatedAt: state.lastActiveAt || Date.now(),
                    };

                    await recoverSessionRecord(record, onTurnUpdate, onTurnComplete, setupSocketSession);
                } catch {}
            }
        }
    } catch (tmpErr: any) {
        logger.warn('[AgyStream] Failed to scan /tmp fallback:', tmpErr.message);
    }
}

async function recoverSessionRecord(
    record: DaemonSessionRecord,
    onTurnUpdate: (state: any, fullText: string, activeTool?: any, doneAction?: string) => Promise<void>,
    onTurnComplete: (state: any, result: TurnResult) => Promise<void>,
    setupSocketSession: (sessionId: string, paths: any, socket: any, workspacePath: string, conversationId: string, model?: string) => any
): Promise<void> {
    if (!record.chatId || !record.statusMessageId) {
        logger.warn(`[AgyStream] Skipping recovery for ${record.channelId}: missing chatId or statusMessageId`);
        return;
    }

    const state = {
        sessionId: record.channelId,
        channelId: record.channelId,
        workspacePath: record.workspacePath,
        conversationId: record.conversationId,
        model: record.model,
        socketPath: record.socketPath,
        daemonPid: record.daemonPid,
        agyPid: record.agyPid,
        isBusy: record.isBusy,
        currentTurnId: record.currentTurnId,
        turnStartTime: record.turnStartTime,
        statusMessageId: record.statusMessageId,
        chatId: record.chatId,
        threadId: record.threadId,
        accumulatedResponse: record.accumulatedResponse,
        turnDelivered: record.turnDelivered,
        lastResult: record.lastStatus ? {
            status: record.lastStatus,
            response: record.accumulatedResponse,
            duration_seconds: record.lastDurationSeconds,
        } : undefined,
    };

    // A. Finished while disconnected but not yet delivered
    if (record.lastStatus && !record.turnDelivered) {
        logger.info(`[AgyStream] Recovering finished undelivered turn for session ${record.channelId}`);
        const turnDuration = record.turnStartTime
            ? Math.max(1, Math.round((Date.now() - record.turnStartTime) / 1000))
            : (record.lastDurationSeconds || 0);

        const resultPayload: TurnResult = {
            status: (record.lastStatus as any) || 'SUCCESS',
            response: record.accumulatedResponse || '✓ Done.',
            durationSeconds: turnDuration,
            conversationId: record.conversationId,
        };

        await onTurnComplete(state, resultPayload);
        try {
            getDatabase().markDaemonTurnDelivered(record.channelId, record.currentTurnId);
        } catch {}
        return;
    }

    // B. In-flight turn
    if (record.isBusy) {
        const socket = record.socketPath ? await tryConnectSocket(record.socketPath) : null;
        if (socket) {
            logger.info(`[AgyStream] Re-attaching to in-flight session ${record.channelId} (PID ${record.agyPid})`);
            const paths = getSessionPaths(record.channelId);
            const session = setupSocketSession(
                record.channelId,
                paths,
                socket,
                record.workspacePath,
                record.conversationId,
                record.model
            );

            session.isBusy = true;
            session.activeTurnId = record.currentTurnId;
            session.accumulatedText = record.accumulatedResponse || '';

            let lastUpdate = 0;
            session.activeOptions = {
                workspacePath: record.workspacePath,
                prompt: '',
                onDelta: (_delta: string, fullText: string) => {
                    const now = Date.now();
                    if (now - lastUpdate > 1500) {
                        lastUpdate = now;
                        Promise.resolve(onTurnUpdate(state, fullText)).catch(() => {});
                    }
                },
                onToolCall: (toolName: string, params: any) => {
                    Promise.resolve(onTurnUpdate(state, session.accumulatedText, { name: toolName, params })).catch(() => {});
                },
                onToolDone: (toolName: string) => {
                    Promise.resolve(onTurnUpdate(state, session.accumulatedText, null, toolName)).catch(() => {});
                },
            };

            session.currentResolve = (result: TurnResult) => {
                Promise.resolve(onTurnComplete(state, result)).catch((err) => {
                    logger.error('[AgyStream] Error in turn recovery completion:', err);
                });
            };

            Promise.resolve(onTurnUpdate(state, session.accumulatedText)).catch(() => {});
            return;
        }

        // Socket not reachable: check if daemon process is still running
        let isAlive = false;
        if (record.daemonPid) {
            try {
                process.kill(record.daemonPid, 0);
                isAlive = true;
            } catch {}
        }

        if (!isAlive) {
            logger.warn(`[AgyStream] Recovering dead busy session ${record.channelId} (PID ${record.daemonPid} dead)`);
            const turnDuration = record.turnStartTime
                ? Math.max(1, Math.round((Date.now() - record.turnStartTime) / 1000))
                : 0;

            const resultPayload: TurnResult = {
                status: 'STOPPED',
                response: record.accumulatedResponse || '⚠️ Task was stopped or process closed.',
                durationSeconds: turnDuration,
                conversationId: record.conversationId,
            };

            await onTurnComplete(state, resultPayload);
            try {
                getDatabase().markDaemonTurnDelivered(record.channelId, record.currentTurnId);
            } catch {}
        }
    }
}
