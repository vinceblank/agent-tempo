/**
 * MaestroAvatar — tile-shell composition around {@link MaestroMark} (#473).
 *
 * Sits next to {@link PlayerAvatar} (`./tempo/PlayerAvatar.tsx`) in surfaces
 * that need a 32×32 identity tile (sidebar identity row, future workspace
 * top-bar). Same dimensions, same border-radius, same inline-flex centering
 * — but with a deliberately NEUTRAL chrome (warm-bone tint via `color-mix`)
 * instead of PlayerAvatar's hue-rotated OKLCH treatment.
 *
 * The neutral-vs-hue-rotated split is load-bearing semantic information per
 * audit rev 4 C2: "MaestroMark is the human operator's mark, distinct from
 * the rotating player roster." If MaestroAvatar adopted PlayerAvatar's
 * `hueForType()` chrome, the maestro tile would visually demote to "just
 * another player" and the C2 distinction would collapse at the visual layer.
 *
 * Why a separate component (composition over modification):
 *
 *   1. {@link MaestroMark} stays the bare-M primitive that audit rev 4 C2
 *      sanctions — it remains usable in {@link FeedMessage} for the chat
 *      composer self-row, where tile chrome would feel heavy.
 *   2. The 32×32 tile is opt-in per surface: places that want the
 *      "intentional avatar tile" treatment swap MaestroMark → MaestroAvatar
 *      explicitly, without affecting other call sites.
 *   3. Reversible. If a future audit picks a different direction (a maestro
 *      glyph, or a hue-locked treatment), this file is one component to
 *      delete; MaestroMark is untouched.
 *
 * The bone-tinted chrome reuses the same `color-mix(in oklch, var(--bone),
 * transparent N%)` pattern that the prior `.sidebar-maestro .maestro-mark`
 * CSS rule used (now removed in favour of this component) — keeps the
 * sidebar's warm-bone aesthetic consistent across themes (`--bone` resolves
 * the same in dark + light).
 */
import { MaestroMark } from './MaestroMark';

interface MaestroAvatarProps {
  /** Tile size in px. Defaults to 32 to match {@link PlayerAvatar}. */
  size?: number;
}

export function MaestroAvatar({ size = 32 }: MaestroAvatarProps) {
  // Inner mark sized to ~60% of the tile, mirroring PlayerAvatar's glyph
  // sizing (`size * 0.55` for non-conductor, `size * 0.72` for conductor).
  // 60% lands the M visually similar to the player glyphs without flooding
  // the tile.
  const markSize = Math.round(size * 0.6);
  return (
    <span
      // The class isn't styled by this component (chrome is inline) — it
      // exists so the sidebar's tablet-collapse rules in `components.css`
      // can keep this element visible alongside `.maestro-mark`. See the
      // `:not(.maestro-avatar)` exemptions added in PR #473.
      className="maestro-avatar"
      data-testid="maestro-avatar"
      aria-label="maestro"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        // Warm-bone tinted neutral surface — matches the prior
        // `.sidebar-maestro .maestro-mark` CSS treatment so the visual
        // identity stays consistent with how the sidebar already reads.
        // Crucially NOT hue-rotated (see file header) — that's the
        // semantic split that keeps maestro distinct from PlayerAvatar.
        background: 'color-mix(in oklch, var(--bone, #F5EBDD), transparent 92%)',
        border: '1px solid color-mix(in oklch, var(--bone, #F5EBDD), transparent 70%)',
        borderRadius: 6,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      <MaestroMark size={markSize} />
    </span>
  );
}
