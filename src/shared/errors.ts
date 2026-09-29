/**
 * Error carrying an already provider-shaped HTTP response.
 * Each provider module builds its own body (MVola and Orange Money errors differ).
 */
export class ProviderHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(`Provider error ${statusCode}`);
  }
}

/** Error for /__mock/* endpoints only (NOT a provider format). */
export class MockError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
