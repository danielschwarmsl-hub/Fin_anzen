<script>
  // Segmented control
  let { value = $bindable(), options = [], size = 'md' } = $props();
</script>
<div class="seg {size}" role="tablist">
  {#each options as o}
    <button role="tab" aria-selected={value === o.value} class:on={value === o.value} onclick={() => (value = o.value)}>{o.label}</button>
  {/each}
</div>
<style>
  .seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); }
  button { border: 0; background: transparent; height: 28px; padding: 0 11px; border-radius: 8px; cursor: pointer; color: var(--text-2); font-weight: 550; font-size: 12.5px; }
  button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
  .sm button { height: 24px; padding: 0 8px; font-size: 12px; }
</style>
