import { initialsOf } from '@/lib/adventurers';

/**
 * An adventurer's portrait: the fallback until art exists (#198), dyed cloth
 * with their initials stitched on, like a campaign with no banner. 3:4 for a
 * framed portrait; `face` is the round 1:1 for medallions. Decorative: the
 * name is always written beside it.
 */
export default function Portrait({ name, face = false }: { name: string; face?: boolean }) {
  return (
    <span className={face ? 'hs-adv-pt is-face' : 'hs-adv-pt'} aria-hidden="true">
      <span className="hs-adv-pt-none"><span>{initialsOf(name)}</span></span>
    </span>
  );
}
