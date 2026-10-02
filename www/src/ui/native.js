// Hands a file to the user: native share sheet in the Android app, Web Share or a download in the browser.

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function saveOrShare(blob, name) {
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) {
    const { Filesystem, Share } = cap.Plugins || {};
    if (Filesystem && Share) {
      const written = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
      await Share.share({ title: name, url: written.uri });
      return 'shared';
    }
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
