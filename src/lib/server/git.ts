import * as git from 'isomorphic-git';
import fs from 'node:fs/promises';
import * as syncfs from 'node:fs';
import { Octokit } from 'octokit';
import { v4 as uuidv4 } from 'uuid';

import type { BlockContent, DefinitionContent } from 'mdast';


import http from 'isomorphic-git/http/web';
import { fireUpdate } from '$lib/trpc/router';
import type { CorrectionResult } from './wol';

const dir = 'repo';


const bot = () => ({
    name: 'Review Bot',
    email: 'noreply@review.bot',
    timestamp: Date.now(),
    timezoneOffset: new Date().getTimezoneOffset(),
});


export type Review = {
    id: string;
    review: string;
    improvements: {
        original: string;
        replacement: string;
        reason: string;
        location: {
            start: { line: number; column: number };
            end: { line: number; column: number };
        };
    }[];
};



export async function updateRepo(githubApiToken: string, repo: string) {
    console.log('Updating repository');
    try {

        console.log(githubApiToken)
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
            });
            console.log('Repository updated successfully');
        } else {
            try {
                await git.clone({
                    fs,
                    http,
                    dir,
                    url: clone_url.href,
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
            })
            if (result.fetchHead) {
                const spellcheckId = ref.ref.substring('refs/spellcheck/'.length);
                if ((await git.listRefs({ fs, dir, filepath: ref.ref })).length === 0) {
                    await git.writeRef({ fs, dir, ref: ref.ref, value: result.fetchHead, symbolic: false, force: true });
                    console.log('fetched new', result);
                }
                else {
                    await git.merge({
                        fs,
                        dir,
                        ours: `refs/spellcheck/${spellcheckId}`,
                        theirs: result.fetchHead,
                        fastForwardOnly: true,
                    })
                    console.log('fetched existing', result);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
}

export async function getText(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommit = await git.resolveRef({ fs, dir, ref: head });

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit });
    return new TextDecoder().decode(currentBlob.blob);
}

export async function getCurrentCommitData() {
    const branch = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommitOid = await git.resolveRef({ fs, dir, ref: branch });

    const currentCommit = await git.readCommit({ fs, dir, oid: currentCommitOid });
    return currentCommit.commit;
}

export async function setText(path: string, newText: string, commitData: Omit<git.CommitObject, 'parent' | 'tree'>) {
    const branch = await git.resolveRef({ fs, dir, ref: 'HEAD' });
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
    await git.writeRef({ fs, dir, ref: branch, value: newCommit, symbolic: false });



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

export type CorrectionMetadata = {
    messages: Array<BlockContent | DefinitionContent>[];
    time_in_ms: number;
    paragraphInfo: {
        text: {
            original: string,
            alternative?: string,
            correction?: string,
            edited?: string,
        },
        selectedText?: 'original' | 'alternative' | 'correction' | 'edited',
        judgment?: {
            goodPoints: string,
            badPoints: string,
            score: number,
        },
        involvedCharacters?: string[],
    }[];
};

export async function correctText(path: string, metadata: CorrectionMetadata, commitData?: { message?: string } & Omit<git.CommitObject, 'message' | 'parent' | 'tree'>) {

    const corrected = metadata.paragraphInfo
        .map((paragraph) => paragraph.text[paragraph.selectedText!] ?? paragraph.text.original)
        .join('\n');

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
    const numberOfCorrectedParagraphs = metadata.paragraphInfo.filter(x => x.text.correction).length;

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
}


export async function listFiles(branch: string = 'HEAD') {
    const ref = await git.resolveRef({ fs, dir, ref: branch });
    const files = await git.listFiles({ fs, dir, ref });
    const hasSpellcheck = await Promise.all(files.toSorted((a, b) => a.localeCompare(b)).map(async (file) => {
        return { hasCorrection: await hasCorrection(file), path: file };
    }));
    return hasSpellcheck;

}


export async function hasCorrection(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: head });

    const oid = currentBlob.oid;
    try {
        await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });
        return true;
    } catch {
        return false;
    }
}
export async function tryGetCorrection(path: string) {
    if (await hasCorrection(path)) {
        return await getCorrection(path);
    } else {
        return null;
    }
}
export async function getCorrection(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: head });
    const oid = currentBlob.oid;
    const correctionOid = await git.resolveRef({ fs, dir, ref: `refs/spellcheck/${oid}` });


    const decoder = new TextDecoder();
    const decode = (data: { blob: Uint8Array<ArrayBufferLike> } | undefined | null) => {
        if (data)
            return decoder.decode(data.blob);
        else
            return null;
    };

    const metadataString = decode(await git.readBlob({ fs, dir, oid: correctionOid, filepath: 'metadata' }));
    if (metadataString)
        return JSON.parse(metadataString) as CorrectionMetadata;
    else
        throw new Error('Failed to get orignal or correction');
}

export async function addReview(review: Omit<Review, 'id'> & Partial<Pick<Review, 'id'>>, forFile: string) {

    const oidOfReviewedFile = await getBlobOfPath(forFile);

    const reviewBlobData = await git.writeBlob({
        fs,
        dir,
        blob: new TextEncoder().encode(JSON.stringify(review)),
    });

    const tree = await git.writeTree({
        fs,
        dir,
        tree: [
            {
                type: 'blob',
                oid: reviewBlobData,
                path: 'review.json',
                mode: '100644',
            },
            {
                type: 'blob',
                oid: oidOfReviewedFile,
                path: 'target',
                mode: '100644',
            },
        ],
    });
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    const bot = {
        name: 'Review Bot',
        email: 'noreply@review.bot',
        timestamp: Date.now(),
        timezoneOffset: new Date().getTimezoneOffset(),
    };

    const commit = await git.writeCommit({
        fs,
        dir,
        commit: {
            message: 'Add review',
            tree,
            parent: [head],
            author: bot,
            committer: bot,
        }
    });
    const uuid = review.id ?? uuidv4();
    if (uuid.length === 0) {
        throw new Error('Review id cannot be empty');
    }
    await git.writeRef({ fs, dir, ref: `refs/reviews/${uuid}`, value: commit, symbolic: false });
    return uuid;
}

export async function getReview(id: string) {
    const oid = await git.resolveRef({ fs, dir, ref: `refs/reviews/${id}` });

    const { blob } = await git.readBlob({ fs, gitdir: dir, oid, filepath: 'review.json' });
    return JSON.parse(new TextDecoder().decode(blob));
}

export async function getReviews() {
    const refs = await git.listRefs({ fs, dir, filepath: 'refs/reviews/' });
    console.log(JSON.stringify(refs, undefined, 2));
    const reviewRefs = refs;
    const reviews = await Promise.all(reviewRefs.map(async (ref) => {
        const oid = await git.resolveRef({ fs, dir, ref });
        const { blob } = await git.readBlob({ fs, gitdir: dir, oid, filepath: 'review.json' });
        return JSON.parse(new TextDecoder().decode(blob));
    }));
    return reviews;
}

async function getBlobOfPath(path: string) {
    const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    //TODO: we only need the oid, not the whole blob
    const resultOid = await resolveFilepathToOid({
        fs,
        oid,
        filepath: path,
    });
    return resultOid;
}

async function resolveFilepathToOid({ fs, oid, filepath }: { fs: git.CallbackFsClient | git.PromiseFsClient, oid: string, filepath: string }) {
    if (filepath.startsWith('/')) {
        if (filepath.endsWith('/')) {
            throw new Error('Path cannot start with a leading slash character nor end with a trailing slash character')
        } else {
            throw new Error('Path cannot start with a leading slash character')
        }
    } else if (filepath.endsWith('/')) {
        throw new Error('Path cannot end with a trailing slash character')
    }
    const { tree, oid: treeOid } = await git.readTree({ fs, gitdir: dir, oid });
    if (filepath === '') {
        return treeOid;
    } else {
        const resultOid = await getOidOfPath({
            fs,
            gitdir: dir,
            tree,
            path: filepath,
            oid,
        });
        return resultOid;
    }

    async function getOidOfPath({
        fs,
        gitdir,
        tree,
        oid,
        path,
    }: {
        fs: git.CallbackFsClient | git.PromiseFsClient;
        gitdir: string;
        tree: git.TreeEntry[];
        path: string
        oid: string;
    }

    ) {
        // get first part of path and rest
        const firstDelimiterPosition = path.indexOf('/');
        const name = path.substring(0, firstDelimiterPosition);
        const rest = path.substring(firstDelimiterPosition + 1);

        for (const entry of tree) {
            if (entry.path === name) {
                if (rest === '') {
                    return entry.oid
                } else {

                    const { oid, tree } = await git.readTree({
                        fs,
                        gitdir,
                        oid: entry.oid,
                    });
                    return getOidOfPath({
                        fs,
                        gitdir,
                        tree,
                        path: rest,
                        oid,
                    })
                }
            }
        }
        throw new Error(`file or directory found at "${oid}:${filepath}"`)
    }
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