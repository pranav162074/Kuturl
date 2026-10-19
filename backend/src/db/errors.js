// Thrown when a short code is already used. Services catch it to retry or to report a conflict.
export class CodeTakenError extends Error {
  constructor(code) {
    super(`Code "${code}" is already taken`);
    this.name = 'CodeTakenError';
    this.code = code;
  }
}