import { create } from 'zustand';

/**
 * États d'affichage de l'éditeur, volontairement NON persistés : l'application redémarre toujours en mode édition
 * (un mode lecture mémorisé donnerait l'impression qu'un document est verrouillé). La largeur de lecture, elle, est une préférence.
 */
interface WritingModeState {
  readMode: boolean;
  focusMode: boolean;
  setReadMode(on: boolean): void;
  setFocusMode(on: boolean): void;
  toggleReadMode(): void;
  toggleFocusMode(): void;
}

export const useWritingMode = create<WritingModeState>((set) => ({
  readMode: false,
  focusMode: false,
  setReadMode: (readMode) => set({ readMode }),
  setFocusMode: (focusMode) => set({ focusMode }),
  toggleReadMode: () => set((s) => ({ readMode: !s.readMode })),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
}));

/** Classe de largeur du document selon la préférence de largeur de lecture. */
export const WIDTH_CLASS = {
  narrow: 'max-w-xl',
  normal: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: 'max-w-none',
} as const;
