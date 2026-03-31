import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const defaults: IconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return <svg {...defaults} {...props}>{children}</svg>;
}

/** Violin — body + neck + bow */
export function Violin(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v8" />
      <path d="M10 11c-2 0-3.5 1.5-3.5 3s1 2 1.5 2.5c.5.5 0 1.5-1 2.5" />
      <path d="M14 11c2 0 3.5 1.5 3.5 3s-1 2-1.5 2.5c-.5.5 0 1.5 1 2.5" />
      <line x1="10" y1="14" x2="14" y2="14" />
    </Icon>
  );
}

/** Trumpet — bell + valves + mouthpiece */
export function Trumpet(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h10" />
      <path d="M17 8c2 0 4 1.8 4 4s-2 4-4 4" />
      <path d="M13 8v8" />
      <path d="M17 8v8" />
      <line x1="7" y1="9" x2="7" y2="12" />
      <line x1="9" y1="9" x2="9" y2="12" />
      <line x1="11" y1="9" x2="11" y2="12" />
    </Icon>
  );
}

/** Saxophone — curved body + bell + mouthpiece */
export function Saxophone(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3l3 3" />
      <path d="M10 6c0 3-1 5-2 7s-2 5-2 7c0 1 1 2 3 2s3-2 3-4" />
      <circle cx="9" cy="18" r="1" />
    </Icon>
  );
}

/** Flute — horizontal tube + holes */
export function Flute(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="10" x2="5" y2="10" />
      <circle cx="9" cy="12" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Harp — frame + strings */
export function Harp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3c0 0 0 14 0 17c0 1 1 2 2 2h2" />
      <path d="M8 3c4 0 8 3 10 8" />
      <path d="M12 22c2-5 6-11 6-11" />
      <line x1="8" y1="8" x2="14" y2="14" />
      <line x1="8" y1="12" x2="12" y2="16" />
      <line x1="8" y1="16" x2="10" y2="18" />
    </Icon>
  );
}

/** Cello — large body + endpin + neck */
export function Cello(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2v4" />
      <path d="M10 6c-2.5 1-4 3-4 5.5c0 1.5.5 2.5 1 3c.5.5.5 1 0 1.5c-.5.5-1 1.5-1 3c0 2 2 3 4 3s4-1 4-3c0-1.5-.5-2.5-1-3c-.5-.5-.5-1 0-1.5c.5-.5 1-1.5 1-3c0-2.5-1.5-4.5-4-5.5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </Icon>
  );
}

/** French Horn — coiled tube + bell */
export function FrenchHorn(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M17 12c2 0 4 1 4 3" />
      <path d="M7 12H3" />
    </Icon>
  );
}

/** Clarinet — straight body + bell + mouthpiece */
export function Clarinet(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="12" y1="2" x2="12" y2="19" />
      <path d="M10 19c0 1.5 1 3 2 3s2-1.5 2-3" />
      <line x1="11" y1="2" x2="13" y2="4" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Tuba — large bell + valves + tubing */
export function Tuba(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 4v10c0 3 2 6 5 6s5-3 5-6" />
      <path d="M18 14c0-4-2-7-5-10" />
      <path d="M5 4c0 2 1.5 3 3 3" />
      <circle cx="13" cy="4" r="3" />
    </Icon>
  );
}

/** Tambourine — ring + jingles */
export function Tambourine(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="5" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="15" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="15" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Conductor Baton — diagonal stick with grip */
export function ConductorBaton(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="4" y1="20" x2="20" y2="4" />
      <circle cx="4" cy="20" r="2" />
    </Icon>
  );
}

/** Music Stand — stand with sheet */
export function MusicStand(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="3" width="12" height="9" rx="1" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="9" y1="6" x2="15" y2="6" />
      <line x1="9" y1="9" x2="13" y2="9" />
    </Icon>
  );
}
