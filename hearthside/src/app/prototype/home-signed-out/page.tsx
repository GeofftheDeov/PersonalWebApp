"use client";

/*
 * PROTOTYPE — throwaway. Four structurally different takes on Hearthside's
 * home for someone who isn't signed in, switchable via `?variant=A|B|C|D`
 * and the floating bar at the bottom. On the floor, under the real top bar,
 * outside the shell (no rail, no Letters), as the sign-in pages are.
 *
 * Nothing here signs anyone in: links go to the real /login and /signup, and
 * B's inline form is a stub. The winner gets rebuilt properly on `/`; the rest
 * stays on the prototype branch. See README.md beside this file.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import PrototypeSwitcher from '@/components/prototype/PrototypeSwitcher';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';
import VariantD from './VariantD';
import './prototype.css';

const VARIANTS = [
  { key: 'A', name: 'The notice', View: VariantA },
  { key: 'B', name: 'At the door', View: VariantB },
  { key: 'C', name: 'The week', View: VariantC },
  { key: 'D', name: 'The round table', View: VariantD },
];

function Switch() {
  const key = useSearchParams()?.get('variant')?.toUpperCase() ?? 'A';
  const current = VARIANTS.find((v) => v.key === key) ?? VARIANTS[0];
  const { View } = current;
  return (
    <>
      <View />
      <PrototypeSwitcher variants={VARIANTS.map(({ key: k, name }) => ({ key: k, name }))} current={current.key} />
    </>
  );
}

export default function SignedOutHomePrototype() {
  return <Suspense><Switch /></Suspense>;
}
