/**
 * SDK-class adapter base.
 *
 * Class hierarchy per design §4.1: `SdkAttachment extends BaseAttachment`. Concrete
 * SDK adapters (copilot, future `headless-claude`) extend this.
 *
 * PR-B (v0.25 rebuild step 2/7) lands this as a **placeholder scaffold only** — no
 * SDK-specific lifecycle here yet. PR-C fills in the `processingStart`/`End`
 * wrapping around `deliver()`, the `onSuperseded` cancellation hook for split-brain
 * resolution, and the SDK recreation budget. Until then, `CopilotSdkAttachment`
 * runs its lifecycle stand-alone (lifted verbatim from `src/copilot-bridge.ts`).
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§4.1, 4.4, 9.3.
 */
import { BaseAttachment } from '../base';

/**
 * Abstract base for SDK-class adapters.
 *
 * In PR-B this class is empty beyond inheriting from {@link BaseAttachment}; it
 * exists so shipped SDK adapters (copilot) and future ones (headless-claude) have
 * a stable parent class to extend, and so PR-C can drop in the shared SDK
 * lifecycle without every adapter rewiring its class hierarchy.
 */
export abstract class SdkAttachment extends BaseAttachment {
  // PR-C: processingStart/End wrapping, onSuperseded hook, SDK recreation budget.
}
