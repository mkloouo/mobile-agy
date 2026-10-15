import { BotServices } from './types';
import { taskManager } from '../services/taskManager';
import { buildStopKeyboard } from './keyboards';
import { presentQuestion, findRecentAskQuestion } from './questionHandler';
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

export { registerSessionRecovery } from './sessionRecovery';

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

    const startTime = Date.now();
    let lastEditTime = Date.now();
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

        let displayText = '🧠 <b>Antigravity is working...</b>';

        if (activeToolInfo) {
            const activeDesc = describeToolAction(activeToolInfo.name, activeToolInfo.params, workspacePath, 'active');
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
                chatId,
                statusMsgId,
                sanitizeTelegramHtml(displayText),
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

    // Update timer every 10 seconds so user sees stable progress
    const progressInterval = setInterval(() => {
        updateTelegramStatus(true);
    }, 10000);

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
            onDelta: () => {
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

        const rawResponse = (result.response || '').trim();

        const isExplicitError =
            rawResponse.startsWith('❌ Antigravity error:') ||
            rawResponse.startsWith('❌ Antigravity process exited') ||
            rawResponse.startsWith('agent executor error:') ||
            rawResponse.includes('AGY_ERROR:') ||
            rawResponse.startsWith('Fatal error:') ||
            rawResponse.startsWith('panic:');

        const isActualError = result.status === 'ERROR' && (!rawResponse || isExplicitError);

        if (isActualError) {
            agyService.restartSession(channelKey).catch(() => {});
        }

        const durationSec = result.durationSeconds || Math.max(1, Math.round((Date.now() - startTime) / 1000));
        const durationText = durationSec >= 60
            ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
            : `${durationSec}s`;

        // 1. Leave the status message on actions done (short list)
        let statusDoneText: string;
        if (isActualError) {
            statusDoneText = `❌ <b>Execution failed</b> (${durationText})`;
        } else if (userPrompt.trim().startsWith('/compact')) {
            statusDoneText = '🗜️ <b>Conversation compacted.</b> Context window summarized.';
        } else if (recentCompletedActions.length > 0) {
            statusDoneText = `✓ <b>Actions completed</b> (${durationText}):\n` +
                recentCompletedActions.slice(-5).map((a) => `• ✓ ${a}`).join('\n');
        } else {
            statusDoneText = `✓ <b>Completed</b> (${durationText})`;
        }

        const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
        const stopKeyboard = buildStopKeyboard(runningTasks);
        if (runningTasks.length > 0) {
            const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
            statusDoneText += `\n\n<b>Active Background:</b>\n${taskBadges}`;
        }

        try {
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                sanitizeTelegramHtml(statusDoneText),
                { parse_mode: 'HTML', reply_markup: stopKeyboard }
            );
        } catch (err: any) {
            if (!err.message?.includes('message is not modified')) {
                logger.debug('[Bot] editMessageText final status error:', err.message);
            }
        }

        // 2. Send the actual final response as separate message(s)
        const cleanResponse = cleanModelResponse(rawResponse);
        if (cleanResponse) {
            const formatted = isActualError
                ? `❌ <b>Error:</b>\n${escapeHtml(cleanResponse || result.error || 'Antigravity execution failed.')}`
                : formatForTelegram(cleanResponse);

            const chunks = splitTelegramHtml(formatted);
            for (const chunk of chunks) {
                try {
                    await bot.api.sendMessage(chatId, chunk, {
                        parse_mode: 'HTML',
                        message_thread_id: threadId,
                    });
                } catch (replyErr: any) {
                    if (replyErr.message?.includes("can't parse entities")) {
                        logger.warn('[Bot] HTML parse failed on sendMessage, falling back to plain text');
                        await bot.api.sendMessage(
                            chatId,
                            decodeHtmlEntities(chunk.replace(/<[^>]+>/g, '')).slice(0, 4000),
                            { message_thread_id: threadId }
                        );
                    } else {
                        logger.error('[Bot] Failed to send chunk reply:', replyErr);
                    }
                }
            }
        }

        agyService.markTurnDelivered(channelKey);

        // If the model called ask_question, present the question dialog with option buttons
        if (!pendingAskQuestionParams && result.conversationId) {
            pendingAskQuestionParams = findRecentAskQuestion(result.conversationId);
        }

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
            try {
                await bot.api.sendMessage(chatId, displayErr, {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            } catch {}
        }
    } finally {
        clearInterval(progressInterval);
        if (!pendingAskQuestionParams) {
            services.processNextQueuedTurn(channelKey);
        }
    }
}
