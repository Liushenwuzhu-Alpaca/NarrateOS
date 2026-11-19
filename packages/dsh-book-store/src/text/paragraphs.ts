export interface ParagraphLine {
    lineNumber: number;
    text: string;
    paragraphIndex: number;
}

/** 空白行划分自然段，单换行仍属于同一段；保留原始物理行号。 */
export function analyzeParagraphs(text: string): { paragraphs: string[]; lines: ParagraphLine[]; ranges: Array<{ start: number; end: number }> } {
    const paragraphs: string[] = [];
    const lines: ParagraphLine[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    let offset = 0;
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
            if (current.length === 0) ranges.push({ start: offset, end: offset + line.length });
            else ranges[ranges.length - 1]!.end = offset + line.length;
            current.push(line);
        }
        offset += line.length;
        offset += text.charAt(offset) === '\r' ? 2 : 1;
    }
    flush();
    return { paragraphs, lines, ranges };
}
