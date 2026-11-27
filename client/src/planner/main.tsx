import { createApi, type Attricat } from '../api.js';
import { mountFrame } from '../frame.js';
import { App } from './App.js';

export function mount(root: HTMLElement, attricat: Attricat) {
  const api = createApi(attricat);
  return mountFrame(root, attricat, () => <App attricat={attricat} api={api} />);
}
