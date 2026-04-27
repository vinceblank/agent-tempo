/**
 * PlayerAvatar — musical-glyph-on-tinted-square avatar. Ported from
 * the canonical handoff bundle's `primitives.jsx:55-81`.
 *
 * The conductor gets a fixed warning-gold treatment + treble-clef
 * glyph, overriding the per-type hue. It's the ensemble's required
 * role and should read as distinct from the rotating player roster.
 */
import { glyphFor, hueForType } from '../../lib/tempo-helpers';

interface PlayerAvatarProps {
  playerId: string;
  playerType?: string;
  isConductor?: boolean;
  size?: number;
}

export function PlayerAvatar({
  playerId,
  playerType,
  isConductor = false,
  size = 32,
}: PlayerAvatarProps) {
  const conductor =
    isConductor || playerType === 'tempo-conductor' || playerId === 'conductor';
  const hue = conductor ? 75 : hueForType(playerType);
  const bg = conductor ? `oklch(0.26 0.06 ${hue})` : `oklch(0.24 0.045 ${hue})`;
  const fg = conductor ? `oklch(0.86 0.14 ${hue})` : `oklch(0.82 0.13 ${hue})`;
  const borderColor = conductor
    ? `oklch(0.55 0.13 ${hue})`
    : `oklch(0.35 0.05 ${hue})`;
  const glyph = conductor ? '𝄞' : glyphFor(playerId);
  return (
    <span
      data-testid={`player-avatar-${playerId}`}
      data-conductor={conductor || undefined}
      aria-label={playerId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: size * (conductor ? 0.72 : 0.55),
        border: `1px solid ${borderColor}`,
        borderRadius: 6,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {glyph}
    </span>
  );
}
