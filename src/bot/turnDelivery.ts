import { InlineKeyboard } from 'grammy';
import { taskManager } from '../services/taskManager';
import { buildStopKeyboard } from './keyboards';
import {
    cleanModelResponse,
    decodeHtmlEntities,
    describeToolAction,
    escapeHtml,
    formatElapsedTime,
    formatForTelegram,
    formatPromptQuote,
    sanitizeTelegramHtml,
    splitTelegramHtml,
} from '../utils/telegramFormatter';
import { logger } from '../utils/logger';
import { formatDuration } from '../utils/dateFormatter';
import { extractFilesToSend, deliverFiles } from './fileDelivery';

export interface ProgressStatusOptions {
    channelKey: string;
    workspacePath: string;
    startTime: number;
    activeToolInfo?: { name: string; params: any } | null;
    recentCompletedActions?: string[];
    title?: string;
    userPrompt?: string;
}

export async function buildProgressStatus(
    options: ProgressStatusOptions
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
    const {
        channelKey,
        workspacePath,
        startTime,
        activeToolInfo,
        recentCompletedActions = [],
        title = '🧠 <b>Antigravity is working...</b>',
        userPrompt,
    } = options;

    const quoteHeader = formatPromptQuote(userPrompt);
    let displayText = `${quoteHeader}${title}`;

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

    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    displayText += `\n\n⏱️ <i>Actively working: ${formatElapsedTime(elapsedSec)}</i>`;

    return {
        text: sanitizeTelegramHtml(displayText),
        keyboard: stopKeyboard,
    };
}

export interface CompletedStatusOptions {
    channelKey: string;
    workspacePath: string;
    durationSec: number;
    isError?: boolean;
    isCompact?: boolean;
    reconnected?: boolean;
    recentCompletedActions?: string[];
    userPrompt?: string;
}

export async function buildCompletedStatus(
    options: CompletedStatusOptions
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
    const {
        channelKey,
        workspacePath,
        durationSec,
        isError = false,
        isCompact = false,
        reconnected = false,
        recentCompletedActions = [],
        userPrompt,
    } = options;

    const durationText = formatDuration(durationSec);

    const tag = reconnected ? ' (reconnected)' : '';
    let statusDoneText: string;

    if (isError) {
        statusDoneText = `❌ <b>Execution failed${tag}</b> (${durationText})`;
    } else if (isCompact) {
        statusDoneText = '🗜️ <b>Conversation compacted.</b> Context window summarized.';
    } else if (recentCompletedActions.length > 0) {
        statusDoneText = `✓ <b>Actions completed${tag}</b> (${durationText}):\n` +
            recentCompletedActions.slice(-5).map((a) => `• ✓ ${a}`).join('\n');
    } else {
        statusDoneText = `✓ <b>Completed${tag}</b> (${durationText})`;
    }

    const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
    const stopKeyboard = buildStopKeyboard(runningTasks);
    if (runningTasks.length > 0) {
        const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
        statusDoneText += `\n\n<b>Active Background:</b>\n${taskBadges}`;
    }

    const quoteHeader = formatPromptQuote(userPrompt);

    return {
        text: sanitizeTelegramHtml(`${quoteHeader}${statusDoneText}`),
        keyboard: stopKeyboard,
    };
}

async function sendWithRetry(
    bot: any,
    chatId: number,
    text: string,
    options: any,
    maxRetries = 3
): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await bot.api.sendMessage(chatId, text, options);
            return;
        } catch (err: any) {
            const retryAfter = err?.parameters?.retry_after;
            if (retryAfter && attempt < maxRetries) {
                const waitSec = Math.min(retryAfter, 15);
                logger.warn(`[Bot] Rate-limited (429) on sendMessage, waiting ${waitSec}s (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise((r) => setTimeout(r, waitSec * 1000));
                continue;
            }
            throw err;
        }
    }
}

export function isActualTurnError(status?: string, rawResponse?: string): boolean {
    const resp = (rawResponse || '').trim();
    if (status !== 'ERROR') return false;

    const isExplicitError =
        resp.startsWith('❌ Antigravity error:') ||
        resp.startsWith('❌ Antigravity process exited') ||
        resp.startsWith('agent executor error:') ||
        resp.includes('AGY_ERROR:') ||
        resp.startsWith('Fatal error:') ||
        resp.startsWith('panic:');

    return !resp || isExplicitError;
}

export async function deliverTurnResponse(
    bot: any,
    chatId: number,
    threadId: number | undefined,
    rawResponse: string,
    isError: boolean = false,
    errorMessage?: string,
    workspacePath?: string
): Promise<void> {
    const { files, cleanedResponse } = extractFilesToSend(rawResponse, workspacePath);
    const cleanResponse = cleanModelResponse((cleanedResponse || '').trim());
    if (!cleanResponse && !errorMessage && files.length === 0) return;

    if (cleanResponse || errorMessage) {
        const formatted = isError
            ? `❌ <b>Error:</b>\n${escapeHtml(cleanResponse || errorMessage || 'Antigravity execution failed.')}`
            : formatForTelegram(cleanResponse);

        const chunks = splitTelegramHtml(formatted);
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (i > 0) {
                // Prevent rapid-fire Telegram message bursts between chunks
                await new Promise((r) => setTimeout(r, 250));
            }

            try {
                await sendWithRetry(bot, chatId, chunk, {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            } catch (replyErr: any) {
                logger.warn(`[Bot] HTML delivery failed on sendMessage (${replyErr.message}), falling back to plain text`);
                try {
                    await sendWithRetry(
                        bot,
                        chatId,
                        decodeHtmlEntities(chunk.replace(/<[^>]+>/g, '')).slice(0, 4000),
                        { message_thread_id: threadId }
                    );
                } catch (fallbackErr: any) {
                    logger.error('[Bot] Plain text fallback also failed:', fallbackErr);
                }
            }
        }
    }

    if (files.length > 0 && !isError) {
        await deliverFiles(bot, chatId, threadId, files);
    }
}
