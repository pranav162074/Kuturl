const MAX_HOST_LENGTH = 253;

export const referrerHost = (referer) => {
  if (typeof referer !== 'string' || referer === '') return null;

  let url;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (host === '' || host.length > MAX_HOST_LENGTH) return null;
  return host;
};
