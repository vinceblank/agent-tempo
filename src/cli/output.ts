const isColor = process.stdout.isTTY && !process.env.NO_COLOR;

const ansi = (code: string) => (s: string) => isColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = ansi('1');
export const dim = ansi('2');
export const red = ansi('31');
export const green = ansi('32');
export const yellow = ansi('33');
export const cyan = ansi('36');

export function log(msg: string) {
  console.log(msg);
}

export function error(msg: string) {
  console.error(`${red('error')} ${msg}`);
}

export function success(msg: string) {
  console.log(`${green('ok')} ${msg}`);
}

export function warn(msg: string) {
  console.log(`${yellow('warn')} ${msg}`);
}

export function heading(msg: string) {
  console.log(`\n${bold(msg)}`);
}

export function check(label: string, ok: boolean, detail?: string) {
  const icon = ok ? green('pass') : red('FAIL');
  const suffix = detail ? ` ${dim(`(${detail})`)}` : '';
  console.log(`  ${icon} ${label}${suffix}`);
}
