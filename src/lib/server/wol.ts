
import fs from 'fs';
import { Ollama } from 'ollama';


import { z } from 'zod';

import type { BlockContent, DefinitionContent, Paragraph, RootContent } from 'mdast';

import * as git from '$lib/server/git'
import { fireUpdate } from '$lib/trpc/router';
import { zodToJsonSchema } from "zod-to-json-schema";

import { formatMarkdown, transformFromAst, transformToAst } from '$lib';
import path from 'path';
import { env, fetchOptions, wake, type NewParagrapInfo } from './configuration';
import { getLanguageToolResult } from './languagetool';


const generalSmystem = (theme: string) => `
Du bist ein weltbekanter, hilfreicher, kompetenter und erfolgreicher Lektor für ${theme}.

Deine Aufgabe ist es Texte zu korrigieren und verbessern. 
Du erhälst einen einzelen Paragraphen, die du berichtigen und verbessern sollst.
Du sollst eine Version zurück geben bei der die Rechtschreibung und Gramatk korrigiert wurden,
und eine Version bei der du auch die Formulierung verbessert hast.

Neben dem zu berichtigenden Paragraphen wird dir auch der Kontext mitgeteilt,
Eine allgemeine übresicht der Geschichte, den vorherigen Paragraphen, falls es nicht
der erste Paragrap des Kapitels ist, und der nächste Paragraph, falls es nicht der
letzte Paragraph des Kapitels ist.

---

Die Daten werden in JSON vormt übergeben, das wie folgt aufgebaut ist:
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(CorrectionInputParser), undefined, 2)}
\`\`\`

**storyContext**: Der Kontext der Geschichte
**intendedStyles**: Die beschreibung der gewünschten Stiles für die alternative Versionen.
**previousParagraphs**: Die vorherigen Abschnitte (nicht vollständig)
**nextParagraphs**: Die nächsten Abschnitte (nicht vollständig)

---

Die Ausgabe wird ebensfalls in JSON erwartet
\`\`\`JSON
${JSON.stringify(zodToJsonSchema(CorrectionResultParser), undefined, 2)}
\`\`\`

**involvedCharacters**: Die Charaktere die in diesem Abschnitt vorkommen
**corrected**: Der korrigierte Abschnitt (nur Rechtschreibung und Grammatik)
**alternative**: Der Abschnitt mit verbesserten/alternativen Formulierungen
**goodPoints**: Die guten Punkte des Abschnitts
**badPoints**: Die schlechten Punkte des Abschnitts
**judgment**: Eine Zahl zwischen -10 und 10 die die Qualität des Abschnitts bewertet

`

const CorrectionInputParser = z.object({
    context: z.object({
        storyContext: z.string(),
        intendedStyles: z.string(),
        previousParagraphs: z.array(z.string()),
        nextParagraphs: z.array(z.string()),
    }),
    paragraphToCorrect: z.string(),
});

type CorrectionInput = z.infer<typeof CorrectionInputParser>;

const CorrectionResultParser = z.object({
    involvedCharacters: z.array(z.string()),
    corrected: z.string(),
    alternative: z.string(),
    goodPoints: z.array(z.string()),
    badPoints: z.array(z.string()),
    judgment: z.number(),
});

export type CorrectionResult = z.infer<typeof CorrectionResultParser>;


const model_properties = {
    'qwen2.5:32b': {
        context_window: 27192,
    },
    'gemma2:27b': {
        context_window: 27192,
    },
    'gemma2:9b': {
        context_window: 27192,
    },
    'llama3.2:3b': {
        context_window: 27192,
    },
    'llama3.2:1b': {
        context_window: 27192,
    },
    'llama3.1:32b': {
        context_window: 27192,
    },
    'hf.co/Hasso5703/Mistral-Small-24B-Instruct-2501-Q4_0-GGUF': {
        context_window: 27192,
    },
} as const satisfies Record<string, ModelPropertys>;

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


const pathFilter = env.PATH_FILTER ? new RegExp(env.PATH_FILTER) : /story\/.*\.md/;

const noTimeoutFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const someInit = init || {}
    return fetch(input, {
        ...someInit,
        keepalive: true,
        ...fetchOptions(protocol)
    })
}

type ModelPropertys = {
    context_window: number
}

// the model to use
const usedModels: (keyof typeof model_properties)[] = (env.MODEL?.split('|') ?? ['hf.co/Hasso5703/Mistral-Small-24B-Instruct-2501-Q4_0-GGUF']) as (keyof typeof model_properties)[];
// manly for debbugging purpus








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


    await wake({ mac, ip, isHealthy });
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    for (const model of usedModels) {
        const models = await ollama.list();
        const context_window = model_properties[model]?.context_window;
        const modelName = `general-${model}`;
        const generalSystem = generalSmystem("Jugendbücher");

        if (models.models.every(m => m.name !== modelName)) {
            await ollama.create({ model: modelName, from: model, system: generalSystem, parameters: { num_ctx: context_window } });
        } else {
            await ollama.delete({ model: modelName });
            await ollama.create({ model: modelName, from: model, system: generalSystem, parameters: { num_ctx: context_window } });
        }
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

            await git.updateRepo(githubApiToken, repo);

            let workDone = false;
            const files = await git.listFiles();
            // first check simple spelling and grammar with langtool (its faster)
            for (const file of files) {
                if (pathFilter.test(file.path)) {
                    console.log(`check ${file.path}`);
                    workDone = await correctClassic(file.path) || workDone;
                }
            }
            // then check with ollama
            for (const file of files) {
                if (pathFilter.test(file.path)) {
                    console.log(`check ${file.path}`);
                    workDone = await correct(file.path) || workDone;
                }
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

async function correctClassic(path: string) {

    const metadata: git.NewCorrectionMetadata = (await git.tryGetCorrection(path)) ?? {
        time_in_ms: 0,
        messages: [],
        paragraphInfo: paragraphsWithPrefixs(await git.getText(path)).map((v) => {
            return {
                original: formatMarkdown(v.text),
                judgment: {},
            };

        }),
    };
    console.log(`Correct langtool ${path} with ${metadata.paragraphInfo.length}`);
    if (metadata.paragraphInfo.every(v => {
        return v.corrected?.text != undefined;
    })) {
        // already corrected
        console.log(`Already corrected ${path}`);
        return false;
    }


    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));
    metadata.messages = messages;


    // need to get ast from original so the paragraph count is correct
    fireUpdate(path, metadata);

    console.log('correct spelling and grammar');
    for (let i = 0; i < metadata.paragraphInfo.length; i++) {
        if (metadata.paragraphInfo[i].corrected !== undefined) {
            // we already corrected this part
            continue;
        }

        const maximumPayload = 1000;

        const originalText = metadata.paragraphInfo[i].original;

        let charactersToConsume = metadata.paragraphInfo[i].original.length;
        const splittedText = [] as string[];
        let currentStart = 0;

        // chack if charactersToConsume fits in one request
        if (charactersToConsume <= maximumPayload) {
            splittedText.push(metadata.paragraphInfo[i].original.substring(currentStart, currentStart + charactersToConsume));
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

        const [correctedText, entryes] = (await Promise.all(splittedText.map(async text => {


            const result = await getLanguageToolResult(text);
            let correctedText = text;
            let furthestOffsetChange = text.length + 1;


            const entrys = [] as entry[];

            // start with the last match
            result.matches.sort((a, b) => (b.offset + b.length) - (a.offset + a.length)).forEach(match => {
                if (match.offset + match.length > furthestOffsetChange) {
                    // we already changed this part
                    return;
                }
                const start = match.offset;
                const end = match.offset + match.length;
                if (match.replacements.filter(x => x.value != undefined).length == 1) {
                    // we can just replace it
                    const before = text.substring(0, start);
                    const after = text.substring(end);
                    const replacement = match.replacements[0].value ?? '';
                    correctedText = `${before}${replacement}${after}`;
                    furthestOffsetChange = Math.min(furthestOffsetChange, start);

                    const deltaLength = replacement.length - match.length;

                    // update all entrys that are after this match (wich are all since we are going from the end)
                    entrys.forEach(entry => {
                        entry.offset += deltaLength;
                    });

                    entrys.push({
                        offset: start,
                        length: match.length,
                        message: match.message,
                        shortMessage: match.shortMessage,
                        alternativeReplacement: [],
                    });
                }
            });

            const secondRun = await getLanguageToolResult(correctedText);
            const anyreplacmentsLef = secondRun.matches.some(match => match.replacements.filter(x => x.value != undefined).length == 1);
            if (anyreplacmentsLef) {
                // we have still some replacments left
                console.warn(`Still replacments left in ${path} at ${i}`);
                console.warn(secondRun.matches.filter(match => match.replacements.filter(x => x.value).length == 1).map(match => match.message));
            }

            entrys.push(...secondRun.matches.filter(match => match.replacements.length != 1).map(match => {
                return {
                    offset: match.offset,
                    length: match.length,
                    message: match.message,
                    shortMessage: match.shortMessage,
                    alternativeReplacement: match.replacements.map(r => r.value ?? ''),
                } satisfies Exclude<NewParagrapInfo['corrected'], undefined>['corrections'][number];
            }
            ));

            return {
                text: formatMarkdown(correctedText),
                corrections: entrys,
            };
        }))).reduce((p, c) => {
            const [text, entrys] = p;
            const currentTextLength = text.length;

            return [text + c.text, [...entrys, ...c.corrections.map(x => ({ ...x, offset: x.offset + currentTextLength }))]] as const;
        }
            , ['', []] as readonly [string, readonly entry[]]);
        metadata.paragraphInfo[i].corrected = {
            text: formatMarkdown(correctedText),
            corrections: [...entryes],
        };
    }
    await git.correctText(path, metadata);
    fireUpdate(path, metadata);

    return true;

}

async function correct(path: string) {

    const metadata: git.NewCorrectionMetadata = (await git.tryGetCorrection(path)) ?? {
        time_in_ms: 0,
        messages: [],
        paragraphInfo: paragraphsWithPrefixs(await git.getText(path)).map((v) => {
            return {
                original: formatMarkdown(v.text),
                judgment: {},
            };

        }),
    };
    console.log(`Correct ${path} with ${metadata.paragraphInfo.length} paragraphs and [${usedModels.join(', ')}] models`);
    if (metadata.paragraphInfo.every(v => {
        const progressed = Object.keys(v.judgment);
        return progressed.length == usedModels.length && progressed.every(k => usedModels.includes(k as keyof typeof model_properties));
    })) {
        // already corrected
        console.log(`Already corrected ${path}`);
        return false;
    }


    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));
    metadata.messages = messages;


    // need to get ast from original so the paragraph count is correct
    fireUpdate(path, metadata);



    await createModels();
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    const styles = Object.keys(desiredStyles).length == 0 ? { "Keine": 'Es wird keine neue Formulierung benötigt.' } : desiredStyles;
    for (const model of usedModels)
        for (let i = 0; i < metadata.paragraphInfo.length; i++)
            for (const [desiredTitle, desired] of Object.entries(styles)) {


                console.log(`Process Part ${i} of ${metadata.paragraphInfo.length} with model ${model} and desired style ${desiredTitle}`);
                const startBlock = now();
                if (metadata.paragraphInfo[i].judgment[model] !== undefined && metadata.paragraphInfo[i].judgment[model].text.alternative[desiredTitle] !== undefined) {
                    // we already have a judgment for this model and style
                    // just skip this
                    continue;
                }
                const text = metadata.paragraphInfo[i].original;
                const prev: string[] = [];
                const next: string[] = [];

                // take some context from the previous and next paragraphs
                // dependend on the size consumed minimum 1 paragraph
                const aproximatedLinse = 24;
                const aproximatedCharactersPerLine = 61;

                const minimumCharactersToConsume = aproximatedLinse * aproximatedCharactersPerLine;
                let charactersConsumed = 0;
                console.log('get previous paragraphs');
                while (charactersConsumed < minimumCharactersToConsume && i - prev.length > 0) {
                    const prevText = metadata.paragraphInfo[i - prev.length - 1].original;
                    prev.push(prevText);
                    charactersConsumed += prevText.length;
                }
                prev.reverse();
                charactersConsumed = 0;
                console.log('get next paragraphs');
                while (charactersConsumed < minimumCharactersToConsume && (i + next.length + 1) < metadata.paragraphInfo.length) {
                    const nextText = metadata.paragraphInfo[i + next.length + 1].original;
                    next.push(nextText);
                    charactersConsumed += nextText.length;
                }


                const input = {
                    context: {
                        storyContext: context,
                        intendedStyles: desired,
                        previousParagraphs: prev,
                        nextParagraphs: next,
                    },
                    paragraphToCorrect: text,
                } satisfies CorrectionInput;
                let currentTime = 0;
                for (let trys = 0; trys < 10; trys++) {

                    console.log(`Process Part\n\n${text}\n\n`);
                    const result = await ollama.chat({ model: `general-${model}`, messages: [{ role: 'user', content: JSON.stringify(input, undefined, 2) }], format: zodToJsonSchema(CorrectionResultParser), stream: true });
                    const parts = [] as string[];


                    console.log('Response \n\n');

                    for await (const part of result) {
                        parts.push(part.message.content);
                        process.stdout.write(part.message.content);
                    }


                    console.log(`Response Finished`);
                    // console.log( part.message.content);

                    const correctionJsonText = parts.join('');
                    // console.log( formatMarkdown(corrected));

                    const { data: correction, success, error } = CorrectionResultParser.safeParse(JSON.parse(correctionJsonText));



                    if (!success) {
                        // probably not the result we want
                        console.log(`retry  ${trys} of 10`);
                        if (!error.isEmpty) {
                            console.error(error.toString());
                            messages.push([ParagrahTexts(error.toString())]);
                        }
                        try {

                            messages.push([
                                {
                                    type: 'paragraph',
                                    children: [
                                        {
                                            type: 'text',
                                            value: `retry ${trys} of 10 for textpart ${i}`
                                        }]
                                },
                                {
                                    type: 'blockquote',
                                    children: [
                                        ...transformToAst(`\`\`\`\n${correctionJsonText}\n\`\`\``).children as BlockContent[]
                                    ]
                                }
                            ]
                            )
                        } catch (error) {
                            // this should always return an valid AST for this method, but to be safe
                            messages.push([ParagrahTexts(JSON.stringify(error))]);
                        }
                        continue;
                    }

                    correction.corrected = formatMarkdown(correction.corrected);
                    correction.alternative = formatMarkdown(correction.alternative);

                    const currentParagraphInfo = metadata.paragraphInfo[i] as unknown as git.NewCorrectionMetadata['paragraphInfo'][0];
                    if (currentParagraphInfo.judgment[model] == undefined) {
                        const alternative = {} as Record<string, string>;
                        alternative[desiredTitle] = correction.alternative;
                        currentParagraphInfo.judgment[model] = {
                            involvedCharacters: correction.involvedCharacters,
                            text: {
                                correction: correction.corrected,
                                alternative,
                            },

                            score: correction.judgment,
                            goodPoints: correction.goodPoints,
                            badPoints: correction.badPoints,
                        };
                    } else {
                        // we have already a judgment for this model
                        // this happens when we have multiple desired styles
                        // we just add the alternative to the existing judgment
                        // and look at the correction again seening what changed
                        const alternative = currentParagraphInfo.judgment[model].text.alternative;
                        alternative[desiredTitle] = correction.alternative;
                        if (correction.corrected != currentParagraphInfo.judgment[model].text.correction) {
                            // we got a new correction
                            // we should note the change in protocol field
                            const protocol = currentParagraphInfo.judgment[model].protocol ?? [];
                            protocol.push({
                                style: desiredTitle,
                                description: `Correction changed`,
                                newValue: correction.corrected,
                                oldValue: currentParagraphInfo.judgment[model].text.correction,
                            });
                            currentParagraphInfo.judgment[model].protocol = protocol;
                        }
                        function ArrayEquals(a: string[], b: string[]) {
                            const aSorted = a.toSorted();
                            const bSorted = b.toSorted();
                            return aSorted.length == bSorted.length && aSorted.every((v, i) => v == bSorted[i]);
                        }
                        if (!ArrayEquals(correction.badPoints, currentParagraphInfo.judgment[model].badPoints)) {
                            // we got a new correction
                            // we should note the change in protocol field
                            const protocol = currentParagraphInfo.judgment[model].protocol ?? [];
                            protocol.push({
                                style: desiredTitle,
                                description: `Bad Points changed`,
                                newValue: correction.badPoints,
                                oldValue: currentParagraphInfo.judgment[model].badPoints,
                            });
                            currentParagraphInfo.judgment[model].protocol = protocol;
                        }
                        if (!ArrayEquals(correction.goodPoints, currentParagraphInfo.judgment[model].goodPoints)) {
                            // we got a new correction
                            // we should note the change in protocol field
                            const protocol = currentParagraphInfo.judgment[model].protocol ?? [];
                            protocol.push({
                                style: desiredTitle,
                                description: `Good Points changed`,
                                newValue: correction.goodPoints,
                                oldValue: currentParagraphInfo.judgment[model].goodPoints,
                            });
                            currentParagraphInfo.judgment[model].protocol = protocol;
                        }
                        if (correction.judgment != currentParagraphInfo.judgment[model].score) {
                            // we got a new correction
                            // we should note the change in protocol field
                            const protocol = currentParagraphInfo.judgment[model].protocol ?? [];
                            protocol.push({
                                style: desiredTitle,
                                description: `Score changed`,
                                newValue: correction.judgment,
                                oldValue: currentParagraphInfo.judgment[model].score,
                            });
                            currentParagraphInfo.judgment[model].protocol = protocol;
                        }
                        if (!ArrayEquals(correction.involvedCharacters, currentParagraphInfo.judgment[model].involvedCharacters)) {
                            // we got a new correction
                            // we should note the change in protocol field
                            const protocol = currentParagraphInfo.judgment[model].protocol ?? [];
                            protocol.push({
                                style: desiredTitle,
                                description: `Involved Characters changed`,
                                newValue: correction.involvedCharacters,
                                oldValue: currentParagraphInfo.judgment[model].involvedCharacters,
                            });
                            currentParagraphInfo.judgment[model].protocol = protocol;
                        }

                    }


                    await git.correctText(path, metadata);
                    const endBlock = now();
                    currentTime = endBlock.getTime() - startBlock.getTime();
                    metadata.time_in_ms += currentTime;
                    // we got an updated text just stop now
                    break;
                }
                fireUpdate(path, metadata);


                metadata.messages = messages;
                await git.correctText(path, metadata);
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


function ParagrahTexts(params: string): Paragraph {
    return {
        type: 'paragraph',
        children: [{ type: 'text', value: params }]
    }

}
