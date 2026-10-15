import { Context } from 'grammy';
import { BotServices } from './types';
import { downloadTelegramPhoto } from '../utils/imageHandler';
import { logger } from '../utils/logger';

interface PendingMediaGroup {
    mediaGroupId: string;
    chatId: number;
    threadId?: number;
    channelKey: string;
    photoFileIds: string[];
    caption?: string;
    replyTo?: any;
    timer: NodeJS.Timeout;
    statusMsgPromise: Promise<any>;
    statusMsgId?: number;
}

const pendingGroups = new Map<string, PendingMediaGroup>();
const BATCH_SIZE = 5;
const ALBUM_DEBOUNCE_MS = 1200;

export async function handleMediaGroupMessage(
    ctx: Context,
    mediaGroupId: string,
    services: BotServices
): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    const channelKey = services.getChannelKey(ctx);
    const photos = ctx.message?.photo;

    if (!photos || photos.length === 0) {
        return;
    }

    const largestPhoto = photos[photos.length - 1];
    const caption = ctx.message?.caption || '';
    const replyTo = ctx.message?.reply_to_message;

    let group = pendingGroups.get(mediaGroupId);

    if (!group) {
        // First image of the media group
        const statusPromise = ctx.reply(
            '📥 <i>Receiving album (1 image)...</i>',
            { parse_mode: 'HTML', message_thread_id: threadId }
        ).then((msg) => {
            if (group) group.statusMsgId = msg.message_id;
            return msg;
        }).catch((err) => {
            logger.warn('[MediaGroup] Could not send initial album status message:', err.message);
            return null;
        });

        group = {
            mediaGroupId,
            chatId: ctx.chat!.id,
            threadId,
            channelKey,
            photoFileIds: [largestPhoto.file_id],
            caption: caption || undefined,
            replyTo: replyTo || undefined,
            timer: setTimeout(() => processCompletedAlbum(mediaGroupId, services), ALBUM_DEBOUNCE_MS),
            statusMsgPromise: statusPromise,
        };
        pendingGroups.set(mediaGroupId, group);
    } else {
        // Subsequent images of the same media group
        group.photoFileIds.push(largestPhoto.file_id);
        if (caption && !group.caption) {
            group.caption = caption;
        }
        if (replyTo && !group.replyTo) {
            group.replyTo = replyTo;
        }

        // Reset debounce timer
        clearTimeout(group.timer);
        group.timer = setTimeout(() => processCompletedAlbum(mediaGroupId, services), ALBUM_DEBOUNCE_MS);

        const currentCount = group.photoFileIds.length;
        group.statusMsgPromise.then((statusMsg) => {
            if (!statusMsg) return;
            services.bot.api.editMessageText(
                group!.chatId,
                statusMsg.message_id,
                `📥 <i>Receiving album (${currentCount} images)...</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        });
    }
}

async function processCompletedAlbum(mediaGroupId: string, services: BotServices): Promise<void> {
    const group = pendingGroups.get(mediaGroupId);
    if (!group) return;
    pendingGroups.delete(mediaGroupId);

    const total = group.photoFileIds.length;
    const statusMsg = await group.statusMsgPromise;
    const statusMsgId = statusMsg?.message_id;

    logger.info(`[MediaGroup] Processing album ${mediaGroupId} with ${total} images in batches of ${BATCH_SIZE}`);

    const downloadedPaths: string[] = [];

    for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = group.photoFileIds.slice(i, i + BATCH_SIZE);
        const currentEnd = Math.min(i + BATCH_SIZE, total);

        if (statusMsgId) {
            await services.bot.api.editMessageText(
                group.chatId,
                statusMsgId,
                `📥 <i>Loading images (${currentEnd}/${total})...</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        try {
            const results = await Promise.all(
                batch.map((fileId) => downloadTelegramPhoto(services.bot.api, fileId))
            );
            downloadedPaths.push(...results);
        } catch (downloadErr: any) {
            logger.error('[MediaGroup] Error downloading image batch:', downloadErr);
        }
    }

    if (downloadedPaths.length === 0) {
        if (statusMsgId) {
            await services.bot.api.editMessageText(
                group.chatId,
                statusMsgId,
                '⚠️ <i>Failed to download album images.</i>',
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        return;
    }

    // Build combined user prompt
    let userPrompt = group.caption ? `${group.caption}\n\n` : '';
    userPrompt += downloadedPaths.map((p) => `[Attached user screenshot: ${p}]`).join('\n');

    // Attach reply context if present
    if (group.replyTo) {
        const replyText = group.replyTo.text || group.replyTo.caption || '';
        const senderName = group.replyTo.from?.is_bot ? 'Antigravity' : (group.replyTo.from?.first_name || 'User');
        if (replyText.trim()) {
            let quoted = replyText.trim();
            if (quoted.length > 2000) {
                quoted = quoted.slice(0, 1000) + '\n... [truncated] ...\n' + quoted.slice(-800);
            }
            userPrompt = `[In reply to ${senderName}]:\n"""\n${quoted}\n"""\n\n${userPrompt}`;
        }
    }

    const channelKey = group.channelKey;
    const workspacePath = services.resolveWorkspace(channelKey);

    // If session is busy, enqueue with the single status message
    if (services.agyService.isBusy(channelKey)) {
        const queue = services.db.getQueuedMessages(channelKey);
        const queuePos = queue.length + 1;

        if (statusMsgId) {
            await services.bot.api.editMessageText(
                group.chatId,
                statusMsgId,
                `📥 <b>Queued (#${queuePos})</b> — will run automatically when current task finishes (${total} photos attached).`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            services.db.enqueueMessage(channelKey, group.chatId, group.threadId, statusMsgId, userPrompt);
        }
        return;
    }

    // Update status to thinking and launch turn
    if (statusMsgId) {
        await services.bot.api.editMessageText(
            group.chatId,
            statusMsgId,
            `🧠 <i>Antigravity is thinking (${total} images loaded)...</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});

        services.executeTurnWithStatus(
            channelKey,
            workspacePath,
            userPrompt,
            group.chatId,
            group.threadId,
            statusMsgId
        ).catch((err) => {
            logger.error('[MediaGroup] Turn execution error:', err);
        });
    }
}
