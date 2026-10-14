import { Api } from 'grammy';
import { logger } from '../utils/logger';

export interface EnsureTopicResult {
    topicId: number;
    created: boolean;
}

export class TelegramTopicManager {
    private readonly api: Api;
    private readonly chatId: number | string;
    private topicCache: Map<string, number> = new Map();

    constructor(api: Api, chatId: number | string) {
        this.api = api;
        this.chatId = chatId;
    }

    public async ensureTopic(workspaceName: string): Promise<EnsureTopicResult> {
        const cached = this.topicCache.get(workspaceName);
        if (cached) return { topicId: cached, created: false };

        try {
            const topic = await this.api.createForumTopic(this.chatId, `📁 ${workspaceName}`);
            this.topicCache.set(workspaceName, topic.message_thread_id);
            return { topicId: topic.message_thread_id, created: true };
        } catch (error: any) {
            logger.error(`[TopicManager] Failed to create topic for "${workspaceName}":`, error?.message || error);
            throw error;
        }
    }

    public registerTopic(workspaceName: string, topicId: number): void {
        this.topicCache.set(workspaceName, topicId);
    }

    public getTopicId(workspaceName: string): number | undefined {
        return this.topicCache.get(workspaceName);
    }
}
