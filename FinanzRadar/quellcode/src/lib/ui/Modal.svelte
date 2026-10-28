<script>
  import Icon from './Icon.svelte';
  let { open = $bindable(false), title = '', width = 560, children, footer = null, onclose = null } = $props();
  function close() { open = false; onclose?.(); }
  function key(e) { if (e.key === 'Escape') close(); }
</script>
<svelte:window onkeydown={open ? key : null} />
{#if open}
  <div class="back" role="presentation" onclick={close}></div>
  <div class="modal fade-up" role="dialog" aria-modal="true" aria-label={title} style="width:min({width}px, 94vw)">
    <div class="head"><h2>{title}</h2><button class="btn btn-ghost btn-icon btn-sm" onclick={close} aria-label="Schließen"><Icon name="x" /></button></div>
    <div class="content scroll">{@render children()}</div>
    {#if footer}<div class="foot">{@render footer()}</div>{/if}
  </div>
{/if}
<style>
  .back { position: fixed; inset: 0; background: rgba(8, 10, 18, .45); backdrop-filter: blur(3px); z-index: 90; }
  .modal { position: fixed; left: 0; right: 0; margin-inline: auto; top: 8vh; max-height: 84vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow-lg); z-index: 91; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 8px; }
  .content { padding: 8px 18px 18px; }
  .foot { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }
</style>
