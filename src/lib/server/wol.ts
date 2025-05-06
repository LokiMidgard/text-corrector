
import fs from 'fs';
import { Ollama, type ShowResponse } from 'ollama';


import { z } from 'zod';

import type { BlockContent, DefinitionContent, RootContent } from 'mdast';

import * as git from '$lib/server/git'
import { fireUpdate, setModelConiguration } from '$lib/trpc/router';
import { zodToJsonSchema } from "zod-to-json-schema";

import { bytesTohuman, createAproximationFunction, formatMarkdown, getFileProgress, getFileTotalProgress, msToHumanReadable, reduceDuration, transformFromAst, transformToAst } from '$lib';
import path from 'path';
import { env, fetchOptions, pathFilter, wake, type NewParagrapInfo } from './configuration';
import { getLanguageToolResult, type LanguageToolResult } from './languagetool';
import { Semaphore } from 'await-semaphore';


const cache_path = '/var/cache/lector/ollama.json';

if (!fs.existsSync(path.basename(cache_path))) {
    console.warn(`Cache path ${cache_path} does not exist. Creating it.`);
    fs.mkdirSync(path.basename(cache_path), { recursive: true });
}

const correctionSmystem = (theme: string) => `
Du bist ein weltbekanter, hilfreicher, kompetenter und erfolgreicher Lektor für ${theme}.

Deine Aufgabe ist es Texte zu korrigieren und verbessern. 
Du erhälst einen einzelen Paragraphen, die du berichtigen und verbessern sollst.
Du sollst eine Version zurück geben bei der die Rechtschreibung und Gramatk korrigiert wurden.

Neben dem zu berichtigenden Paragraphen wird dir auch der Kontext mitgeteilt,
Eine allgemeine übresicht der Geschichte; einige vorherigen Paragraphen, falls es nicht
der erste Paragrap des Kapitels ist, und einige nächste Paragraph, falls es nicht der
letzte Paragraph des Kapitels ist.

---

Die Daten werden in JSON vormt übergeben, das wie folgt aufgebaut ist:
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(CorrectionInputParser), undefined, 2)}
\`\`\`

**storyContext**: Der Kontext der Geschichte
**previousParagraphs**: Die vorherigen Abschnitte (nicht vollständig)
**nextParagraphs**: Die nächsten Abschnitte (nicht vollständig)

---

Die Ausgabe wird ebensfalls in JSON erwartet
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(CorrectionResultParser), undefined, 2)}
\`\`\`

**involvedCharacters**: Die Charaktere die in diesem Abschnitt vorkommen
**corrected**: Der korrigierte Abschnitt (nur Rechtschreibung und Grammatik)
**goodPoints**: Die guten Punkte des Abschnitts
**badPoints**: Die schlechten Punkte des Abschnitts
**judgment**: Eine Zahl zwischen -10 und 10 die die Qualität des Abschnitts bewertet

`
const alternationSmystem = (theme: string) => `
Du bist ein weltbekanter, hilfreicher, kompetenter und erfolgreicher Lektor für ${theme}.

Deine Aufgabe ist es Texte zu korrigieren und verbessern. 
Du erhälst einen einzelen Paragraphen, die du berichtigen und verbessern sollst.
Du sollst eine Version zurück geben bei der du auch die Formulierung verbessert hast.
Rechtschreibung und Gramatk sollten ebenfalls stimmen.

Neben dem zu berichtigenden Paragraphen wird dir auch der Kontext mitgeteilt,
Eine allgemeine übresicht der Geschichte; einige vorherigen Paragraphen, falls es nicht
der erste Paragrap des Kapitels ist, und einige nächste Paragraph, falls es nicht der
letzte Paragraph des Kapitels ist. Zusätzlich wird dir auch der gewünschte Stil mitgeteilt.

---

Die Daten werden in JSON vormt übergeben, das wie folgt aufgebaut ist:
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(AlternationInputParser), undefined, 2)}
\`\`\`

**storyContext**: Der Kontext der Geschichte
**intendedStyles**: Die beschreibung der gewünschten Stiles für die alternative Versionen.
**previousParagraphs**: Die vorherigen Abschnitte (nicht vollständig)
**nextParagraphs**: Die nächsten Abschnitte (nicht vollständig)

---

Die Ausgabe wird ebensfalls in JSON erwartet
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(AlternationResultParser), undefined, 2)}
\`\`\`

**involvedCharacters**: Die Charaktere die in diesem Abschnitt vorkommen
**alternative**: Der Abschnitt mit verbesserten/alternativen Formulierungen

`


const dictionaryLocation = '.vscode/spellright.dict';

const CorrectionInputParser = z.object({
    context: z.object({
        storyContext: z.string(),
        previousParagraphs: z.array(z.string()),
        nextParagraphs: z.array(z.string()),
    }),
    paragraphToCorrect: z.string(),
});

const AlternationInputParser = z.object({
    context: z.object({
        storyContext: z.string(),
        intendedStyles: z.string(),
        previousParagraphs: z.array(z.string()),
        nextParagraphs: z.array(z.string()),
    }),
    paragraphToCorrect: z.string(),
});

type CorrectionInput = z.infer<typeof CorrectionInputParser>;
type AlternationInput = z.infer<typeof AlternationInputParser>;

const CorrectionResultParser = z.object({
    involvedCharacters: z.array(z.string()),
    corrected: z.string(),
    goodPoints: z.array(z.string()),
    badPoints: z.array(z.string()),
    judgment: z.number(),
});

const AlternationResultParser = z.object({
    involvedCharacters: z.array(z.string()),
    alternative: z.string(),
});

export type CorrectionResult = z.infer<typeof CorrectionResultParser>;
export type AlternationResult = z.infer<typeof AlternationResultParser>;

// const models = Object.keys(model_properties) as (keyof typeof model_properties)[];

// check if all required systems files are present
const requiredFiles = [
    'systems/context.system',
];


const desiredStyles = Object.fromEntries(fs.readdirSync('systems/desired').filter(file => file.endsWith('.system')).map(file => [path.basename(file, '.system'), fs.readFileSync(`systems/desired/${file}`, 'utf8')] as const));

const context = fs.readFileSync('systems/context.system', 'utf8');

const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

if (missingFiles.length > 0) {
    throw new Error(`Missing system files: ${missingFiles.join(', ')}`);
}




const host = env.OLLAMA_HOST;
const protocol = env.OLLAMA_PROTOCOL;
const port = env.OLLAMA_PORT;
const mac = env.OLLAMA_MAC;
const ip = env.OLLAMA_IP;

const githubApiToken = env.GITHUB_API_TOKEN;
const repo = env.REPO;



const noTimeoutFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const someInit = init || {}
    return fetch(input, {
        ...someInit,
        keepalive: true,
        ...fetchOptions(protocol)
    })
}


// the model to use
const usedModels: ({
    model: string,
    context_window: number | undefined,
})[] = (env.MODEL?.split('|') ?? ['hf.co/Hasso5703/Mistral-Small-24B-Instruct-2501-Q4_0-GGUF>27192']).map(modelString => {
    const [model, contextText] = modelString.split('>');
    const context_window = contextText?.length > 0 ? parseInt(contextText) : undefined;
    return {
        model: model.trim(),
        context_window: context_window,
    }
});// manly for debbugging purpus




let vram_size_checked = false;


async function createModels() {

    console.log(`wait for server to be healthy. call ${protocol}://${host}:${port}/api/version`);
    const isHealthy = async () => {
        try {
            const httpResponse = await fetch(`${protocol}://${host}:${port}/api/version`, {
                ...fetchOptions(protocol),
            });
            return httpResponse.ok;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    let cache: {
        max_vram: number | undefined,
        models: Record<`general-correction-${string}` | `general-alternation-${string}`, { context_size: number, samples: { tokens: number, model_size: number }[] }>,
    };

    if (fs.existsSync(cache_path)) {
        cache = JSON.parse(fs.readFileSync(cache_path, 'utf8'));
    } else {
        cache = {
            max_vram: undefined,
            models: {},
        };
    }

    const correctionSystem = correctionSmystem("Jugendbücher");
    const alternationSystem = alternationSmystem("Jugendbücher");

    await wake({ mac, ip, isHealthy });
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });


    // check if vram still is correct
    if (cache.max_vram && !vram_size_checked) {
        const testSample = Object.entries(cache.models).flatMap(([model, { samples }]) => samples.map(x => ({ model: model, sample: x }))).filter(({ sample }) => {
            return sample.model_size >= cache.max_vram!;
        }).sort((a, b) => a.sample.model_size - b.sample.model_size)[0];
        if (testSample) {
            console.log(`Check if VRAM size is still the same (was ${bytesTohuman(cache.max_vram)})`);
            const modelName = testSample.model as `general-correction-${string}` | `general-alternation-${string}`;
            console.log(`Using ${testSample.model} with ${testSample.sample.tokens} tokens (${bytesTohuman(testSample.sample.model_size)})`)
            // create the model with the context and check if vram is still correct
            const system = isAlternationModel(modelName)
                ? alternationSystem
                : correctionSystem;
            const baseModel = getBasemodel(modelName)

            if (await ollama.list().then(models => models.models.some(m => m.name == modelName))) {
                await ollama.delete({ model: modelName });
            }
            await ollama.create({ model: modelName, from: baseModel, system, parameters: { num_ctx: testSample.sample.tokens } });
            if (isCorrectionModel(modelName)) {
                await RunModel(modelName, {
                    context: {
                        nextParagraphs: [],
                        previousParagraphs: [],
                        storyContext: 'Testdata',
                    },
                    paragraphToCorrect: 'Testdata',
                });
            } else {
                await RunModel(modelName, {
                    context: {
                        nextParagraphs: [],
                        previousParagraphs: [],
                        storyContext: 'Testdata',
                        intendedStyles: 'short',
                    },
                    paragraphToCorrect: 'Testdata',
                });
            }
            const modelInfo = await ModelInfo(modelName);
            const vramContextSize = modelInfo.size_vram;
            // check if the diference is bigger than 10%
            if (cache.max_vram && Math.abs(vramContextSize - cache.max_vram) / cache.max_vram > 0.1) {
                // clear cache
                console.log(`Invalidate cache, vram changed (${bytesTohuman(cache.max_vram)} -> ${bytesTohuman(vramContextSize)})`)
                cache = {
                    max_vram: undefined,
                    models: {}
                }
            }
            if (cache.max_vram) {
                console.log(`Difference ${(Math.abs(vramContextSize - cache.max_vram) / cache.max_vram * 100).toFixed(2)}%`);
            }
        }
        vram_size_checked = true;
    }


    for (const { model, context_window } of usedModels) {
        const models = await ollama.list();
        const modelNameCorrection = `general-correction-${model}` as const;
        const modelNameAlternation = `general-alternation-${model}` as const;

        const updateModel = async (modelName: `general-correction-${string}` | `general-alternation-${string}`, system: string) => {


            let max_supported_context_of_model: number | undefined = undefined;
            function extractMaxContextSize(modelInfo: ShowResponse) {
                const possible_maximumsizeText = Object.entries(modelInfo.model_info).filter(([x]) => x.includes('context_length')).map(([, x]) => x as string | number | undefined)[0];
                const possible_maximumsize = possible_maximumsizeText == undefined ? undefined : parseInt(possible_maximumsizeText.toString());
                if (possible_maximumsize && !isNaN(possible_maximumsize)) {
                    max_supported_context_of_model = possible_maximumsize;
                    console.log(`Model ${modelName} has a maximum context size of ${max_supported_context_of_model} tokens`);
                }
            }


            if (models.models.some(m => m.name == modelName)) {
                const modelInfo = await ModelDetails(modelName);
                const currentSystem = modelName.startsWith('general-correction') ? correctionSystem : alternationSystem;

                function getContextSizeFromParameters(params: string) {
                    const match = /num_ctx\s+(?<size>\d+)/.exec(params);
                    if (match) {
                        return parseInt(match.groups?.size ?? '0');
                    }
                    return undefined;
                }

                if (modelInfo.details.parent_model == model && modelInfo.system == currentSystem && ((context_window != undefined && getContextSizeFromParameters(modelInfo.parameters) == context_window) || (context_window == undefined && cache.models[modelName]?.context_size == getContextSizeFromParameters(modelInfo.parameters)))) {
                    console.log(`Model ${modelName} is already up to date`);
                    return;// already up to date
                }
                console.log(`Delete model ${modelName}`);
                delete (modelInfo as unknown as { tensors: unknown }).tensors;
                console.log(`Model info ${JSON.stringify(modelInfo, undefined, 2)}`);
                extractMaxContextSize(modelInfo);
                await ollama.delete({ model: modelName });
            }

            if (context_window) {
                await ollama.create({ model: modelName, from: model, system, parameters: { num_ctx: context_window } });
            } else {
                // create the model and find out maximum context size for the availabel VRAM

                // read from cache, maybe we already have the sizes


                if (cache.models[modelName] && cache.models[modelName].context_size) {
                    await ollama.create({ model: modelName, from: model, system, parameters: { num_ctx: cache.models[modelName].context_size } });
                    console.log(`Model ${modelName} created with context size ${cache.models[modelName].context_size}`);
                    return;
                }

                const startContextSize = 4000; // thats a number that may be enough for smaller paragraphs…
                const incrementContext = 1000;


                let currentContextSize = startContextSize;
                let baseModelSize: number | undefined = undefined;
                const context_size_per_token_history: { tokens: number, model_size: number }[] = [];
                let max_vram: number | undefined = undefined;

                let first = true;
                while (true) {
                    console.log(`Try model ${modelName} with context size ${currentContextSize} tokens`);

                    if (await ollama.list().then(models => models.models.some(m => m.name == modelName))) {
                        await ollama.delete({ model: modelName });
                    }
                    await ollama.create({ model: modelName, from: model, system, parameters: { num_ctx: currentContextSize } });
                    if (max_supported_context_of_model == undefined && first) {
                        const modelInfo = await ModelDetails(modelName);
                        delete (modelInfo as unknown as { tensors: unknown }).tensors;

                        console.log(`Model info ${JSON.stringify(modelInfo, undefined, 2)}`);

                        extractMaxContextSize(modelInfo);
                    }
                    first = false;

                    if (isCorrectionModel(modelName)) {
                        await RunModel(modelName, {
                            context: {
                                nextParagraphs: [],
                                previousParagraphs: [],
                                storyContext: 'Testdata',
                            },
                            paragraphToCorrect: 'Testdata',
                        });
                    } else {
                        await RunModel(modelName, {
                            context: {
                                nextParagraphs: [],
                                previousParagraphs: [],
                                storyContext: 'Testdata',
                                intendedStyles: 'short',
                            },
                            paragraphToCorrect: 'Testdata',
                        });
                    }
                    const modelInfo = await ModelInfo(modelName);
                    const total_model_size = modelInfo.size;
                    const vramContextSize = modelInfo.size_vram;
                    console.log(`Model ${modelName} created with ${currentContextSize} tokens context; total size ${bytesTohuman(total_model_size)} and vram size ${bytesTohuman(vramContextSize)}`);
                    if (baseModelSize == undefined) {
                        baseModelSize = total_model_size;
                        context_size_per_token_history.push({ tokens: currentContextSize, model_size: total_model_size });
                        currentContextSize = startContextSize + incrementContext;
                        continue;
                    }
                    context_size_per_token_history.push({ tokens: currentContextSize, model_size: total_model_size });
                    const modelSizeEstimator = createAproximationFunction(context_size_per_token_history.map(({ model_size, tokens }) => ({ x: tokens, y: model_size })));



                    if (max_vram == undefined) {
                        if (total_model_size > vramContextSize) {
                            max_vram = vramContextSize;
                            console.log(`Max vram ${bytesTohuman(max_vram)}`);
                        } else {
                            if (cache.max_vram) {
                                max_vram = cache.max_vram;
                                console.log(`Max vram ${bytesTohuman(max_vram)} from cache`);
                            } else {
                                // increase the context size by 4 GB to find the maximum vram
                                const increase = 4 * 1024 * 1024 * 1024;
                                const newContextSize = Math.floor(modelSizeEstimator.inverse(total_model_size + increase));
                                console.log(`Increase context size ${currentContextSize} -> ${newContextSize}`);
                                if (max_supported_context_of_model && newContextSize > max_supported_context_of_model) {
                                    console.warn(`Model ${modelName} has a maximum context size of ${max_supported_context_of_model} tokens. Cannot increase to ${newContextSize}`);
                                    currentContextSize = max_supported_context_of_model;
                                } else {
                                    currentContextSize = newContextSize;
                                }
                                continue;
                            }
                        }
                        if (baseModelSize > max_vram) {
                            // it will be slow, but we can probably get some use out of it
                            console.warn(`Base model size ${bytesTohuman(baseModelSize)} is bigger than max vram ${bytesTohuman(max_vram)} no optmalization possible`);
                            // we need to use the base model size   
                            console.log(`Model ${modelName} created with context size ${currentContextSize} tokens. Store for future use`);
                            cache.models[modelName] = {
                                context_size: currentContextSize,
                                samples: context_size_per_token_history,
                            };
                            cache.max_vram = max_vram;
                            fs.writeFileSync(cache_path, JSON.stringify(cache, undefined, 2));

                            await ollama.delete({ model: modelName });
                            await ollama.create({ model: modelName, from: model, system, parameters: { num_ctx: currentContextSize } });
                            return;
                        } else {
                            // calculate the maximum context size
                            const maxContextSize = Math.floor(modelSizeEstimator.inverse(max_vram));
                            currentContextSize = maxContextSize;
                            if (max_supported_context_of_model && maxContextSize > max_supported_context_of_model) {
                                console.warn(`Model ${modelName} has a maximum context size of ${max_supported_context_of_model} tokens. Cannot increase to ${maxContextSize}`);
                                currentContextSize = max_supported_context_of_model;
                            }
                            console.log(`Max context size ${maxContextSize} tokens`);
                        }
                        continue;
                    } else {
                        max_vram = Math.max(max_vram, vramContextSize);
                        cache.max_vram = max_vram;
                        fs.writeFileSync(cache_path, JSON.stringify(cache, undefined, 2));
                    }
                    if (total_model_size > max_vram) {
                        // we missed probably through rounding
                        // try a little bit smaller

                        const biggestSampelToSmall = context_size_per_token_history.filter(x => x.model_size > max_vram!).sort((a, b) => b.tokens - a.tokens)[0];
                        const smallestSampleToBig = context_size_per_token_history.filter(x => x.model_size < max_vram!).sort((a, b) => a.tokens - b.tokens)[0];

                        if (biggestSampelToSmall && smallestSampleToBig) {
                            const diff = (biggestSampelToSmall.tokens - smallestSampleToBig.tokens) / 2;
                            currentContextSize = Math.floor(biggestSampelToSmall.tokens - diff);
                        } else {
                            if (biggestSampelToSmall) {
                                // this should not happen, but just in case
                                currentContextSize = Math.floor(biggestSampelToSmall.tokens * 0.9);
                            } else if (smallestSampleToBig) {
                                currentContextSize = Math.floor(smallestSampleToBig.tokens * 0.9);
                            } else {
                                const assumedTokensForModelSize = modelSizeEstimator.inverse(total_model_size);
                                const diffToActualTokens = assumedTokensForModelSize - currentContextSize;
                                const newTargetTokens = Math.floor(modelSizeEstimator.inverse(max_vram));
                                if (newTargetTokens >= currentContextSize) {
                                    // model is too big, so a higher context size is not possible
                                    currentContextSize = Math.floor(currentContextSize * 0.95);
                                } else {
                                    if (diffToActualTokens == 0) {
                                        // the aproximation seems to be near enough
                                        currentContextSize = newTargetTokens;
                                    } else {
                                        const diff_in_percent = (diffToActualTokens / currentContextSize);
                                        // apply diff to new target
                                        const newTargetTokensCorrected = Math.floor(newTargetTokens * (1 - diff_in_percent));
                                        currentContextSize = newTargetTokensCorrected;
                                    }
                                }

                            }


                        }


                        console.log(`Model ${modelName} too big, try smaller context size ${currentContextSize}`);
                        continue;
                    } else if (total_model_size < max_vram * 0.95) {
                        // we missed probably through rounding
                        // try a little bit bigger

                        if (!max_supported_context_of_model || currentContextSize < max_supported_context_of_model) {
                            const biggestSampelToSmall = context_size_per_token_history.filter(x => x.model_size < max_vram!).sort((a, b) => b.tokens - a.tokens)[0];
                            const smallestSampleToBig = context_size_per_token_history.filter(x => x.model_size > max_vram!).sort((a, b) => a.tokens - b.tokens)[0];
                            if (biggestSampelToSmall && smallestSampleToBig) {
                                const diff = (smallestSampleToBig.tokens - biggestSampelToSmall.tokens) / 2;
                                currentContextSize = Math.floor(biggestSampelToSmall.tokens + diff);
                            } else {
                                if (biggestSampelToSmall) {
                                    // this should not happen, but just in case
                                    currentContextSize = Math.floor(biggestSampelToSmall.tokens * 1.1);
                                } else if (smallestSampleToBig) {
                                    currentContextSize = Math.floor(smallestSampleToBig.tokens * 1.1);
                                } else {
                                    const assumedTokensForModelSize = modelSizeEstimator.inverse(total_model_size);
                                    const diffToActualTokens = assumedTokensForModelSize - currentContextSize;
                                    const newTargetTokens = Math.floor(modelSizeEstimator.inverse(max_vram));
                                    if (newTargetTokens <= currentContextSize) {
                                        // model is too small, so a lower context size is not possible
                                        currentContextSize = Math.floor(currentContextSize * 1.05);
                                    } else {
                                        if (diffToActualTokens == 0) {
                                            // the aproximation seems to be near enough
                                            currentContextSize = newTargetTokens;
                                        } else {
                                            const diff_in_percent = (diffToActualTokens / currentContextSize);
                                            // apply diff to new target
                                            const newTargetTokensCorrected = Math.floor(newTargetTokens * (1 + diff_in_percent));
                                            currentContextSize = newTargetTokensCorrected;
                                        }
                                    }

                                }
                            }


                            console.log(`Model ${modelName} too small, try bigger context size ${currentContextSize}`);
                            continue;
                        }
                    }
                    if (max_supported_context_of_model && currentContextSize > max_supported_context_of_model!) {
                        console.warn(`Model ${modelName} has a maximum context size of ${max_supported_context_of_model} tokens. Cannot increase to ${currentContextSize}`);
                        currentContextSize = max_supported_context_of_model;
                    }
                    // we are done
                    console.log(`Model ${modelName} created with context size ${currentContextSize} tokens. Store for future use`);
                    cache.models[modelName] = {
                        context_size: currentContextSize,
                        samples: context_size_per_token_history,
                    };
                    cache.max_vram = max_vram;
                    fs.writeFileSync(cache_path, JSON.stringify(cache, undefined, 2));
                    return;
                }
            }



        }

        await updateModel(modelNameCorrection, correctionSystem);
        await updateModel(modelNameAlternation, alternationSystem);
    }



}

let running = false;



export async function checkRepo(): Promise<never> {
    if (running) {
        throw new Error('Already running');
    }

    running = true;
    while (true) {
        try {
            const cache = {};

            await git.updateRepo(githubApiToken, repo, cache);

            setModelConiguration({ modelNames: usedModels.map(x => x.model), styles: Object.keys(desiredStyles) });


            console.log('Repo updated');

            let workDone = false;
            const files = (await git.listFiles(undefined, cache)).filter(file => pathFilter.test(file.path));



            const timing = Date.now();
            const fileOrdering = Object.fromEntries(await Promise.all(files.map(async ({ path }) => [path, await git.getShortestCommitDepth(path, cache)] as const)))

            console.log(`File ordering ${JSON.stringify(fileOrdering, undefined, 2)}`);

            const elapsedMs = Date.now() - timing;

            // we want to start with the oldest entry, the one with the longest commit depth
            // assuming that newer files are less often changed then newer.

            // the ordering should be working if we assuem we are more or less up to date
            // but if we have a huge amount backlock we may want to have the next
            // we want to correct processed first
            const priorityOrdering: number[] = [];

            files.sort((a, b) => {
                for (const index of priorityOrdering) {
                    const stringPart = index <= 9
                        ? `0${index}`
                        : index.toString();
                    if (a.path.includes(stringPart)) {
                        return -1;
                    } else if (b.path.includes(stringPart)) {
                        return 1;
                    }
                }
                return fileOrdering[b.path] - fileOrdering[a.path]
            });
            const elapsedTime = elapsedMs < 1000 ?
                `${elapsedMs}ms` :
                elapsedMs < 60000 ?
                    `${(elapsedMs / 1000).toFixed(1)}s` :
                    `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`;
            console.log(`Ordering for ${files.length} files took ${elapsedTime}`, files.map(x => x.path));

            const originalId = await git.getCurrentCommitId();
            const checkStillValid = async () => {
                const currentId = await git.getCurrentCommitId();
                if (currentId != originalId) {
                    // ugly but it sholud work
                    throw new Error(`current Commit Changed RESTART ${currentId} != ${originalId}`);
                }
            }



            // first check simple spelling and grammar with langtool (its faster)
            for (const file of files) {
                await checkStillValid();
                console.log(`check ${file.path}`);
                workDone = await correctClassic(file.path) || workDone;
            }
            // then check with ollama
            for (const file of files) {
                await checkStillValid();
                console.log(`check ${file.path}`);
                workDone = await correct(file.path) || workDone;
            }
            if (!workDone) {
                console.log('Nothing to do, shutting down remote');
                await fetch(`${protocol}://${host}/poweroff`, {
                    method: 'POST',
                    ...fetchOptions(protocol),
                });
            }

            // delay for 30 seconds
            await new Promise((resolve) => setTimeout(resolve, 1000 * 30));
        } catch (error) {
            console.error('Error on background thread wait 1 min', error);
            await new Promise((resolve) => setTimeout(resolve, 1000 * 30 * 2));

        }
    }
};

export async function addWordToDictionary(params: string) {
    const currentDictionary = await git.getText(dictionaryLocation);
    const spited = currentDictionary.split('\n').map(x => x.trim()).filter(x => x.length > 0);
    if (spited.includes(params)) {
        console.log(`Word ${params} already in dictionary`);
        return;
    }
    const bot = git.getBotCommitDate();
    await git.setText(dictionaryLocation, `${spited.join('\n')}\n${params}\n`, {
        author: bot,
        committer: bot,
        message: 'Update dictionary'
    })
    console.log(`Word ${params} added to dictionary`);
}

export async function removeWordFromDictionary(params: string) {
    const currentDictionary = await git.getText(dictionaryLocation);
    const newDictionary = currentDictionary.split('\n').map(x => x.trim()).filter(x => x != params).join('\n');
    if (newDictionary == currentDictionary) {
        return;
    }
    const bot = git.getBotCommitDate();
    await git.setText(dictionaryLocation, newDictionary, {
        author: bot,
        committer: bot,
        message: 'Update dictionary'
    });
}

export async function getDictionary() {
    const dictionary = new Set((await git.getText(dictionaryLocation)).split('\n').map(x => x.trim().toLowerCase()).filter(x => x.length > 0));
    return {
        has: (word: string) => dictionary.has(word.toLowerCase())
    };
}


// const modelNameCorrection = `general-correction-${model}`;
// const modelNameAlternation = `general-alternation-${model}`;

async function ModelInfo(model: `general-correction-${string}` | `general-alternation-${string}`) {
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    const data = await ollama.ps();
    const requestedModel = data.models.filter(x => x.name.startsWith(model))[0];
    return requestedModel;
}
async function ModelDetails(model: `general-correction-${string}` | `general-alternation-${string}`) {
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    const data = await ollama.show({ model });
    return data;
}

function isCorrectionModel(params: string): params is `general-correction-${string}` {
    return params.startsWith('general-correction');
}
function isAlternationModel(params: string): params is `general-alternation-${string}` {
    return params.startsWith('general-alternation');
}

function getBasemodel<T extends string>(params: `general-correction-${T}` | `general-alternation-${T}`): T {
    if (isCorrectionModel(params)) {
        return params.substring('general-correction-'.length) as T;
    } else if (isAlternationModel(params)) {
        return params.substring('general-alternation-'.length) as T;
    }
    throw new Error(`Not a model`)
}

async function RunModel(model: `general-correction-${string}`, input: CorrectionInput): Promise<CorrectionResult & { prompt_eval_count?: number }>;
async function RunModel(model: `general-alternation-${string}`, input: AlternationInput): Promise<AlternationResult & { prompt_eval_count?: number }>;
async function RunModel(model: `general-correction-${string}` | `general-alternation-${string}`, input: CorrectionInput | AlternationInput): Promise<(CorrectionResult | AlternationResult) & { prompt_eval_count?: number }> {
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    for (let trys = 0; trys < 10; trys++) {

        const parser = model.startsWith('general-correction') ? CorrectionResultParser : AlternationResultParser;
        const result = await ollama.chat({
            model,
            messages: [{ role: 'user', content: JSON.stringify(input, undefined, 2) }],
            format: zodToJsonSchema(parser),
            stream: true,
        });
        const parts = [] as string[];
        let prompt_eval_count: number | undefined = undefined;
        for await (const part of result) {
            parts.push(part.message.content);
            prompt_eval_count = part.prompt_eval_count
            process.stdout.write(part.message.content);
            const currentText = parts.join('');
            if (checkForLongRepeatingPart(currentText, 150, 3)) {
                console.log('\n');

                console.error(`Model ${model} is repeating itself. Try again`);
                console.log('\n');
                console.log(currentText);
                console.log('\n');

                throw new Error(`Model ${model} is repeating itself. Try again`);
            }
        }
        console.log('\n');
        const correctionJsonText = parts.join('');

        // fix encoding errors like <0x6E>
        const correctionJsonTextFixed = correctionJsonText.replace(/<0x[0-9A-Fa-f]{2}>/g, (match) => {
            const charCode = parseInt(match.slice(3, -1), 16);
            return String.fromCharCode(charCode);
        });


        const parsed = parser.safeParse(JSON.parse(correctionJsonTextFixed));
        if (parsed.success) { // this should not fail, since ollama already validated against this schema
            return { prompt_eval_count, ...parsed.data };
        }
        else {
            const errorPath = 'faild.json';
            // check if we already have a sample and wirte it to a file if not

            if (!fs.existsSync(errorPath)) {
                fs.writeFileSync(errorPath, JSON.stringify(correctionJsonTextFixed, undefined, 2));
            }

            console.error(`Unable to parse result from model ${model} with input:\n${JSON.stringify(input, undefined, 2)}\nand output:\n${correctionJsonText}`);
        }
    }
    throw new Error(`Unable to get a valid response from model ${model} wit input:\n${JSON.stringify(input, undefined, 2)}`);
}

function checkForLongRepeatingPart(txt: string, minLength: number, minRepeats: number) {
    // we pereodicly check, so we can just check if the last minLength characters are somewhere else in the text
    const lastPart = txt.substring(txt.length - minLength);
    let found = 0;
    let index = txt.length - minLength - 1;
    while (index > 0) {
        const foundIndex = txt.lastIndexOf(lastPart, index);
        if (foundIndex == -1) {
            return false;
        }
        found++;
        if (found >= minRepeats) {
            return true;
        }
        index = foundIndex - minLength;
    }
    return false;
}

async function correctClassic(path: string) {


    const metadata: git.NewCorrectionMetadata = await getOrCreateMetadta(path);
    console.log(`Correct langtool ${path} with ${metadata.paragraphInfo.length}`);
    if (metadata.paragraphInfo.every(v => {
        return v.corrected?.text != undefined
            ;
    })) {
        // already corrected
        console.log(`Already corrected ${path}`);
        return false;
    }


    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));
    metadata.messages = messages;


    fireUpdate(path, metadata, true);

    const dictionary = await getDictionary();

    const disabled_rules = ['AUSLASSUNGSPUNKTE_LEERZEICHEN', 'DE_UNPAIRED_QUOTES', 'KLEINE_-CHEN'];

    console.log('correct spelling and grammar');
    for (let i = 0; i < metadata.paragraphInfo.length; i++) {
        if (metadata.paragraphInfo[i].corrected !== undefined) {
            // we already corrected this part
            continue;
        }
        console.log(`Process Part ${i} of ${metadata.paragraphInfo.length}`);

        const maximumPayload = 1000;

        const originalText = formatMarkdown(metadata.paragraphInfo[i].original);

        let charactersToConsume = metadata.paragraphInfo[i].original.length;
        const splittedText = [] as string[];
        let currentStart = 0;

        // chack if charactersToConsume fits in one request
        if (charactersToConsume <= maximumPayload) {
            splittedText.push(metadata.paragraphInfo[i].original);
        }
        else {
            // we need to split the text
            // start at maximumPayload and go back to the next `.`, `!`, `?` that is not next to an `"` or `'` and also not next to an digit
            const charactersToCheckAgainst = ['.', '!', '?'];
            const charactersToIgnore = ['"', "'", '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '!', '?'];
            for (let payloadArrayIndex = maximumPayload - 1; payloadArrayIndex > 0; payloadArrayIndex--) {
                const currentChar = originalText[currentStart + payloadArrayIndex];
                if (charactersToCheckAgainst.includes(currentChar)) {
                    const nextChar = originalText[currentStart + payloadArrayIndex + 1];
                    const prevChar = originalText[currentStart + payloadArrayIndex - 1];
                    if (!charactersToIgnore.includes(nextChar) && !charactersToIgnore.includes(prevChar)) {
                        const text = originalText.substring(currentStart, currentStart + payloadArrayIndex + 1);
                        if (text.length == 0) {
                            throw new Error(`Unable to split text in ${path} at ${payloadArrayIndex}`);
                        }
                        if (charactersToCheckAgainst.includes(text[0])) {
                            throw new Error(`Should end with . ? or ! in ${path} at ${payloadArrayIndex}`);
                        }
                        splittedText.push(text);
                        currentStart += payloadArrayIndex + 1;
                        charactersToConsume -= payloadArrayIndex + 1;
                        if (charactersToConsume <= maximumPayload) {
                            splittedText.push(originalText.substring(currentStart, currentStart + charactersToConsume));
                            break;
                        }
                        payloadArrayIndex = maximumPayload; // thats an interesting way to reset the loop
                    }

                }
            }

        }

        if (splittedText.join('') != metadata.paragraphInfo[i].original) {
            throw new Error(`Splitted text does not match original text in ${path} at ${i}`);
        }

        type entry = Exclude<NewParagrapInfo['corrected'], undefined>['corrections'][number];

        const semaphore = new Semaphore(1);



        const [correctedText, entrys] = (await Promise.all(splittedText.map(async text => {


            let result: LanguageToolResult;
            const toRelease = await semaphore.acquire();
            try {
                result = await getLanguageToolResult(text, disabled_rules);
            } finally {
                toRelease();
            }
            let correctedText = text;
            let furthestOffsetChange = text.length + 1;


            const entrys = [] as entry[];

            // start with the last match
            result.matches.sort((a, b) => (b.offset + b.length) - (a.offset + a.length)).forEach(match => {
                if (match.offset + match.length > furthestOffsetChange) {
                    // we already changed this part
                    console.warn(`Skip ${match.message} with offset ${match.offset} and length ${match.length} and replacement:\n\t${match.replacements.map(x => x.value).join('\n\t')}`);
                    return;
                }


                const start = match.offset;
                const end = match.offset + match.length;
                if (match.replacements.filter(x => x.value != undefined).length > 0) {
                    // we can just replace it


                    const [currentReplacement, ...alternativeReplacement] = match.replacements.filter(x => x.value != undefined).map(x => x.value ?? '');

                    const before = correctedText.substring(0, start);
                    const after = correctedText.substring(end);
                    const replacement = currentReplacement ?? '';
                    const original = correctedText.substring(start, end);
                    if (dictionary.has(original) && match.rule?.id == 'GERMAN_SPELLER_RULE') {
                        // it is a spelling error but it is in the dictionary so its fine
                        return;
                    }

                    correctedText = `${before}${replacement}${after}`;
                    furthestOffsetChange = Math.min(furthestOffsetChange, start);

                    const deltaLength = replacement.length - match.length;

                    // update all entrys that are after this match (wich are all since we are going from the end)
                    entrys.forEach(entry => {
                        entry.offset += deltaLength;
                    });

                    entrys.push({
                        offset: start,
                        length: replacement.length,
                        message: `${match.shortMessage}
${match.message}

Original war: ${original}

RuleID: ${match.rule?.id}
RuleDescription: ${match.rule?.description}
RuleCategory: ${match.rule?.category.name}
RuleConfidence: ${match.rule?.confidence}
`,
                        original,
                        rule: match.rule ? {
                            category: match.rule.category.id ?? '',
                            id: match.rule.id,
                            confidence: match.rule.confidence,
                        } : undefined,
                        replacedWith: replacement,
                        shortMessage: match.shortMessage,
                        alternativeReplacement,
                    });
                } else {
                    entrys.push({
                        offset: start,
                        length: match.length,
                        message: match.message,
                        original: '',
                        shortMessage: match.shortMessage,
                        alternativeReplacement: [],
                    });
                }
            });

            return {
                text: formatMarkdown(correctedText),
                corrections: entrys,
            };
        }))).reduce((p, c) => {
            const [text, entrys] = p;
            const currentTextLength = Math.max(0, text.length - 1);

            return [text + c.text, [...entrys, ...c.corrections.map(x => ({ ...x, offset: x.offset + currentTextLength }))]] as const;
        }
            , ['', []] as readonly [string, readonly entry[]]);
        metadata.paragraphInfo[i].corrected = {
            text: formatMarkdown(correctedText),
            corrections: [...entrys],
        };
    }
    await git.correctText(path, true, metadata);
    fireUpdate(path, metadata, true);

    return true;

}

async function getOrCreateMetadta(path: string, cache: object = {}) {

    const createNewParagraphs = async () => {
        console.log(`Create new paragraphs for ${path}`);
        const previousCorrection = await git.tryGetCorrection({ path, depth: 1, cache });

        return paragraphsWithPrefixs(await git.getText(path, cache)).map((v) => {
            const original = formatMarkdown(v.text);
            const existingOld = previousCorrection?.paragraphInfo.filter(x => x.original == original)[0];
            if (existingOld) {
                return {
                    ...existingOld,
                    edited: undefined,
                    selectedText: undefined,
                }
            }
            else {
                return {
                    original,
                    judgment: {},
                };
            }

        });
    };


    const metadata: git.NewCorrectionMetadata = (await git.tryGetCorrection({ path, cache })) ?? {
        time_in_ms: 0,
        messages: [],
        paragraphInfo: await createNewParagraphs()
    };

    return metadata;

}

async function correct(path: string) {


    const cache: object = {};

    const originalId = await git.getCurrentCommitId();
    const checkStillValid = async () => {
        const currentId = await git.getCurrentCommitId();
        if (currentId != originalId) {
            // ugly but it sholud work
            throw new Error('current Commit Changed RESTART');
        }
    }
    const metadata: git.NewCorrectionMetadata = await getOrCreateMetadta(path, cache);

    const isEveryModelAndStyleProcessed =
        (getFileProgress(metadata, { modelNames: usedModels.map(x => x.model), styles: Object.keys(desiredStyles) }) ?? 0) >= (getFileTotalProgress(metadata, { modelNames: usedModels.map(x => x.model), styles: Object.keys(desiredStyles) }));

    if (isEveryModelAndStyleProcessed) {
        // already corrected
        // technically this is not correct since we also check if the langtool is done, but that should be done already at this point
        return false;
    }
    console.log(`Correct ${path} with ${metadata.paragraphInfo.length} paragraphs and [${usedModels.map(({ model, context_window }) => context_window ? `${model} (${context_window})` : model).join(', ')}] models`);


    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));
    metadata.messages = messages;


    // need to get ast from original so the paragraph count is correct
    fireUpdate(path, metadata, true);



    await createModels();
    for (let modelIndex = 0; modelIndex < usedModels.length; modelIndex++) {
        const { model } = usedModels[modelIndex];


        // check if we need to do something in this model
        if (metadata.paragraphInfo.every(v => {
            return v.judgment[model]?.text.correction != undefined && Object.keys(v.judgment[model].text.alternative).filter(x => Object.keys(desiredStyles).includes(x)).length == Object.keys(desiredStyles).length;
        })) {
            // already corrected
            console.log(`Already corrected ${path} with model ${model}`);
            continue;
        }

        // we force the model to be loaded with a short request
        console.log(`Load model ${model}`);
        const startLoading = now();
        await RunModel(`general-correction-${model}`, {
            context: {
                storyContext: 'Testdata',
                previousParagraphs: [],
                nextParagraphs: [],
            },
            paragraphToCorrect: 'Testdata',
        }
        );


        const endLoading = now();
        const loadingTime = endLoading.getTime() - startLoading.getTime();
        console.log(`Model ${model} loaded in ${(reduceDuration({ milliseconds: loadingTime, second: 0, minute: 0 })).toFormat('mm:ss,SSS')}`);
        const modelInfo = await ModelInfo(`general-correction-${model}`);
        console.log(`Model ${model} info: ${JSON.stringify(modelInfo, undefined, 2)}`);

        if (modelInfo.size > modelInfo.size_vram) {
            console.warn(`Model ${model} dose not fit in VRAM. ${bytesTohuman(modelInfo.size - modelInfo.size_vram)} of ${bytesTohuman(modelInfo.size)} are offloaded.`);
        }


        for (let paragraphIndex = 0; paragraphIndex < metadata.paragraphInfo.length; paragraphIndex++) {




            // we get the next and previous paragraphs
            const text = metadata.paragraphInfo[paragraphIndex].original;
            const prev: string[] = [];
            const next: string[] = [];

            // take some context from the previous and next paragraphs
            // dependend on the size consumed minimum 1 paragraph
            const aproximatedLinse = 24;
            const aproximatedCharactersPerLine = 61;

            const minimumCharactersToConsume = aproximatedLinse * aproximatedCharactersPerLine;
            let charactersConsumed = 0;
            while (charactersConsumed < minimumCharactersToConsume && paragraphIndex - prev.length > 0) {
                const prevText = metadata.paragraphInfo[paragraphIndex - prev.length - 1].original;
                prev.push(prevText);
                charactersConsumed += prevText.length;
            }
            prev.reverse();
            charactersConsumed = 0;
            while (charactersConsumed < minimumCharactersToConsume && (paragraphIndex + next.length + 1) < metadata.paragraphInfo.length) {
                const nextText = metadata.paragraphInfo[paragraphIndex + next.length + 1].original;
                next.push(nextText);
                charactersConsumed += nextText.length;
            }
            const currentParagraphInfo = metadata.paragraphInfo[paragraphIndex];

            if (currentParagraphInfo.judgment[model]?.text.correction == undefined) {
                console.log(`Correct ${path} with model ${model} at paragraph ${paragraphIndex + 1} of ${metadata.paragraphInfo.length}`);

                const startBlock = now();

                const correctionInput = {
                    context: {
                        storyContext: context,
                        previousParagraphs: prev,
                        nextParagraphs: next,
                    },
                    paragraphToCorrect: text,
                } satisfies CorrectionInput;

                const correctionResult = await RunModel(`general-correction-${model}`, correctionInput);

                if (currentParagraphInfo.judgment[model]) {
                    currentParagraphInfo.judgment[model].text.correction = formatMarkdown(correctionResult.corrected);
                    currentParagraphInfo.judgment[model].goodPoints = correctionResult.goodPoints;
                    currentParagraphInfo.judgment[model].badPoints = correctionResult.badPoints;
                    currentParagraphInfo.judgment[model].score = correctionResult.judgment;
                    currentParagraphInfo.judgment[model].involvedCharacters = correctionResult.involvedCharacters;
                } else {
                    currentParagraphInfo.judgment[model] = {
                        involvedCharacters: correctionResult.involvedCharacters,
                        text: {
                            correction: formatMarkdown(correctionResult.corrected),
                            alternative: {},
                        },
                        score: correctionResult.judgment,
                        goodPoints: correctionResult.goodPoints,
                        badPoints: correctionResult.badPoints,
                    };
                }

                currentParagraphInfo.judgment[model].prompt_tokens = correctionResult.prompt_eval_count;


                const endBlock = now();
                const currentTime = endBlock.getTime() - startBlock.getTime();
                currentParagraphInfo.judgment[model].duration_ms = currentTime;
                console.log(`Correction for ${model} took ${(reduceDuration({ milliseconds: currentTime, second: 0, minute: 0 })).toFormat('mm:ss,SSS')}`);
                metadata.time_in_ms += currentTime;

                metadata.messages = messages;
                await git.correctText(path, true, metadata);
                fireUpdate(path, metadata, true);
                await checkStillValid();
            }


            for (const [desiredTitle, desired, styleIndex] of Object.entries(desiredStyles).map(([k, v], i) => [k, v, i] as const)) {
                await checkStillValid();


                const startBlock = now();
                if (metadata.paragraphInfo[paragraphIndex].judgment[model] !== undefined && metadata.paragraphInfo[paragraphIndex].judgment[model].text.alternative[desiredTitle] !== undefined) {
                    // we already have a judgment for this model and style
                    // just skip this
                    continue;
                }
                console.log(`Alternate Part ${paragraphIndex + 1} of ${metadata.paragraphInfo.length} for ${path} with model ${model} (${modelIndex + 1}/${usedModels.length}) and desired style ${desiredTitle} (${styleIndex + 1}/${Object.keys(desiredStyles).length})`);

                const alternationInput = {
                    context: {
                        storyContext: context,
                        intendedStyles: desired,
                        previousParagraphs: prev,
                        nextParagraphs: next,
                    },
                    paragraphToCorrect: text,
                } satisfies AlternationInput;

                const alternationResult = await RunModel(`general-alternation-${model}`, alternationInput);

                if (metadata.paragraphInfo[paragraphIndex].judgment[model] == undefined) {
                    // this should never happen since correction should always be called first
                    throw new Error(`Correction for model ${model} was not called before alternation`);
                }

                const formatedResult = formatMarkdown(alternationResult.alternative);

                const endBlock = now();
                const currentTime = endBlock.getTime() - startBlock.getTime();
                currentParagraphInfo.judgment[model].text.alternative[desiredTitle] = {
                    text: formatedResult,
                    duration_ms: currentTime,
                    prompt_tokens: alternationResult.prompt_eval_count,
                };

                console.log(`Alternation for ${desiredTitle} took ${(reduceDuration({ milliseconds: currentTime, second: 0, minute: 0 })).toFormat('mm:ss,SSS')}`);


                metadata.time_in_ms += currentTime;

                metadata.messages = messages;
                await git.correctText(path, true, metadata);
                fireUpdate(path, metadata, true);

            }
        }
    }



    return true;



}





















const paragraphsWithPrefixs = (text: string) => transformToAst(text).children.reverse().reduce((p, c) => {
    if (p.length == 0) {
        // always add it if it has no entrys yet 
        return [[c]];
    } else if (c.type == 'paragraph') {
        return [[c], ...p];
    } else {
        const [first, ...rest] = p;
        return [[c, ...first], ...rest];
    }
}, [] as RootContent[][])
    .map(x => {
        const [first] = x;
        const last = x[x.length - 1];
        return {
            text: transformFromAst({ type: 'root', children: x }),
            start: first.position?.start,
            end: last.position?.end,
        }
    });




const now = () => new Date(Date.now());


