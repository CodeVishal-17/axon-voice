/// <reference types="vite/client" />

import type { AxonBridge } from '@axon/core';

declare global {
  interface Window {
    /**
     * The complete Axon API available to the renderer, installed by the
     * preload script. Typed as possibly undefined because a failed preload is
     * a real condition the UI has to report rather than crash on.
     */
    readonly axon?: AxonBridge;
  }
}

export {};
