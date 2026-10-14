import { Api } from 'grammy';
import { logger } from '../utils/logger';

export class TelegramTopicManager {
    private readonly api: Api;

    constructor(api: Api) {
        this.api = api;
    }

    /**
     * Sanitize topic title for Telegram (max 128 characters)
     */
    public sanitizeTitle(raw: string, defaultTitle: string = 'Conversation'): string {
        const cleaned = raw.replace(/[\r\n]+/g, ' ').trim();
        if (!cleaned) return defaultTitle;
        return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
    }

    /**
     * Create a new forum topic for a conversation
     */
    public async createConversationTopic(chatId: number | string, title: string): Promise<number> {
        const sanitized = this.sanitizeTitle(title);
        const topicName = `💬 ${sanitized}`;
        try {
            logger.info(`[TopicManager] Creating topic "${topicName}" in chat ${chatId}`);
            const topic = await this.api.createForumTopic(chatId, topicName);
            return topic.message_thread_id;
        } catch (err: any) {
            logger.error(`[TopicManager] Failed to create conversation topic "${topicName}":`, err?.message || err);
            throw err;
        }
    }

    /**
     * Create a forum topic for a project
     */
    public async createProjectTopic(chatId: number | string, projectName: string): Promise<number> {
        const topicName = `📁 ${projectName}`;
        try {
            logger.info(`[TopicManager] Creating project topic "${topicName}" in chat ${chatId}`);
            const topic = await this.api.createForumTopic(chatId, topicName);
            return topic.message_thread_id;
        } catch (err: any) {
            logger.error(`[TopicManager] Failed to create project topic "${topicName}":`, err?.message || err);
            throw err;
        }
    }

    /**
     * Rename a forum topic
     */
    public async renameTopic(chatId: number | string, topicId: number, newTitle: string): Promise<void> {
        const sanitized = this.sanitizeTitle(newTitle);
        try {
            await this.api.editForumTopic(chatId, topicId, { name: sanitized });
        } catch (err: any) {
            logger.warn(`[TopicManager] Failed to rename topic ${topicId}:`, err?.message || err);
        }
    }

    /**
     * Close (archive) a forum topic
     */
    public async closeTopic(chatId: number | string, topicId: number): Promise<void> {
        try {
            await this.api.closeForumTopic(chatId, topicId);
        } catch (err: any) {
            logger.warn(`[TopicManager] Failed to close topic ${topicId}:`, err?.message || err);
        }
    }
}
