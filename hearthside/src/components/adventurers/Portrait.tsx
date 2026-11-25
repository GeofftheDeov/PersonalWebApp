import { initialsOf } from '@/lib/adventurers';

/**
 * An adventurer's portrait (#273): their art, or, until there is some, dyed
 * cloth with their initials stitched on, like a campaign with no banner. 3:4
 * for a framed portrait; `face` is the round 1:1 for medallions, zoomed onto
 * the head (the top of a 3:4 portrait). Decorative: the name is always
 * written beside it.
 */
export default function Portrait({ name, src, face = false }: { name: string; src?: string | null; face?: boolean }) {
  return (
    <span className={face ? 'hs-adv-pt is-face' : 'hs-adv-pt'} aria-hidden="true">
      {src
        ? <img className="hs-adv-pt-img" src={src} alt="" loading="lazy" decoding="async" draggable={false} />
        : <span className="hs-adv-pt-none"><span>{initialsOf(name)}</span></span>}
    </span>
  );
}
