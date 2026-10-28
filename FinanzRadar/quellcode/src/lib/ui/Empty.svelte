<script>
  import Icon from './Icon.svelte';
  let { icon = 'inbox', title, action = null, children = null } = $props();
</script>
<div class="empty">
  <div class="ic"><Icon name={icon} size={26} /></div>
  <h3>{title}</h3>
  {#if children}<div class="muted small">{@render children()}</div>{/if}
  {#if action}<div>{@render action()}</div>{/if}
</div>
<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 16px; text-align: center; }
  .ic { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
</style>
