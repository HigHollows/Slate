import * as S from '@radix-ui/react-switch';

export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange(v: boolean): void;
  label: string;
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-5 w-9 rounded-full bg-pressed transition-colors data-[state=checked]:bg-accent"
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[1.125rem]" />
    </S.Root>
  );
}
