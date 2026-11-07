import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { useNav } from '../features/navigation';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { bus } from '../shared/bus';
import type { PresenceService } from '../shared/presence';
import { renderApp } from '../test-utils';
import { useWritingMode } from '../features/editor';

// L'état d'affichage (lecture / focus) est global : chaque test repart du mode édition.
beforeEach(() => useWritingMode.setState({ readMode: false, focusMode: false }));

type PMEditor = {
  state: { doc: { descendants(f: (n: { type: { name: string } }, pos: number) => void): void } };
  commands: {
    insertContent(c: unknown): boolean;
    selectAll(): boolean;
    focus(): boolean;
    setTextSelection(p: number): boolean;
    setContent(c: unknown): boolean;
    setTextSelection(p: number | { from: number; to: number }): boolean;
  };
  getJSON(): unknown;
  getText(): string;
  getHTML(): string;
};
const editorOf = (): PMEditor => {
  const dom = document.querySelector('.ProseMirror') as
    (HTMLElement & { editor?: PMEditor }) | null;
  if (!dom?.editor) throw new Error('éditeur introuvable');
  return dom.editor;
};
const newPage = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: 'Nouvelle page' })[0]!);
  await screen.findByRole('textbox', { name: 'Contenu de la page' });
  return editorOf();
};
const slash = async (ed: PMEditor, query: string) => {
  act(() => void ed.commands.insertContent(query));
  await screen.findByRole('listbox', { name: 'Insérer un bloc' });
  fireEvent.keyDown(document.querySelector('.ProseMirror')!, { key: 'Enter' });
};
// La barre flottante (sélection) répète certains boutons : on cible toujours la barre fixe.
const tool = (name: string | RegExp) =>
  within(screen.getByRole('toolbar', { name: 'Barre de mise en forme' })).getByRole('button', {
    name,
  });

describe('éditeur de texte riche : barre d’outils', () => {
  it('est un vrai outil accessible, réductible et ses états reflètent la sélection', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    const bar = screen.getByRole('toolbar', { name: 'Barre de mise en forme' });
    expect(bar).toBeInTheDocument();
    act(() => void ed.commands.insertContent('Bonjour monde'));
    act(() => void ed.commands.selectAll());
    await user.click(tool('Gras'));
    await waitFor(() => expect(tool('Gras')).toHaveAttribute('aria-pressed', 'true'));
    await user.click(tool('Gras'));
    await waitFor(() => expect(tool('Gras')).toHaveAttribute('aria-pressed', 'false'));
    expect(await axe(document.body)).toHaveNoViolations();

    await user.click(tool('Masquer la barre de mise en forme'));
    expect(
      screen.queryByRole('toolbar', { name: 'Barre de mise en forme' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Afficher la barre de mise en forme' }));
    expect(screen.getByRole('toolbar', { name: 'Barre de mise en forme' })).toBeInTheDocument();
  });

  it('applique style, police, taille, couleur, surlignage, alignement et listes — puis tout survit à la réouverture', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('Texte formaté'));
    act(() => void ed.commands.selectAll());

    await user.click(tool('Gras'));
    await user.click(tool('Italique'));
    await user.click(tool('Souligné'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Police' }), 'serif');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Taille de police' }), '24');
    await user.click(tool('Couleur du texte'));
    await user.click(await screen.findByRole('button', { name: 'Rouge' }));
    await user.keyboard('{Escape}');
    await user.click(tool('Surlignage'));
    await user.click(await screen.findByRole('button', { name: 'Rose' }));
    await user.keyboard('{Escape}');
    await user.click(tool('Centrer'));

    const html = ed.getHTML();
    for (const part of [
      '<strong>',
      '<em>',
      '<u>',
      'data-doc-color="red"',
      'data-doc-size="24"',
      'data-doc-font="serif"',
      'data-color="pink"',
      'text-align: center',
    ])
      expect(html).toContain(part);

    // L'enregistrement est différé : on attend celui qui contient TOUT le formatage.
    await waitFor(
      () => expect(api.pageSave.mock.calls.at(-1)?.[0].contentJson).toContain('"highlight"'),
      { timeout: 4000 },
    );
    const saved = api.pageSave.mock.calls.at(-1)![0];
    expect(saved.contentJson).toContain('"textStyle"');
    expect(saved.contentJson).toContain('"highlight"');
    expect(saved.textPlain).toContain('Texte formaté');

    // fermer la page puis la rouvrir : le rendu est identique
    const id = api.nodes[0]!.id;
    act(() => useNav.getState().navigate({ name: 'home' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Contenu de la page' })).not.toBeInTheDocument(),
    );
    act(() => useNav.getState().navigate({ name: 'page', id }));
    await screen.findByText('Texte formaté');
    expect(editorOf().getHTML()).toBe(html);
  });

  it('couleur personnalisée : seule une valeur HEX valide est acceptée', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('abc'));
    act(() => void ed.commands.selectAll());
    await user.click(tool('Couleur du texte'));
    const hex = await screen.findByRole('textbox', { name: 'Code HEX' });
    await user.clear(hex);
    await user.type(hex, 'javascript:1');
    expect(screen.getByRole('button', { name: 'Appliquer' })).toBeDisabled();
    await user.clear(hex);
    await user.type(hex, '#12ab9f{Enter}');
    await waitFor(() => expect(ed.getHTML()).toContain('data-doc-color="#12ab9f"'));
    if (!screen.queryByRole('button', { name: 'Couleur par défaut' }))
      await user.click(tool('Couleur du texte'));
    await user.click(await screen.findByRole('button', { name: 'Couleur par défaut' }));
    await waitFor(() => expect(ed.getHTML()).not.toContain('data-doc-color'));
  });

  it('listes, titres, citation et suppression du formatage', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('Ligne'));
    act(() => void ed.commands.selectAll());
    await user.click(tool('Liste à puces'));
    expect(ed.getHTML()).toContain('<ul>');
    await user.click(tool('Liste numérotée'));
    expect(ed.getHTML()).toContain('<ol>');
    await user.click(tool('Liste de tâches'));
    expect(ed.getHTML()).toContain('data-type="taskList"');
    await user.click(tool('Liste de tâches')); // retire la liste
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style de paragraphe' }), 'h4');
    expect(ed.getHTML()).toContain('<h4');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Style de paragraphe' }),
      'quote',
    );
    expect(ed.getHTML()).toContain('<blockquote>');
    act(() => void ed.commands.selectAll());
    await user.click(tool('Gras'));
    await user.click(tool('Supprimer le formatage'));
    expect(ed.getHTML()).not.toContain('<strong>');
  });

  it('raccourcis : Ctrl+\\ supprime le formatage, Ctrl+Maj+K ouvre le lien (Ctrl+K reste la palette)', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p><strong>gras</strong></p>'));
    act(() => void ed.commands.focus());
    act(() => void ed.commands.selectAll());
    expect(ed.getHTML()).toContain('<strong>');
    await user.keyboard('{Control>}\\{/Control}');
    expect(ed.getHTML()).not.toContain('<strong>');
    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Lien' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /commande/i })).not.toBeInTheDocument();
  });

  it('tableau : barre contextuelle (lignes, colonnes, fond) et accessibilité', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    await user.click(tool('Insérer un tableau'));
    const bar = await screen.findByRole('toolbar', { name: 'Outils du tableau' });
    expect(bar).toBeInTheDocument();
    const rows = () => (ed.getHTML().match(/<tr/g) ?? []).length;
    expect(rows()).toBe(3);
    await user.click(screen.getByRole('button', { name: 'Ligne en dessous' }));
    expect(rows()).toBe(4);
    await user.click(screen.getByRole('button', { name: 'Supprimer la ligne' }));
    expect(rows()).toBe(3);
    await user.click(screen.getByRole('button', { name: 'Fond de cellule' }));
    await user.click(await screen.findByRole('button', { name: 'Rose' }));
    expect(ed.getHTML()).toContain('data-bg="pink"');
    expect(await axe(document.body)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Supprimer le tableau' }));
    expect(ed.getHTML()).not.toContain('<table');
    expect(screen.queryByRole('toolbar', { name: 'Outils du tableau' })).not.toBeInTheDocument();
  });

  it('encadré typé via le menu /, changement de type, sommaire et bloc repliable', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    await slash(ed, '/avert');
    await waitFor(() => expect(ed.getHTML()).toContain('data-variant="warning"'));
    const sel = await screen.findByRole('combobox', { name: "Type d'encadré" });
    await user.selectOptions(sel, 'tip');
    expect(ed.getHTML()).toContain('data-variant="tip"');
    expect(ed.getHTML()).toContain('data-label="Conseil"');
    await user.click(screen.getByRole('button', { name: "Retirer l'encadré" }));
    expect(ed.getHTML()).not.toContain('data-callout');

    act(() => void ed.commands.insertContent('<h2>Chapitre</h2><p></p>'));
    await slash(ed, '/somm');
    const nav = await screen.findByRole('navigation', { name: 'Sommaire' });
    expect(within(nav).getByRole('button', { name: 'Chapitre' })).toBeInTheDocument();

    await slash(ed, '/repli');
    expect(await screen.findByRole('button', { name: 'Déplier le bloc' })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('image : insertion depuis le disque, options, texte alternatif, aperçu, suppression', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'chat.png', {
      type: 'image/png',
    });
    await user.upload(screen.getByLabelText('Choisir une image'), png);
    await waitFor(() => expect(api.mediaPut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ed.getHTML()).toMatch(/data-hash="[0-9a-f]{64}"/));
    expect(ed.getHTML()).not.toMatch(/base64|data:image/); // jamais d'image dans le document
    expect(ed.getHTML()).toContain('data-alt="chat"');

    const at = () => {
      let found = -1;
      ed.state.doc.descendants((n, pos) => void (n.type.name === 'imageFigure' && (found = pos)));
      return found;
    };
    act(() => void ed.commands.setTextSelection(at() + 1));
    const bar = await screen.findByRole('toolbar', { name: "Outils de l'image" });
    const alt = within(bar).getByRole('textbox', { name: 'Texte alternatif' });
    await user.clear(alt);
    await user.type(alt, 'Un chat roux');
    await waitFor(() => expect(ed.getHTML()).toContain('data-alt="Un chat roux"'));
    await user.click(within(bar).getByRole('button', { name: 'Pleine largeur' }));
    expect(ed.getHTML()).toContain('data-align="full"');
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Largeur' }), '50');
    await waitFor(() => expect(ed.getHTML()).toContain('data-width="50"'));
    expect(await axe(document.body)).toHaveNoViolations();

    const open = await screen.findByRole('button', { name: 'Un chat roux' });
    await user.click(open);
    expect(await screen.findByRole('dialog', { name: 'Image en grand' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    act(() => void ed.commands.setTextSelection(at() + 1));
    await user.click(await screen.findByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(ed.getHTML()).not.toContain('data-hash'));
  });

  it('image : un fichier qui n’est pas une image autorisée est refusé et signalé', async () => {
    const user = userEvent.setup({ applyAccept: false }); // simule un glisser-déposer qui contourne le filtre du sélecteur
    const { api } = await renderApp();
    await newPage(user);
    const svg = new File(['<svg><script>alert(1)</script></svg>'], 'x.svg', {
      type: 'image/svg+xml',
    });
    await user.upload(screen.getByLabelText('Choisir une image'), svg);
    expect(await screen.findByText(/format d’image non pris en charge/i)).toBeInTheDocument();
    expect(api.mediaPut).not.toHaveBeenCalled();
  });

  it('bloc de code : langage, numéros de ligne, copie, repli', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() => void ed.commands.insertContent('<pre><code>let a = 1;\nlet b = 2;</code></pre>'));
    const lang = await screen.findByRole('combobox', { name: 'Langage du code' });
    await user.selectOptions(lang, 'typescript');
    await waitFor(() => expect(ed.getHTML()).toContain('data-language="typescript"'));
    await user.click(screen.getByRole('button', { name: 'Numéros de ligne' }));
    await waitFor(() => expect(ed.getHTML()).toContain('data-line-numbers="true"'));
    expect(document.querySelector('.code-gutter')?.textContent).toBe('1\n2');
    await user.click(screen.getByRole('button', { name: 'Copier' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('let a = 1;\nlet b = 2;'));
    await user.click(screen.getByRole('button', { name: 'Replier' }));
    await waitFor(() => expect(ed.getHTML()).toContain('data-collapsed="true"'));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('image : le collage d’une image du presse-papiers l’insère dans le document', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])], 'capture.png', {
      type: 'image/png',
    });
    fireEvent.paste(document.querySelector('.ProseMirror')!, {
      clipboardData: { files: [png], getData: () => '', types: ['Files'] },
    });
    await waitFor(() => expect(api.mediaPut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ed.getHTML()).toMatch(/data-hash="[0-9a-f]{64}"/));
    expect(ed.getHTML()).toContain('data-alt="capture"');
  });

  it('recherche : Ctrl+F, compteur, navigation, remplacement, fermeture avec Échap', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>chat et chat et Chat</p>'));
    act(() => void ed.commands.focus());
    await user.keyboard('{Control>}f{/Control}');
    const bar = await screen.findByRole('search', { name: 'Rechercher dans le document' });
    const find = within(bar).getByRole('textbox', { name: 'Rechercher' });
    await user.type(find, 'chat');
    expect(await within(bar).findByText('1 / 3')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(await within(bar).findByText('2 / 3')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Respecter la casse' }));
    expect(await within(bar).findByText('1 / 2')).toBeInTheDocument();
    await user.type(within(bar).getByRole('textbox', { name: 'Remplacer par' }), 'lion');
    expect(await axe(document.body)).toHaveNoViolations();
    await user.click(within(bar).getByRole('button', { name: 'Tout remplacer' }));
    await waitFor(() => expect(ed.getHTML()).toContain('lion et lion et Chat'));
    expect(within(bar).getByText('Aucun résultat')).toBeInTheDocument();
    await user.click(find); // Échap ferme la barre quand le focus y est
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('search', { name: 'Rechercher dans le document' }),
      ).not.toBeInTheDocument(),
    );
    expect(document.querySelector('.search-match')).toBeNull();
  });

  it('versions : enregistrer, comparer, restaurer sans rien perdre (l’état actuel est sauvegardé avant)', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>première rédaction</p>'));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 4000 });
    await user.click(screen.getByRole('button', { name: 'Historique des versions' }));
    const dlg = await screen.findByRole('dialog', { name: 'Historique des versions' });
    expect(await within(dlg).findByText(/Aucune version pour l'instant/)).toBeInTheDocument();
    await user.type(within(dlg).getByRole('textbox', { name: 'Nom de la version' }), 'Jalon 1');
    await user.click(within(dlg).getByRole('button', { name: 'Enregistrer une version' }));
    const item = await within(dlg).findByRole('button', { name: /Jalon 1/ });
    expect(api.versionCreate).toHaveBeenCalledWith(expect.any(String), 'manual', 'Jalon 1', null);
    await user.keyboard('{Escape}');

    // le document évolue
    act(() => void ed.commands.setContent('<p>version corrigée</p>'));
    await waitFor(
      () => expect(api.pageSave.mock.calls.at(-1)?.[0].textPlain).toContain('corrigée'),
      { timeout: 4000 },
    );
    await user.click(screen.getByRole('button', { name: 'Historique des versions' }));
    const dlg2 = await screen.findByRole('dialog', { name: 'Historique des versions' });
    await user.click(await within(dlg2).findByRole('button', { name: /Jalon 1/ }));
    expect(await within(dlg2).findByText(/ligne\(s\) ajoutée\(s\)/)).toBeInTheDocument();
    expect(await axe(dlg2)).toHaveNoViolations();
    void item;
    await user.click(within(dlg2).getByRole('button', { name: 'Restaurer cette version' }));
    await waitFor(() => expect(ed.getHTML()).toContain('première rédaction'));
    expect(ed.getHTML()).not.toContain('corrigée');
    // la version « avant restauration » contient bien l'état remplacé
    const backup = api.versions.find((v) => v.reason === 'restore');
    expect(backup?.textPlain).toContain('corrigée');
    expect(api.versionCreate).toHaveBeenLastCalledWith(
      expect.any(String),
      'restore',
      'Avant restauration',
      null,
    );
  });

  it('versions : si la sauvegarde préalable échoue, rien n’est restauré', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>avant</p>'));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 4000 });
    await user.click(screen.getByRole('button', { name: 'Historique des versions' }));
    const dlg = await screen.findByRole('dialog', { name: 'Historique des versions' });
    await user.click(within(dlg).getByRole('button', { name: 'Enregistrer une version' }));
    await user.click(await within(dlg).findByRole('button', { name: /Manuelle/ }));
    act(() => void ed.commands.setContent('<p>après</p>'));
    api.versionCreate.mockRejectedValueOnce({
      code: 'io',
      messageKey: 'errors.io',
      retryable: true,
    });
    await user.click(within(dlg).getByRole('button', { name: 'Restaurer cette version' }));
    expect(await within(dlg).findByRole('alert')).toBeInTheDocument();
    expect(ed.getHTML()).toContain('après');
    expect(ed.getHTML()).not.toContain('avant');
  });

  describe('commentaires', () => {
    const setup = async () => {
      const user = userEvent.setup();
      const ctx = await renderApp();
      const ed = await newPage(user);
      act(() => void ed.commands.insertContent('<p>un passage important du texte</p>'));
      return { user, ctx, ed };
    };
    const select = (ed: PMEditor, from: number, to: number) =>
      act(() => void ed.commands.setTextSelection({ from, to } as never));
    const comment = async (user: ReturnType<typeof userEvent.setup>, body: string) => {
      await user.click(tool('Commenter la sélection'));
      const panel = await screen.findByRole('complementary', { name: 'Commentaires' });
      await user.type(within(panel).getByRole('textbox', { name: 'Commentaire' }), body);
      await user.click(within(panel).getByRole('button', { name: 'Envoyer' }));
      return panel;
    };

    it('crée un fil ancré à la sélection, répond, modifie, résout et rouvre', async () => {
      const { user, ctx, ed } = await setup();
      select(ed, 4, 11); // « passage »
      const panel = await comment(user, 'À reformuler');
      await waitFor(() => expect(ctx.api.threadCreate).toHaveBeenCalledTimes(1));
      expect(ctx.api.threadCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        expect.any(String),
        'passage',
        'À reformuler',
        null,
      );
      await waitFor(() => expect(ed.getHTML()).toMatch(/data-comment-thread="[0-9a-f-]{36}"/));
      expect(ed.getHTML()).toContain('>passage</span>');
      const thread = await within(panel).findByRole('listitem', { name: 'Fil sur « passage »' });
      expect(within(thread).getByText('À reformuler')).toBeInTheDocument();
      expect(await axe(panel)).toHaveNoViolations();

      await user.type(within(thread).getByRole('textbox', { name: /Répondre au fil/ }), 'D’accord');
      await user.click(within(thread).getAllByRole('button', { name: 'Envoyer' }).at(-1)!);
      expect(await within(thread).findByText('D’accord')).toBeInTheDocument();

      await user.click(within(thread).getAllByRole('button', { name: 'Modifier' })[0]!);
      const box = within(thread).getByRole('textbox', { name: 'Commentaire' });
      await user.clear(box);
      await user.type(box, 'À reformuler vite');
      await user.click(within(thread).getByRole('button', { name: 'Appliquer' }));
      expect(await within(thread).findByText('À reformuler vite')).toBeInTheDocument();
      expect(within(thread).getByText(/modifié/)).toBeInTheDocument();

      await user.click(within(thread).getByRole('button', { name: 'Résoudre' }));
      await waitFor(() =>
        expect(within(panel).queryByRole('listitem', { name: /Fil sur/ })).not.toBeInTheDocument(),
      );
      await user.click(within(panel).getByRole('button', { name: /Résolus/ }));
      const resolved = await within(panel).findByRole('listitem', { name: 'Fil sur « passage »' });
      expect(within(resolved).getByText(/Résolu par/)).toBeInTheDocument();
      expect(ed.getHTML()).toContain('data-comment-thread'); // l'ancrage reste
      await user.click(within(resolved).getByRole('button', { name: 'Rouvrir' }));
      await user.click(within(panel).getByRole('button', { name: /Ouverts/ }));
      expect(
        await within(panel).findByRole('listitem', { name: 'Fil sur « passage »' }),
      ).toBeInTheDocument();
    });

    it('supprimer le dernier message supprime le fil et son ancrage ; supprimer un fil retire l’ancrage', async () => {
      const { user, ctx, ed } = await setup();
      select(ed, 4, 11);
      const panel = await comment(user, 'Premier');
      const thread = await within(panel).findByRole('listitem', { name: /Fil sur/ });
      await user.click(within(thread).getByRole('button', { name: 'Supprimer' }));
      await waitFor(() => expect(ctx.api.threads).toHaveLength(0));
      await waitFor(() => expect(ed.getHTML()).not.toContain('data-comment-thread'));
      expect(ed.getText()).toContain('passage'); // le texte reste

      select(ed, 12, 21); // « important »
      await comment(user, 'Autre');
      const t2 = await within(panel).findByRole('listitem', { name: /Fil sur/ });
      await user.click(within(t2).getByRole('button', { name: 'Supprimer le fil' }));
      await waitFor(() => expect(ctx.api.threads).toHaveLength(0));
      await waitFor(() => expect(ed.getHTML()).not.toContain('data-comment-thread'));
    });

    it('sans sélection : message ; échec de création : aucun ancrage ; fil orphelin signalé', async () => {
      const { user, ctx, ed } = await setup();
      act(() => void ed.commands.setTextSelection(3));
      await user.click(tool('Commenter la sélection'));
      expect(await screen.findByText(/Sélectionnez d'abord du texte/)).toBeInTheDocument();

      select(ed, 4, 11);
      ctx.api.threadCreate.mockRejectedValueOnce({
        code: 'io',
        messageKey: 'errors.io',
        retryable: true,
      });
      const panel = await comment(user, 'Va échouer');
      await waitFor(() => expect(ctx.api.threadCreate).toHaveBeenCalled());
      expect(ed.getHTML()).not.toContain('data-comment-thread');
      expect(within(panel).queryByRole('listitem', { name: /Fil sur/ })).not.toBeInTheDocument();

      // un fil dont le texte a disparu reste lisible et supprimable
      const nodeId = ctx.api.nodes[0]!.id;
      ctx.api.threads.push({
        id: '0192f0a0-0000-7000-8000-0000000000aa',
        nodeId,
        quote: 'texte disparu',
        createdAt: '2026-06-17T10:00:00.000Z',
        createdBy: null,
        resolvedAt: null,
        resolvedBy: null,
        comments: [
          {
            id: 'cx',
            threadId: '0192f0a0-0000-7000-8000-0000000000aa',
            body: 'Orphelin',
            author: null,
            createdAt: '2026-06-17T10:00:00.000Z',
            editedAt: null,
          },
        ],
      });
      await user.click(screen.getByRole('button', { name: 'Fermer les commentaires' }));
      await user.click(screen.getByRole('button', { name: 'Commentaires' }));
      const orphan = await screen.findByRole('listitem', { name: 'Fil sur « texte disparu »' });
      expect(within(orphan).getByText(/n'existe plus/)).toBeInTheDocument();
    });

    it('commentaires reçus d’un autre membre : relus après synchronisation, modifiables seulement par leur auteur ou un administrateur', async () => {
      const { user, ctx, ed } = await setup();
      select(ed, 4, 11);
      await comment(user, 'Mon avis');
      const nodeId = ctx.api.nodes[0]!.id;
      const tid = '0192f0a0-0000-7000-8000-0000000000bb';
      ctx.api.threads.push({
        id: tid,
        nodeId,
        quote: 'texte de Bob',
        createdAt: '2026-06-17T10:00:00.000Z',
        createdBy: 'bob@example.com',
        resolvedAt: null,
        resolvedBy: null,
        comments: [
          {
            id: 'cb1',
            threadId: tid,
            body: 'Message de Bob',
            author: 'bob@example.com',
            createdAt: '2026-06-17T10:00:00.000Z',
            editedAt: null,
          },
        ],
      });
      // la synchronisation vient d'appliquer des données distantes : le panneau se relit tout seul
      act(() => bus.emit('sync-applied', {}));
      const theirs = await screen.findByRole('listitem', { name: 'Fil sur « texte de Bob »' });
      expect(within(theirs).getByText('Message de Bob')).toBeInTheDocument();
      expect(within(theirs).getByText(/bob@example.com/)).toBeInTheDocument();
      act(() => ctx.account.setState({ email: 'ada@example.com' }));
      // pas administrateur de cet espace : ni modifier ni supprimer le message de Bob, ni son fil
      act(() => ctx.pages.setState({ role: 'editor' }));
      await waitFor(() =>
        expect(within(theirs).queryByRole('button', { name: 'Modifier' })).not.toBeInTheDocument(),
      );
      expect(within(theirs).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument();
      expect(
        within(theirs).queryByRole('button', { name: 'Supprimer le fil' }),
      ).not.toBeInTheDocument();
      // résoudre reste possible pour tout éditeur
      expect(within(theirs).getByRole('button', { name: 'Résoudre' })).toBeInTheDocument();
      // un administrateur modère
      act(() => ctx.pages.setState({ role: 'admin' }));
      expect(await within(theirs).findByRole('button', { name: 'Modifier' })).toBeInTheDocument();
    });

    it('cliquer sur un passage commenté ouvre le panneau ; en lecture seule on ne peut pas créer de fil', async () => {
      const { user, ctx, ed } = await setup();
      select(ed, 4, 11);
      await comment(user, 'Note');
      await user.click(screen.getByRole('button', { name: 'Fermer les commentaires' }));
      expect(screen.queryByRole('complementary', { name: 'Commentaires' })).not.toBeInTheDocument();
      const id = ctx.api.threads[0]!.id;
      act(() => void window.dispatchEvent(new CustomEvent('slate:comment-open', { detail: id })));
      expect(
        await screen.findByRole('complementary', { name: 'Commentaires' }),
      ).toBeInTheDocument();

      await user.keyboard('{Control>}{Shift>}e{/Shift}{/Control}');
      await waitFor(() =>
        expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false'),
      );
      expect(
        screen.getByText(/adding comments is disabled|l'ajout de commentaires est désactivé/),
      ).toBeInTheDocument();
      // les réponses restent possibles en lecture seule
      const thread = screen.getByRole('listitem', { name: /Fil sur/ });
      await user.type(within(thread).getByRole('textbox', { name: /Répondre/ }), 'En lecture');
      await user.click(within(thread).getAllByRole('button', { name: 'Envoyer' }).at(-1)!);
      expect(await within(thread).findByText('En lecture')).toBeInTheDocument();
    });
  });

  describe('liens et collage', () => {
    const setup = async () => {
      const user = userEvent.setup();
      const ctx = await renderApp();
      const ed = await newPage(user);
      act(() => void ed.commands.insertContent('<p>voir ce texte ici</p>'));
      return { user, ctx, ed };
    };
    const dialog = () => screen.findByRole('dialog', { name: 'Lien' });

    it('insère un lien sur la sélection avec normalisation, refuse les adresses dangereuses', async () => {
      const { user, ed } = await setup();
      act(() => void ed.commands.setTextSelection({ from: 6, to: 11 } as never)); // « ce te »
      await user.click(tool('Lien'));
      const dlg = await dialog();
      const url = within(dlg).getByRole('textbox', { name: 'Adresse du lien' });
      await user.type(url, 'javascript:alert(1)');
      expect(await within(dlg).findByRole('alert')).toBeInTheDocument();
      expect(within(dlg).getByRole('button', { name: 'Appliquer' })).toBeDisabled();
      await user.clear(url);
      await user.type(url, 'example.com/page');
      expect(await within(dlg).findByText(/https:\/\/example\.com\/page/)).toBeInTheDocument();
      expect(await axe(dlg)).toHaveNoViolations();
      await user.click(within(dlg).getByRole('button', { name: 'Appliquer' }));
      await waitFor(() => expect(ed.getHTML()).toContain('href="https://example.com/page"'));
      expect(ed.getHTML()).not.toMatch(/javascript:/);
    });

    it('sans sélection : insère un lien avec son texte ; une page de Slate devient un lien interne', async () => {
      const { user, ctx, ed } = await setup();
      act(() => void ed.commands.focus());
      await user.click(tool('Lien'));
      const dlg = await dialog();
      await user.type(within(dlg).getByRole('textbox', { name: 'Texte affiché' }), 'Mon site');
      await user.type(
        within(dlg).getByRole('textbox', { name: 'Adresse du lien' }),
        'ada@example.com',
      );
      await user.click(within(dlg).getByRole('button', { name: 'Appliquer' }));
      await waitFor(() => expect(ed.getHTML()).toContain('href="mailto:ada@example.com"'));
      expect(ed.getHTML()).toContain('>Mon site</a>');

      // lien vers une autre page
      await user.click(screen.getAllByRole('button', { name: 'Nouvelle page' })[0]!);
      await waitFor(() => expect(ctx.api.nodes.length).toBe(2));
      await user.type(await screen.findByRole('textbox', { name: 'Titre de la page' }), 'Cible');
      await waitFor(() => expect(editorOf()).not.toBe(ed)); // l'éditeur de la nouvelle page est monté
      const ed2 = editorOf();
      act(() => void ed2.commands.focus());
      await user.click(tool('Lien'));
      const d2 = await dialog();
      await user.click(await within(d2).findByRole('button', { name: 'Cible' }));
      await user.click(within(d2).getByRole('button', { name: 'Appliquer' }));
      await waitFor(() => expect(ed2.getHTML()).toMatch(/href="slate:\/\/page\/[0-9a-f-]{36}"/));
    });

    it('carte du lien au curseur : ouvrir (navigateur ou page), copier, retirer', async () => {
      const { user, ctx, ed } = await setup();
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      act(
        () =>
          void ed.commands.setContent(
            '<p>va sur <a href="https://example.com/x">example</a> maintenant</p>',
          ),
      );
      act(() => void ed.commands.setTextSelection(10));
      const card = await screen.findByRole('group', { name: 'Lien' });
      expect(within(card).getByText('https://example.com/x')).toBeInTheDocument();
      await user.click(within(card).getByRole('button', { name: 'Ouvrir' }));
      await waitFor(() =>
        expect(ctx.api.openExternal).toHaveBeenCalledWith('https://example.com/x'),
      );
      await user.click(within(card).getByRole('button', { name: "Copier l'adresse" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/x'));
      await user.click(within(card).getByRole('button', { name: 'Retirer le lien' }));
      await waitFor(() => expect(ed.getHTML()).not.toContain('<a '));
      expect(ed.getText()).toContain('example');
    });

    it('Ctrl+clic ouvre ; en lecture seule un simple clic ouvre ; un lien interne ouvre la page', async () => {
      const { user, ctx, ed } = await setup();
      act(() => void ed.commands.setContent('<p><a href="https://example.com/a">externe</a></p>'));
      const a = document.querySelector('.ProseMirror a') as HTMLElement;
      await user.click(a); // simple clic en édition : curseur seulement
      expect(ctx.api.openExternal).not.toHaveBeenCalled();
      await user.keyboard('{Control>}');
      await user.click(a);
      await user.keyboard('{/Control}');
      await waitFor(() => expect(ctx.api.openExternal).toHaveBeenCalledTimes(1));

      act(() => useWritingMode.getState().setReadMode(true)); // (le raccourci est testé dans writingMode.test.tsx)
      await waitFor(() =>
        expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false'),
      );
      await user.click(document.querySelector('.ProseMirror a') as HTMLElement);
      await waitFor(() => expect(ctx.api.openExternal).toHaveBeenCalledTimes(2));
    });

    it('collage : site web normalisé, Word conservé ; menu « Coller » ; texte brut', async () => {
      const { user, ed } = await setup();
      const web = '<p style="color:#ff0000;text-align:center">collé <strong>web</strong></p>';
      const word =
        '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal><span style="color:#0000ff">bleu<o:p></o:p></span></p></body></html>';
      const read = vi.fn(async () => [
        { types: ['text/html'], getType: async () => new Blob([web], { type: 'text/html' }) },
      ]);
      const readText = vi.fn(async () => 'brut <i>littéral</i>');
      Object.defineProperty(navigator, 'clipboard', {
        value: { read, readText, writeText: vi.fn() },
        configurable: true,
      });
      act(() => void ed.commands.focus());
      act(() => void ed.commands.selectAll());
      await user.click(screen.getByRole('button', { name: 'Coller' }));
      await user.click(
        await screen.findByRole('menuitem', { name: 'Coller avec la mise en forme' }),
      );
      await waitFor(() => expect(ed.getHTML()).toContain('<strong>web</strong>'));
      expect(ed.getHTML()).toContain('data-doc-color="#ff0000"'); // « avec la mise en forme » : conservée même depuis le web

      act(() => void ed.commands.selectAll());
      await user.click(screen.getByRole('button', { name: 'Coller' }));
      await user.click(
        await screen.findByRole('menuitem', {
          name: 'Coller en conservant les formats compatibles',
        }),
      );
      await waitFor(() => expect(ed.getHTML()).not.toContain('data-doc-color'));
      expect(ed.getHTML()).toContain('<strong>web</strong>');

      read.mockResolvedValueOnce([
        { types: ['text/html'], getType: async () => new Blob([word], { type: 'text/html' }) },
      ]);
      act(() => void ed.commands.selectAll());
      await user.click(screen.getByRole('button', { name: 'Coller' }));
      await user.click(
        await screen.findByRole('menuitem', { name: 'Coller avec la mise en forme' }),
      );
      await waitFor(() => expect(ed.getHTML()).toContain('data-doc-color="#0000ff"'));

      act(() => void ed.commands.selectAll());
      await user.click(screen.getByRole('button', { name: 'Coller' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Coller en texte brut' }));
      await waitFor(() => expect(ed.getText()).toContain('brut <i>littéral</i>'));
      expect(ed.getHTML()).not.toContain('<i>');
    });

    it('collage : presse-papiers illisible -> message, document intact', async () => {
      const { user, ed } = await setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          read: vi.fn(async () => {
            throw new Error('refusé');
          }),
          readText: vi.fn(async () => {
            throw new Error('refusé');
          }),
        },
        configurable: true,
      });
      const before = ed.getHTML();
      await user.click(screen.getByRole('button', { name: 'Coller' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Coller en texte brut' }));
      expect(await screen.findByText(/Impossible de lire le presse-papiers/)).toBeInTheDocument();
      expect(ed.getHTML()).toBe(before);
    });
  });

  describe('listes et paragraphes', () => {
    const setup = async (html: string) => {
      const user = userEvent.setup();
      const ctx = await renderApp();
      const ed = await newPage(user);
      act(() => void ed.commands.insertContent(html));
      act(() => void ed.commands.focus());
      return { user, ctx, ed };
    };
    const at = (ed: PMEditor, text: string) => {
      let pos = -1;
      (
        ed as unknown as {
          state: {
            doc: {
              descendants(f: (n: { isText: boolean; text?: string }, p: number) => void): void;
            };
          };
        }
      ).state.doc.descendants((n, p) => void (n.isText && n.text === text && (pos = p)));
      return pos;
    };

    it('style de liste, retrait et déplacement depuis la barre contextuelle', async () => {
      const { user, ed } = await setup(
        '<ul><li><p>un</p></li><li><p>deux</p></li><li><p>trois</p></li></ul>',
      );
      act(() => void ed.commands.setTextSelection(at(ed, 'deux') + 1));
      const bar = await screen.findByRole('toolbar', { name: 'Outils de liste' });
      await user.selectOptions(
        within(bar).getByRole('combobox', { name: 'Style de liste' }),
        'square',
      );
      expect(ed.getHTML()).toContain('data-list-style="square"');
      await user.click(within(bar).getByRole('button', { name: "Monter l'élément" }));
      await waitFor(() =>
        expect([...document.querySelectorAll('.ProseMirror li')].map((l) => l.textContent)).toEqual(
          ['deux', 'un', 'trois'],
        ),
      );
      await user.click(within(bar).getByRole('button', { name: "Descendre l'élément" }));
      await waitFor(() =>
        expect([...document.querySelectorAll('.ProseMirror li')].map((l) => l.textContent)).toEqual(
          ['un', 'deux', 'trois'],
        ),
      );
      expect(await axe(bar)).toHaveNoViolations();
      // numérotation : alphabétique puis romaine
      await user.click(tool('Liste numérotée'));
      const bar2 = await screen.findByRole('toolbar', { name: 'Outils de liste' });
      await user.selectOptions(
        within(bar2).getByRole('combobox', { name: 'Style de liste' }),
        'upper-roman',
      );
      expect(ed.getHTML()).toContain('data-list-style="upper-roman"');
    });

    it('Tab / Maj+Tab indentent la liste, Alt+Maj+↓ déplace l’élément, Entrée deux fois sort de la liste', async () => {
      // Le clavier est simulé directement sur l'éditeur : sous charge, le focus du navigateur simulé n'est pas fiable.
      const key = (k: string, mods: object = {}) =>
        fireEvent.keyDown(document.querySelector('.ProseMirror')!, { key: k, ...mods });
      const { ed } = await setup('<ul><li><p>un</p></li><li><p>deux</p></li></ul>');
      act(() => void ed.commands.setTextSelection(at(ed, 'deux') + 4));
      act(() => void ed.commands.focus()); // le clavier doit viser l'éditeur, même sous charge
      key('Tab');
      await waitFor(() => expect(document.querySelectorAll('.ProseMirror ul ul').length).toBe(1));
      key('Tab', { shiftKey: true });
      await waitFor(() => expect(document.querySelectorAll('.ProseMirror ul ul').length).toBe(0));
      act(() => void ed.commands.setTextSelection(at(ed, 'un') + 2));
      act(() => void ed.commands.focus());
      key('ArrowDown', { altKey: true, shiftKey: true });
      await waitFor(() =>
        expect([...document.querySelectorAll('.ProseMirror li')].map((l) => l.textContent)).toEqual(
          ['deux', 'un'],
        ),
      );
      act(() => void ed.commands.setTextSelection(at(ed, 'un') + 2));
      act(() => void ed.commands.focus());
      key('Enter');
      await waitFor(() => expect(document.querySelectorAll('.ProseMirror li').length).toBe(3));
      key('Enter');
      await waitFor(() => expect(document.querySelectorAll('.ProseMirror li').length).toBe(2));
      expect(ed.getHTML()).toMatch(/<\/ul><p><\/p>/);
    });

    it('liste de tâches : barre de progression activable et accessible', async () => {
      const { user, ed } = await setup(
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>fait</p></li><li data-type="taskItem" data-checked="false"><p>à faire</p></li></ul>',
      );
      act(() => void ed.commands.setTextSelection(at(ed, 'fait') + 1));
      const bar = await screen.findByRole('toolbar', { name: 'Outils de liste' });
      await user.click(within(bar).getByRole('button', { name: 'Barre de progression' }));
      const pb = await screen.findByRole('progressbar', { name: '1 sur 2 tâches terminées' });
      expect(pb).toHaveAttribute('aria-valuenow', '1');
      expect(pb).toHaveAttribute('aria-valuemax', '2');
      const checkboxes = document.querySelectorAll<HTMLInputElement>(
        '.ProseMirror input[type=checkbox]',
      );
      await user.click(checkboxes[1]!);
      expect(
        await screen.findByRole('progressbar', { name: '2 sur 2 tâches terminées' }),
      ).toBeInTheDocument();
    });

    it('retrait des paragraphes, retrait à droite et espacements depuis le menu ¶', async () => {
      const { user, ed } = await setup('<p>premier</p><p>second</p>');
      act(() => void ed.commands.selectAll());
      await user.click(tool('Augmenter le retrait'));
      await user.click(tool('Augmenter le retrait'));
      expect((ed.getHTML().match(/data-indent="2"/g) ?? []).length).toBe(2);
      await user.click(tool('Diminuer le retrait'));
      expect((ed.getHTML().match(/data-indent="1"/g) ?? []).length).toBe(2);
      await user.click(tool('Paragraphe'));
      const pop = await screen.findByRole('dialog', { name: 'Outils de paragraphe' });
      await user.click(within(pop).getByRole('button', { name: 'Retrait à droite' }));
      await user.selectOptions(within(pop).getByRole('combobox', { name: 'Espace avant' }), '16');
      await user.selectOptions(within(pop).getByRole('combobox', { name: 'Espace après' }), '8');
      const html = ed.getHTML();
      // (le navigateur regroupe les marges en un raccourci CSS : on vérifie les valeurs validées stockées)
      expect(html).toContain('data-indent-right="1"');
      expect(html).toContain('data-space-before="16"');
      expect(html).toContain('data-space-after="8"');
      expect(html).toContain('margin: 16px 1.5rem 8px');
      expect(await axe(pop)).toHaveNoViolations();
      await user.click(within(pop).getByRole('button', { name: 'Réinitialiser le paragraphe' }));
      await waitFor(() => expect(ed.getHTML()).toBe('<p>premier</p><p>second</p>'));
    });

    it('raccourci Ctrl+Alt+→ / ← pour le retrait', async () => {
      const { user, ed } = await setup('<p>texte</p>');
      act(() => void ed.commands.setTextSelection(at(ed, 'texte') + 2));
      await user.keyboard('{Control>}{Alt>}{ArrowRight}{/Alt}{/Control}');
      expect(ed.getHTML()).toContain('data-indent="1"');
      await user.keyboard('{Control>}{Alt>}{ArrowLeft}{/Alt}{/Control}');
      expect(ed.getHTML()).not.toContain('data-indent');
    });
  });
});

describe('éditeur détruit (régression)', () => {
  it("détruire l'éditeur puis ouvrir les volets ne produit pas « Une erreur inattendue »", async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = (await newPage(user)) as unknown as { destroy(): void };
    ed.destroy();
    await user.click(screen.getByRole('button', { name: 'Historique des versions' }));
    expect(
      await screen.findByRole('dialog', { name: 'Historique des versions' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Commentaires' }));
    expect(screen.queryByText(/erreur inattendue/i)).not.toBeInTheDocument();
  });

  describe('barre masquable et menu du clic droit', () => {
    const setup = async (html: string) => {
      const user = userEvent.setup();
      const ctx = await renderApp();
      const ed = await newPage(user);
      act(() => void ed.commands.insertContent(html));
      act(() => void ed.commands.focus());
      return { user, ctx, ed };
    };
    const rightClick = (target?: Element) =>
      fireEvent.contextMenu(target ?? document.querySelector('.ProseMirror')!, {
        clientX: 40,
        clientY: 40,
      });
    const menuEl = () => screen.findByRole('menu', { name: 'Actions rapides' });

    it('la barre se masque avec une petite flèche, reste masquée d’une page à l’autre et se réaffiche', async () => {
      const { user, ctx } = await setup('<p>texte</p>');
      await user.click(tool('Masquer la barre de mise en forme'));
      expect(
        screen.queryByRole('toolbar', { name: 'Barre de mise en forme' }),
      ).not.toBeInTheDocument();
      const arrow = screen.getByRole('button', { name: 'Afficher la barre de mise en forme' });
      expect(arrow).toHaveAttribute('aria-expanded', 'false');
      await waitFor(() =>
        expect(ctx.api.settingsSet).toHaveBeenCalledWith('pref.toolbar-collapsed', 'true'),
      );
      // une autre page : la barre reste masquée (préférence mémorisée)
      await user.click(screen.getAllByRole('button', { name: 'Nouvelle page' })[0]!);
      await waitFor(() => expect(ctx.api.nodes.length).toBe(2));
      await screen.findByRole('textbox', { name: 'Titre de la page' });
      expect(
        screen.queryByRole('toolbar', { name: 'Barre de mise en forme' }),
      ).not.toBeInTheDocument();
      expect(
        await axe(screen.getByRole('button', { name: 'Afficher la barre de mise en forme' })),
      ).toHaveNoViolations();
      await user.click(screen.getByRole('button', { name: 'Afficher la barre de mise en forme' }));
      expect(
        await screen.findByRole('toolbar', { name: 'Barre de mise en forme' }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(ctx.api.settingsSet).toHaveBeenCalledWith('pref.toolbar-collapsed', 'false'),
      );
    });

    it('clic droit sur une sélection : mise en forme rapide, états cochés, sous-menus', async () => {
      const { user, ed } = await setup('<p>un mot important ici</p>');
      act(() => void ed.commands.setTextSelection({ from: 4, to: 7 } as never));
      rightClick();
      const menu = await menuEl();
      expect(within(menu).getByRole('menuitem', { name: /Couper/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(within(menu).getByRole('menuitemcheckbox', { name: /Gras/ })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(await axe(menu)).toHaveNoViolations();
      await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Gras/ }));
      await waitFor(() => expect(ed.getHTML()).toContain('<strong>mot</strong>'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      // la sélection est conservée et le focus revient dans le document
      expect(document.activeElement).toBe(document.querySelector('.ProseMirror'));
      rightClick();
      const m2 = await menuEl();
      expect(within(m2).getByRole('menuitemcheckbox', { name: /Gras/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await user.click(within(m2).getByRole('menuitem', { name: 'Surlignage' }));
      // (sous-menus : clic direct ; sous jsdom la « zone de grâce » du pointeur de Radix referme le sous-menu pendant un vrai geste)
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rose' }));
      await waitFor(() => expect(ed.getHTML()).toContain('data-color="pink"'));
    });

    it('sous-menus Paragraphe, Listes et Insérer ; effacer le formatage ; Échap ferme', async () => {
      const { user, ed } = await setup('<p><strong>gras</strong> texte</p>');
      act(() => void ed.commands.setTextSelection({ from: 2, to: 4 } as never));
      rightClick();
      let menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: 'Paragraphe' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Titre 2' }));
      await waitFor(() => expect(ed.getHTML()).toContain('<h2'));
      act(() => void ed.commands.selectAll());
      rightClick();
      menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: /Supprimer le formatage/ }));
      await waitFor(() => expect(ed.getHTML()).not.toContain('<strong>'));
      rightClick();
      menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: 'Insérer' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Insérer un tableau' }));
      await waitFor(() => expect(ed.getHTML()).toContain('<table'));
      rightClick();
      await menuEl();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('sans sélection : le clic droit place le curseur, Couper/Copier sont grisés', async () => {
      const { ed } = await setup('<p>alpha beta</p>');
      act(() => void ed.commands.setTextSelection({ from: 2, to: 4 } as never));
      rightClick(); // la sélection existe
      await menuEl();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      act(() => void ed.commands.setTextSelection(3));
      rightClick();
      const menu = await menuEl();
      expect(within(menu).getByRole('menuitem', { name: /Couper/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(within(menu).getByRole('menuitem', { name: /^Copier/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('sur un lien : ouvrir, copier l’adresse, retirer ; dans un tableau : sous-menu Tableau', async () => {
      const { user, ctx, ed } = await setup('<p>un <a href="https://example.com/x">lien</a></p>');
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const a = document.querySelector('.ProseMirror a') as HTMLElement;
      rightClick(a);
      let menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: 'Ouvrir' }));
      await waitFor(() =>
        expect(ctx.api.openExternal).toHaveBeenCalledWith('https://example.com/x'),
      );
      rightClick(a);
      menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: "Copier l'adresse" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/x'));
      rightClick(a);
      menu = await menuEl();
      await user.click(within(menu).getByRole('menuitem', { name: 'Retirer le lien' }));
      await waitFor(() => expect(ed.getHTML()).not.toContain('<a '));
      // tableau
      act(
        () =>
          void (ed as unknown as { chain(): { insertTable(a: object): { run(): boolean } } })
            .chain()
            .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
            .run(),
      );
      rightClick(document.querySelector('.ProseMirror td, .ProseMirror th') as Element);
      menu = await menuEl();
      expect(within(menu).getByRole('menuitem', { name: 'Tableau' })).toBeInTheDocument();
    });

    it('en lecture seule : seulement copier et tout sélectionner (plus de mise en forme)', async () => {
      const { user } = await setup('<p>texte lu</p>');
      act(() => useWritingMode.getState().setReadMode(true));
      await waitFor(() =>
        expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false'),
      );
      rightClick();
      const menu = await menuEl();
      expect(within(menu).getByRole('menuitem', { name: /Tout sélectionner/ })).toBeInTheDocument();
      expect(
        within(menu).queryByRole('menuitemcheckbox', { name: /Gras/ }),
      ).not.toBeInTheDocument();
      expect(within(menu).queryByRole('menuitem', { name: /Couper/ })).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
    });
  });
});

describe('présence en direct', () => {
  /** Un « autre participant » : un second Y.Doc / Awareness qui partage l'historique de la page ouverte. */
  const remote = (ydoc: Y.Doc, name: string, at: number | null) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(ydoc));
    d.clientID = 4242;
    const aw = new Awareness(d);
    const frag = d.getXmlFragment('default');
    aw.setLocalState({
      user: { name },
      cursor:
        at === null
          ? undefined
          : {
              anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(frag, at)),
              head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(frag, at)),
            },
    });
    const u = encodeAwarenessUpdate(aw, [4242]);
    aw.destroy();
    return u;
  };

  it('page ouverte : le service est attaché, les présents sont annoncés, le curseur distant est dessiné avec le NOM en texte', async () => {
    const user = userEvent.setup();
    const detach = vi.fn();
    let attached: { nodeId: string; ydoc: Y.Doc; awareness: Awareness } | null = null;
    const presence: PresenceService = {
      attach: (nodeId, ydoc, awareness) => {
        attached = { nodeId, ydoc, awareness };
        return detach;
      },
    };
    await renderApp({}, { presence });
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>un texte partagé</p>'));
    await waitFor(() => expect(attached).not.toBeNull());
    const a = attached!;
    expect(a.nodeId).toMatch(/[0-9a-f-]{36}/);
    // personne d'autre : rien d'affiché
    expect(screen.queryByText(/^Avec :/)).not.toBeInTheDocument();
    // un participant arrive, nom hostile compris
    act(() =>
      applyAwarenessUpdate(
        a.awareness,
        remote(a.ydoc, '<img src=x onerror=alert(1)>', 3),
        'realtime',
      ),
    );
    expect(await screen.findByText(/Avec : <img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector('[onerror], img[src="x"]')).toBeNull();
    const label = await waitFor(() => {
      const l = document.querySelector('.slate-remote-caret-label');
      expect(l).not.toBeNull();
      return l!;
    });
    expect(label.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(label.children.length).toBe(0); // du texte, jamais du HTML
    // il part : le curseur et l'annonce disparaissent
    act(() =>
      applyAwarenessUpdate(
        a.awareness,
        (() => {
          const d = new Y.Doc();
          d.clientID = 4242;
          const aw = new Awareness(d);
          aw.setLocalState({ user: { name: 'x' } });
          aw.setLocalState(null);
          const u = encodeAwarenessUpdate(aw, [4242]);
          aw.destroy();
          return u;
        })(),
        'realtime',
      ),
    );
    await waitFor(() => expect(screen.queryByText(/^Avec :/)).not.toBeInTheDocument());
    // fermeture de la page : détachement
    await user.click(screen.getByRole('button', { name: 'Accueil' }));
    await waitFor(() => expect(detach).toHaveBeenCalled());
  });

  it('sans service (invité, cloud absent) : éditeur local, aucune barre de présence', async () => {
    const user = userEvent.setup();
    await renderApp();
    await newPage(user);
    expect(screen.queryByText(/^Avec :/)).not.toBeInTheDocument();
    expect(document.querySelector('.slate-remote-caret')).toBeNull();
  });
});
