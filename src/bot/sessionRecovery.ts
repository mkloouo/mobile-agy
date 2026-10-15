import { BotServices } from './types';
import { findRecentAskQuestion, presentQuestion } from './questionHandler';
import {
    cleanModelResponse,
    decodeHtmlEntities,
    formatForTelegram,
    splitTelegramHtml,
} from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

/**
 * Register recovery for active sessions that were in-flight when the daemon was reloaded.
 */
export function registerSessionRecovery(services: BotServices): void {
    const { bot, db, agyService } = services;

    agyService.recoverActiveSessions(
        async (state) => {
            if (!state.chatId || !state.statusMessageId) return;
            logger.info(`[Bot] Re-attaching and updating Telegram status message for session ${state.sessionId}`);
            try {
                await bot.api.editMessageText(
                    state.chatId,
                    state.statusMessageId,
                    '🧠 <i>Antigravity is working (reconnected)...</i>',
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                logger.warn(`[Bot] Failed to update status message on reconnect (${state.sessionId}):`, err.message);
            }
        },
        async (state, result) => {
            if (!state.chatId || !state.statusMessageId) return;
            logger.info(`[Bot] Completing recovered turn for session ${state.sessionId} (status: ${result.status})`);
            try {
                if (result.conversationId) {
                    db.saveSession(state.sessionId, state.workspacePath, result.conversationId, state.threadId);
                }
                db.recordTurnUsage(state.sessionId, {
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

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        `✓ <b>Completed (reconnected)</b> (${durationText})`,
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

                agyService.markTurnDelivered(state.sessionId);

                if (result.conversationId) {
                    const questionParams = findRecentAskQuestion(result.conversationId);
                    if (questionParams) {
                        await presentQuestion(
                            services,
                            state.sessionId,
                            state.workspacePath,
                            state.chatId,
                            state.threadId,
                            questionParams
                        );
                    }
                }
            } catch (err: any) {
                logger.error('[Bot] Failed to finalize recovered session message:', err);
            }
        }
    ).catch((err) => {
        logger.warn('[Bot] Session recovery error:', err.message);
    });
}
