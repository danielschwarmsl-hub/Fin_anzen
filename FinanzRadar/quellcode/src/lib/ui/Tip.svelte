<script>
  // ⓘ-Tooltip: Erklärung nur bei Hover/Fokus. Die Sprechblase ist fixed und wird per JS in den Viewport geklemmt
  // und nur im geöffneten Zustand gerendert (sonst ragt sie auf schmalen Bildschirmen über den Rand und
  // erzeugt horizontales Scrollen).
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  let { text, children = null, side = 'top' } = $props();
  let host = $state(null);
  let bubble = $state(null);
  let open = $state(false);

  async function show() {
    open = true;
    await tick();
    place();
  }
  function hide() { open = false; }

  function place() {
    if (!host || !bubble) return;
    const r = host.getBoundingClientRect();
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 8, gap = 8;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    let left, top;
    if (side === 'right' && r.right + gap + w <= vw - m) {
      left = r.right + gap; top = r.top + r.height / 2 - h / 2;
    } else {
      left = r.left + r.width / 2 - w / 2;
      top = side === 'bottom' ? r.bottom + gap : r.top - h - gap;
      if (top < m && side !== 'bottom') top = r.bottom + gap;
      else if (top + h > vh - m && side === 'bottom') top = r.top - h - gap;
    }
    // Ursprung messen: hat ein Vorfahr transform/filter, ist fixed relativ zu ihm und nicht zum Viewport
    bubble.style.left = '0px'; bubble.style.top = '0px';
    const o = bubble.getBoundingClientRect();
    bubble.style.left = clamp(left, m, vw - w - m) - o.left + 'px';
    bubble.style.top = clamp(top, m, vh - h - m) - o.top + 'px';
    bubble.style.visibility = 'visible';
  }
</script>
<span class="tip" tabindex="0" role="note" aria-label={text} bind:this={host}
  onpointerenter={show} onpointerleave={(e) => { if (e.pointerType === 'mouse' && document.activeElement !== host) hide(); }} onfocus={show} onblur={hide}>
  {#if children}{@render children()}{:else}<Icon name="info" size={14} />{/if}
  {#if open}<span class="bubble" bind:this={bubble} aria-hidden="true">{text}</span>{/if}
</span>
<style>
  .tip { position: relative; display: inline-flex; align-items: center; color: var(--text-3); cursor: help; }
  .tip:hover, .tip:focus { color: var(--accent); }
  .bubble { position: fixed; left: 0; top: 0; visibility: hidden; width: max-content; max-width: min(260px, calc(100vw - 16px)); padding: 8px 10px; border-radius: 9px; background: var(--text); color: var(--bg); font-size: 12px; line-height: 1.4; font-weight: 450; pointer-events: none; z-index: 150; white-space: normal; text-transform: none; letter-spacing: 0; text-align: left; font-family: var(--font); cursor: default; }
</style>
