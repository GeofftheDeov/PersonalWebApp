import type { ReactNode } from 'react';
import type { StepState } from '@/lib/noticeBoard';

/**
 * PlannerSteps (the design system's): a session's numbered steps on its
 * parchment, the one under way marked in the seal's red, finished ones
 * inked in. Each step's body is its own (NightStep, VenueStep, FoodStep).
 *
 *   <PlannerSteps label="Planning The Drowned Chapel">
 *     <PlannerStep n={1} title="Pick the night" state="live" status="round 2">…</PlannerStep>
 *   </PlannerSteps>
 */
export function PlannerSteps({ label, children }: { label: string; children: ReactNode }) {
  return <ol className="hs-steps" aria-label={label}>{children}</ol>;
}

export function PlannerStep({ n, title, state, status, children }: {
  n: number;
  title: string;
  state: StepState;
  /** Beside the title, quieter: "round 2", the night once it's set. */
  status?: ReactNode;
  children?: ReactNode;
}) {
  const cls = state === 'live' ? 'hs-step is-live' : state === 'done' ? 'hs-step is-done' : 'hs-step is-later';
  return (
    <li className={cls} aria-current={state === 'live' ? 'step' : undefined}>
      <span className="hs-step-n" aria-hidden="true">{n}</span>
      <div className="hs-step-body">
        <h4>
          <span className="hs-sr-only">Step {n}: </span>
          {title}
          {status && <span className="hs-step-status">{status}</span>}
        </h4>
        {children}
      </div>
    </li>
  );
}
