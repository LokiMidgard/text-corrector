// See https://svelte.dev/docs/kit/types#app.d.ts


declare module 'node-windows-root-certs-napi' {
	export function getCerts(storeName?:string, options?:{maxcerts?:number}): string[]; 
	export function patchTls(): void;
	export function unPatchTls(): void;
	export function useWindowsCerts(): void;
  
  }

  