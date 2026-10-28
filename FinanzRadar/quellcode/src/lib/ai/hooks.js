// Andockstellen für das (optionale) KI-Modul. Ohne KI bleiben alle null.
export const aiHooks = {
  beforeImport: null, // () => void  (laufende KI-Läufe beenden, bevor die Nachverarbeitung Buchungen neu schreibt)
  detect: null,      // async (extracted, meta, detection, {signal}) => detection
  parse: null,       // async (detection, extracted, meta, result, {signal}) => result
  afterImport: null, // async ({signal}) => void  (z. B. unsichere Buchungen kategorisieren)
};
