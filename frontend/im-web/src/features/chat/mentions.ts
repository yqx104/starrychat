export interface MentionSpan { id: string; start: number; end: number }
export interface Draft { text: string; mentions: MentionSpan[] }
export interface Selection { start: number; end: number }
export interface MentionQuery { start: number; end: number; text: string }

// A mention remains linked only while its complete, explicitly selected text remains intact.
export function replaceDraft(draft: Draft, start: number, end: number, inserted: string): Draft {
  const shift = inserted.length - (end - start);
  const mentions = draft.mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention];
    if (mention.start >= end) return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
    return [];
  });
  return { text: draft.text.slice(0, start) + inserted + draft.text.slice(end), mentions };
}

// Locate the browser's edit using its selection before and after the input event.
// If an unusual edit cannot be located reliably, discard links rather than guess IDs.
export function applyInput(draft: Draft, text: string, selection: Selection, caret: number): Draft {
  const before = draft.text;
  const { start, end } = selection;
  if (before === text) return draft;
  if (caret >= start && before.slice(0, start) === text.slice(0, start) && before.slice(end) === text.slice(caret)) {
    return replaceDraft(draft, start, end, text.slice(start, caret));
  }
  if (start === end && caret <= start && before.slice(0, caret) === text.slice(0, caret) && before.slice(start) === text.slice(caret)) {
    return replaceDraft(draft, caret, start, '');
  }
  const removed = before.length - text.length;
  if (start === end && caret === start && removed > 0 && before.slice(0, start) === text.slice(0, start) && before.slice(start + removed) === text.slice(start)) {
    return replaceDraft(draft, start, start + removed, '');
  }
  return { text, mentions: [] };
}

export function mentionQuery(draft: Draft, selection: Selection): MentionQuery | null {
  if (selection.start !== selection.end) return null;
  const end = selection.start;
  if (end === 0) return null;
  const start = draft.text.lastIndexOf('@', end - 1);
  if (start < 0 || draft.mentions.some((mention) => start >= mention.start && start < mention.end)) return null;
  const text = draft.text.slice(start + 1, end);
  if (/[\r\n@]/.test(text)) return null;
  return { start, end, text };
}
