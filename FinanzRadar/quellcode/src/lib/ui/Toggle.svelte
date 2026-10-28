<script>
  let { checked = $bindable(false), label = '', disabled = false, onchange = null } = $props();
</script>
<label class="tg" class:dis={disabled}>
  <input type="checkbox" bind:checked {disabled} onchange={() => onchange?.(checked)} />
  <span class="track"><span class="knob"></span></span>
  {#if label}<span class="small">{label}</span>{/if}
</label>
<style>
  .tg { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .tg.dis { opacity: .5; cursor: not-allowed; }
  input { position: absolute; opacity: 0; pointer-events: none; }
  .track { width: 34px; height: 20px; border-radius: 20px; background: var(--surface-3); position: relative; transition: background .15s; flex: none; }
  .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .15s; }
  input:checked + .track { background: var(--accent); }
  input:checked + .track .knob { transform: translateX(14px); }
  input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
