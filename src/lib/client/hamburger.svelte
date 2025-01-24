<script lang="ts">
	let { active = $bindable() }: { active: boolean } = $props();
</script>

<svg class:active width="32" height="32" viewBox="0 0 32 32">
	<circle cx="16" cy="16" r="16"></circle>
</svg>

<style>
	svg {
		transition: all 1s;
		fill: red;
	}
	.active {
		fill: green;
	}
</style>
