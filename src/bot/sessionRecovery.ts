import { BotServices } from './types';
import { findRecentAskQuestion, presentQuestion } from './questionHandler';
import { describeToolAction } from '../utils/telegramFormatter';
import { buildProgressStatus, buildCompletedStatus, deliverTurnResponse, isActualTurnError } from './turnDelivery';
import { logger } from '../utils/logger';

/**
 * Register recovery for active sessions that were in-flight when the daemon was reloaded.
 */
export function registerSessionRecovery(services: BotServices): void {
    const { bot, db, agyService } = services;

    // Track active heartbeat timers per recovered session
    const activeHeartbeats: Map<string, NodeJS.Timeout> = new Map();
    const activeToolInfos: Map<string, { name: string; params: any } | null> = new Map();
    const completedActionsMap: Map<string, string[]> = new Map();

    let rateLimitUntil = 0;
    let lastEditTime = 0;

    agyService.recoverActiveSessions(
        async (state, _fullText, activeTool, doneAction) => {
            if (!state.chatId || !state.statusMessageId) return;

            const channelKey = state.channelId || state.sessionId;
            const workspacePath = state.workspacePath;
            const startTime = state.turnStartTime || state.createdAt || Date.now();

            if (!completedActionsMap.has(channelKey)) {
                completedActionsMap.set(channelKey, []);
            }
            const recentCompletedActions = completedActionsMap.get(channelKey)!;

            if (activeTool) {
                activeToolInfos.set(channelKey, activeTool);
            }

            if (doneAction) {
                const activeTool = activeToolInfos.get(channelKey);
                const params = activeTool?.name === doneAction ? activeTool.params : undefined;
                const doneDesc = describeToolAction(doneAction, params, workspacePath, 'done');
                recentCompletedActions.push(doneDesc);
                if (recentCompletedActions.length > 6) {
                    recentCompletedActions.shift();
                }
                activeToolInfos.set(channelKey, null);
            }

            const updateTelegramStatus = async (force: boolean = false) => {
                const now = Date.now();
                if (now < rateLimitUntil) return;
                if (!force && now - lastEditTime < 2500) return;
                lastEditTime = now;

                const status = await buildProgressStatus({
                    channelKey,
                    workspacePath,
                    startTime,
                    activeToolInfo: activeToolInfos.get(channelKey),
                    recentCompletedActions,
                    title: '🧠 <b>Antigravity is working (reconnected)...</b>',
                    userPrompt: state.userPrompt,
                });

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        status.text,
                        { parse_mode: 'HTML', reply_markup: status.keyboard }
                    );
                } catch (err: any) {
                    if (err.parameters?.retry_after) {
                        rateLimitUntil = Date.now() + (err.parameters.retry_after * 1000);
                        logger.warn(`[Bot] Rate-limited by Telegram (429) during recovery. Pausing for ${err.parameters.retry_after}s`);
                    } else if (!err.message?.includes('message is not modified')) {
                        logger.debug('[Bot] editMessageText error on recovery status:', err.message);
                    }
                }
            };

            // Start repeating 10s heartbeat timer if not already running for this session
            if (!activeHeartbeats.has(channelKey)) {
                logger.info(`[Bot] Starting 10s heartbeat updater for recovered session ${channelKey}`);
                const interval = setInterval(() => {
                    updateTelegramStatus(true).catch(() => {});
                }, 10000);
                activeHeartbeats.set(channelKey, interval);
            }

            await updateTelegramStatus(false);
        },
        async (state, result) => {
            const channelKey = state.channelId || state.sessionId;
            const heartbeat = activeHeartbeats.get(channelKey);
            if (heartbeat) {
                clearInterval(heartbeat);
                activeHeartbeats.delete(channelKey);
            }

            if (!state.chatId || !state.statusMessageId) return;
            logger.info(`[Bot] Completing recovered turn for session ${channelKey} (status: ${result.status})`);

            try {
                if (result.conversationId) {
                    db.saveSession(channelKey, state.workspacePath, result.conversationId, state.threadId);
                }
                const durationSec = state.turnStartTime
                    ? Math.max(1, Math.round((Date.now() - state.turnStartTime) / 1000))
                    : (result.durationSeconds || 0);

                db.recordTurnUsage(channelKey, {
                    inputTokens: result.usage?.input_tokens || 0,
                    outputTokens: result.usage?.output_tokens || 0,
                    thinkingTokens: result.usage?.thinking_tokens || 0,
                    cacheTokens: result.usage?.cache_read_tokens || 0,
                    totalTokens: result.usage?.total_tokens || 0,
                    durationSeconds: durationSec,
                });

                // 1. Leave status message on completed state
                const recentActions = completedActionsMap.get(channelKey) || [];
                const rawResponse = (result.response || '').trim();
                const isActualError = isActualTurnError(result.status, rawResponse);

                const doneStatus = await buildCompletedStatus({
                    channelKey,
                    workspacePath: state.workspacePath,
                    durationSec,
                    isError: isActualError,
                    reconnected: true,
                    recentCompletedActions: recentActions,
                    userPrompt: state.userPrompt,
                });

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        doneStatus.text,
                        { parse_mode: 'HTML', reply_markup: doneStatus.keyboard }
                    );
                } catch {}

                // 2. Send actual response chunks as new message(s)
                await deliverTurnResponse(
                    bot,
                    state.chatId,
                    state.threadId,
                    rawResponse,
                    isActualError,
                    result.error || 'Execution failed.'
                );

                agyService.markTurnDelivered(channelKey, state.currentTurnId);

                if (result.conversationId) {
                    const questionParams = findRecentAskQuestion(result.conversationId);
                    if (questionParams) {
                        await presentQuestion(
                            services,
                            channelKey,
                            state.workspacePath,
                            state.chatId,
                            state.threadId,
                            questionParams
                        );
                    }
                }
            } catch (err: any) {
                logger.error('[Bot] Failed to finalize recovered session message:', err);
            } finally {
                activeToolInfos.delete(channelKey);
                completedActionsMap.delete(channelKey);
                bot.api.unpinChatMessage(state.chatId, state.statusMessageId).catch(() => {});
                services.processNextQueuedTurn(channelKey).catch((err) => {
                    logger.error('[Bot] Error processing queued turn after recovery:', err);
                });
            }
        }
    ).catch((err) => {
        logger.warn('[Bot] Session recovery error:', err.message);
    });
}
