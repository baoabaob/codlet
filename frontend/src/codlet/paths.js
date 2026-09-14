/** Display only: keep the original path in manager state and RPC identities. */
export function displayPath(path) {
  if(typeof path!=='string')return '';
  if(/^\\\\\?\\UNC\\/i.test(path))return '\\\\'+path.slice(8);
  if(/^\\\\\?\\[A-Za-z]:\\/.test(path))return path.slice(4);
  return path;
}
