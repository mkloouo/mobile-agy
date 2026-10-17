import { describe, it, expect } from 'vitest';
import { buildInitialSessionPrompt, DEFAULT_MOBILE_SYSTEM_PROMPT } from '../src/bot/systemPrompt';

describe('buildInitialSessionPrompt', () => {
    it('returns empty string when input is empty or whitespace', () => {
        expect(buildInitialSessionPrompt('')).toBe('');
        expect(buildInitialSessionPrompt('   ')).toBe('');
    });

    it('prepends default mobile system prompt to regular user requests', () => {
        const result = buildInitialSessionPrompt('Build a simple REST endpoint');
        expect(result).toContain(DEFAULT_MOBILE_SYSTEM_PROMPT);
        expect(result).toContain('[User Request]:\nBuild a simple REST endpoint');
        expect(result).toContain('No Markdown Tables: Telegram mobile screens are narrow');
        expect(result).toContain('Extensive Content & Markdown Files');
        expect(result).toContain('ALWAYS accompany it with a concise general gist');
        expect(result).toContain('File & Media Delivery');
    });

    it('uses custom system prompt if provided', () => {
        const custom = '[Custom Instructions: Respond in French]';
        const result = buildInitialSessionPrompt('Hello world', custom);
        expect(result).toContain('[Custom Instructions: Respond in French]');
        expect(result).not.toContain(DEFAULT_MOBILE_SYSTEM_PROMPT);
        expect(result).toContain('[User Request]:\nHello world');
    });

    it('preserves Antigravity slash commands at the start of the string', () => {
        const result = buildInitialSessionPrompt('/plan Implement user authentication');
        expect(result.startsWith('/plan ')).toBe(true);
        expect(result).toContain(DEFAULT_MOBILE_SYSTEM_PROMPT);
        expect(result).toContain('[User Request]:\nImplement user authentication');
    });

    it('does not decorate /compact command', () => {
        const result = buildInitialSessionPrompt('/compact');
        expect(result).toBe('/compact');

        const resultWithFocus = buildInitialSessionPrompt('/compact focus on api');
        expect(resultWithFocus).toBe('/compact focus on api');
    });
});
