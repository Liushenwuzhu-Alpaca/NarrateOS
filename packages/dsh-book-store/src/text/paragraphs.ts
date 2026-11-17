export interface ParagraphLine {
    lineNumber: number;
    text: string;
    paragraphIndex: number;
}

/** 空白行划分自然段，单换行仍属于同一段；保留原始物理行号。 */
export function analyzeParagraphs(text: string): { paragraphs: string[]; lines: ParagraphLine[] } {
    const paragraphs: string[] = [];
    const lines: ParagraphLine[] = [];
    let current: string[] = [];
    const flush = (): void => {
        if (current.length > 0) {
            paragraphs.push(current.join('\n').trim());
            current = [];
        }
    };
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.trim().length === 0) {
            flush();
            lines.push({ lineNumber: index + 1, text: line, paragraphIndex: -1 });
        } else {
            lines.push({ lineNumber: index + 1, text: line, paragraphIndex: paragraphs.length });
            current.push(line);
        }
    }
    flush();
    return { paragraphs, lines };
}
