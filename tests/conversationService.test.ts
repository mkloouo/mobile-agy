import { describe, it, expect } from 'vitest';
import { ConversationService } from '../src/services/conversationService';

describe('ConversationService workspace parsing', () => {
    const service = new ConversationService();

    it('extracts single workspace correctly', () => {
        const raw = JSON.stringify(['file:///Users/test/project1']);
        // @ts-ignore
        const { primary, all } = service.parseWorkspaceUris(raw);
        expect(primary).toBe('/Users/test/project1');
        expect(all).toEqual(['/Users/test/project1']);
    });

    it('extracts multiple workspaces correctly', () => {
        const raw = JSON.stringify([
            'file:///Users/mkloouo/Projects/mmyway/main',
            'file:///Users/mkloouo/Projects/tmyway-app'
        ]);
        // @ts-ignore
        const { primary, all } = service.parseWorkspaceUris(raw);
        expect(primary).toBe('/Users/mkloouo/Projects/mmyway/main');
        expect(all).toEqual([
            '/Users/mkloouo/Projects/mmyway/main',
            '/Users/mkloouo/Projects/tmyway-app'
        ]);
    });

    it('handles null, undefined and invalid json gracefully', () => {
        // @ts-ignore
        expect(service.parseWorkspaceUris(null)).toEqual({ primary: '', all: [] });
        // @ts-ignore
        expect(service.parseWorkspaceUris(undefined)).toEqual({ primary: '', all: [] });
        // @ts-ignore
        expect(service.parseWorkspaceUris('invalid json')).toEqual({ primary: '', all: [] });
    });
});
