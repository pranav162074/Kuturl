// The same rule as the CHECK constraint on links.code in the database
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

export const isValidCodeShape = (value) => typeof value === 'string' && CODE_SHAPE.test(value);