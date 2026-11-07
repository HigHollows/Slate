import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);

// jsdom n'implémente pas ces API utilisées par Radix et l'interface.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// ProseMirror interroge la géométrie des Range (absente de jsdom).
const emptyRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
document.elementFromPoint ??= () => null;

// Le virtualiseur lit clientWidth/clientHeight de son conteneur (nuls sous jsdom) : on lui en donne pour les tests.
for (const [prop, size] of [
  ['clientHeight', 800],
  ['clientWidth', 1200],
  ['offsetHeight', 800],
  ['offsetWidth', 1200],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-virtual-scroller') ? size : 0;
    },
  });
}

// jsdom n'implémente pas les URL d'objets (images de l'éditeur).
if (!URL.createObjectURL) {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => undefined;
}

// La suite complète rend l'application des dizaines de fois en parallèle : 1 s (défaut) ne suffit pas sous charge pour
// attendre un état de l'interface. Un test qui échoue vraiment échoue quand même, simplement après 5 s.
configure({ asyncUtilTimeout: 5000 });
