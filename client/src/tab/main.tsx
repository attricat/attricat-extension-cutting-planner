import { createApi, type Attricat } from '../api.js';
import { mountFrame } from '../frame.js';
import { PlanTab } from './PlanTab.js';

export function mount(root: HTMLElement, attricat: Attricat) {
  const api = createApi(attricat);
  return mountFrame(root, attricat, () => <PlanTab root={root} attricat={attricat} api={api} />);
}
