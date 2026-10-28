<script>
  import { CATEGORIES } from '../classify/categories.js';
  let { category = null, subcategory = null, onpick, compact = false } = $props();
  const cat = $derived(CATEGORIES.find(c => c.id === category));
  function change(e) {
    const [c, s] = e.target.value.split('|');
    onpick?.({ category: c, subcategory: s || null });
  }
</script>
<span class="cp" class:compact>
  <span class="dot" style="background:{cat?.color || 'var(--text-3)'}"></span>
  <select class="sel" value={(category || '') + '|' + (subcategory || '')} onchange={change} aria-label="Kategorie">
    {#if !category}<option value="|">Ohne Kategorie</option>{/if}
    {#each CATEGORIES as c}
      <optgroup label={c.label}>
        <option value={c.id + '|'}>{c.label}</option>
        {#each c.subs || [] as s}<option value={c.id + '|' + s.id}>{c.label} › {s.label}</option>{/each}
      </optgroup>
    {/each}
  </select>
</span>
<style>
  .cp { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; }
  .sel { border: 1px solid transparent; background: transparent; border-radius: 7px; padding: 3px 4px; cursor: pointer; max-width: 200px; text-overflow: ellipsis; }
  .sel:hover { border-color: var(--border); background: var(--surface); }
  .compact .sel { font-size: 12.5px; }
</style>
