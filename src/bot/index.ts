import { exec, spawn, ChildProcess } from 'child_process';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { AppConfig } from '../utils/config';
import { DatabaseManager } from '../database/db';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { ConversationService, ConversationSummary, SearchResult } from '../services/conversationService';
import { AgyStreamService } from '../services/agyStreamService';
import { taskManager, RunningTask } from '../services/taskManager';
import { escapeHtml, formatForTelegram, splitTelegramHtml, describeToolAction, balanceHtmlTags, formatAccountQuota, stripAnsi } from '../utils/telegramFormatter';
import { downloadTelegramPhoto } from '../utils/imageHandler';
import { logger } from '../utils/logger';

export function createBot(config: AppConfig) {
    const bot = new Bot(config.telegramBotToken);
    const db = new DatabaseManager(config.dbPath);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const topicManager = new TelegramTopicManager(bot.api);
    const convService = new ConversationService();
    const agyService = new AgyStreamService(config.idleTimeoutSeconds);

    // Register /agy_* commands with Telegram so they appear in autocomplete menu
    bot.api.setMyCommands([
        { command: 'agy_new', description: 'Create a new topic & conversation' },
        { command: 'agy_chats', description: 'Browse and assign existing chats' },
        { command: 'agy_projects', description: 'Select a project workspace' },
        { command: 'agy_model', description: 'Switch active AI model' },
        { command: 'agy_compact', description: 'Compact conversation context' },
        { command: 'agy_usage', description: 'Show account quota and limits' },
        { command: 'agy_queue', description: 'View queued messages' },
        { command: 'agy_clear', description: 'Reset conversation in this topic' },
        { command: 'agy_kill', description: 'Kill last running command or background server' },
        { command: 'agy_stop', description: 'Stop current running task' },
        { command: 'agy_status', description: 'Show session and execution status' },
        { command: 'agy_resume', description: 'Attach a conversation UUID' },
        { command: 'agy_bind', description: 'Bind topic to a workspace folder' },
        { command: 'agy_topic', description: 'Rename current topic' },
        { command: 'agy_help', description: 'Show guide and commands' },
    ]).catch((err) => logger.warn('[Bot] Failed to set bot commands menu:', err.message));

    // In-memory cache for recent conversations to support callback buttons
    const convCache = new Map<string, ConversationSummary>();

    interface QueuedTurn {
        userPrompt: string;
        ctx: Context;
        threadId?: number;
        statusMsgId: number;
    }

    const messageQueues = new Map<string, QueuedTurn[]>();

    interface ShellProcessInfo {
        pid: number;
        child: ChildProcess;
        cmd: string;
        chatId: number;
        messageId: number;
        threadId?: number;
        workspacePath: string;
        outputBuffer: string;
    }

    const activeShellProcesses = new Map<number, ShellProcessInfo>();

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

    /**
     * Resolve the channel key (combines chatId + topicId)
     */
    function getChannelKey(ctx: Context, overrideThreadId?: number): string {
        const chatId = ctx.chat?.id;
        const threadId = overrideThreadId ?? (ctx.message?.message_thread_id || (ctx.callbackQuery?.message as any)?.message_thread_id);
        return threadId ? `${chatId}:${threadId}` : `${chatId}`;
    }

    /**
     * Resolve workspace path for current context
     */
    function resolveWorkspace(channelKey: string): string {
        const boundPath = db.getWorkspaceBinding(channelKey);
        if (boundPath && workspaceService.exists(boundPath)) {
            return workspaceService.getWorkspacePath(boundPath);
        }
        return workspaceService.getBaseDir();
    }

    /**
     * Try to create a topic in supergroup if topics are enabled
     */
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

    /**
     * Helper to render /agy_chats keyboard with pagination
     */
    function buildChatsUI(result: SearchResult, query: string): { text: string; keyboard: InlineKeyboard } {
        const keyboard = new InlineKeyboard();

        if (result.items.length === 0) {
            return {
                text: query
                    ? `No conversations found matching "<b>${escapeHtml(query)}</b>".`
                    : 'No conversations found in history.',
                keyboard,
            };
        }

        for (const item of result.items) {
            convCache.set(item.conversationId, item);
            const shortId = item.conversationId.slice(0, 8);
            const label = item.title.length > 28 ? `${item.title.slice(0, 25)}...` : item.title;
            keyboard.text(`💬 ${label}`, `assign_chat:${shortId}`).row();
        }

        // Pagination buttons if more than one page
        if (result.totalPages > 1) {
            const prevPage = Math.max(0, result.page - 1);
            const nextPage = Math.min(result.totalPages - 1, result.page + 1);
            const encQuery = encodeURIComponent(query);

            if (result.page > 0) {
                keyboard.text('◀ Prev', `chats_p:${prevPage}:${encQuery}`);
            } else {
                keyboard.text('·', 'noop');
            }

            keyboard.text(`${result.page + 1} / ${result.totalPages}`, 'noop');

            if (result.page < result.totalPages - 1) {
                keyboard.text('Next ▶', `chats_p:${nextPage}:${encQuery}`);
            } else {
                keyboard.text('·', 'noop');
            }
            keyboard.row();
        }

        const titleHeader = query
            ? `<b>Conversations matching "${escapeHtml(query)}" (${result.totalCount}):</b>`
            : `<b>Select an existing conversation to assign to a topic (${result.totalCount} total):</b>`;

        return { text: titleHeader, keyboard };
    }

    // Command: /agy_help, /help, /start, /agy_start
    bot.command(['agy_help', 'help', 'start', 'agy_start'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const currentModel = db.getModel(channelKey) || session?.selectedModel || config.defaultModel || 'Default';

        const helpText = `
<b>🤖 Antigravity CLI Mobile Remote</b>

<b>Current Workspace:</b> <code>${ws}</code>
<b>Active Conversation:</b> <code>${session?.conversationId || 'None (New)'}</code>
<b>Model:</b> <code>${escapeHtml(currentModel)}</code>

<b>Commands:</b>
• <code>/agy_new &lt;title&gt;</code> - Create a new topic & conversation
• <code>/agy_model [name]</code> - View or switch active model
• <code>/agy_compact [focus]</code> - Compact transcript & context window
• <code>/agy_clear</code> - Reset conversation in this topic
• <code>/agy_queue</code> - View & manage queued messages
• <code>/agy_chats [query]</code> - Browse past Antigravity chats with pagination/search
• <code>/agy_projects</code> - View and select project workspace (creates a topic)
• <code>/agy_resume &lt;id&gt;</code> - Attach a specific conversation ID to this topic
• <code>/agy_bind &lt;workspace&gt;</code> - Bind this topic to a workspace folder
• <code>/agy_topic &lt;name&gt;</code> - Rename current topic
• <code>/agy_usage</code> - Show account quota and limits
• <code>/agy_stop</code> - Stop current running task
• <code>/agy_status</code> - Show execution and session info
• <code>! &lt;cmd&gt;</code> - Direct shell execution (e.g. <code>! git status</code>, <code>! nr start</code>)
• <code>/agy_help</code> - Show this guide

<i>Note: Chatting in General is disabled. Every conversation must be in its own topic.</i>
        `.trim();

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Command: /agy_usage - Show overall Antigravity account quota and limits
    bot.command('agy_usage', async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const statusMsg = await ctx.reply('⏳ <i>Fetching account quota & usage...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        exec('agy --print "/usage"', {
            timeout: 15000,
            env: { ...process.env, PAGER: 'cat' },
        }, async (error, stdout, stderr) => {
            if (error && !stdout) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `❌ <b>Failed to fetch account quota:</b> ${escapeHtml(error.message)}`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            const raw = (stdout || stderr || '').trim();
            const message = formatAccountQuota(raw);

            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    message,
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                if (!err.message?.includes('message is not modified')) {
                    logger.error('[Bot] Error editing account usage message:', err);
                }
            }
        });
    });

    // Command: /usage - Show current conversation session token statistics
    bot.command('usage', async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const session = db.getSession(channelKey);

        if (!session || !session.conversationId) {
            return ctx.reply('No active conversation tracked in this topic yet. Send a prompt to begin.');
        }

        const formatNum = (n: number) => n.toLocaleString();

        const usageText = `
<b>📊 Session Token Usage</b>
• <b>Conversation:</b> <code>${session.conversationId}</code>
• <b>Total Turns:</b> ${formatNum(session.totalTurns || 1)}

<b>Latest Turn:</b>
• <b>Input:</b> ${formatNum(session.lastInputTokens)} tokens
• <b>Output:</b> ${formatNum(session.lastOutputTokens)} tokens
• <b>Thinking:</b> ${formatNum(session.lastThinkingTokens)} tokens
• <b>Cached Context:</b> ${formatNum(session.lastCacheTokens)} tokens
• <b>Turn Total:</b> ${formatNum(session.lastTotalTokens)} tokens
• <b>Execution Time:</b> ${session.lastDurationSeconds.toFixed(1)}s

<b>Session Cumulative:</b>
• <b>Total Input:</b> ${formatNum(session.totalInputTokens)} tokens
• <b>Total Output:</b> ${formatNum(session.totalOutputTokens)} tokens
        `.trim();

        await ctx.reply(usageText, { parse_mode: 'HTML' });
    });

    const AVAILABLE_MODELS = [
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
        { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
        { id: 'gpt-oss-120b-medium', label: 'GPT OSS 120B' },
    ];

    // Command: /agy_model, /model [name]
    bot.command(['agy_model', 'model'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const targetModel = ctx.match?.trim();

        if (targetModel) {
            db.setModel(channelKey, targetModel);
            return ctx.reply(
                `✅ <b>Model set to:</b> <code>${escapeHtml(targetModel)}</code>\n\nSubsequent prompts in this topic will run on this model.`,
                { parse_mode: 'HTML' }
            );
        }

        const currentModel = db.getModel(channelKey) || config.defaultModel || 'gemini-3.8-flash-high';
        const keyboard = new InlineKeyboard();

        for (const m of AVAILABLE_MODELS) {
            const isSelected = m.id === currentModel;
            const prefix = isSelected ? '✓ ' : '';
            keyboard.text(`${prefix}${m.label}`, `set_model:${m.id}`).row();
        }

        await ctx.reply(
            `🤖 <b>Model Selection</b>\n\n` +
            `Current model for this topic:\n<code>${escapeHtml(currentModel)}</code>\n\n` +
            `Choose a model below or type <code>/model &lt;name&gt;</code>:`,
            {
                parse_mode: 'HTML',
                reply_markup: keyboard,
                message_thread_id: ctx.message?.message_thread_id,
            }
        );
    });

    // Handle model picker callback
    bot.callbackQuery(/^set_model:(.+)$/, async (ctx) => {
        const selectedModel = ctx.match[1];
        const channelKey = getChannelKey(ctx);
        db.setModel(channelKey, selectedModel);

        await ctx.answerCallbackQuery({ text: `Model set to ${selectedModel}` });
        await ctx.editMessageText(
            `✅ <b>Active model updated!</b>\n\nTopic model: <code>${escapeHtml(selectedModel)}</code>\nSubsequent prompts will use this model.`,
            { parse_mode: 'HTML' }
        );
    });

    // Command: /agy_compact, /compact [focus]
    bot.command(['agy_compact', 'compact'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (ctx.chat?.type === 'supergroup' && isGeneral) {
            return ctx.reply('⚠️ Please run /compact inside a specific conversation topic.');
        }

        const channelKey = getChannelKey(ctx);
        const session = db.getSession(channelKey);
        if (!session || !session.conversationId) {
            return ctx.reply('⚠️ No active conversation in this topic to compact. Send a prompt to start one.');
        }

        if (agyService.isBusy(channelKey)) {
            return ctx.reply('⏳ Antigravity is busy running another task. Wait for it to finish or send /agy_stop.');
        }

        const focus = ctx.match?.trim();
        const compactPrompt = focus ? `/compact ${focus}` : '/compact';
        const workspacePath = resolveWorkspace(channelKey);

        const statusMsg = await ctx.reply('🗜️ <i>Compacting conversation transcript & context...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        executeTurnWithStatus(
            channelKey,
            workspacePath,
            compactPrompt,
            ctx.chat!.id,
            threadId,
            statusMsg.message_id
        ).catch((err) => {
            logger.error('[Bot] Compact error:', err);
        });
    });

    // Command: /agy_clear, /agy_reset, /clear, /reset
    bot.command(['agy_clear', 'agy_reset', 'clear', 'reset'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        agyService.stopSession(channelKey);
        messageQueues.delete(channelKey);
        db.deleteSession(channelKey);

        await ctx.reply(
            '🧹 <b>Conversation Reset</b>\n\n' +
            'Cleared active conversation in this topic. Your workspace binding is kept.\n' +
            'Next message will start a fresh session.',
            { parse_mode: 'HTML' }
        );
    });

    // Command: /agy_queue, /queue
    bot.command(['agy_queue', 'queue'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const queue = db.getQueuedMessages(channelKey);
        const isRunning = agyService.isBusy(channelKey);

        if (queue.length === 0) {
            return ctx.reply(
                `📭 <b>Message Queue is Empty</b>\nActive task: ${isRunning ? '⚙️ Running' : '💤 Idle'}`,
                { parse_mode: 'HTML' }
            );
        }

        let queueList = `📬 <b>Queued Messages (${queue.length}):</b>\n\n`;
        queue.forEach((item, idx) => {
            const preview = item.prompt.length > 50 ? `${item.prompt.slice(0, 47)}...` : item.prompt;
            queueList += `${idx + 1}. <code>${escapeHtml(preview)}</code>\n`;
        });

        const keyboard = new InlineKeyboard().text('🗑️ Clear Queue', 'clear_queue');
        await ctx.reply(queueList, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    });

    bot.callbackQuery('clear_queue', async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const count = db.clearQueue(channelKey);

        await ctx.answerCallbackQuery({ text: `Cleared ${count} queued message(s)` });
        await ctx.editMessageText(`🗑️ <b>Cleared ${count} queued message(s).</b>`, { parse_mode: 'HTML' });
    });

    // Command: /agy_status, /status
    bot.command(['agy_status', 'status'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const currentModel = db.getModel(channelKey) || session?.selectedModel || config.defaultModel || 'Default';
        const isRunning = agyService.isBusy(channelKey);
        const queue = db.getQueuedMessages(channelKey);
        const queueLine = queue.length > 0 ? `\n• <b>Queue:</b> ${queue.length} message(s) waiting` : '';

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        let taskSection = '';
        if (runningTasks.length > 0) {
            taskSection = '\n\n<b>Active Background Servers / Tasks:</b>\n' +
                runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
        }

        const statusMsg = `
<b>📊 Session Status</b>
• <b>Workspace:</b> <code>${ws}</code>
• <b>Model:</b> <code>${escapeHtml(currentModel)}</code>
• <b>Conversation:</b> <code>${session?.conversationId || 'Fresh'}</code>
• <b>Status:</b> ${isRunning ? '⚙️ Running task' : '💤 Idle (warm process)'}${queueLine}${taskSection}
        `.trim();

        const keyboard = new InlineKeyboard();
        for (const t of runningTasks) {
            keyboard.text(`🛑 Stop ${t.name.split(' ')[0]} (${t.pid})`, `kill_proc:${t.pid}`).row();
        }

        await ctx.reply(statusMsg, {
            parse_mode: 'HTML',
            reply_markup: runningTasks.length > 0 ? keyboard : undefined,
        });
    });

    // Command: /agy_kill, /kill [pid] - Cancel/kill last running command or background server
    bot.command(['agy_kill', 'kill'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const targetArg = ctx.match?.trim();

        if (targetArg && /^\d+$/.test(targetArg)) {
            const pid = parseInt(targetArg, 10);
            const killed = taskManager.killProcess(pid);
            return ctx.reply(
                killed ? `🛑 Sent kill signal to PID <code>${pid}</code>.` : `PID <code>${pid}</code> not found or already exited.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
        }

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        const wasAgyBusy = agyService.isBusy(channelKey);
        if (wasAgyBusy) {
            agyService.stopSession(channelKey);
        }

        if (runningTasks.length === 0 && !wasAgyBusy) {
            return ctx.reply('No active commands or background servers running in this topic.', {
                message_thread_id: threadId,
            });
        }

        const killedNames: string[] = [];
        for (const task of runningTasks) {
            taskManager.killProcess(task.pid);
            killedNames.push(`${task.name} (PID ${task.pid})`);
        }

        const agyNote = wasAgyBusy ? '• Stopped active Antigravity task\n' : '';
        const taskNote = killedNames.length > 0 ? killedNames.map((k) => `• Stopped ${k}`).join('\n') : '';

        await ctx.reply(`🛑 <b>Cancelled:</b>\n${agyNote}${taskNote}`, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });
    });

    // Command: /agy_stop, /stop - Stop running agy turn, clear queue, and stop background processes
    bot.command(['agy_stop', 'stop'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const stoppedAgy = agyService.stopSession(channelKey);
        const queueCount = db.clearQueue(channelKey);

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        for (const task of runningTasks) {
            taskManager.killProcess(task.pid);
        }

        const parts: string[] = [];
        if (stoppedAgy) parts.push('active Antigravity task');
        if (runningTasks.length > 0) parts.push(`${runningTasks.length} background process(es) [${runningTasks.map(t => t.name).join(', ')}]`);
        if (queueCount > 0) parts.push(`${queueCount} queued message(s)`);

        if (parts.length > 0) {
            await ctx.reply(`🛑 <b>Stopped:</b> ${escapeHtml(parts.join(', '))}.`, {
                parse_mode: 'HTML',
                message_thread_id: threadId,
            });
        } else {
            await ctx.reply('No active task or background server running in this topic.', {
                message_thread_id: threadId,
            });
        }
    });

    // Command: /agy_new, /new [title] - Create a new topic & conversation
    bot.command(['agy_new', 'new'], async (ctx) => {
        const rawTitle = ctx.match?.trim();
        const title = rawTitle || `Chat ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const currentChannelKey = getChannelKey(ctx);
        const currentWorkspace = resolveWorkspace(currentChannelKey);

        agyService.stopSession(currentChannelKey);

        const newTopicId = await createConversationTopic(ctx, title);

        if (newTopicId && ctx.chat) {
            const newChannelKey = `${ctx.chat.id}:${newTopicId}`;

            const boundWs = db.getWorkspaceBinding(currentChannelKey);
            if (boundWs) {
                db.bindWorkspace(newChannelKey, boundWs, newTopicId);
            }

            await ctx.reply(`👉 Created conversation topic: <b>${escapeHtml(title)}</b>`, {
                parse_mode: 'HTML',
            });

            await ctx.api.sendMessage(
                ctx.chat.id,
                `✨ <b>New Conversation</b>\n📁 <b>Workspace:</b> <code>${currentWorkspace}</code>\n\nSend a message here to start chatting!`,
                { parse_mode: 'HTML', message_thread_id: newTopicId }
            );
        } else {
            db.deleteSession(currentChannelKey);
            await ctx.reply('✨ Started a fresh conversation. Next message will create a new session.');
        }
    });

    // Command: /agy_projects, /agy_project, /projects, /project
    bot.command(['agy_projects', 'agy_project', 'projects', 'project'], async (ctx) => {
        const workspaces = workspaceService.scanWorkspaces();
        if (workspaces.length === 0) {
            return ctx.reply(`No subdirectories found in <code>${workspaceService.getBaseDir()}</code>`, {
                parse_mode: 'HTML',
            });
        }

        const keyboard = new InlineKeyboard();
        for (let i = 0; i < workspaces.length; i++) {
            const ws = workspaces[i];
            keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
            if (i % 2 === 1) keyboard.row();
        }

        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_chats, /chats [query] - List recent Antigravity conversations with pagination
    bot.command(['agy_chats', 'chats'], async (ctx) => {
        const query = ctx.match?.trim() || '';
        const searchResult = convService.search(query, 0, 5);
        const { text, keyboard } = buildChatsUI(searchResult, query);

        await ctx.reply(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Handle pagination callback for /chats
    bot.callbackQuery(/^chats_p:(\d+):(.*)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        const query = decodeURIComponent(ctx.match[2] || '');
        const searchResult = convService.search(query, page, 5);
        const { text, keyboard } = buildChatsUI(searchResult, query);

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_resume, /resume <conversation_id>
    bot.command(['agy_resume', 'resume'], async (ctx) => {
        const convId = ctx.match?.trim();
        if (!convId) {
            return ctx.reply('Usage: <code>/agy_resume &lt;conversation-uuid&gt;</code>', { parse_mode: 'HTML' });
        }

        const threadId = ctx.message?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (ctx.chat?.type === 'supergroup' && isGeneral) {
            const summary = convService.getSummary(convId);
            const title = summary?.title || `Resume ${convId.slice(0, 8)}`;
            const wsPath = summary?.workspacePath || workspaceService.getBaseDir();

            const newTopicId = await createConversationTopic(ctx, title);
            if (newTopicId && ctx.chat) {
                const newKey = `${ctx.chat.id}:${newTopicId}`;
                db.saveSession(newKey, wsPath, convId, newTopicId);

                await ctx.reply(`👉 Assigned chat to new topic: <b>${escapeHtml(title)}</b>`, { parse_mode: 'HTML' });
                await ctx.api.sendMessage(
                    ctx.chat.id,
                    `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(title)}</i>\n<code>${convId}</code>\n<b>Workspace:</b> <code>${wsPath}</code>\n\nSend a message here to resume!`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
                return;
            }
        }

        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        db.saveSession(channelKey, ws, convId, threadId);
        await ctx.reply(`✅ Linked this topic to conversation <code>${convId}</code>. Send a prompt to continue.`, {
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_bind, /bind <workspace>
    bot.command(['agy_bind', 'bind'], async (ctx) => {
        const wsName = ctx.match?.trim();
        if (!wsName) {
            return ctx.reply('Usage: <code>/agy_bind &lt;workspace_folder&gt;</code>', { parse_mode: 'HTML' });
        }

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            const channelKey = getChannelKey(ctx);
            const threadId = ctx.message?.message_thread_id;

            db.bindWorkspace(channelKey, wsName, threadId);
            await ctx.reply(`✅ Bound this topic to workspace: <b>${escapeHtml(wsName)}</b>\n<code>${fullPath}</code>`, {
                parse_mode: 'HTML',
            });
        } catch (err: any) {
            await ctx.reply(`❌ Error binding workspace: ${err.message}`);
        }
    });

    // Command: /agy_topic, /topic <new title>
    bot.command(['agy_topic', 'topic'], async (ctx) => {
        const newTitle = ctx.match?.trim();
        const threadId = ctx.message?.message_thread_id;
        if (!newTitle || !threadId || threadId === 1 || !ctx.chat) {
            return ctx.reply('Usage: <code>/agy_topic &lt;new title&gt;</code> inside a topic.', { parse_mode: 'HTML' });
        }

        await topicManager.renameTopic(ctx.chat.id, threadId, newTitle);
        await ctx.reply(`✅ Renamed topic to: <b>${escapeHtml(newTitle)}</b>`, { parse_mode: 'HTML' });
    });

    // Handle project selection callback
    bot.callbackQuery(/^select_ws:(.+)$/, async (ctx) => {
        const wsName = ctx.match[1];
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            let newTopicId: number | undefined;

            if (config.useTopics && ctx.chat?.type === 'supergroup') {
                try {
                    newTopicId = await topicManager.createProjectTopic(chatId, wsName);
                } catch (err: any) {
                    logger.warn(`[ProjectSelect] Could not create topic for ${wsName}:`, err?.message || err);
                }
            }

            if (newTopicId) {
                const newChannelKey = `${chatId}:${newTopicId}`;
                db.bindWorkspace(newChannelKey, wsName, newTopicId);

                await ctx.answerCallbackQuery({ text: `Created topic 📁 ${wsName}` });
                await ctx.editMessageText(
                    `✅ Created topic: <b>📁 ${escapeHtml(wsName)}</b>\nPath: <code>${fullPath}</code>`,
                    { parse_mode: 'HTML' }
                );

                await ctx.api.sendMessage(
                    chatId,
                    `📁 <b>Workspace: ${escapeHtml(wsName)}</b>\n<code>${fullPath}</code>\n\nSend messages here to interact with this project.`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
            } else {
                const channelKey = getChannelKey(ctx);
                db.bindWorkspace(channelKey, wsName);
                db.deleteSession(channelKey);

                await ctx.answerCallbackQuery({ text: `Switched to ${wsName}` });
                await ctx.editMessageText(
                    `✅ Switched to workspace: <b>${wsName}</b>\nPath: <code>${fullPath}</code>\n\nStarted a fresh conversation. Send a message to begin.`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (err: any) {
            await ctx.answerCallbackQuery({ text: 'Error switching workspace' });
            await ctx.reply(`Failed to switch: ${err.message}`);
        }
    });

    // Handle assign existing chat callback
    bot.callbackQuery(/^assign_chat:(.+)$/, async (ctx) => {
        const shortId = ctx.match[1];
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        let match: ConversationSummary | undefined;
        for (const [id, summary] of convCache.entries()) {
            if (id.startsWith(shortId)) {
                match = summary;
                break;
            }
        }

        if (!match) {
            const searchRes = convService.search('', 0, 20);
            match = searchRes.items.find((r) => r.conversationId.startsWith(shortId));
        }

        if (!match) {
            await ctx.answerCallbackQuery({ text: 'Conversation not found' });
            return;
        }

        const threadId = (ctx.callbackQuery.message as any)?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (config.useTopics && ctx.chat?.type === 'supergroup' && isGeneral) {
            try {
                const topicTitle = match.title || `Chat ${shortId}`;
                const newTopicId = await topicManager.createConversationTopic(chatId, topicTitle);
                const newKey = `${chatId}:${newTopicId}`;

                const wsPath = match.workspacePath || workspaceService.getBaseDir();
                db.saveSession(newKey, wsPath, match.conversationId, newTopicId);

                await ctx.answerCallbackQuery({ text: `Created topic for ${match.title}` });
                await ctx.editMessageText(
                    `✅ Assigned conversation <b>${escapeHtml(match.title)}</b> to new topic: <b>💬 ${escapeHtml(topicTitle)}</b>`,
                    { parse_mode: 'HTML' }
                );

                await ctx.api.sendMessage(
                    chatId,
                    `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(match.title)}</i>\n<code>${match.conversationId}</code>\n📁 <b>Workspace:</b> <code>${wsPath}</code>\n\nSend a prompt here to continue where you left off!`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
            } catch (err: any) {
                await ctx.answerCallbackQuery({ text: 'Error creating topic' });
                await ctx.reply(`Failed to create topic: ${err.message}`);
            }
        } else {
            const channelKey = getChannelKey(ctx);
            const wsPath = match.workspacePath || resolveWorkspace(channelKey);
            db.saveSession(channelKey, wsPath, match.conversationId, threadId);

            await ctx.answerCallbackQuery({ text: `Attached ${match.title}` });
            await ctx.editMessageText(
                `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(match.title)}</i>\n<code>${match.conversationId}</code>\n📁 <b>Workspace:</b> <code>${wsPath}</code>\n\nReady to chat!`,
                { parse_mode: 'HTML' }
            );
        }
    });

    // Handle noop callbacks
    bot.callbackQuery('noop', async (ctx) => {
        await ctx.answerCallbackQuery();
    });

    // General button callbacks
    bot.callbackQuery('cmd_projects', async (ctx) => {
        await ctx.answerCallbackQuery();
        const workspaces = workspaceService.scanWorkspaces();
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < workspaces.length; i++) {
            const ws = workspaces[i];
            keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
            if (i % 2 === 1) keyboard.row();
        }
        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    bot.callbackQuery('cmd_chats', async (ctx) => {
        await ctx.answerCallbackQuery();
        const searchResult = convService.search('', 0, 5);
        const { text, keyboard } = buildChatsUI(searchResult, '');
        await ctx.reply(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Callback to stop a running background shell process or daemon
    bot.callbackQuery(/^kill_proc:(\d+)$/, async (ctx) => {
        const pid = parseInt(ctx.match[1], 10);
        const killed = taskManager.killProcess(pid);

        await ctx.answerCallbackQuery({ text: `Process PID ${pid} stopped` });
        try {
            await ctx.editMessageText(
                `🛑 <b>Stopped process:</b> PID <code>${pid}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch {}
    });

    async function handleIncomingMessage(ctx: Context): Promise<void> {
        const threadId = ctx.message?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        // RULE 1: No chatting directly in General chat
        if (ctx.chat?.type === 'supergroup' && isGeneral) {
            const keyboard = new InlineKeyboard()
                .text('📁 Browse Projects', 'cmd_projects')
                .text('📜 Existing Chats', 'cmd_chats');

            await ctx.reply(
                '⚠️ <b>Chatting in General is disabled.</b>\n\n' +
                'Every conversation must have its own topic:\n' +
                '• <code>/agy_new &lt;title&gt;</code> - Create a new topic & chat\n' +
                '• <code>/agy_projects</code> - Pick a project workspace\n' +
                '• <code>/agy_chats</code> - Assign an existing chat to a topic',
                { parse_mode: 'HTML', reply_markup: keyboard }
            );
            return;
        }

        const rawText = ctx.message?.text || ctx.message?.caption || '';

        if (!rawText && (!ctx.message?.photo || ctx.message.photo.length === 0)) {
            return;
        }

        const ANTIGRAVITY_SLASH_COMMANDS = new Set([
            'plan',
            'goal',
            'learn',
            'grill-me',
            'boost',
            'browser',
            'schedule',
            'teamwork-preview',
            'compact',
            'caveman',
            'ponytail',
            'review',
            'audit',
            'help',
        ]);

        // RULE 2: Catch unrecognized slash commands so they don't get sent to Antigravity CLI as heavy prompts!
        if (rawText.startsWith('/')) {
            const cmdMatch = rawText.match(/^\/([a-zA-Z0-9_-]+)/);
            const cmdName = cmdMatch ? cmdMatch[1].toLowerCase() : '';

            if (!ANTIGRAVITY_SLASH_COMMANDS.has(cmdName)) {
                const cmd = rawText.split(/[\s@]/)[0];
                await ctx.reply(
                    `❓ Unknown command: <code>${escapeHtml(cmd)}</code>\n\nUse /agy_help to see all available commands.`,
                    { parse_mode: 'HTML', message_thread_id: threadId }
                );
                return;
            }
        }

        // Direct shell execution: ! <command> (e.g. ! echo hello, ! git status, ! nr start)
        if (rawText.startsWith('!')) {
            const shellCmd = rawText.slice(1).trim();
            if (!shellCmd) {
                await ctx.reply(
                    '⚡ <b>Direct Shell Execution</b>\n\n' +
                    'Usage: <code>! &lt;command&gt;</code>\n' +
                    'Example: <code>! git status</code>, <code>! nr start</code>\n' +
                    'Cancel: <code>! kill</code> or <code>/kill</code>',
                    { parse_mode: 'HTML', message_thread_id: threadId }
                );
                return;
            }

            const channelKey = getChannelKey(ctx);
            const workspacePath = resolveWorkspace(channelKey);

            if (shellCmd === 'kill' || shellCmd === 'stop') {
                const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
                const wasAgyBusy = agyService.isBusy(channelKey);
                if (wasAgyBusy) agyService.stopSession(channelKey);
                for (const t of runningTasks) {
                    taskManager.killProcess(t.pid);
                }
                const msg = runningTasks.length > 0 || wasAgyBusy
                    ? `🛑 <b>Cancelled:</b>\n${runningTasks.map((t) => `• Stopped ${t.name} (PID ${t.pid})`).join('\n')}`
                    : 'No active command or background server running in this topic.';
                await ctx.reply(msg, { parse_mode: 'HTML', message_thread_id: threadId });
                return;
            }

            let outputBuffer = '';
            let hasExited = false;
            let exitCode: number | null = null;
            let exitSignal: string | null = null;

            const child = spawn(process.env.SHELL || '/bin/zsh', ['-c', shellCmd], {
                cwd: workspacePath,
                detached: true,
                env: { ...process.env, PAGER: 'cat' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const pid = child.pid;
            const stopKeyboard = pid
                ? new InlineKeyboard().text(`🛑 Stop (PID ${pid})`, `kill_proc:${pid}`)
                : undefined;

            const statusMsg = await ctx.reply(
                `⚡ <code>$ ${escapeHtml(shellCmd)}</code>\n<i>Running${pid ? ` · PID ${pid}` : ''}...</i>`,
                { parse_mode: 'HTML', reply_markup: stopKeyboard, message_thread_id: threadId }
            );

            if (pid) {
                taskManager.registerProcess(pid, child, shellCmd, channelKey, workspacePath, ctx.chat!.id, statusMsg.message_id, threadId);
            }

            const onData = (chunk: Buffer) => {
                const str = chunk.toString('utf-8');
                outputBuffer += str;
                if (pid) taskManager.appendOutput(pid, str);
                if (outputBuffer.length > 500000) {
                    outputBuffer = outputBuffer.slice(-250000);
                }
            };

            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);

            let runningTimer: NodeJS.Timeout | null = null;

            const formatShellMessage = (bodyText: string, statusTag: string): string => {
                let clean = stripAnsi(bodyText).trim();
                if (!clean) clean = '(no output)';
                if (clean.length > 8000) {
                    clean = clean.slice(0, 4000) + '\n\n... [output truncated, ' + clean.length + ' chars total] ...\n\n' + clean.slice(-3000);
                }
                return `⚡ <b>$ ${escapeHtml(shellCmd)}</b>${statusTag}\n<pre><code>${escapeHtml(clean)}</code></pre>`;
            };

            // Periodically refresh running output if still active after 2.5s
            runningTimer = setInterval(async () => {
                if (hasExited || !pid) return;

                const statusTag = ` [Running · PID ${pid}]`;
                const msgText = formatShellMessage(outputBuffer || '(process running in background...)', statusTag);
                const chunks = splitTelegramHtml(msgText);

                try {
                    await ctx.api.editMessageText(
                        ctx.chat!.id,
                        statusMsg.message_id,
                        chunks[0],
                        { parse_mode: 'HTML', reply_markup: stopKeyboard }
                    );
                } catch (err: any) {
                    logger.debug('[Shell] Failed to edit background status:', err.message);
                }
            }, 3000);

            child.on('close', async (code, signal) => {
                hasExited = true;
                exitCode = code;
                exitSignal = signal;
                if (runningTimer) clearInterval(runningTimer);
                if (pid) taskManager.unregisterProcess(pid);

                const statusTag = exitCode === 0
                    ? ''
                    : ` [exit ${exitCode !== null ? exitCode : exitSignal || 1}]`;

                const fullMsg = formatShellMessage(outputBuffer, statusTag);
                const chunks = splitTelegramHtml(fullMsg);

                try {
                    await ctx.api.editMessageText(
                        ctx.chat!.id,
                        statusMsg.message_id,
                        chunks[0],
                        { parse_mode: 'HTML' }
                    );

                    for (let i = 1; i < chunks.length; i++) {
                        await ctx.reply(chunks[i], {
                            parse_mode: 'HTML',
                            message_thread_id: threadId,
                        });
                    }
                } catch (editErr: any) {
                    logger.error('[Bot] Failed to finalize shell output:', editErr);
                }
            });

            child.on('error', async (err) => {
                hasExited = true;
                if (runningTimer) clearTimeout(runningTimer);
                if (pid) taskManager.unregisterProcess(pid);

                try {
                    await ctx.api.editMessageText(
                        ctx.chat!.id,
                        statusMsg.message_id,
                        `⚡ <b>$ ${escapeHtml(shellCmd)}</b> [Failed to spawn]\n<pre><code>${escapeHtml(err.message)}</code></pre>`,
                        { parse_mode: 'HTML' }
                    );
                } catch {}
            });

            return;
        }

        let userPrompt = rawText;

        // If photo attached, download it and append path to prompt
        if (ctx.message?.photo && ctx.message.photo.length > 0) {
            const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
            try {
                const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
                userPrompt = `${userPrompt}\n[Attached user screenshot: ${localPath}]`.trim();
            } catch (err: any) {
                logger.error('[Bot] Failed to download photo:', err);
                await ctx.reply('⚠️ Warning: Failed to download attached image.');
            }
        }

        // Context from replied-to message (if user used Telegram reply)
        const replyTo = ctx.message?.reply_to_message;
        if (replyTo) {
            const replyText = replyTo.text || replyTo.caption || '';
            const isBot = replyTo.from?.is_bot;
            const senderName = isBot ? 'Antigravity' : (replyTo.from?.first_name || 'User');

            // If replied message had a photo and current message didn't, download it
            if (replyTo.photo && replyTo.photo.length > 0 && (!ctx.message?.photo || ctx.message.photo.length === 0)) {
                const largestPhoto = replyTo.photo[replyTo.photo.length - 1];
                try {
                    const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
                    userPrompt = `${userPrompt}\n[Attached screenshot from replied message: ${localPath}]`.trim();
                } catch (err: any) {
                    logger.debug('[Bot] Could not download photo from replied message:', err);
                }
            }

            if (replyText.trim()) {
                let quoted = replyText.trim();
                if (quoted.length > 2000) {
                    quoted = quoted.slice(0, 1000) + '\n... [truncated] ...\n' + quoted.slice(-800);
                }
                userPrompt = `[In reply to ${senderName}]:\n"""\n${quoted}\n"""\n\n${userPrompt}`;
            }
        }

        if (!userPrompt.trim()) {
            return;
        }

        const channelKey = getChannelKey(ctx);

        if (agyService.isBusy(channelKey)) {
            const queue = db.getQueuedMessages(channelKey);
            const queuePos = queue.length + 1;
            const queuedMsg = await ctx.reply(
                `📥 <b>Queued (#${queuePos})</b> — will run automatically when current task finishes.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            db.enqueueMessage(channelKey, ctx.chat!.id, threadId, queuedMsg.message_id, userPrompt);
            return;
        }

        const workspacePath = resolveWorkspace(channelKey);

        const initialStatus = await ctx.reply('🧠 <i>Antigravity is thinking...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        executeTurnWithStatus(
            channelKey,
            workspacePath,
            userPrompt,
            ctx.chat!.id,
            threadId,
            initialStatus.message_id
        ).catch((err) => {
            logger.error('[Bot] Execution error:', err);
        });
    }

    async function processNextQueuedTurn(channelKey: string): Promise<void> {
        const next = db.popNextQueuedMessage(channelKey);
        if (!next) return;

        const workspacePath = resolveWorkspace(channelKey);

        try {
            await bot.api.editMessageText(
                next.chatId,
                next.statusMsgId,
                '🧠 <i>Antigravity is thinking...</i>',
                { parse_mode: 'HTML' }
            );
        } catch {}

        executeTurnWithStatus(
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

    async function executeTurnWithStatus(
        channelKey: string,
        workspacePath: string,
        userPrompt: string,
        chatId: number,
        threadId: number | undefined,
        statusMsgId: number
    ): Promise<void> {
        agyService.setTelegramStatus(channelKey, statusMsgId, chatId, threadId);

        let lastEditTime = Date.now();
        let lastRenderedText = '';
        let activeToolInfo: { name: string; params: any } | null = null;
        const recentCompletedActions: string[] = [];

        const updateTelegramStatus = async (force: boolean = false) => {
            const now = Date.now();
            if (!force && now - lastEditTime < 1500) {
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
            let stopKeyboard: InlineKeyboard | undefined;
            if (runningTasks.length > 0) {
                const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
                displayText += `\n\n<b>Active Background:</b>\n${taskBadges}`;
                stopKeyboard = new InlineKeyboard();
                for (const t of runningTasks) {
                    stopKeyboard.text(`🛑 Stop ${t.name.split(' ')[0]} (${t.pid})`, `kill_proc:${t.pid}`).row();
                }
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
                if (!err.message?.includes('message is not modified')) {
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
                onInit: (convId) => {
                    db.saveSession(channelKey, workspacePath, convId, threadId);
                },
                onDelta: (_delta, fullText) => {
                    lastRenderedText = fullText;
                    updateTelegramStatus(false);
                },
                onToolCall: (toolName, params) => {
                    activeToolInfo = { name: toolName, params };
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

            if (userPrompt.trim().startsWith('/compact')) {
                formatted = '🗜️ <b>Conversation compacted.</b> Context window has been summarized and freed.';
            } else if (!rawResponse) {
                formatted = '✓ <i>Done.</i>';
            } else {
                formatted = formatForTelegram(rawResponse);
            }

            const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
            let stopKeyboard: InlineKeyboard | undefined;
            if (runningTasks.length > 0) {
                const taskBadges = runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
                formatted += `\n\n<b>Active Background:</b>\n${taskBadges}`;
                stopKeyboard = new InlineKeyboard();
                for (const t of runningTasks) {
                    stopKeyboard.text(`🛑 Stop ${t.name.split(' ')[0]} (${t.pid})`, `kill_proc:${t.pid}`).row();
                }
            }

            const chunks = splitTelegramHtml(formatted);

            // Edit the initial message with the first chunk
            try {
                await bot.api.editMessageText(
                    chatId,
                    statusMsgId,
                    chunks[0],
                    { parse_mode: 'HTML', reply_markup: stopKeyboard }
                );
            } catch (editErr: any) {
                if (editErr.message?.includes('message is not modified')) {
                    // Harmless no-op
                } else if (editErr.message?.includes("can't parse entities")) {
                    logger.warn('[Bot] HTML parse failed on editMessageText, falling back to plain text');
                    await bot.api.editMessageText(
                        chatId,
                        statusMsgId,
                        chunks[0].replace(/<[^>]+>/g, '').slice(0, 4000),
                        { reply_markup: stopKeyboard }
                    );
                } else {
                    throw editErr;
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
                        await bot.api.sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, '').slice(0, 4000), {
                            message_thread_id: threadId,
                        });
                    } else {
                        logger.error('[Bot] Failed to send chunk reply:', replyErr);
                    }
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
            } catch (fallbackErr: any) {
                if (!fallbackErr.message?.includes('message is not modified')) {
                    logger.error('[Bot] Failed to render error message:', fallbackErr);
                }
            }
        } finally {
            processNextQueuedTurn(channelKey);
        }
    }

    // Handle incoming messages (Text and Photos) concurrently without blocking other topics
    bot.on(['message:text', 'message:photo'], (ctx) => {
        handleIncomingMessage(ctx).catch((err) => {
            logger.error('[Bot] Unhandled error in concurrent message handler:', err);
        });
    });

    // Recover any in-flight turns from before PM2 restart
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

    // Process any queued turns that were preserved in SQLite across bot restart
    setTimeout(() => {
        try {
            const channels = db.getDistinctQueuedChannels();
            for (const ch of channels) {
                if (!agyService.isBusy(ch)) {
                    processNextQueuedTurn(ch).catch((err) => {
                        logger.error(`[Bot] Error processing restored queue for ${ch}:`, err);
                    });
                }
            }
        } catch (err: any) {
            logger.warn('[Bot] Failed to check restored message queues:', err.message);
        }
    }, 1500);

    return { bot, db, agyService };
}
