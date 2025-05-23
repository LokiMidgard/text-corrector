// lib/trpc/router.ts
import type { Context } from '$lib/trpc/context';
import { initTRPC } from '@trpc/server';
import { correctText, getCorrection, getCurrentCommitData, getText, listFiles, newCorrectionParser, setText, type NewCorrectionMetadata } from '../server/git';
import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import EventEmitter from 'events';
import { addWordToDictionary } from '$lib/server/wol';
import { formatMarkdown } from '$lib';
import { pathFilter } from '$lib/server/configuration';

export const t = initTRPC.context<Context>().create();

const ee = new EventEmitter();




export type UpdateData = NewCorrectionMetadata & { path: string, isCurrentRunning:boolean };

let lastUpdate: UpdateData | null = null;

export function fireUpdate(path: string, metadata: NewCorrectionMetadata, isCurrentRunning: boolean) {
    const data = {
        path, 
        isCurrentRunning,
        ...metadata,
    };
    if(isCurrentRunning){
        lastUpdate = data;
    }
    ee.emit('update', data)
}

let lastModels: { modelNames: string[], styles: string[] } = { modelNames: [], styles: [] };
export function setModelConiguration(models: typeof lastModels) {
    lastModels = models;
    ee.emit('modelUpdate', lastModels);
}

export const router = t.router({
    greeting: t.procedure.query(async () => {

        return `Hello tRPC v10 @ ${new Date().toLocaleTimeString()}`;
    }),
    listFiles: t.procedure.query(async () => {
        console.log('listFiles');
        const files = await listFiles();
        return files;
    }),

    getCorrections: t.procedure.query(async () => {
        const files = await listFiles();
        // filter out files that are not matched by the configured pattern
        const pathesOfInterest = files.filter((file) => pathFilter.test(file.path) && file.hasCorrection);
        const corrections = await Promise.all(pathesOfInterest.map(async (file) => {
            const correction = await getCorrection({ path: file.path });
            return { ...correction, path: file.path };
        }));


        return corrections;
    }),

    // getCorrection: t.procedure.input(z.string()).query(async ({ input }) => {
    //     const corrections = await getCorrection(input);
    //     return corrections;
    // }),
    getText: t.procedure.input(z.string()).query(async ({ input }) => {
        const text = await getText(input);
        return text;
    }),
    addWordToDictionary: t.procedure.input(z.string()).query(async ({ input }) => {
        await addWordToDictionary(input);
    }),
    onModelChange: t.procedure
        .subscription(() => {
            return observable<typeof lastModels>((emit) => {
                const callback = (models: typeof lastModels) => {
                    emit.next(models);
                };
                ee.on('modelUpdate', callback);
                if (lastModels) {
                    emit.next(lastModels);
                }
                return () => {
                    ee.off('modelUpdate', callback);
                };
            });
        }),
    onMessage: t.procedure
        // .output(onProgress)
        // .input(z.string())
        .subscription(() => {
            // console.log('subscribing to onMessage');
            return observable<UpdateData>((emit) => {
                const callback = (meta: UpdateData) => {
                    // console.log('onMessage', meta);
                    emit.next(meta);
                };
                ee.on('update', callback);
                if (lastUpdate) {
                    emit.next(lastUpdate);
                }

                return () => {
                    ee.off('update', callback);
                }
            });
        }),



    // testData: t.procedure.query(async () => {
    //     const path = 'story/03-das-leben-in-der-stadt.md';
    //     if (await hasCorrection(path)) {
    //         const text = await getText(path);
    //         console.log('text', text);
    //         return false;
    //     } else {
    //         const text = await getText(path);
    //         await correctText(path, text);
    //         return true;
    //     }
    // }),

    // testWol: t.procedure.query(async () => {


    //     return await ip;
    // }),

    getCommitData: t.procedure.query(async () => {
        return await getCurrentCommitData();
    }),
    updateText: t.procedure.input(z.object({
        path: z.string(),
        metadata: newCorrectionParser,
        commitDetails: z.object({
            message: z.string().nonempty(),
            author: z.object({ name: z.string(), email: z.string().email() }),
        })
    })).query(async ({ input }) => {
        const committer = {
            ...input.commitDetails.author,
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: new Date().getTimezoneOffset()
        };
        try {
            await correctText(input.path, false,input.metadata, { ...input.commitDetails, committer, author: committer });

        } catch (error) {
            console.error(`Faild to update text wit \n${JSON.stringify(input, undefined,2)}\n\n`, error);
            throw error;
        }
    }),

    finishText: t.procedure.input(z.object({
        path: z.string(),
        text: z.string(),
        commitDetails: z.object({
            message: z.string().nonempty(),
            author: z.object({ name: z.string(), email: z.string().email() }),
        })
    })).query(async ({ input }) => {
        const committer = {
            ...input.commitDetails.author,
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: new Date().getTimezoneOffset()
        };
        await setText(input.path, formatMarkdown(input.text), { ...input.commitDetails, committer, author: committer });
    }),

});

export type Router = typeof router;