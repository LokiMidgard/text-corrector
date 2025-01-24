<script lang="ts" module>
	export type TreeElement = {
		lable: string;
		id: string;
		chlidren: TreeElement[];
	};
</script>

<script lang="ts">
	let {
		tree,
		selectedElement = $bindable()
	}: { tree: TreeElement; selectedElement: undefined | string } = $props();

	// let selectedElement: undefined | string = $state('prolog');
</script>

{#if tree}
	<ul>
		{@render element(tree)}
	</ul>
{/if}
{#snippet element(ele: TreeElement, indentation = 0)}
	<li style="--indentation:{indentation}">
		{#if ele.chlidren.length > 0}
			<details open>
				<summary>
					{ele.lable}
				</summary>
				<ul>
					{#each ele.chlidren as child}
						{@render element(child, indentation + 1)}
					{/each}
				</ul>
			</details>
		{:else}
			<label title={ele.lable}>
				{ele.lable}
				<input type="radio" name="selectedElement" bind:group={selectedElement} value={ele.id} />
			</label>
		{/if}
	</li>
{/snippet}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	summary,
	label {
		/* width: 100%; */
		background-color: green;
		margin: 0;
		padding: 0;
		display: block;
		padding-left: calc(var(--indentation) * 1rem);
		/* prevent line break and keep everything in ne line */
		white-space: nowrap;
	}
	summary:hover,
	label:hover {
		background-color: lightgreen;
	}
	label:has(:checked) {
		background-color: aqua;
	}
	input {
		display: none;
	}
</style>
