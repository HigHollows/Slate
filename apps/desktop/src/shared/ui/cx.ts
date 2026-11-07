export const cx = (...c: (string | false | null | undefined)[]): string =>
  c.filter(Boolean).join(' ');
