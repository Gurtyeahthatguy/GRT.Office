/** What a value is, and what the program says about itself, without anything that tells where it runs. */

import { ERROR, isError, isBlank, toNumber, toText } from '../engine/values.js';

const valueOf = (arg) => (arg?.matrix ? arg.matrix.first : arg?.value);

/** Even or odd: a number, truncated; empty counts as zero; text is an error. */
const parity = (odd) => (args) => {
  const v = valueOf(args[0]);
  if (isError(v)) return v;
  if (isBlank(v)) return ERROR.value;
  const n = typeof v === 'boolean' ? Number(v) : toNumber(v);
  if (isError(n)) return n;
  return Math.abs(Math.trunc(n)) % 2 === (odd ? 1 : 0);
};

// INFO answers alike on every computer: a saved result must not tell where the file was opened.
const INFO_ANSWERS = {
  memavail: 0, memused: 0, totmem: 0, numfile: 1, origin: '$A:$A$1', osversion: 'GRT', recalc: 'Automatic', release: 'GRT', system: 'GRT',
};

export const INFORMATION = {
  ISERR: (args) => { const v = valueOf(args[0]); return isError(v) && v !== ERROR.na; },
  ISNA: (args) => valueOf(args[0]) === ERROR.na,
  ISLOGICAL: (args) => typeof valueOf(args[0]) === 'boolean',
  ISNONTEXT: (args) => { const v = valueOf(args[0]); return !(typeof v === 'string' && !isError(v) && v !== '') || v === ''; },
  ISEVEN: parity(false),
  ISODD: parity(true),
  ISEVEN_ADD: parity(false),
  ISODD_ADD: parity(true),
  N: (args) => {
    const v = valueOf(args[0]);
    if (isError(v)) return v;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return Number(v);
    return 0;
  },
  INFO: (args) => {
    const kind = toText(valueOf(args[0]));
    if (isError(kind)) return kind;
    const answer = INFO_ANSWERS[kind.toLowerCase()];
    // The folder a file sits in is never given.
    return answer === undefined ? ERROR.num : answer;
  },
};
