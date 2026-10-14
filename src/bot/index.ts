import { Bot, Context } from 'grammy';
import { AppConfig } from '../utils/config';
import { DatabaseManager } from '../database/db';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { ConversationService, ConversationSummary } from '../services/conversationService';
import { AgyStreamService } from '../services/agyStreamService';
import { logger } from '../utils/logger';
import { BotServices } from './types';
import { registerBotCommands } from './commands';
import { registerBotCallbacks } from './callbacks';
import { registerMessageHandlers } from './messages';
import { executeTurnWithStatus, registerSessionRecovery } from './turnExecutor';
import { processNextQueuedTurn, restoreQueuedTurns } from './queue';

export function createBot(config: AppConfig) {
    const bot = new Bot(config.telegramBotToken);
    const db = new DatabaseManager(config.dbPath);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const topicManager = new TelegramTopicManager(bot.api);
    const convService = new ConversationService();
    const agyService = new AgyStreamService(config.idleTimeoutSeconds);

    // In-memory cache for recent conversations to support callback buttons
    const convCache = new Map<string, ConversationSummary>();

    // Whitelist Authorization Middleware
    bot.use(async (ctx, next) => {
        // Ignore messages from bots (including self) to prevent loops
        if (ctx.from?.is_bot) {
            return;
        }

        if (config.allowedUserIds.length > 0) {
            const userId = ctx.from?.id;
            if (!userId || !config.allowedUserIds.includes(userId)) {
                logger.warn(`[Auth] Blocked unauthorized message from user ${userId} (${ctx.from?.username})`);
                if (ctx.chat?.type === 'private') {
                    await ctx.reply('⛔ You are not authorized to use this bot.');
                }
                return;
            }
        }
        await next();
    });

    function getChannelKey(ctx: Context, overrideThreadId?: number): string {
        const chatId = ctx.chat?.id;
        const threadId = overrideThreadId ?? (ctx.message?.message_thread_id || (ctx.callbackQuery?.message as any)?.message_thread_id);
        return threadId ? `${chatId}:${threadId}` : `${chatId}`;
    }

    function resolveWorkspace(channelKey: string): string {
        const boundPath = db.getWorkspaceBinding(channelKey);
        if (boundPath && workspaceService.exists(boundPath)) {
            return workspaceService.getWorkspacePath(boundPath);
        }
        return workspaceService.getBaseDir();
    }

    async function createConversationTopic(ctx: Context, title: string): Promise<number | undefined> {
        if (!config.useTopics || !ctx.chat || ctx.chat.type !== 'supergroup') {
            return undefined;
        }
        try {
            return await topicManager.createConversationTopic(ctx.chat.id, title);
        } catch (err: any) {
            logger.warn(`[Bot] Could not create topic (check bot admin 'can_manage_topics' permission):`, err?.message || err);
            return undefined;
        }
    }

    const services: BotServices = {
        bot,
        config,
        db,
        workspaceService,
        topicManager,
        convService,
        agyService,
        convCache,
        getChannelKey,
        resolveWorkspace,
        createConversationTopic,
        executeTurnWithStatus: (channelKey, workspacePath, userPrompt, chatId, threadId, statusMsgId) =>
            executeTurnWithStatus(services, channelKey, workspacePath, userPrompt, chatId, threadId, statusMsgId),
        processNextQueuedTurn: (channelKey) =>
            processNextQueuedTurn(services, channelKey),
    };

    // Register modular bot features
    registerBotCommands(services);
    registerBotCallbacks(services);
    registerMessageHandlers(services);
    registerSessionRecovery(services);
    restoreQueuedTurns(services);

    return { bot, db, agyService };
}
