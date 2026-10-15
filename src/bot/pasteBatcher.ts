import { Context } from 'grammy';
import { BotServices } from './types';
import { logger } from '../utils/logger';

interface PendingPasteBatch {
    channelKey: string;
    chatId: number;
    threadId?: number;
    texts: string[];
    replyTo?: any;
    statusMsgId?: number;
    timer: NodeJS.Timeout;
}

const pendingBatches = new Map<string, PendingPasteBatch>();
const PASTE_DEBOUNCE_MS = 600;

/**
 * Handle rapid incoming text chunks (such as large pasted logs split by Telegram into 4096-char messages).
 * Returns true if message was buffered into a paste batch, false if it should execute immediately.
 */
export function handlePastedText(
    ctx: Context,
    text: string,
    services: BotServices,
    onComplete: (combinedText: string, ctx: Context) => Promise<void>
): boolean {
    const channelKey = services.getChannelKey(ctx);
    const threadId = ctx.message?.message_thread_id;
    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    // Do NOT batch slash commands or direct shell commands
    if (text.startsWith('/') || text.startsWith('!')) {
        return false;
    }

    let batch = pendingBatches.get(channelKey);

    if (!batch) {
        // Start a candidate batch
        batch = {
            channelKey,
            chatId,
            threadId,
            texts: [text],
            replyTo: ctx.message?.reply_to_message,
            timer: setTimeout(() => {
                finalizeBatch(channelKey, ctx, services, onComplete);
            }, PASTE_DEBOUNCE_MS),
        };
        pendingBatches.set(channelKey, batch);
        return true;
    }

    // Subsequent chunk arrived within debounce window!
    clearTimeout(batch.timer);
    batch.texts.push(text);
    if (!batch.replyTo && ctx.message?.reply_to_message) {
        batch.replyTo = ctx.message.reply_to_message;
    }

    // If 2nd chunk arrives, notify Telegram user that chunks are being assembled
    const chunkCount = batch.texts.length;
    if (chunkCount === 2) {
        ctx.reply(
            `📋 <i>Assembling large paste (2 chunks)...</i>`,
            { parse_mode: 'HTML', message_thread_id: threadId }
        ).then((msg) => {
            if (batch) batch.statusMsgId = msg.message_id;
        }).catch(() => {});
    } else if (batch.statusMsgId && chunkCount > 2) {
        ctx.api.editMessageText(
            chatId,
            batch.statusMsgId,
            `📋 <i>Assembling large paste (${chunkCount} chunks)...</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }

    batch.timer = setTimeout(() => {
        finalizeBatch(channelKey, ctx, services, onComplete);
    }, PASTE_DEBOUNCE_MS);

    return true;
}

async function finalizeBatch(
    channelKey: string,
    lastCtx: Context,
    services: BotServices,
    onComplete: (combinedText: string, ctx: Context) => Promise<void>
): Promise<void> {
    const batch = pendingBatches.get(channelKey);
    if (!batch) return;
    pendingBatches.delete(channelKey);

    const totalChunks = batch.texts.length;
    const combined = batch.texts.join('\n');

    if (totalChunks > 1) {
        logger.info(`[PasteBatcher] Merged ${totalChunks} pasted text chunks for ${channelKey} (${combined.length} chars)`);
        if (batch.statusMsgId) {
            services.bot.api.editMessageText(
                batch.chatId,
                batch.statusMsgId,
                `📋 <b>Received complete log (${totalChunks} chunks, ${Math.round(combined.length / 1024 * 10) / 10} KB).</b> Dispatching...`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }

    await onComplete(combined, lastCtx);
}
