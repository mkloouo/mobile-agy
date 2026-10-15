import { BotServices } from './types';
import { formatPromptQuote } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export async function processNextQueuedTurn(services: BotServices, channelKey: string): Promise<void> {
    const { bot, db } = services;
    const next = db.popNextQueuedMessage(channelKey);
    if (!next) return;

    const workspacePath = services.resolveWorkspace(channelKey);
    const quoteHeader = formatPromptQuote(next.prompt);

    try {
        await bot.api.editMessageText(
            next.chatId,
            next.statusMsgId,
            `${quoteHeader}🧠 <i>Antigravity is thinking...</i>`,
            { parse_mode: 'HTML' }
        );
    } catch {}

    services.executeTurnWithStatus(
        channelKey,
        workspacePath,
        next.prompt,
        next.chatId,
        next.threadId,
        next.statusMsgId
    ).catch((err) => {
        logger.error('[Bot] Error executing queued turn:', err);
    });
}

export function restoreQueuedTurns(services: BotServices): void {
    const { db, agyService } = services;

    setTimeout(() => {
        try {
            const channels = db.getDistinctQueuedChannels();
            for (const ch of channels) {
                if (!agyService.isBusy(ch)) {
                    services.processNextQueuedTurn(ch).catch((err) => {
                        logger.error(`[Bot] Error processing restored queue for ${ch}:`, err);
                    });
                }
            }
        } catch (err: any) {
            logger.warn('[Bot] Failed to check restored message queues:', err.message);
        }
    }, 1500);
}
