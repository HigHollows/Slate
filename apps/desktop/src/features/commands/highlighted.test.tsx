import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Highlighted } from './Highlighted';

describe('Highlighted', () => {
  it('met en gras les correspondances et traite le HTML comme du texte', () => {
    const { container } = render(
      <Highlighted
        text={`avant ${String.fromCharCode(2)}<b>x</b>${String.fromCharCode(3)} après`}
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('<b>x</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('avant <b>x</b> après');
  });
  it('tolère les marqueurs non fermés et le texte vide', () => {
    expect(
      render(<Highlighted text={`${String.fromCharCode(2)}ouvert`} />).container.querySelector(
        'strong',
      )?.textContent,
    ).toBe('ouvert');
    expect(render(<Highlighted text="" />).container.textContent).toBe('');
  });
});
