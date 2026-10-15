import { BotServices } from './types';
import { taskManager } from '../services/taskManager';
import { buildStopKeyboard } from './keyboards';
import { findRecentAskQuestion, presentQuestion } from './questionHandler';
import {
    cleanModelResponse,
    decodeHtmlEntities,
    describeToolAction,
    escapeHtml,
    formatElapsedTime,
    formatForTelegram,
    sanitizeTelegramHtml,
    splitTelegramHtml,
} from '../utils/telegramFormatter';
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

            const channelKey = state.sessionId;
            const workspacePath = state.workspacePath;
            const startTime = state.createdAt || Date.now();

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

                let displayText = '🧠 <b>Antigravity is working (reconnected)...</b>';

                const currentTool = activeToolInfos.get(channelKey);
                if (currentTool) {
                    const activeDesc = describeToolAction(currentTool.name, currentTool.params, workspacePath, 'active');
                    displayText += `\n\n⚙️ ${activeDesc}...`;
                }

                if (recentCompletedActions.length > 0) {
                    const actionLines = recentCompletedActions.slice(-4).map((item) => `• ✓ ${item}`);
                    displayText += `\n\n<b>Recent actions:</b>\n${actionLines.join('\n')}`;
                }

                const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
                const stopKeyboard = buildStopKeyboard(runningTasks);
                if (runningTasks.length > 0) {
                    const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
                    displayText += `\n\n<b>Active Background:</b>\n${taskBadges}`;
                }

                const elapsedSec = Math.max(0, Math.floor((now - startTime) / 1000));
                displayText += `\n\n⏱️ <i>Actively working: ${formatElapsedTime(elapsedSec)}</i>`;

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        sanitizeTelegramHtml(displayText),
                        { parse_mode: 'HTML', reply_markup: stopKeyboard }
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
            const channelKey = state.sessionId;
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
                db.recordTurnUsage(channelKey, {
                    inputTokens: result.usage?.input_tokens || 0,
                    outputTokens: result.usage?.output_tokens || 0,
                    thinkingTokens: result.usage?.thinking_tokens || 0,
                    cacheTokens: result.usage?.cache_read_tokens || 0,
                    totalTokens: result.usage?.total_tokens || 0,
                    durationSeconds: result.durationSeconds || 0,
                });

                // 1. Leave status message on completed state
                const durationSec = result.durationSeconds || 0;
                const durationText = durationSec >= 60
                    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
                    : `${durationSec}s`;

                const recentActions = completedActionsMap.get(channelKey) || [];
                let statusDoneText: string;
                if (recentActions.length > 0) {
                    statusDoneText = `✓ <b>Actions completed (reconnected)</b> (${durationText}):\n` +
                        recentActions.slice(-5).map((a) => `• ✓ ${a}`).join('\n');
                } else {
                    statusDoneText = `✓ <b>Completed (reconnected)</b> (${durationText})`;
                }

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        statusDoneText,
                        { parse_mode: 'HTML' }
                    );
                } catch {}

                // 2. Send actual response chunks as new message(s)
                const rawResponse = cleanModelResponse((result.response || '').trim());
                if (rawResponse) {
                    const formatted = formatForTelegram(rawResponse);
                    const chunks = splitTelegramHtml(formatted);

                    for (const chunk of chunks) {
                        try {
                            await bot.api.sendMessage(state.chatId, chunk, {
                                parse_mode: 'HTML',
                                message_thread_id: state.threadId,
                            });
                        } catch (err: any) {
                            if (err.message?.includes("can't parse entities")) {
                                await bot.api.sendMessage(
                                    state.chatId,
                                    decodeHtmlEntities(chunk.replace(/<[^>]+>/g, '')).slice(0, 4000),
                                    { message_thread_id: state.threadId }
                                );
                            } else {
                                logger.error('[Bot] Failed to send recovered chunk:', err);
                            }
                        }
                    }
                }

                agyService.markTurnDelivered(channelKey);

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
            }
        }
    ).catch((err) => {
        logger.warn('[Bot] Session recovery error:', err.message);
    });
}
