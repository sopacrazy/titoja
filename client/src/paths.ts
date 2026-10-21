/** The server supplies this meta value; importing this module never accesses the DOM. */
export function appPath(path: string, doc: Document): string {
  const prefix = doc.querySelector<HTMLMetaElement>('meta[name="titoja-base-path"]')?.content ?? '';
  if (prefix.length > 160 || !/^(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) throw new Error('O endereço do aplicativo está configurado incorretamente.');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020]/.test(path)
    || path.split(/[?#]/, 1)[0].split('/').some(part => part === '.' || part === '..')) {
    throw new Error('O caminho do aplicativo é inválido.');
  }
  return prefix + path;
}
