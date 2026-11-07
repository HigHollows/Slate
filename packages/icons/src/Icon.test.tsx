import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, ICON_NAMES } from './Icon';

describe('Icon', () => {
  it('expose le catalogue Papicons vendu', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(90);
    expect(ICON_NAMES).toContain('search');
  });
  it('est décorative sans label et accessible avec label', () => {
    const { container, rerender } = render(<Icon name="search" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Icon name="search" label="Rechercher" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-label', 'Rechercher');
  });
  it('utilise currentColor et aucune couleur en dur', () => {
    const { container } = render(<Icon name="home" />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}|black/i);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });
});
