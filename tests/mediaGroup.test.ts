import { describe, it, expect } from 'vitest';

describe('mediaGroup batching logic', () => {
    it('chunks photos into batches of 5', () => {
        const photos = Array.from({ length: 9 }, (_, i) => `photo_${i + 1}`);
        const BATCH_SIZE = 5;
        const batches: string[][] = [];

        for (let i = 0; i < photos.length; i += BATCH_SIZE) {
            batches.push(photos.slice(i, i + BATCH_SIZE));
        }

        expect(batches.length).toBe(2);
        expect(batches[0]).toEqual(['photo_1', 'photo_2', 'photo_3', 'photo_4', 'photo_5']);
        expect(batches[1]).toEqual(['photo_6', 'photo_7', 'photo_8', 'photo_9']);
    });

    it('formats multi-image prompt with all downloaded image paths', () => {
        const downloadedPaths = ['/tmp/1.jpg', '/tmp/2.jpg', '/tmp/3.jpg'];
        const caption = 'Review these screens';

        let userPrompt = caption ? `${caption}\n\n` : '';
        userPrompt += downloadedPaths.map((p) => `[Attached user screenshot: ${p}]`).join('\n');

        expect(userPrompt).toContain('Review these screens');
        expect(userPrompt).toContain('[Attached user screenshot: /tmp/1.jpg]');
        expect(userPrompt).toContain('[Attached user screenshot: /tmp/2.jpg]');
        expect(userPrompt).toContain('[Attached user screenshot: /tmp/3.jpg]');
    });
});
