import { traceEvent } from '@narrateos/dsh-book-store';

/** 只归一化标签的编号写法，不对剧情正文做模糊匹配。 */
function beatKey(label: string): string {
    const compact = label.trim().replace(/\s+/g, '').toLowerCase();
    const match = /^(?:节拍|beat)?([0-9]+|[一二三四五六七八九十]+)(?:[：:、.].*)?$/.exec(compact);
    if (!match) return compact;
    const raw = match[1]!;
    const digits = '零一二三四五六七八九';
    const number = /^\d+$/.test(raw) ? Number(raw) : raw.includes('十')
        ? (raw.startsWith('十') ? 1 : digits.indexOf(raw[0]!)) * 10 + (raw.endsWith('十') ? 0 : digits.indexOf(raw.at(-1)!))
        : digits.indexOf(raw);
    return `beat:${number}`;
}

/** 终审确认只翻转唯一匹配条目；重复确认幂等，歧义和不存在仅记诊断。 */
export function settleConfirmedLedger(
    content: string,
    labels: readonly string[],
    kind: 'beats' | 'threads',
    chapter: number
): string {
    if (labels.length === 0) return content;
    const lines = content.split('\n');
    const candidates = lines.flatMap((line, index) => {
        if (!/^\s*-\s*\[/.test(line)) return [];
        if (kind === 'threads') {
            const id = /^\s*-\s*\[([^\]|\s]+)/.exec(line)?.[1];
            return id ? [{ index, key: id.toLowerCase() }] : [];
        }
        if (!/\bstatus:\s*(?:PENDING|COMPLETED)\b/i.test(line)) return [];
        const label = line.replace(/^\s*-\s*\[[^\]]*\]\s*/, '').split('|')[0]!.trim();
        return [{ index, key: beatKey(label) }];
    });
    for (const label of new Set(labels)) {
        const key = kind === 'beats' ? beatKey(label) : label.trim().replace(/^\[/, '').split(/[\s|\]]/)[0]!.toLowerCase();
        let matches = candidates.filter((candidate) => candidate.key === key);
        // 未命名节拍也可按开篇序列的实际序号确认，已完成条目仍占原序号。
        if (kind === 'beats' && matches.length === 0 && /^beat:\d+$/.test(key)) {
            const candidate = candidates[Number(key.slice(5)) - 1];
            matches = candidate ? [candidate] : [];
        }
        if (matches.length !== 1) {
            traceEvent('ledger.confirmation_skipped', { kind, label, chapter, matches: matches.length });
            continue;
        }
        const index = matches[0]!.index;
        const line = lines[index]!;
        const nextStatus = kind === 'beats' ? 'COMPLETED' : 'RESOLVED';
        if (new RegExp(`\\bstatus:\\s*${nextStatus}\\b`, 'i').test(line)) continue;
        const priorStatus = kind === 'beats' ? 'PENDING' : 'ACTIVE';
        const status = new RegExp(`\\bstatus:\\s*${priorStatus}\\b`, 'i');
        if (status.test(line)) {
            lines[index] = line.replace(status, `status: ${nextStatus} | ch:${String(chapter).padStart(2, '0')}`);
        } else if (kind === 'threads' && !/\bstatus:/i.test(line)) {
            lines[index] = line.replace(']', ` | status: ${nextStatus} | ch:${String(chapter).padStart(2, '0')}]`);
        } else {
            traceEvent('ledger.confirmation_skipped', { kind, label, chapter, reason: '条目不处于待完成状态' });
            continue;
        }
        traceEvent('ledger.confirmed', { kind, label, chapter, line: index + 1 });
    }
    return lines.join('\n');
}
