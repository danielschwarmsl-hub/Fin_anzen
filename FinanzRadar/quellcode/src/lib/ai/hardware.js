// Hardware-Erkennung: Plattform aus dem Browser, Beschleunigung aus Ollama (/api/ps)
export async function detectPlatform() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = nav.userAgent || '';
  let os = /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) ? 'linux' : 'other';
  let arch = null;
  try {
    const hi = await nav.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness', 'platform']);
    if (hi?.architecture) arch = hi.architecture; // 'arm' | 'x86'
  } catch { /* Firefox/Safari: nicht verfügbar */ }
  let gpu = null;
  try {
    const adapter = await nav.gpu?.requestAdapter?.();
    if (adapter) gpu = { vendor: adapter.info?.vendor || '', architecture: adapter.info?.architecture || '', description: adapter.info?.description || '' };
  } catch { /* ignore */ }
  if (!gpu) {
    try {
      const c = document.createElement('canvas').getContext('webgl');
      const ext = c?.getExtension('WEBGL_debug_renderer_info');
      if (ext) gpu = { vendor: c.getParameter(ext.UNMASKED_VENDOR_WEBGL), architecture: '', description: c.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
    } catch { /* ignore */ }
  }
  const gpuText = `${gpu?.vendor} ${gpu?.architecture} ${gpu?.description}`.toLowerCase();
  if (os === 'mac' && !arch) arch = /apple|m1|m2|m3|m4|m5/.test(gpuText) ? 'arm' : /intel|amd|radeon/.test(gpuText) ? 'x86' : null;
  const appleSilicon = os === 'mac' && arch === 'arm';
  const dedicatedGpu = os !== 'mac' && /nvidia|geforce|rtx|radeon|amd|arc/.test(gpuText) && !/microsoft basic|swiftshader|llvmpipe/.test(gpuText);
  return {
    os, arch, appleSilicon, dedicatedGpu,
    gpuName: gpu?.description || gpu?.architecture || gpu?.vendor || '',
    cores: nav.hardwareConcurrency || null,
    memoryGB: nav.deviceMemory || null, // in Chrome auf max. 8 gedeckelt
  };
}

/**
 * Nach einem Warm-up: wie viel des Modells liegt im (V)RAM der GPU?
 * Mac: Unified Memory → 'metal'. Windows/Linux: size_vram/size → gpu | teilweise | cpu
 */
export async function detectAcceleration(client, model, platform) {
  const running = await client.ps().catch(() => []);
  const m = running.find(x => x.name === model || x.model === model) || running[0];
  if (!m) return { mode: 'unknown', vramShare: null };
  const share = m.size ? (m.size_vram || 0) / m.size : null;
  if (platform?.os === 'mac') return { mode: platform.appleSilicon || share > 0.5 ? 'metal' : 'cpu', vramShare: share };
  if (share == null) return { mode: 'unknown', vramShare: null };
  return { mode: share > 0.9 ? 'gpu' : share > 0.05 ? 'teilweise' : 'cpu', vramShare: share };
}

export const ACCEL_LABEL = { metal: 'Apple Silicon (Metal)', gpu: 'GPU', teilweise: 'GPU teilweise', cpu: 'Nur CPU', unknown: 'Unbekannt' };
