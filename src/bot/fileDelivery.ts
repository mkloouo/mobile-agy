import fs from 'fs';
import path from 'path';
import { InputFile } from 'grammy';
import { logger } from '../utils/logger';

export type FileType = 'photo' | 'document' | 'video' | 'audio';

export interface FileToSend {
    path: string;
    caption?: string;
    type: FileType;
}

export interface ExtractFilesResult {
    files: FileToSend[];
    cleanedResponse: string;
}

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB Telegram Bot API limit

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
export const AUTO_DOC_EXTENSIONS = new Set([
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
    '.csv', '.xlsx', '.xls', '.docx',
    '.dmg', '.apk', '.ipa', '.svg'
]);

const SENSITIVE_PATTERNS = [
    /(^|\/)\.(env|git|ssh|netrc|npmrc|gnupg)($|\/)/i,
    /(id_rsa|id_ed25519|.*\.pem|.*\.key)$/i,
    /^\/(etc|private\/etc)\//i,
];

/**
 * Clean path string by stripping file:// scheme and URL decoding.
 */
export function normalizeFilePath(rawPath: string): string {
    let clean = rawPath.trim();
    if (clean.startsWith('file://localhost/')) {
        clean = clean.slice('file://localhost'.length);
    } else if (clean.startsWith('file://')) {
        clean = clean.slice('file://'.length);
    }
    // Remove query params or hash fragments if any
    clean = clean.split(/[?#]/)[0];
    try {
        clean = decodeURIComponent(clean);
    } catch {}
    return clean;
}

/**
 * Validate that file is safe to send, exists, and meets size limits.
 */
export function validateFileToSend(filePath: string): boolean {
    for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(filePath)) {
            logger.warn(`[FileDelivery] Blocked sensitive file path: ${filePath}`);
            return false;
        }
    }

    try {
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return false;
        if (stat.size <= 0 || stat.size > MAX_FILE_SIZE_BYTES) {
            logger.warn(`[FileDelivery] Skipping file ${filePath} with invalid size: ${stat.size} bytes`);
            return false;
        }
        return true;
    } catch (err: any) {
        logger.debug(`[FileDelivery] Error checking file ${filePath}:`, err.message);
        return false;
    }
}

/**
 * Determine Telegram media type based on file extension.
 */
export function getFileType(filePath: string, isExplicitTag = false): FileType {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return 'photo';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    return 'document';
}

/**
 * Parse attributes from HTML/XML style tag like <send_file path="..." caption="..." />
 */
function parseTagAttributes(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /([a-zA-Z_:][a-zA-Z0-9.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(attrStr)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        attrs[key] = value;
    }
    return attrs;
}

/**
 * Extract files from model response:
 * 1. Explicit <send_file path="..." [caption="..."] /> tags
 * 2. Markdown images ![alt](path)
 * 3. Markdown links [alt](path) for document / archive extensions
 */
export function extractFilesToSend(rawResponse: string, workspacePath?: string): ExtractFilesResult {
    if (!rawResponse) {
        return { files: [], cleanedResponse: '' };
    }

    const files: FileToSend[] = [];
    const seenPaths = new Set<string>();
    const baseDir = workspacePath || process.cwd();

    function tryAddFile(candidatePath: string, caption?: string, isExplicit = false): boolean {
        const cleanPath = normalizeFilePath(candidatePath);
        if (!cleanPath) return false;

        const resolved = path.isAbsolute(cleanPath)
            ? path.resolve(cleanPath)
            : path.resolve(baseDir, cleanPath);

        if (seenPaths.has(resolved)) return false;

        if (validateFileToSend(resolved)) {
            seenPaths.add(resolved);
            files.push({
                path: resolved,
                caption: caption?.trim() || undefined,
                type: getFileType(resolved, isExplicit),
            });
            return true;
        }
        return false;
    }

    let cleaned = rawResponse;

    // 1. Explicit <send_file path="..." caption="..." /> or <send_file>path</send_file>
    cleaned = cleaned.replace(/<send_file\b([^>]*)>(?:([\s\S]*?)<\/send_file>)?/gi, (_match, attrsStr, bodyText) => {
        const attrs = parseTagAttributes(attrsStr || '');
        const targetPath = attrs.path || attrs.file || attrs.src || bodyText?.trim() || '';
        const caption = attrs.caption || attrs.title || undefined;
        if (targetPath) {
            tryAddFile(targetPath, caption, true);
        }
        return '';
    });

    // Also strip self-closing <send_file ... />
    cleaned = cleaned.replace(/<send_file\b([^>]*)\/>/gi, (_match, attrsStr) => {
        const attrs = parseTagAttributes(attrsStr || '');
        const targetPath = attrs.path || attrs.file || attrs.src || '';
        const caption = attrs.caption || attrs.title || undefined;
        if (targetPath) {
            tryAddFile(targetPath, caption, true);
        }
        return '';
    });

    // 2. Markdown images: ![alt](path)
    cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (fullMatch, altText, imgPath) => {
        const cleanPath = normalizeFilePath(imgPath);
        // Ignore web URLs
        if (/^https?:\/\//i.test(cleanPath)) {
            return fullMatch;
        }

        const added = tryAddFile(cleanPath, altText || undefined, false);
        if (added) {
            const label = altText?.trim() || path.basename(cleanPath);
            return `📷 _${label}_`;
        }
        return fullMatch;
    });

    // 3. Markdown document links: [alt](path) for auto-recognized file extensions
    cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (fullMatch, linkText, docPath) => {
        const cleanPath = normalizeFilePath(docPath);
        if (/^https?:\/\//i.test(cleanPath)) {
            return fullMatch;
        }

        const ext = path.extname(cleanPath).toLowerCase();
        if (AUTO_DOC_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) {
            tryAddFile(cleanPath, linkText || undefined, false);
        }
        return fullMatch;
    });

    return {
        files,
        cleanedResponse: cleaned.trim(),
    };
}

/**
 * Deliver extracted files to Telegram with retry on rate limits and photo->document fallback.
 */
export async function deliverFiles(
    bot: any,
    chatId: number,
    threadId: number | undefined,
    files: FileToSend[],
    maxRetries = 3
): Promise<void> {
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (i > 0) {
            // Slight delay between multiple media items to respect Telegram limits
            await new Promise((r) => setTimeout(r, 300));
        }

        const options: any = {
            message_thread_id: threadId,
        };
        if (file.caption) {
            options.caption = file.caption.slice(0, 1024);
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const inputFile = new InputFile(file.path);
                if (file.type === 'photo') {
                    try {
                        await bot.api.sendPhoto(chatId, inputFile, options);
                    } catch (photoErr: any) {
                        logger.warn(`[FileDelivery] sendPhoto failed (${photoErr.message}), falling back to sendDocument for ${file.path}`);
                        const docFile = new InputFile(file.path);
                        await bot.api.sendDocument(chatId, docFile, options);
                    }
                } else if (file.type === 'video') {
                    try {
                        await bot.api.sendVideo(chatId, inputFile, options);
                    } catch {
                        const docFile = new InputFile(file.path);
                        await bot.api.sendDocument(chatId, docFile, options);
                    }
                } else if (file.type === 'audio') {
                    try {
                        await bot.api.sendAudio(chatId, inputFile, options);
                    } catch {
                        const docFile = new InputFile(file.path);
                        await bot.api.sendDocument(chatId, docFile, options);
                    }
                } else {
                    await bot.api.sendDocument(chatId, inputFile, options);
                }
                logger.info(`[FileDelivery] Successfully delivered ${file.type}: ${file.path} (chat: ${chatId})`);
                break;
            } catch (err: any) {
                const retryAfter = err?.parameters?.retry_after;
                if (retryAfter && attempt < maxRetries) {
                    const waitSec = Math.min(retryAfter, 15);
                    logger.warn(`[FileDelivery] Rate-limited (429) on sending file, waiting ${waitSec}s (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise((r) => setTimeout(r, waitSec * 1000));
                    continue;
                }
                logger.error(`[FileDelivery] Failed to deliver file ${file.path}:`, err.message);
                break;
            }
        }
    }
}
