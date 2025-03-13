<script lang="ts">
	import { tweened } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { onMount } from 'svelte';

	import { FontAwesomeIcon } from '@fortawesome/svelte-fontawesome';
	import { faThumbtackSlash } from '@fortawesome/free-solid-svg-icons/faThumbtackSlash';
	import { faThumbtack } from '@fortawesome/free-solid-svg-icons/faThumbtack';

	let { isPinned = $bindable() }: { isPinned: boolean } = $props();
</script>

{#if isPinned}
	<FontAwesomeIcon icon={faThumbtackSlash} on:click={() => (isPinned = !isPinned)} />
{:else}
	<FontAwesomeIcon icon={faThumbtack} on:click={() => (isPinned = !isPinned)} />
{/if}

<!-- <svg
	class:isPinned
	class="pin-icon"
	width="24"
	height="24"
	viewBox="0 0 24 24"
	fill="none"
	xmlns="http://www.w3.org/2000/svg"
>
	<path
		d="M12 2C11.45 2 11 2.45 11 3V10.59L7.41 14.17C7.05 14.54 7.05 15.14 7.41 15.5L8.83 16.92C9.2 17.29 9.8 17.29 10.17 16.92L13.75 13.34V21C13.75 21.55 14.2 22 14.75 22H15.25C15.8 22 16.25 21.55 16.25 21V13.34L19.83 16.92C20.2 17.29 20.8 17.29 21.17 16.92L22.59 15.5C22.95 15.14 22.95 14.54 22.59 14.17L19 10.59V3C19 2.45 18.55 2 18 2H12Z"
		fill="currentColor"
	/>
</svg> -->

<style>
	.pin-icon {
		cursor: pointer;
		transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
		&.isPinned {
			transform: rotate(45deg);
		}
	}
</style>
