import * as git from 'isomorphic-git';
import fs from 'node:fs/promises';
import * as syncfs from 'node:fs';
import { Octokit } from 'octokit';
import { z } from 'zod'

import type { BlockContent, DefinitionContent } from 'mdast';


import http from 'isomorphic-git/http/web';
import { fireUpdate } from '$lib/trpc/router';
import { getDictionary } from './wol';
import { paragrapInfo } from './configuration';

const dir = 'repo';


const bot = () => ({
    name: 'Review Bot',
    email: 'noreply@review.bot',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset(),
});

export function getBotCommitDate() {
    return bot();
}




export async function updateRepo(githubApiToken: string, repo: string, cache: object = {}) {
    console.log('Updating repository');
    try {


        const octokit = new Octokit({ auth: githubApiToken });

        const {
            data: { login },
        } = await octokit.rest.users.getAuthenticated();
        console.log(`Login is ${login}`)
        console.log(`Repo is ${repo}`)
        // checkout repository
        const { data: repository } = await octokit.rest.repos.get({
            owner: login,
            repo,
        });

        console.log(`Clone URL is ${repository.clone_url}`);

        const clone_url = new URL(repository.clone_url);
        clone_url.username = login;
        clone_url.password = githubApiToken;



        if (syncfs.existsSync(dir) && await git.findRoot({ fs, filepath: dir }) == dir) {
            await git.pull({
                fs,
                http,
                dir,
                author: bot(),
                committer: bot(),
                url: clone_url.href,
                cache,
            });
            console.log('Repository updated successfully');
        } else {
            try {
                await git.clone({
                    fs,
                    http,
                    dir,
                    url: clone_url.href,
                    cache,
                });
                console.log('Repository cloned successfully');
            } catch (error) {
                console.error('Failed to clone repository:', error);
            }
        }
        const remoteRefs = await git.listServerRefs({ http, url: clone_url.href, prefix: 'refs/spellcheck/' });
        for (const ref of remoteRefs) {
            console.log('fetching', ref.ref);
            const result = await git.fetch({
                fs,
                http,
                dir,
                ref: ref.ref,
                cache,
            })
            if (result.fetchHead) {
                const spellcheckId = ref.ref.substring('refs/spellcheck/'.length);
                if ((await git.listRefs({ fs, dir, filepath: ref.ref })).length === 0) {
                    await git.writeRef({ fs, dir, ref: ref.ref, value: result.fetchHead, symbolic: false, force: true });
                    console.log('fetched new', result.fetchHead);
                }
                else {
                    try {
                        await git.merge({
                            fs,
                            dir,
                            ours: `refs/spellcheck/${spellcheckId}`,
                            theirs: result.fetchHead,
                            fastForwardOnly: true,
                            cache,
                        })
                        console.log('fetched existing', result.fetchHead);
                    } catch (e) {
                        if (e instanceof git.Errors.FastForwardError) {
                            // we need too merge it, we know the structure of metadate, so we should be able to merge it automatically
                            console.log(`Try merging ${spellcheckId}`);


                            // get local and remote metadata
                            const localMetadata = await getCorrection({ path: spellcheckId, type: 'local', pathType: 'spellcheckID' });
                            const remoteMetadata = await getCorrection({ path: spellcheckId, type: 'remote', pathType: 'spellcheckID' });
                            const commonParent = await getCorrection({ path: spellcheckId, type: 'common parent', pathType: 'spellcheckID' });

                            // merge metadata
                            const mergedMetadataParagarps = localMetadata.paragraphInfo.map((x, i) => [x, remoteMetadata.paragraphInfo[i], commonParent.paragraphInfo[i]] as const).map(([local, remote, common]) => {
                                if (local.original != remote.original && remote.original != common.original) {
                                    // this should not happen, since changing the text would change the spellcheck id
                                    throw new Error('Original text is different');
                                }
                                let edited: string | undefined;
                                if (!local.edited) {
                                    edited = remote.edited;
                                } else if (!remote.edited) {
                                    edited = local.edited;
                                } else if (local.edited == common.edited) {
                                    edited = remote.edited;
                                } else if (remote.edited == common.edited) {
                                    edited = local.edited;
                                } else if (local.edited != remote.edited) {
                                    edited = `======MERGE CONFLICT=====\n\n===LOCAL===\n\n${local.edited}\n\n===LOCAL END===\n\n===REMOTE===\n\n${remote.edited}\n\n===REMOTE END===`;
                                } else {
                                    edited = local.edited ?? remote.edited;
                                }

                                // for judgement deep merge and prefer the remote if two strings are different
                                const judgment = { ...local.judgment, ...remote.judgment };
                                for (const model in judgment) {
                                    if (local.judgment[model] && remote.judgment[model]) {
                                        const localText = local.judgment[model].text;
                                        const remoteText = remote.judgment[model].text;
                                        const commonText = common.judgment[model].text;
                                        const mergedTextKeys = Object.keys({ ...localText.alternative, ...remoteText.alternative, ...commonText.alternative });
                                        const mergedText = { alternative: {} } as NewCorrectionMetadata['paragraphInfo'][number]['judgment'][string]['text'];
                                        for (const key of mergedTextKeys) {
                                            const localValue = localText.alternative[key];
                                            const remoteValue = remoteText.alternative[key];
                                            const commonValue = commonText.alternative[key];
                                            if (localValue == remoteValue || remoteValue == commonValue) {
                                                mergedText.alternative[key] = localValue;
                                            } else if (localValue == commonValue) {
                                                mergedText.alternative[key] = remoteValue;
                                            } else {
                                                // in conflict case prefere remote
                                                mergedText.alternative[key] = remoteValue;
                                            }
                                        }
                                        // for correction prefere remote
                                        if ((remoteText.correction != commonText.correction) || localText.correction == undefined) {
                                            mergedText.correction = remoteText.correction;
                                        } else {
                                            mergedText.correction = localText.correction;
                                        }

                                        judgment[model].text = mergedText;
                                    }
                                }

                                return {
                                    selectedText: remote.selectedText ?? local.selectedText,
                                    original: local.original,
                                    edited,
                                    judgment,
                                    corrected: local.corrected ?? remote.corrected,
                                } satisfies NewCorrectionMetadata['paragraphInfo'][number];

                            });

                            const mergedMetadata = {
                                messages: [...remoteMetadata.messages],
                                time_in_ms: localMetadata.time_in_ms + remoteMetadata.time_in_ms,
                                paragraphInfo: mergedMetadataParagarps,
                            } satisfies NewCorrectionMetadata;

                            const bot = getBotCommitDate();

                            await correctText(spellcheckId, mergedMetadata, {
                                author: bot,
                                committer: bot,
                                message: `Merged ${spellcheckId}`,
                            }, 'merge');



                        } else {

                            throw e;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
}

export async function getCurrentCommitId() {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    return head;
}

export async function getText(path: string, cache: object = {}) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommit = await git.resolveRef({ fs, dir, ref: head });

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
    return new TextDecoder().decode(currentBlob.blob);
}

export async function getCurrentCommitData() {
    const branch = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommitOid = await git.resolveRef({ fs, dir, ref: branch });

    const currentCommit = await git.readCommit({ fs, dir, oid: currentCommitOid });
    return currentCommit.commit;
}

export async function setText(path: string, newText: string, commitData: Omit<git.CommitObject, 'parent' | 'tree'>) {
    const branch = await git.resolveRef({ fs, dir, ref: 'HEAD', depth: 1 });
    const branchName = branch.replace(/^ref:\s*/, '');
    const currentCommitOid = await git.resolveRef({ fs, dir, ref: branch });

    const currentCommit = await git.readCommit({ fs, dir, oid: currentCommitOid });
    const rootTreeOid = currentCommit.commit.tree;
    const rootTree = await git.readTree({ fs, dir, oid: rootTreeOid });
    const pathSegments = path.split('/');

    type Tree = git.TreeEntry[];
    const newTree = await modifyTree(rootTree.tree, newText, pathSegments)
    const newTreeOid = await git.writeTree({ fs, dir, tree: newTree });

    const newCommit = await git.writeCommit({
        fs, dir, commit: {
            ...commitData,
            parent: [currentCommitOid],
            tree: newTreeOid,

        }
    });
    console.log(`${newCommit} ${path} on ${branch} with name ${branchName}`);
    await git.writeRef({ fs, dir, ref: branchName, value: newCommit, symbolic: false, force: true });
    await git.push({
        fs,
        dir,
        //  force: true,
        http,
    });

    async function modifyTree(tree: git.TreeEntry[], newText: string, segments: string[]): Promise<Tree> {
        const [currentPath, ...restPathsegments] = [...segments];

        const promises = tree.map(async x => {
            if (x.path == currentPath) {
                if (x.type == 'blob') {
                    if (restPathsegments.length == 0) {
                        //las element we can return our new blob
                        const newBlobOid = await git.writeBlob({
                            fs, dir,
                            blob: new TextEncoder().encode(newText),
                        });
                        return {
                            ...x,
                            oid: newBlobOid
                        } satisfies git.TreeEntry;
                    }
                    throw new Error(`Faild to write blob, Encounterd blob instead of tree. Rest Path ${restPathsegments.join(", ")}`);
                } else if (x.type == 'commit') {
                    throw new Error(`Type Commit not supported`);
                } else {
                    const { tree } = await git.readTree({ fs, dir, oid: x.oid });
                    const newTree = await modifyTree(tree, newText, restPathsegments);
                    const newTreeOid = await git.writeTree({ fs, dir, tree: newTree });
                    return {
                        ...x,
                        oid: newTreeOid,
                    } satisfies git.TreeEntry;
                }
            } else {
                return x;
            }
        });
        return await Promise.all(promises);
    }
}

const oldParagraphInfo = z.object({
    text: z.object({
        original: z.string(),
        alternative: z.string().optional(),
        correction: z.string().optional(),
        edited: z.string().optional(),
    }),
    selectedText: z.enum(['original', 'alternative', 'correction', 'edited'] as const).optional(),
    judgment: z.object({
        goodPoints: z.string(),
        badPoints: z.string(),
        score: z.number(),
        model: z.string().optional(),
    }).optional(),
    involvedCharacters: z.array(z.string()).optional()
});

export type OldParagraphInfo = z.infer<typeof oldParagraphInfo>;

export function isParagraphInfoWithCorrection(x: OldParagraphInfo): x is OldParagraphInfo {
    return 'judgment' in x && x.judgment != undefined;
}

export const oldCorrectionParser = z.object({
    messages: z.array(z.any()),
    time_in_ms: z.number(),
    paragraphInfo: z.array(oldParagraphInfo),
});



export type OldCorrectionMetadata = z.infer<typeof oldCorrectionParser> & {
    messages: Array<BlockContent | DefinitionContent>[];
};


export const newCorrectionParser = z.object({
    messages: z.array(z.any()),
    time_in_ms: z.number(),
    paragraphInfo: z.array(paragrapInfo),
});

export type NewCorrectionMetadata = z.infer<typeof newCorrectionParser> & {
    messages: Array<BlockContent | DefinitionContent>[];
};

export async function correctText(path: string, metadata: NewCorrectionMetadata, commitData?: { message?: string } & Omit<git.CommitObject, 'message' | 'parent' | 'tree'>, type: 'fileChange' | 'merge' = 'fileChange') {

    const corrected = metadata.paragraphInfo.map((paragraph) => {
        if (paragraph.selectedText == undefined) {
            // this should not happen
            if (paragraph.corrected?.text) {
                return paragraph.corrected.text;
            }
            return paragraph.judgment[Object.keys(paragraph.judgment).toSorted()[0]]?.text?.correction ?? paragraph.original;
        } else if (paragraph.selectedText == 'original') {
            return paragraph.original;
        } else if (paragraph.selectedText == 'corrected') {
            if (paragraph.corrected?.text) return paragraph.corrected.text;
        } else if (paragraph.selectedText == 'edited') {
            if (paragraph.edited) { return paragraph.edited; }
        } else if (paragraph.selectedText[1] == 'correction') {
            const [model] = paragraph.selectedText;
            if (paragraph.judgment[model]) {
                return paragraph.judgment[model].text;
            }
        } else if (paragraph.selectedText[1] == 'alternative') {
            const [model, , alternative] = paragraph.selectedText;
            if (paragraph.judgment[model] && paragraph.judgment[model].text.alternative[alternative]) {
                return paragraph.judgment[model].text.alternative[alternative];
            }
        }
        throw new Error(`Faild to buidld Text from Metdata`);
    }).join('\n');

    if (type == 'fileChange') {
        const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const currentCommit = await git.resolveRef({ fs, dir, ref: head });

        let lastCommit = currentCommit;

        const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit });
        const metadataBlobOid = await git.writeBlob({
            fs, dir,
            blob: new TextEncoder().encode(JSON.stringify(metadata, undefined, 2)),
        });
        const correctionBlobOid = await git.writeBlob({
            fs, dir,
            blob: new TextEncoder().encode(corrected),
        });

        const tree = await git.writeTree({
            fs,
            dir,
            tree: [
                {
                    type: 'blob',
                    oid: correctionBlobOid,
                    path: 'correction',
                    mode: '100644',
                },
                {
                    type: 'blob',
                    oid: currentBlob.oid,
                    path: 'original',
                    mode: '100644',
                },
                {
                    type: 'blob',
                    oid: metadataBlobOid,
                    path: 'metadata',
                    mode: '100644',
                }

            ],
        });



        let parent = [lastCommit];
        if (await hasCorrection(path)) {
            const oid = await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${currentBlob.oid}` });
            console.log('old oid for last spellcheck', oid);
            parent = [oid];
        }

        const numberOfParagraphs = metadata.paragraphInfo.length;
        const numberOfCorrectedParagraphs = metadata.paragraphInfo.map(x => Object.keys(x.judgment).length).reduce((a, b) => a + b, 0);

        const actualCommitData = {
            message: `Correct ${path} ${numberOfCorrectedParagraphs}/${numberOfParagraphs} ${metadata.time_in_ms}`,
            ...(commitData ?? {
                author: bot(),
                committer: bot(),
            }),
            tree,
            parent: parent,
        };

        const commit = await git.writeCommit({
            fs,
            dir,
            commit: actualCommitData
        });
        lastCommit = commit;
        console.log('commit', commit);

        await git.writeRef({ fs, dir, ref: `refs/spellcheck/${currentBlob.oid}`, value: commit, symbolic: false, force: true });
        fireUpdate(path, metadata);
        await git.push({
            fs,
            dir,
            force: true,
            http, ref: `refs/spellcheck/${currentBlob.oid}`,
        });
    } else {
        const originalOid = path;
        const metadataBlobOid = await git.writeBlob({
            fs, dir,
            blob: new TextEncoder().encode(JSON.stringify(metadata, undefined, 2)),
        });
        const correctionBlobOid = await git.writeBlob({
            fs, dir,
            blob: new TextEncoder().encode(corrected),
        });

        const tree = await git.writeTree({
            fs,
            dir,
            tree: [
                {
                    type: 'blob',
                    oid: correctionBlobOid,
                    path: 'correction',
                    mode: '100644',
                },
                {
                    type: 'blob',
                    oid: originalOid,
                    path: 'original',
                    mode: '100644',
                },
                {
                    type: 'blob',
                    oid: metadataBlobOid,
                    path: 'metadata',
                    mode: '100644',
                }

            ],
        });

        const remoteCommit = await git.resolveRef({ fs, dir, ref: `remotes/origin/refs/spellcheck/${originalOid}` });
        const localCommit = await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${originalOid}` });

        const parent = [remoteCommit, localCommit];

        const actualCommitData = {
            message: `Merge ${path}`,
            ...(commitData ?? {
                author: bot(),
                committer: bot(),
            }),
            tree,
            parent: parent,
        };

        const commit = await git.writeCommit({
            fs,
            dir,
            commit: actualCommitData
        });
        console.log('commit', commit);

        await git.writeRef({ fs, dir, ref: `refs/spellcheck/${originalOid}`, value: commit, symbolic: false, force: true });
        fireUpdate(path, metadata);
        await git.push({
            fs,
            dir,
            force: true,
            http, ref: `refs/spellcheck/${originalOid}`,
        });


    }
}


export async function listFiles(branch: string = 'HEAD', cache: object = {}) {
    const ref = await git.resolveRef({ fs, dir, ref: branch });
    const files = await git.listFiles({ fs, dir, ref, cache });
    const hasSpellcheck = await Promise.all(files.toSorted((a, b) => a.localeCompare(b)).map(async (file) => {
        return { hasCorrection: await hasCorrection(file, undefined, cache), path: file };
    }));
    return hasSpellcheck;
}

export async function getShortestCommitDepth(path: string, cache: object = {}) {
    const ref = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    let lastDepth = 0;


    const log_of_file = (await git.log({ fs, dir, ref: 'HEAD', filepath: path, depth: 0, cache }))[0];

    // count the number of commits in from head to log_of_file.oid
    const oidToHandle: { oid: string, depth: number }[] = [{ oid: ref, depth: 0 }]
    while (oidToHandle.length > 0) {
        const [{ oid, depth }] = oidToHandle.splice(0, 1)!;

        const parents = (await git.readCommit({ fs, dir, oid, cache })).commit.parent.map(oid => ({ oid, depth: depth + 1 }));
        if (parents.some(x => x.oid == log_of_file.oid)) {
            return depth;
        }
        // let us store the depth if we runn out of parents
        lastDepth = Math.max(lastDepth, depth);
        oidToHandle.push(...parents);
    }
    return lastDepth;
}


export async function getCorrectionOid(path: string, depth: number = 0, cache: object = {}) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    // this is not correct, we do not want the correction from previous commit, but from previous correction
    let currentCommit = head;
    if (depth == 0) {
        const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
        const oid = currentBlob.oid;
        console.log(`check if spellchekID ${oid} exists`);
        return await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
    }
    depth--;
    {
        // get the commit before the current commit
        const commit = await git.readCommit({ fs, dir, oid: currentCommit, cache });
        if (commit.commit.parent.length == 0) {
            throw new Error('No parent found');
        }
        currentCommit = commit.commit.parent[0];
    }

    while (depth > 0) {

        depth--;


        // get the commit before the current commit
        const commit = await git.readCommit({ fs, dir, oid: currentCommit, cache });
        if (commit.commit.parent.length == 0) {
            throw new Error('No parent found');
        }


        currentCommit = commit.commit.parent[0];
    }

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
    const oid = currentBlob.oid;
    try {
        return await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
    } catch {
        throw new Error(`No correction found for ${path}`);
    }
}

export async function hasCorrection(path: string, depth: number = 0, cache: object = {}) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    // this is not correct, we do not want the correction from previous commit, but from previous correction
    let currentCommit = head;
    if (depth == 0) {
        const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
        const oid = currentBlob.oid;
        try {
            console.log(`check if spellchekID ${oid} exists`);
            await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
            console.log(`spellchekID ${oid} exists`);
            return true;
        } catch {
            console.log(`spellchekID ${oid} does not exist`);
            return false;
        }
    }
    depth--;
    {
        // get the commit before the current commit
        const commit = await git.readCommit({ fs, dir, oid: currentCommit, cache });
        if (commit.commit.parent.length == 0) {
            return false;
        }
        currentCommit = commit.commit.parent[0];
    }

    while (depth > 0) {

        const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
        const oid = currentBlob.oid;
        try {
            await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
            depth--;
        } catch {
            return false;
        }


        // get the commit before the current commit
        const commit = await git.readCommit({ fs, dir, oid: currentCommit, cache });
        if (commit.commit.parent.length == 0) {
            return false;
        }


        currentCommit = commit.commit.parent[0];
    }

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit, cache });
    const oid = currentBlob.oid;
    try {
        await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
        return true;
    } catch {
        return false;
    }
}

export async function getSpellcheckId(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: head });
    const oid = currentBlob.oid;
    return oid;
}

export async function tryGetCorrection({ path, depth = 0, cache = {} }: { path: string, depth?: number, cache?: object }) {
    if (await hasCorrection(path, depth, cache)) {
        console.log(`Correction found for ${path}`);
        return await getCorrection({ path, depth, cache });
    } else {
        console.log(`No correction found for ${path}`);
        return null;
    }
}
export async function getCorrection({ path, type = 'local', pathType = 'filePath', depth = 0, cache = {} }: { path: string, type?: 'local' | 'remote' | 'common parent', pathType?: 'filePath' | 'spellcheckID', depth?: number, cache?: object }): Promise<NewCorrectionMetadata> {


    let correctionOid: string;
    if (type == 'local' && pathType == 'filePath') {
        correctionOid = await getCorrectionOid(path, depth, cache);
    } else {


        let oid: string;
        if (pathType == 'spellcheckID') {
            oid = path;
        }
        else {
            console.log(`resolve head`)
            const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: head, cache });
            oid = currentBlob.oid;
        }
        console.log(`resolvig id ${oid}`);
        if (type == 'common parent') {
            console.log(`Try to resolve common Parent`)

            const localOid = await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
            const remoteOid = await git.resolveRef({ fs, dir, ref: `remotes/origin/refs/spellcheck/${oid}` });
            const [commonParentOid] = await git.findMergeBase({ fs, dir, oids: [localOid, remoteOid], cache }) as string[];
            correctionOid = commonParentOid;

        } else {
            const ref = type == 'remote' ? `remotes/origin/refs/spellcheck/${oid}` : `refs/spellcheck/${oid}`;
            console.log(`Try to resolve ${ref}`)
            correctionOid = await git.resolveRef({ fs, dir, ref });
        }

        if (!correctionOid) {
            throw new Error(`Failed to find correction ${type} ${type == 'common parent' ? 'common parent' : ''} for ${path}`);
        }

        for (let i = 0; i < depth; i++) {
            const commit = await git.readCommit({ fs, dir, oid: correctionOid, cache });
            if (commit.commit.parent.length == 0) {
                throw new Error("No perent fonud");
            }
            correctionOid = commit.commit.parent[0];
        }

    }
    const decoder = new TextDecoder();
    const decode = (data: { blob: Uint8Array<ArrayBufferLike> } | undefined | null) => {
        if (data)
            return decoder.decode(data.blob);
        else
            return null;
    };

    const metadataString = decode(await git.readBlob({ fs, dir, oid: correctionOid, filepath: 'metadata', cache }));
    if (metadataString) {
        const metadataObj = JSON.parse(metadataString);
        const isOld = oldCorrectionParser.safeParse(metadataObj);
        if (isOld.success) {
            // refactor to new
            const trnasformed = {
                messages: isOld.data.messages,
                time_in_ms: isOld.data.time_in_ms,
                paragraphInfo: isOld.data.paragraphInfo.map(x => {
                    const defaultAlternativeTitle = 'standard';
                    const defaultModel = x.judgment?.model ?? 'unbekannt';
                    const selectedText = x.selectedText == undefined
                        ? undefined
                        : x.selectedText == 'correction'
                            ? [defaultModel, x.selectedText] as const
                            : x.selectedText == 'alternative'
                                ? [defaultModel, x.selectedText, defaultAlternativeTitle] as const
                                : x.selectedText;

                    const judgment = {} as NewCorrectionMetadata['paragraphInfo'][number]['judgment'];
                    if (x.judgment) {
                        const alternative = {} as Record<string, string>;
                        alternative[defaultAlternativeTitle] = x.text.alternative!;
                        judgment[x.judgment.model ?? 'unbekannt'] = {
                            badPoints: [x.judgment.badPoints],
                            goodPoints: [x.judgment.goodPoints],
                            involvedCharacters: x.involvedCharacters!,
                            score: x.judgment.score,
                            text: {
                                correction: x.text.correction!,
                                alternative,
                            }
                        }
                    }


                    return ({
                        original: x.text.original,
                        edited: x.text.edited,
                        selectedText,
                        judgment,
                    }) satisfies NewCorrectionMetadata['paragraphInfo'][number]
                })
            } satisfies NewCorrectionMetadata;
            return trnasformed;
        } else {
            const isNew = newCorrectionParser.safeParse(metadataObj);
            if (isNew.success) {
                const data = isNew.data
                // now lets check if corrections have words that were added to
                // the dictionary after the correction was made
                const words = await getDictionary();
                data.paragraphInfo.forEach(paragraph => {
                    if (paragraph.corrected) {
                        paragraph.corrected.corrections = paragraph.corrected.corrections.sort((a, b) => a.offset - b.offset);
                        for (let i = paragraph.corrected.corrections.length - 1; i >= 0; i--) {
                            const correction = paragraph.corrected.corrections[i];
                            if (correction.original && words.has(correction.original)) {
                                const textBefore = paragraph.corrected.text.substring(0, correction.offset);
                                const textAfter = paragraph.corrected.text.substring(correction.offset + correction.length);
                                const replacedText = paragraph.corrected.text.substring(correction.offset, correction.offset + correction.length);
                                const newText = correction.original!;
                                const deltaLength = newText.length - replacedText.length;
                                paragraph.corrected.text = `${textBefore}${newText}${textAfter}`;
                                // correct offset of all following corrections
                                for (let j = i + 1; j < paragraph.corrected.corrections.length; j++) {
                                    paragraph.corrected.corrections[j].offset += deltaLength;
                                }
                                // remove correction 
                                paragraph.corrected.corrections.splice(i, 1);
                            }
                        }
                    }
                });
                // fixup data
                return data;
            } else {
                throw new Error(`Faild to read Object oldSchema ${JSON.stringify(isOld.error.flatten(), undefined, 2)}\n\n newSchema ${JSON.stringify(isNew.error.format(), undefined, 2)}`);
            }
        }
    }
    else
        throw new Error('Failed to get orignal or correction');
}


export async function getReview(id: string) {
    const oid = await git.resolveRef({ fs, dir, ref: `refs/reviews/${id}` });

    const { blob } = await git.readBlob({ fs, gitdir: dir, oid, filepath: 'review.json' });
    return JSON.parse(new TextDecoder().decode(blob));
}



export async function pullRepo(dir: string, auth?: { username: string, password: string }) {
    try {
        await git.pull({
            fs,
            http,
            dir,
            onAuth: () => auth,
        });
        console.log('Repository pulled successfully');
    } catch (error) {
        console.error('Failed to pull repository:', error);
    }
}

export async function pushRepo(dir: string, auth?: { username: string, password: string }) {
    try {
        await git.push({
            fs,
            http,
            dir,
            onAuth: () => auth,
        });
        console.log('Repository pushed successfully');
    } catch (error) {
        console.error('Failed to push repository:', error);
    }
}