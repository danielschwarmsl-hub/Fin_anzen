import './polyfills.js';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

// Nach einem Update heißen die nachgeladenen Dateien anders; eine noch offene alte Seite findet sie nicht mehr.
// Dann einmal neu laden (Schutz gegen Schleifen: höchstens einmal je Minute).
window.addEventListener('vite:preloadError', (e) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('fr-reload') || 0); } catch { /* privat */ }
  if (Date.now() - last < 60000) return;
  try { sessionStorage.setItem('fr-reload', String(Date.now())); } catch { /* privat */ }
  e.preventDefault();
  location.reload();
});
mount(App, { target: document.getElementById('app') });
