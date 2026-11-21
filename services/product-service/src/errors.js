/** An error that maps directly to an HTTP response: { detail } with the given status. */
export class HttpError extends Error {
  constructor(status, detail, headers) {
    super(typeof detail === 'string' ? detail : 'Request failed');
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const conflict = (message) => new HttpError(409, message);
