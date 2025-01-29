<script lang="ts" module>
	export type TreeElement = {
		label: string;
		hasCorrection?: boolean;
		id: string;
		children: TreeElement[];
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
		{#if ele.children.length > 0}
			<details open>
				<summary>
					{ele.label}
				</summary>
				<ul>
					{#each ele.children as child}
						{@render element(child, indentation + 1)}
					{/each}
				</ul>
			</details>
		{:else}
			<label title={ele.label}>
				<span class:hasCorrection={ele.hasCorrection}>
					{ele.label}
				</span>
				<input type="radio" name="selectedElement" bind:group={selectedElement} value={ele.id} />
				<!-- {#if ele.hasCorrection}
					<span>🔴</span>
				{/if} -->
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
	.hasCorrection {
		position: relative;
		display: flex	;		align-content: center;
		&::before {
			align-self: center;
			opacity: 0.5;
			content: ' ';
			background-color: red;
			width: 0.6rem;
			height: 0.6rem;
			position: absolute;
			left: -0.8rem;
			border-radius: 0.3rem;
		}
		&:hover::before {
			opacity: 1;
		}
	}
</style>
