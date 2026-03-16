export function getPageKeyFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.hostname}${url.pathname}`;
}

export function isSupportedPageUrl(rawUrl: string): boolean {
  return /^https?:/i.test(rawUrl);
}
