<script>
  // Schwebender Tooltip innerhalb eines position:relative Containers.
  let { x = 0, y = 0, show = false, width = 0, children } = $props();
  const flip = $derived(width > 0 && x > width * 0.58);
</script>
<div class="ct" class:show class:flip style="left:{x}px; top:{y}px" role="presentation">
  {#if show}{@render children?.()}{/if}
</div>
<style>
  .ct {
    position: absolute; z-index: 20; pointer-events: none; min-width: 120px; max-width: 260px;
    padding: 9px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.4;
    background: color-mix(in srgb, var(--surface) 94%, transparent); color: var(--text);
    border: 1px solid var(--border); box-shadow: var(--shadow-lg); backdrop-filter: blur(6px);
    opacity: 0; transform: translate(14px, -50%) scale(.98); transition: opacity .12s ease;
  }
  .ct.flip { transform: translate(calc(-100% - 14px), -50%) scale(.98); }
  .ct.show { opacity: 1; }
</style>
