/**
 * The project's `digest-hold` gate as the project page reads it: true when the owner turned "A few seconds to take back an Allow" off for
 * this project (or its preset does), so an Allow goes out at once. The value comes from the gates view the Gates page uses, so the two always
 * agree. Until that view has loaded the hold stays on: the safe side.
 */
import { gateOffFor } from '../../gates/presetsLogic';
import { useGatesView } from '../../gates/useGatesView';

export function useHoldOff(projectId: string): boolean {
  const { view } = useGatesView();
  return gateOffFor(view, 'digest-hold', projectId);
}
