import fs from 'fs';
import path from 'path';
import os from 'os';

export interface AskQuestionItem {
    question: string;
    options: string[];
    is_multi_select?: boolean;
}

export function parseQuestions(params: any): AskQuestionItem[] {
    if (!params) return [];

    let qData = params.questions;
    if (typeof qData === 'string') {
        try {
            qData = JSON.parse(qData);
        } catch {}
    }

    if (Array.isArray(qData)) {
        return qData
            .filter((q: any) => q && typeof q === 'object')
            .map((q: any) => ({
                question: String(q.question || 'Please select an option:'),
                options: Array.isArray(q.options) ? q.options.map(String) : [],
                is_multi_select: !!q.is_multi_select,
            }))
            .filter((q: AskQuestionItem) => q.options.length > 0);
    }

    let singleOpts = params.options;
    if (typeof singleOpts === 'string') {
        try {
            singleOpts = JSON.parse(singleOpts);
        } catch {}
    }

    if (params?.question) {
        const opts = Array.isArray(singleOpts) ? singleOpts.map(String) : [];
        if (opts.length > 0) {
            return [{
                question: String(params.question),
                options: opts,
                is_multi_select: !!params.is_multi_select,
            }];
        }
    }

    return [];
}

/**
 * Scan the latest turn in conversation transcript to find any ask_question call
 */
export function findRecentAskQuestion(conversationId: string): any | null {
    if (!conversationId) return null;
    const transcriptPath = path.join(
        os.homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
    );
    if (!fs.existsSync(transcriptPath)) return null;

    try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const lines = content.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const step = JSON.parse(line);
                if (step.type === 'USER_INPUT') {
                    break;
                }
                if (Array.isArray(step.tool_calls)) {
                    const qCall = step.tool_calls.find((tc: any) => tc.name === 'ask_question');
                    if (qCall?.args) {
                        return qCall.args;
                    }
                }
            } catch {}
        }
    } catch {}

    return null;
}
