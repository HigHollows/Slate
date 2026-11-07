import type { Editor } from '@tiptap/core';
import type { TFunction } from 'i18next';
import { toast } from '../../shared/ui';
import type { PasteMode } from './paste';
import { pasteHtml, pastePlainText } from './SmartPaste';

/** Collage explicite depuis le presse-papiers du système (le navigateur peut demander une autorisation). */
export async function pasteFromClipboard(
  editor: Editor,
  mode: PasteMode,
  t: TFunction,
): Promise<void> {
  try {
    if (mode === 'plain') {
      if (!pastePlainText(editor, await navigator.clipboard.readText()))
        toast.info(t('editor.pasteEmpty'));
      return;
    }
    let html = '';
    for (const item of await navigator.clipboard.read())
      if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
    if (html) pasteHtml(editor, html, mode);
    else if (!pastePlainText(editor, await navigator.clipboard.readText()))
      toast.info(t('editor.pasteEmpty'));
  } catch {
    toast.error(t('editor.pasteFailed'));
  }
}
