/** Special functions the statistics and the option prices need, to full double precision. */

const A = [3.16112374387056560e00, 1.13864154151050156e02, 3.77485237685302021e02, 3.20937758913846947e03, 1.85777706184603153e-1];
const B = [2.36012909523441209e01, 2.44024637934444173e02, 1.28261652607737228e03, 2.84423683343917062e03];
const C = [5.64188496988670089e-1, 8.88314979438837594e00, 6.61191906371416295e01, 2.98635138197400131e02,
  8.81952221241769090e02, 1.71204761263407058e03, 2.05107837782607147e03, 1.23033935479799725e03, 2.15311535474403846e-8];
const D = [1.57449261107098347e01, 1.17693950891312499e02, 5.37181101862009858e02, 1.62138957456669019e03,
  3.29079923573345963e03, 4.36261909014324716e03, 3.43936767414372164e03, 1.23033935480374942e03];
const P = [3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1, 1.60837851487422766e-2,
  6.58749161529837803e-4, 1.63153871373020978e-2];
const Q = [2.56852019228982242e00, 1.87295284992346725e00, 5.27905102951428412e-1, 6.05183413124413191e-2, 2.33520497626869185e-3];
const SQRPI = 5.6418958354775628695e-1;

/** exp(-y²) without losing digits to the square: Cody's split of y into a sixteenth and the rest. */
const tail = (y, value) => {
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  return Math.exp(-ysq * ysq) * Math.exp(-del) * value;
};

/** The complementary error function, by W. J. Cody's rational approximations. */
export function erfc(x) {
  const y = Math.abs(x);
  let result;
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let num = A[4] * ysq;
    let den = ysq;
    for (let i = 0; i < 3; i += 1) {
      num = (num + A[i]) * ysq;
      den = (den + B[i]) * ysq;
    }
    return 1 - (x * (num + A[3])) / (den + B[3]);
  }
  if (y <= 4) {
    let num = C[8] * y;
    let den = y;
    for (let i = 0; i < 7; i += 1) {
      num = (num + C[i]) * y;
      den = (den + D[i]) * y;
    }
    result = tail(y, (num + C[7]) / (den + D[7]));
  } else if (y >= 26.543) {
    result = 0;
  } else {
    const ysq = 1 / (y * y);
    let num = P[5] * ysq;
    let den = ysq;
    for (let i = 0; i < 4; i += 1) {
      num = (num + P[i]) * ysq;
      den = (den + Q[i]) * ysq;
    }
    result = tail(y, (SQRPI - (ysq * (num + P[4])) / (den + Q[4])) / y);
  }
  return x < 0 ? 2 - result : result;
}

export const erf = (x) => 1 - erfc(x);

/** The standard normal distribution, cumulative. */
export const normal = (x) => 0.5 * erfc(-x / Math.SQRT2);

/** The standard normal density. */
export const density = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
