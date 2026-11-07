/** Marque Slate Ω (voir brand/slate-omega.svg) : un seul tracé géométrique, aucun élément intérieur. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 50H25.755A20 20 0 1 1 38.245 50H56" stroke="currentColor" strokeWidth="5" />
    </svg>
  );
}
