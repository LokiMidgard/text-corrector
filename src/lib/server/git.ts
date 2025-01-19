import * as git from 'isomorphic-git';
import fs from 'node:fs/promises';
import * as syncfs from 'node:fs';
import { Octokit } from 'octokit';
import { v4 as uuidv4 } from 'uuid';

import type { BlockContent, DefinitionContent } from 'mdast';


import http from 'isomorphic-git/http/web';
import { fireUpdate } from '$lib/trpc/router';

const dir = 'repo';


const bot = {
    name: 'Review Bot',
    email: 'noreply@review.bot',
    timestamp: Date.now(),
    timezoneOffset: new Date().getTimezoneOffset(),
};


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



export async function updateRepo(githubApiToken:string, repo:string) {
    console.log('Updating repository');
    const octokit = new Octokit({ auth: githubApiToken });

    const {
        data: { login },
    } = await octokit.rest.users.getAuthenticated();
    // checkout repository
    const { data: repository } = await octokit.rest.repos.get({
        owner: login,
        repo,
    });


    const clone_url = new URL(repository.clone_url);
    clone_url.username = login;
    clone_url.password = githubApiToken;



    if (syncfs.existsSync(dir)) {
        await git.pull({
            fs,
            http,
            dir,
            author: bot,
            committer: bot,
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
}

export async function getText(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommit = await git.resolveRef({ fs, dir, ref: head });

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit });
    return new TextDecoder().decode(currentBlob.blob);
}

export type CorrectionMetadata = {
    paragraph: { value: number, of: number | undefined };
    messages: Array<BlockContent | DefinitionContent>[];
    time_in_ms: number;
};

export async function correctText(path: string, corrected: string, metadata: CorrectionMetadata) {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const currentCommit = await git.resolveRef({ fs, dir, ref: head });

    let lastCommit = currentCommit;

    const currentBlob = await git.readBlob({ fs, dir, filepath: path, oid: currentCommit });
    const metadataBlobOid = await git.writeBlob({
        fs, dir,
        blob: new TextEncoder().encode(JSON.stringify(metadata)),
    });
    const correctionBlobOid = await git.writeBlob({
        fs, dir,
        blob: new TextEncoder().encode(corrected),
    });
    console.log('metadataBlobOid', metadataBlobOid);
    console.log('correctionBlobOid', correctionBlobOid);
    console.log('currentBlob', currentBlob.oid);

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




    const commit = await git.writeCommit({
        fs,
        dir,
        commit: {
            message: `Correct ${path} ${metadata.paragraph.value}/${metadata.paragraph.of} ${metadata.time_in_ms}`,
            tree,
            parent: parent,
            author: bot,
            committer: bot,
        }
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
    const files = await git.listFiles({ fs, dir, ref: branch });
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

    const correction = decode(await git.readBlob({ fs, dir, oid: correctionOid, filepath: 'correction' }));
    const original = decode(await git.readBlob({ fs, dir, oid: correctionOid, filepath: 'original' }));
    const metadataString = decode(await git.readBlob({ fs, dir, oid: correctionOid, filepath: 'metadata' }));
    if (original && correction && metadataString)
        return { correction, original, metadata: JSON.parse(metadataString) as CorrectionMetadata };
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