/** The least and the greatest of a list of numbers, read one by one: spreading a long list into Math.min fails past a hundred thousand or so. */

export const least = (list) => list.reduce((a, b) => (b < a ? b : a), Infinity);
export const greatest = (list) => list.reduce((a, b) => (b > a ? b : a), -Infinity);
