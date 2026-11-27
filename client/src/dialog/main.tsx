import type { Attricat } from '../api.js';
import { mountFrame } from '../frame.js';
import { CuttingSheetDialog } from './CuttingSheetDialog.js';

export function mount(root: HTMLElement, attricat: Attricat) {
  return mountFrame(root, attricat, () => <CuttingSheetDialog attricat={attricat} />);
}
