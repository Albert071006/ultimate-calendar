export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
