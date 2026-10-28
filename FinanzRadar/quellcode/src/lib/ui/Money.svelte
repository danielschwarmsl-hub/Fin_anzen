<script>
  import { fmtEUR } from '../util/format.js';
  let { value, sign = false, color = false, compact = false, class: cls = '' } = $props();
</script>
<span class={'num ' + cls} class:pos={color && value > 0} class:negc={color && value < 0}>{fmtEUR(value, { sign, compact })}</span>
