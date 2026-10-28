<script>
  let { title, open = $bindable(false), children, badge = null } = $props();
</script>
<details class="collapsible" bind:open>
  <summary>{title}{#if badge != null}<span class="badge">{badge}</span>{/if}</summary>
  <div class="body">{@render children()}</div>
</details>
