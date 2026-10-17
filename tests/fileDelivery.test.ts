import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    normalizeFilePath,
    validateFileToSend,
    getFileType,
    extractFilesToSend,
    deliverFiles,
} from '../src/bot/fileDelivery';

describe('normalizeFilePath', () => {
    it('strips file:// prefix', () => {
        expect(normalizeFilePath('file:///tmp/image.png')).toBe('/tmp/image.png');
        expect(normalizeFilePath('file://localhost/tmp/image.png')).toBe('/tmp/image.png');
    });

    it('decodes percent-encoded characters and strips hash/query', () => {
        expect(normalizeFilePath('/tmp/my%20file.png?v=1#sec')).toBe('/tmp/my file.png');
    });

    it('handles regular absolute and relative paths', () => {
        expect(normalizeFilePath('/path/to/doc.pdf')).toBe('/path/to/doc.pdf');
        expect(normalizeFilePath('./rel/doc.pdf')).toBe('./rel/doc.pdf');
    });
});

describe('validateFileToSend and getFileType', () => {
    let tmpDir: string;
    let testFile: string;
    let emptyFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-file-test-'));
        testFile = path.join(tmpDir, 'test.png');
        fs.writeFileSync(testFile, 'fake-png-data');
        emptyFile = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(emptyFile, '');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('validates existing non-empty file', () => {
        expect(validateFileToSend(testFile)).toBe(true);
    });

    it('rejects non-existent file or directory', () => {
        expect(validateFileToSend(path.join(tmpDir, 'nonexistent.txt'))).toBe(false);
        expect(validateFileToSend(tmpDir)).toBe(false);
    });

    it('rejects empty (0 byte) files', () => {
        expect(validateFileToSend(emptyFile)).toBe(false);
    });

    it('blocks sensitive files', () => {
        const envFile = path.join(tmpDir, '.env');
        fs.writeFileSync(envFile, 'SECRET=123');
        expect(validateFileToSend(envFile)).toBe(false);

        const keyFile = path.join(tmpDir, 'id_rsa');
        fs.writeFileSync(keyFile, 'key');
        expect(validateFileToSend(keyFile)).toBe(false);

        expect(validateFileToSend('/etc/passwd')).toBe(false);
    });

    it('determines file type by extension', () => {
        expect(getFileType('img.png')).toBe('photo');
        expect(getFileType('img.jpg')).toBe('photo');
        expect(getFileType('img.webp')).toBe('photo');
        expect(getFileType('video.mp4')).toBe('video');
        expect(getFileType('audio.mp3')).toBe('audio');
        expect(getFileType('doc.pdf')).toBe('document');
        expect(getFileType('archive.zip')).toBe('document');
        expect(getFileType('source.ts')).toBe('document');
    });
});

describe('extractFilesToSend', () => {
    let tmpDir: string;
    let imgFile: string;
    let pdfFile: string;
    let codeFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-extract-test-'));
        imgFile = path.join(tmpDir, 'chart.png');
        fs.writeFileSync(imgFile, 'fake-image-content');
        pdfFile = path.join(tmpDir, 'report.pdf');
        fs.writeFileSync(pdfFile, 'fake-pdf-content');
        codeFile = path.join(tmpDir, 'main.ts');
        fs.writeFileSync(codeFile, 'console.log("hello");');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts explicit <send_file> tag and cleans response text', () => {
        const raw = `Here is your export:\n<send_file path="${imgFile}" caption="Architecture Diagram" />\nLet me know!`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].path).toBe(imgFile);
        expect(result.files[0].caption).toBe('Architecture Diagram');
        expect(result.files[0].type).toBe('photo');
        expect(result.cleanedResponse).not.toContain('<send_file');
        expect(result.cleanedResponse).toContain('Here is your export:');
        expect(result.cleanedResponse).toContain('Let me know!');
    });

    it('extracts explicit <send_file> with body content', () => {
        const raw = `Sending file:\n<send_file>${codeFile}</send_file>`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].path).toBe(codeFile);
        expect(result.files[0].type).toBe('document');
        expect(result.cleanedResponse).toBe('Sending file:');
    });

    it('extracts markdown image and replaces with camera emoji label', () => {
        const raw = `See diagram below:\n![System Architecture](${imgFile})\nAll done.`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].path).toBe(imgFile);
        expect(result.files[0].caption).toBe('System Architecture');
        expect(result.cleanedResponse).toContain('📷 _System Architecture_');
    });

    it('ignores external web images', () => {
        const raw = `See web image: ![Web](https://example.com/logo.png)`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(0);
        expect(result.cleanedResponse).toBe(raw);
    });

    it('extracts auto-recognized document links (pdf/zip/csv)', () => {
        const raw = `Download: [Financial Report](${pdfFile})`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].path).toBe(pdfFile);
        expect(result.files[0].caption).toBe('Financial Report');
    });

    it('does NOT auto-extract code file links like .ts or .md', () => {
        const raw = `Modified [main.ts](${codeFile}) in backend`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(0);
        expect(result.cleanedResponse).toBe(raw);
    });

    it('deduplicates identical files', () => {
        const raw = `![Chart 1](${imgFile})\n![Chart 2](${imgFile})`;
        const result = extractFilesToSend(raw, tmpDir);

        expect(result.files).toHaveLength(1);
    });
});

describe('deliverFiles', () => {
    let tmpDir: string;
    let photoPath: string;
    let docPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deliver-test-'));
        photoPath = path.join(tmpDir, 'photo.png');
        fs.writeFileSync(photoPath, 'fake-photo');
        docPath = path.join(tmpDir, 'data.csv');
        fs.writeFileSync(docPath, 'col1,col2\n1,2');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('delivers photo via sendPhoto', async () => {
        const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
        const bot = { api: { sendPhoto: mockSendPhoto } };

        await deliverFiles(bot, 123, 456, [{
            path: photoPath,
            caption: 'Test photo',
            type: 'photo',
        }]);

        expect(mockSendPhoto).toHaveBeenCalledTimes(1);
        expect(mockSendPhoto).toHaveBeenCalledWith(123, expect.any(Object), {
            caption: 'Test photo',
            message_thread_id: 456,
        });
    });

    it('falls back to sendDocument if sendPhoto fails', async () => {
        const mockSendPhoto = vi.fn().mockRejectedValue(new Error('Bad Request: PHOTO_INVALID_DIMENSIONS'));
        const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 11 });
        const bot = { api: { sendPhoto: mockSendPhoto, sendDocument: mockSendDocument } };

        await deliverFiles(bot, 123, 456, [{
            path: photoPath,
            caption: 'Failing photo',
            type: 'photo',
        }]);

        expect(mockSendPhoto).toHaveBeenCalledTimes(1);
        expect(mockSendDocument).toHaveBeenCalledTimes(1);
        expect(mockSendDocument).toHaveBeenCalledWith(123, expect.any(Object), {
            caption: 'Failing photo',
            message_thread_id: 456,
        });
    });

    it('retries on Telegram 429 rate limit', async () => {
        const mockSendDocument = vi.fn()
            .mockRejectedValueOnce({
                message: '429: Too Many Requests',
                parameters: { retry_after: 0.01 },
            })
            .mockResolvedValueOnce({ message_id: 12 });
        const bot = { api: { sendDocument: mockSendDocument } };

        await deliverFiles(bot, 123, undefined, [{
            path: docPath,
            type: 'document',
        }]);

        expect(mockSendDocument).toHaveBeenCalledTimes(2);
    });

    it('logs error gracefully without throwing when delivery fails completely', async () => {
        const mockSendDocument = vi.fn().mockRejectedValue(new Error('Network error'));
        const bot = { api: { sendDocument: mockSendDocument } };

        await expect(deliverFiles(bot, 123, undefined, [{
            path: docPath,
            type: 'document',
        }])).resolves.not.toThrow();
    });
});
