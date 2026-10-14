import { Bot, Context } from 'grammy';
import { AppConfig } from '../utils/config';
import { DatabaseManager } from '../database/db';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { ConversationService, ConversationSummary } from '../services/conversationService';
import { AgyStreamService } from '../services/agyStreamService';

export interface ModelOption {
    id: string;
    label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT OSS 120B' },
];

export interface BotServices {
    bot: Bot;
    config: AppConfig;
    db: DatabaseManager;
    workspaceService: WorkspaceService;
    topicManager: TelegramTopicManager;
    convService: ConversationService;
    agyService: AgyStreamService;
    convCache: Map<string, ConversationSummary>;
    getChannelKey: (ctx: Context, overrideThreadId?: number) => string;
    resolveWorkspace: (channelKey: string) => string;
    createConversationTopic: (ctx: Context, title: string) => Promise<number | undefined>;
    executeTurnWithStatus: (
        channelKey: string,
        workspacePath: string,
        userPrompt: string,
        chatId: number,
        threadId: number | undefined,
        statusMsgId: number
    ) => Promise<void>;
    processNextQueuedTurn: (channelKey: string) => Promise<void>;
}
