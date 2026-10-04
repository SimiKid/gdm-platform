/** Prolific researcher API (v1). */
export const PROLIFIC_API_BASE_URL = "https://api.prolific.com/api/v1";

/** The configured researcher API token, or undefined when Prolific calls are off. */
export function prolificApiToken(): string | undefined {
  return process.env.PROLIFIC_API_TOKEN?.trim() || undefined;
}

/** Call the Prolific API as the researcher (`path` starts with a slash). */
export function prolificApiFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${PROLIFIC_API_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Token ${token}`, ...init.headers },
  });
}
