import { BotServices } from './types';
import { buildChatsUI, buildProjectsUI } from './keyboards';
import { escapeHtml, formatHumanDate } from '../utils/telegramFormatter';

export function registerWorkspaceCommands(services: BotServices): void {
    const { bot, db, workspaceService, topicManager, convService, agyService } = services;

    // Command: /agy_new, /new [title] - Create a new topic & conversation
    bot.command(['agy_new', 'new'], async (ctx) => {
        const rawTitle = ctx.match?.trim();
        const title = rawTitle || `Chat ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const currentChannelKey = services.getChannelKey(ctx);
        const currentWorkspace = services.resolveWorkspace(currentChannelKey);

        agyService.stopSession(currentChannelKey);

        const newTopicId = await services.createConversationTopic(ctx, title);

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

        const keyboard = buildProjectsUI(workspaces);

        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_chats, /chats [query] - List recent Antigravity conversations with pagination
    bot.command(['agy_chats', 'chats'], async (ctx) => {
        const query = ctx.match?.trim() || '';
        const searchResult = convService.search(query, 0, 5);
        const { text, keyboard } = buildChatsUI(services.convCache, searchResult, query);

        await ctx.reply(text, {
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

            const newTopicId = await services.createConversationTopic(ctx, title);
            if (newTopicId && ctx.chat) {
                const newKey = `${ctx.chat.id}:${newTopicId}`;
                db.saveSession(newKey, wsPath, convId, newTopicId);

                await ctx.reply(`👉 Assigned chat to new topic: <b>${escapeHtml(title)}</b>`, { parse_mode: 'HTML' });
                const timeInfo = summary?.lastModified ? `\n• <b>Last Active:</b> ${formatHumanDate(summary.lastModified)}` : '';
                await ctx.api.sendMessage(
                    ctx.chat.id,
                    `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(title)}</i>\n<code>${convId}</code>\n<b>Workspace:</b> <code>${wsPath}</code>${timeInfo}\n\nSend a message here to resume!`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
                return;
            }
        }

        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        db.saveSession(channelKey, ws, convId, threadId);
        const summary = convService.getSummary(convId);
        const timeInfo = summary?.lastModified ? ` (last active: ${formatHumanDate(summary.lastModified)})` : '';
        await ctx.reply(`✅ Linked this topic to conversation <code>${convId}</code>${timeInfo}. Send a prompt to continue.`, {
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_bind, /bind, /cd, /workspace <folder>
    bot.command(['agy_bind', 'bind', 'cd', 'workspace'], async (ctx) => {
        const wsName = ctx.match?.trim();
        if (!wsName) {
            return ctx.reply('Usage: <code>/bind &lt;workspace_folder_or_path&gt;</code>', { parse_mode: 'HTML' });
        }

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            const channelKey = services.getChannelKey(ctx);
            const threadId = ctx.message?.message_thread_id;

            db.bindWorkspace(channelKey, fullPath, threadId);
            await ctx.reply(`✅ Bound this topic to workspace:\n<code>${escapeHtml(fullPath)}</code>`, {
                parse_mode: 'HTML',
            });
        } catch (err: any) {
            await ctx.reply(`❌ Error binding workspace: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
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
}
