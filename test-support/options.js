// Options shared by the integration tests that need the /caisse page (it is the only page behind the login):
// the page enabled with the fictitious credentials of the fake Cyclos, and quick listeners (no real pauses).
// Every response of the fake Cyclos stream is closed after 200 ms by default, which is harmless here.
import { USER } from "./fake-cyclos.js";

export const CAISSE_OPTIONS = {
  caisse: { enabled: true, login: USER.login, password: USER.password },
  caisseHooks: {
    listenerOptions: { shortStreamMs: 0, sleep: async () => {} },
    processorOptions: { debounceMs: 50, retryDelaysMs: [30, 30, 30] },
  },
};
