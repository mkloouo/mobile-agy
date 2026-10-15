import { BotServices } from './types';
import { taskManager } from '../services/taskManager';
import { buildStopKeyboard } from './keyboards';
import { presentQuestion } from './questionHandler';
import {
    balanceHtmlTags,
    decodeHtmlEntities,
    describeToolAction,
    escapeHtml,
    formatForTelegram,
    splitTelegramHtml,
} from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export async function executeTurnWithStatus(
    services: BotServices,
    channelKey: string,
    workspacePath: string,
    userPrompt: string,
    chatId: number,
    threadId: number | undefined,
    statusMsgId: number
): Promise<void> {
    const { bot, db, config, agyService } = services;
    agyService.setTelegramStatus(channelKey, statusMsgId, chatId, threadId);

    let lastEditTime = Date.now();
    let lastRenderedText = '';
    let rateLimitUntil = 0;
    let activeToolInfo: { name: string; params: any } | null = null;
    let pendingAskQuestionParams: any = null;
    const recentCompletedActions: string[] = [];

    const updateTelegramStatus = async (force: boolean = false) => {
        const now = Date.now();
        if (now < rateLimitUntil) {
            return;
        }
        if (!force && now - lastEditTime < 2500) {
            return;
        }
        lastEditTime = now;

        let displayText = lastRenderedText.trim()
            ? formatForTelegram(lastRenderedText.trim())
            : '🧠 <i>Antigravity is working...</i>';

        const actionLines: string[] = [];
        for (const item of recentCompletedActions.slice(-3)) {
            actionLines.push(`• ✓ ${item}`);
        }
        if (activeToolInfo) {
            const activeDesc = describeToolAction(activeToolInfo.name, activeToolInfo.params, workspacePath, 'active');
            actionLines.push(`• ⚙️ ${activeDesc}...`);
        }

        if (actionLines.length > 0) {
            displayText += `\n\n<b>Recent actions:</b>\n${actionLines.join('\n')}`;
        }

        const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
        const stopKeyboard = buildStopKeyboard(runningTasks);
        if (runningTasks.length > 0) {
            const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
            displayText += `\n\n<b>Active Background:</b>\n${taskBadges}`;
        }

        try {
            const truncated = displayText.length > 3900
                ? balanceHtmlTags(displayText.slice(0, 3900)).closedHtml
                : displayText;
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                truncated,
                { parse_mode: 'HTML', reply_markup: stopKeyboard }
            );
        } catch (err: any) {
            if (err.parameters?.retry_after) {
                rateLimitUntil = Date.now() + (err.parameters.retry_after * 1000);
                logger.warn(`[Bot] Rate-limited by Telegram (429). Pausing status edits for ${err.parameters.retry_after}s`);
            } else if (!err.message?.includes('message is not modified')) {
                logger.debug('[Bot] editMessageText error:', err.message);
            }
        }
    };

    try {
        const session = db.getSession(channelKey);
        const selectedModel = db.getModel(channelKey) || session?.selectedModel || config.defaultModel;
        const result = await agyService.executeTurn(channelKey, {
            workspacePath,
            conversationId: session?.conversationId,
            prompt: userPrompt,
            autoApprove: config.autoApprove,
            model: selectedModel,
            chatId,
            statusMessageId: statusMsgId,
            threadId,
            onInit: (convId) => {
                db.saveSession(channelKey, workspacePath, convId, threadId);
            },
            onDelta: (_delta, fullText) => {
                lastRenderedText = fullText;
                updateTelegramStatus(false);
            },
            onToolCall: (toolName, params) => {
                activeToolInfo = { name: toolName, params };
                if (toolName === 'ask_question') {
                    pendingAskQuestionParams = params;
                }
                updateTelegramStatus(false);
            },
            onToolDone: (toolName, _output) => {
                const params = activeToolInfo?.name === toolName ? activeToolInfo.params : undefined;
                const doneDesc = describeToolAction(toolName, params, workspacePath, 'done');
                recentCompletedActions.push(doneDesc);
                if (recentCompletedActions.length > 6) {
                    recentCompletedActions.shift();
                }
                activeToolInfo = null;
                updateTelegramStatus(false);
            },
        });

        // Save conversation ID
        if (result.conversationId) {
            db.saveSession(channelKey, workspacePath, result.conversationId, threadId);
        }

        db.recordTurnUsage(channelKey, {
            inputTokens: result.usage?.input_tokens || 0,
            outputTokens: result.usage?.output_tokens || 0,
            thinkingTokens: result.usage?.thinking_tokens || 0,
            cacheTokens: result.usage?.cache_read_tokens || 0,
            totalTokens: result.usage?.total_tokens || 0,
            durationSeconds: result.durationSeconds || 0,
        });

        // Final delivery with background tasks indicator and stop buttons if running
        let formatted: string;
        const rawResponse = (result.response || lastRenderedText || '').trim();

        const isExplicitError =
            rawResponse.startsWith('❌ Antigravity error:') ||
            rawResponse.startsWith('❌ Antigravity process exited') ||
            rawResponse.startsWith('agent executor error:') ||
            rawResponse.includes('AGY_ERROR:') ||
            rawResponse.startsWith('Fatal error:') ||
            rawResponse.startsWith('panic:');

        const isActualError = result.status === 'ERROR' && (!rawResponse || isExplicitError);

        if (isActualError) {
            formatted = `❌ <b>Error:</b>\n${escapeHtml(rawResponse || result.error || 'Antigravity execution failed.')}`;
            agyService.restartSession(channelKey).catch(() => {});
        } else if (userPrompt.trim().startsWith('/compact')) {
            formatted = '🗜️ <b>Conversation compacted.</b> Context window has been summarized and freed.';
        } else if (!rawResponse) {
            if (recentCompletedActions.length > 0) {
                formatted = '✓ <b>Completed:</b>\n' + recentCompletedActions.map((a) => `• ✓ ${a}`).join('\n');
            } else {
                formatted = '✓ <i>Done.</i>';
            }
        } else {
            formatted = formatForTelegram(rawResponse);
        }

        const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
        const stopKeyboard = buildStopKeyboard(runningTasks);
        if (runningTasks.length > 0) {
            const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
            formatted += `\n\n<b>Active Background:</b>\n${taskBadges}`;
        }

        const chunks = splitTelegramHtml(formatted);

        // Edit the initial message with the first chunk
        let deliverySucceeded = false;
        try {
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                chunks[0],
                { parse_mode: 'HTML', reply_markup: stopKeyboard }
            );
            deliverySucceeded = true;
        } catch (editErr: any) {
            if (editErr.message?.includes('message is not modified')) {
                deliverySucceeded = true;
            } else if (editErr.message?.includes("can't parse entities")) {
                logger.warn('[Bot] HTML parse failed on editMessageText, falling back to plain text');
                try {
                    await bot.api.editMessageText(
                        chatId,
                        statusMsgId,
                        decodeHtmlEntities(chunks[0].replace(/<[^>]+>/g, '')).slice(0, 4000),
                        { reply_markup: stopKeyboard }
                    );
                    deliverySucceeded = true;
                } catch {
                    // Fall back to sending new message
                }
            } else {
                logger.warn('[Bot] editMessageText failed on final delivery (e.g. 429), falling back to sendMessage:', editErr.message);
            }
        }

        // If edit failed (e.g. 429 rate limit), send as a new message so the user ALWAYS gets the response!
        if (!deliverySucceeded) {
            try {
                await bot.api.sendMessage(chatId, chunks[0], {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                    reply_markup: stopKeyboard,
                });
            } catch {
                await bot.api.sendMessage(chatId, decodeHtmlEntities(chunks[0].replace(/<[^>]+>/g, '')).slice(0, 4000), {
                    message_thread_id: threadId,
                    reply_markup: stopKeyboard,
                });
            }
        }

        // Send remaining chunks as subsequent messages if response is long
        for (let i = 1; i < chunks.length; i++) {
            try {
                await bot.api.sendMessage(chatId, chunks[i], {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            } catch (replyErr: any) {
                if (replyErr.message?.includes("can't parse entities")) {
                    await bot.api.sendMessage(chatId, decodeHtmlEntities(chunks[i].replace(/<[^>]+>/g, '')).slice(0, 4000), {
                        message_thread_id: threadId,
                    });
                } else {
                    logger.error('[Bot] Failed to send chunk reply:', replyErr);
                }
            }
        }

        // If the model called ask_question, present the question dialog with option buttons
        if (pendingAskQuestionParams) {
            try {
                await presentQuestion(
                    services,
                    channelKey,
                    workspacePath,
                    chatId,
                    threadId,
                    pendingAskQuestionParams
                );
            } catch (qErr: any) {
                logger.error('[Bot] Failed to present question dialog:', qErr);
            }
        }

    } catch (err: any) {
        if (err.message?.includes('message is not modified')) {
            return;
        }
        logger.error('[Bot] Execution error:', err);
        const errStr = err?.message || String(err);
        let displayErr = `❌ <b>Error:</b> ${escapeHtml(errStr)}`;
        if (errStr.includes('429') || errStr.toLowerCase().includes('quota') || errStr.toLowerCase().includes('rate limit')) {
            displayErr += '\n\n💡 <i>You may have hit your model quota limit. Use /model to switch to another model (e.g. Gemini 3.8 Flash Medium).</i>';
        }
        try {
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                displayErr,
                { parse_mode: 'HTML' }
            );
        } catch {
            // Fallback: send as new message if edit fails
            try {
                await bot.api.sendMessage(chatId, displayErr, {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            } catch {}
        }
    } finally {
        if (!pendingAskQuestionParams) {
            services.processNextQueuedTurn(channelKey);
        }
    }
}

export function registerSessionRecovery(services: BotServices): void {
    const { bot, db, agyService } = services;

    agyService.recoverActiveSessions(
        async (state, fullText) => {
            if (!state.chatId || !state.statusMessageId) return;
            try {
                const formatted = formatForTelegram(fullText);
                const truncated = formatted.length > 3900
                    ? balanceHtmlTags(formatted.slice(0, 3900)).closedHtml
                    : formatted;
                await bot.api.editMessageText(
                    state.chatId,
                    state.statusMessageId,
                    truncated || '🧠 <i>Antigravity is working (reconnected)...</i>',
                    { parse_mode: 'HTML' }
                );
            } catch {}
        },
        async (state, result) => {
            if (!state.chatId || !state.statusMessageId) return;
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

                const formatted = formatForTelegram(result.response || '<i>Done.</i>');
                const chunks = splitTelegramHtml(formatted);

                try {
                    await bot.api.editMessageText(
                        state.chatId,
                        state.statusMessageId,
                        chunks[0],
                        { parse_mode: 'HTML' }
                    );
                } catch (editErr: any) {
                    if (editErr.message?.includes("can't parse entities")) {
                        await bot.api.editMessageText(
                            state.chatId,
                            state.statusMessageId,
                            chunks[0].replace(/<[^>]+>/g, '').slice(0, 4000)
                        );
                    }
                }

                for (let i = 1; i < chunks.length; i++) {
                    await bot.api.sendMessage(state.chatId, chunks[i], {
                        parse_mode: 'HTML',
                        message_thread_id: state.threadId,
                    });
                }
            } catch (err: any) {
                logger.error('[Bot] Failed to finalize recovered session message:', err);
            }
        }
    ).catch((err) => {
        logger.warn('[Bot] Session recovery error:', err.message);
    });
}
