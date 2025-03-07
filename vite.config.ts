import { sveltekit } from '@sveltejs/kit/vite';
import { vitePluginTrpcWebSocket } from 'trpc-sveltekit/websocket';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), vitePluginTrpcWebSocket],
	server: {
		port: 3000,
		host: '0.0.0.0'
	},
	build: {
		outDir: 'build',
		sourcemap:true
	},

});
