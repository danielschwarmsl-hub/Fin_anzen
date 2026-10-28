// Modell-Empfehlung + „kleineres Modell“-Leiter
// Größen grob in Mrd. Parametern; Reihenfolge = Präferenz innerhalb gleicher Größe
export const TEXT_LADDER = ['qwen3:14b', 'gemma3:12b', 'qwen3:8b', 'llama3.1:8b', 'qwen3:4b', 'gemma3:4b', 'phi4-mini', 'llama3.2:3b', 'qwen3:1.7b', 'gemma3:1b', 'qwen3:0.6b'];
export const VISION_LADDER = ['qwen2.5vl:7b', 'qwen3-vl:8b', 'gemma3:12b', 'qwen3-vl:4b', 'gemma3:4b', 'qwen2.5vl:3b', 'qwen3-vl:2b'];

export function paramsOf(m) {
  const s = (m?.details?.parameter_size || m?.name || '').toLowerCase();
  const mm = s.match(/(\d+(?:\.\d+)?)\s*b/);
  return mm ? Number(mm[1]) : null;
}

/** Empfehlung nach Hardware-Profil */
export function recommend(platform, accel) {
  const mode = accel?.mode;
  if (platform?.appleSilicon || mode === 'metal') {
    const big = !platform?.memoryGB || platform.memoryGB >= 8; // deviceMemory ist gedeckelt → optimistisch
    return { text: big ? 'qwen3:8b' : 'qwen3:4b', vision: big ? 'qwen2.5vl:7b' : 'gemma3:4b', reason: 'Apple Silicon nutzt Metal' };
  }
  if (mode === 'gpu' || platform?.dedicatedGpu) return { text: 'qwen3:8b', vision: 'qwen2.5vl:7b', reason: 'Grafikkarte erkannt' };
  if (mode === 'teilweise') return { text: 'qwen3:4b', vision: 'gemma3:4b', reason: 'Modell passt nur teilweise in den Grafikspeicher' };
  return { text: 'qwen3:4b', vision: null, reason: 'Nur CPU – kleines Modell, Bons per Texterkennung' };
}

/** Nächstkleineres installiertes Modell (oder empfohlener Pull-Name) */
export function smallerModel(current, installed = [], ladder = TEXT_LADDER) {
  const cur = installed.find(m => m.name === current);
  const curSize = paramsOf(cur) ?? paramsOf({ name: current }) ?? 99;
  const candidates = installed.filter(m => { const p = paramsOf(m); return p != null && p < curSize; }).sort((a, b) => paramsOf(b) - paramsOf(a));
  if (candidates.length) return { name: candidates[0].name, installed: true };
  const next = ladder.find(n => (paramsOf({ name: n }) ?? 99) < curSize);
  return next ? { name: next, installed: false } : null;
}
