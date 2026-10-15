import { BotServices } from './types';
import { presentQuestion, findRecentAskQuestion } from './questionHandler';
import { describeToolAction, escapeHtml } from '../utils/telegramFormatter';
import { buildProgressStatus, buildCompletedStatus, deliverTurnResponse } from './turnDelivery';
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

        const status = await buildProgressStatus({
            channelKey,
            workspacePath,
            startTime,
            activeToolInfo,
            recentCompletedActions,
        });

        try {
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                status.text,
                { parse_mode: 'HTML', reply_markup: status.keyboard }
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

        const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));

        db.recordTurnUsage(channelKey, {
            inputTokens: result.usage?.input_tokens || 0,
            outputTokens: result.usage?.output_tokens || 0,
            thinkingTokens: result.usage?.thinking_tokens || 0,
            cacheTokens: result.usage?.cache_read_tokens || 0,
            totalTokens: result.usage?.total_tokens || 0,
            durationSeconds: durationSec,
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

        // 1. Leave the status message on actions done
        const doneStatus = await buildCompletedStatus({
            channelKey,
            workspacePath,
            durationSec,
            isError: isActualError,
            isCompact: userPrompt.trim().startsWith('/compact'),
            recentCompletedActions,
        });

        try {
            await bot.api.editMessageText(
                chatId,
                statusMsgId,
                doneStatus.text,
                { parse_mode: 'HTML', reply_markup: doneStatus.keyboard }
            );
        } catch (err: any) {
            if (!err.message?.includes('message is not modified')) {
                logger.debug('[Bot] editMessageText final status error:', err.message);
            }
        }

        // 2. Deliver actual final response as separate message(s)
        await deliverTurnResponse(
            bot,
            chatId,
            threadId,
            rawResponse,
            isActualError,
            result.error || 'Antigravity execution failed.'
        );

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
