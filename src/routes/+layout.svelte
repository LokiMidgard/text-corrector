<script lang="ts">
	import Hamburger from '$lib/client/hamburger.svelte';
	import Tree, { type TreeElement } from '$lib/client/tree.svelte';
	import { trpc } from '$lib/trpc/client';
	import { onMount } from 'svelte';
	let open = $state(true);

	type Unpromise<T> = T extends PromiseLike<infer K> ? K : T;
	type fileListType = Unpromise<ReturnType<typeof client.listFiles.query>>;

	let selectedPath: undefined | string = $state();

	const client = trpc();
	let fileList: fileListType = $state([]);
	let tree = $derived(converteToTree(fileList));

	onMount(() => {
		client.listFiles.query().then((files) => {
			fileList = files;
		});
	});

	function converteToTree(pathes: fileListType): TreeElement {
		const root: TreeElement = {
			chlidren: [],
			id: '',
			lable: 'root'
		};
		const lookup: Record<string, TreeElement> = { '': root };

		for (const { path, hasCorrection } of pathes) {
			let parent: undefined | string = undefined;
			let current: undefined | string = undefined;
			let currentIndex = path.indexOf('/');
			console.log(currentIndex);
			do {
				parent = current ?? '';
				current = path.substring(0, currentIndex);
				if (!lookup[current]) {
					const newTreeElement: TreeElement = {
						chlidren: [],
						id: current,
						lable: current.substring(current.lastIndexOf('/')+1)
					};
					lookup[current] = newTreeElement;
					lookup[parent!].chlidren.push(newTreeElement);
				}
				currentIndex = path.indexOf('/', currentIndex + 1);
				console.log(currentIndex);
			} while (currentIndex > 0);

			parent = current ?? '';
			current = path;
			if (!lookup[current]) {
				const newTreeElement: TreeElement = {
					chlidren: [],
					id: current,
					lable: current.substring(current.lastIndexOf('/')+1)
				};
				lookup[current] = newTreeElement;
				lookup[parent!].chlidren.push(newTreeElement);
			}
		}
		return root;
	}
</script>

<label class="hamburger" class:open>
	<input type="checkbox" bind:checked={open} style="display: none;" />
	<Hamburger bind:active={open} />
</label>
<aside>
	{#if tree}
		tree {selectedPath}
		<Tree bind:selectedElement={selectedPath} {tree} />
	{/if}
</aside>

<main>
	<slot />
</main>

<style>
	:root {
		--aside-width: 15rem;
		--menu-background: violet;
	}
	.hamburger {
		position: fixed;
		z-index: 20;
		background-color: var(--menu-background);
		top: 0;
		left: 0;
		padding: 0.3em;
		border-bottom-right-radius: 50%;
		transition: all 1s;
	}
	.hamburger.open {
		left: var(--aside-width);
	}
	aside {
		z-index: 10;
		position: fixed;
		top: 0;
		bottom: 0;
		left: 0;
		width: var(--aside-width);
		background-color: red;
		transform: translateX(calc(-1 * var(--aside-width)));
		transition: 1s transform;
        overflow-y: auto;
        overflow-x:hidden;
	}
	.hamburger:has(input:checked) + aside {
		transform: translateX(0);
	}
	main {
		z-index: 5;
		top: 0;
		left: 0;
		right: 0;
		height: 0;
		position: fixed;
	}
</style>
